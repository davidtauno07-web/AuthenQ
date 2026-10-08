import { detectTextEntities } from '../domain/firewall.js';
import { prisma, Prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, forbidden, gateBlocked, notFound } from '../lib/errors.js';
import { storage, storageKey } from '../lib/storage.js';
import { createZip } from '../lib/zip.js';
import { extractCandidates } from '../domain/canary.js';
import { audit } from '../modules/audit.js';
import { can, systemContext, type RequestContext } from '../modules/context.js';
import { enqueue, type JobReporter } from '../modules/jobs/queue.js';
import { emit, recordUsage } from '../modules/platform/events.js';
import { getProjectOrThrow, labelsOf, taskText } from './labeling.js';
import { qualityReport } from './quality.js';

export interface ExportFormat {
  key: string;
  name: string;
  extension: string;
  description: string;
  render: (records: ExportRecord[], ctx: { labels: string[]; guideline: string }) => string;
}

export interface ExportRecord {
  id: string;
  key: string;
  text: string;
  fields: Record<string, unknown>;
  context: Record<string, unknown>;
  label: string;
  source: string;
  split: string;
  guidelineVersion: number | null;
  confidence: number | null;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralize spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Extensible registry of output formats. */
export const FORMATS: Record<string, ExportFormat> = {
  JSONL: {
    key: 'JSONL',
    name: 'JSONL (text + label)',
    extension: 'jsonl',
    description: 'One JSON object per line with text, label, split and provenance fields.',
    render: (rs) => rs.map((r) => JSON.stringify({ id: r.key, text: r.text, label: r.label, split: r.split, label_source: r.source, guideline_version: r.guidelineVersion, context: r.context })).join('\n') + '\n',
  },
  CHAT_JSONL: {
    key: 'CHAT_JSONL',
    name: 'Chat fine-tuning JSONL',
    extension: 'jsonl',
    description: 'OpenAI-style {"messages": [...]} records for supervised fine-tuning.',
    render: (rs, c) =>
      rs
        .map((r) => JSON.stringify({ messages: [{ role: 'system', content: `Classify the record into one of: ${c.labels.join(', ')}.` }, { role: 'user', content: r.text }, { role: 'assistant', content: r.label }] }))
        .join('\n') + '\n',
  },
  CSV: {
    key: 'CSV',
    name: 'CSV',
    extension: 'csv',
    description: 'Tabular file with one row per record.',
    render: (rs) => {
      const ctxKeys = [...new Set(rs.flatMap((r) => Object.keys(r.context)))];
      const header = ['id', 'text', 'label', 'split', 'label_source', 'guideline_version', ...ctxKeys];
      return [header.join(','), ...rs.map((r) => [r.key, r.text, r.label, r.split, r.source, r.guidelineVersion, ...ctxKeys.map((k) => r.context[k])].map(csvCell).join(','))].join('\n') + '\n';
    },
  },
  HF_JSONL: {
    key: 'HF_JSONL',
    name: 'Hugging Face datasets (JSONL + ClassLabel)',
    extension: 'jsonl',
    description: 'JSONL with integer label ids plus dataset_info.json describing the ClassLabel feature.',
    render: (rs, c) => rs.map((r) => JSON.stringify({ text: r.text, label: c.labels.indexOf(r.label), split: r.split })).join('\n') + '\n',
  },
};

export async function listExports(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.export.findMany({ where: { projectId, deletedAt: null }, orderBy: { version: 'desc' } });
}

export async function createExport(ctx: RequestContext, projectId: string, input: { format: string; includeSplits: string[]; overrideReason?: string }) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (!FORMATS[input.format]) throw badRequest(`Unknown export format "${input.format}".`);
  const report = await qualityReport(ctx, projectId);
  let overrideReason: string | null = null;
  if (!report.gate.ready) {
    const reasons = report.gate.checks.filter((c) => !c.within).map((c) => `${c.label} is outside threshold: ${c.explanation}`);
    if (!input.overrideReason) throw gateBlocked('export quality', reasons, [{ label: 'Open Review & Quality', href: `/projects/${projectId}/quality` }]);
    if (!can(ctx, 'exports.override')) throw forbidden('Only project managers and admins can override a blocked quality gate.');
    if (input.overrideReason.trim().length < 15) throw badRequest('Explain the override in at least 15 characters. The reason is recorded in the manifest and data card.');
    overrideReason = input.overrideReason.trim();
  }
  const last = await prisma.export.findFirst({ where: { projectId }, orderBy: { version: 'desc' } });
  const exp = await prisma.export.create({
    data: {
      orgId: ctx.orgId,
      projectId,
      version: (last?.version ?? 0) + 1,
      format: input.format,
      options: { includeSplits: input.includeSplits } as Prisma.InputJsonValue,
      gate: { ready: report.gate.ready, checks: report.gate.checks } as unknown as Prisma.InputJsonValue,
      overrideReason,
      overrideById: overrideReason ? ctx.userId : null,
      createdById: ctx.userId,
    },
  });
  const job = await enqueue({ orgId: ctx.orgId, type: 'EXPORT_BUILD', payload: { exportId: exp.id }, resourceType: 'export', resourceId: exp.id, createdById: ctx.userId });
  await prisma.export.update({ where: { id: exp.id }, data: { jobId: job.id } });
  await audit(ctx, {
    action: overrideReason ? 'export.created_with_override' : 'export.created',
    resourceType: 'export',
    resourceId: exp.id,
    summary: `Started export v${exp.version} (${input.format}) of "${p.name}"${overrideReason ? ` with quality gate override: ${overrideReason}` : ''}`,
    jobId: job.id,
  });
  return { ...exp, jobId: job.id };
}

export async function runExportJob(orgId: string, payload: { exportId: string }, reporter: JobReporter) {
  const exp = await prisma.export.update({ where: { id: payload.exportId }, data: { status: 'BUILDING' } });
  const p = await prisma.labelProject.findUniqueOrThrow({ where: { id: exp.projectId } });
  const ctx = systemContext(orgId, 'Export builder');
  const fmt = FORMATS[exp.format]!;
  const labels = labelsOf(p).map((l) => l.value);
  const opts = exp.options as { includeSplits?: string[] };
  const includeSplits = new Set(opts.includeSplits?.length ? opts.includeSplits : ['TRAIN']);
  const guideline = p.activeGuidelineVersionId ? await prisma.guidelineVersion.findUnique({ where: { id: p.activeGuidelineVersionId } }) : null;
  const versions = new Map((await prisma.guidelineVersion.findMany({ where: { projectId: p.id }, select: { id: true, version: true } })).map((v) => [v.id, v.version]));
  const tasks = await prisma.task.findMany({
    where: { projectId: p.id, status: { in: ['DONE', 'LABELED'] }, finalLabels: { not: Prisma.AnyNull } },
    orderBy: { ordinal: 'asc' },
    include: { syntheticRow: { select: { id: true, data: true, syntheticKey: true } }, gold: { select: { split: true } }, engineItems: { orderBy: { createdAt: 'desc' }, take: 1, select: { confidence: true } } },
  });
  const finalLabelIds = tasks.map((t) => t.finalLabelId).filter((x): x is string => !!x);
  const labelRows = new Map((await prisma.label.findMany({ where: { id: { in: finalLabelIds } }, select: { id: true, guidelineVersionId: true } })).map((l) => [l.id, l]));
  await reporter.progress(0, tasks.length, undefined, `Collected ${tasks.length} labeled records`);
  const records: ExportRecord[] = [];
  for (const t of tasks) {
    const split = t.gold?.split === 'LOCKED_TEST' ? 'TEST' : t.gold?.split === 'TUNING' ? 'VALIDATION' : 'TRAIN';
    if (!includeSplits.has(split)) continue;
    const data = t.syntheticRow.data as Record<string, unknown>;
    const gv = t.finalLabelId ? labelRows.get(t.finalLabelId)?.guidelineVersionId : null;
    records.push({
      id: t.id,
      key: t.syntheticRow.syntheticKey,
      text: taskText(p, data),
      fields: Object.fromEntries(p.textFields.map((f) => [f, data[f]])),
      context: Object.fromEntries(p.contextFields.map((f) => [f, data[f]])),
      label: (t.finalLabels as { label: string }).label,
      source: t.finalSource ?? 'UNKNOWN',
      split,
      guidelineVersion: gv ? versions.get(gv) ?? null : null,
      confidence: t.engineItems[0]?.confidence ?? null,
    });
  }
  if (!records.length) throw Object.assign(new Error('No labeled records match the selected splits.'), { permanent: true });
  const dataText = fmt.render(records, { labels, guideline: guideline?.content ?? '' });

  // Safety: no real source value from replaced/scrubbed columns may appear in the export.
  const set = await prisma.syntheticSet.findUniqueOrThrow({ where: { id: p.setId } });
  const sensitiveCols = await prisma.sourceColumn.findMany({ where: { sourceId: set.sourceId, decision: { in: ['REPLACE', 'SCRUB_TEXT', 'DROP'] }, entityType: { not: 'FREE_TEXT' } }, select: { name: true, tableId: true } });
  const candidates = extractCandidates(dataText);
  let realHits = 0;
  const checkedValues = new Set<string>();
  for (const c of sensitiveCols) {
    const rows = await prisma.$queryRaw<{ v: string | null }[]>`SELECT data->>${c.name} AS v FROM source_rows WHERE "tableId" = ${c.tableId}::uuid`;
    for (const r of rows) {
      if (!r.v || r.v.length < 4) continue;
      const v = r.v.toLowerCase();
      checkedValues.add(v);
      if (candidates.has(v) || candidates.has(v.replace(/\D/g, '')) && v.replace(/\D/g, '').length >= 7) realHits++;
    }
  }
  // Free text is rebuilt from real sentences, so also block anything that still looks like a credential.
  const secretLike = detectTextEntities(dataText).SECRET?.length ?? 0;
  const safety = {
    realValuesChecked: checkedValues.size,
    realValueMatches: realHits,
    secretLikeMatches: secretLike,
    passed: realHits === 0 && secretLike === 0,
    dataClass: 'SYNTHETIC',
    explanation:
      realHits > 0
        ? `${realHits} real sensitive values were found in the export. The export was blocked.`
        : secretLike > 0
          ? `${secretLike} credential-like value(s) (keys, tokens or passwords) were found in the export. The export was blocked.`
          : `None of ${checkedValues.size} real sensitive values from the source were found in the export, and no credential-like values were detected.`,
  };
  if (!safety.passed) {
    await prisma.export.update({ where: { id: exp.id }, data: { status: 'BLOCKED', safety } });
    return { blocked: true };
  }

  // Canary exposure for every registered synthetic value included in this package.
  const rowIds = tasks.filter((t) => records.some((r) => r.id === t.id)).map((t) => t.syntheticRow.id);
  const registry = await prisma.canaryRegistry.findMany({ where: { setId: set.id, syntheticRowId: { in: rowIds } }, select: { id: true } });
  const send = await prisma.send.create({ data: { orgId, setId: set.id, recipient: `Export v${exp.version} (${fmt.name})`, recipientType: 'EXPORT', channel: 'Download package', exportId: exp.id, projectId: p.id, recordCount: records.length, sentById: exp.createdById } });
  for (let i = 0; i < registry.length; i += 5000) await prisma.exposure.createMany({ data: registry.slice(i, i + 5000).map((r) => ({ orgId, sendId: send.id, registryId: r.id })), skipDuplicates: true });

  const report = await qualityReport({ ...ctx, roleKey: 'ADMIN' }, p.id);
  const splitCounts = records.reduce<Record<string, number>>((a, r) => ((a[r.split] = (a[r.split] ?? 0) + 1), a), {});
  const sourceCounts = records.reduce<Record<string, number>>((a, r) => ((a[r.source] = (a[r.source] ?? 0) + 1), a), {});
  const labelCounts = records.reduce<Record<string, number>>((a, r) => ((a[r.label] = (a[r.label] ?? 0) + 1), a), {});
  const dataFile = `data.${fmt.extension}`;
  const schema = { format: fmt.key, fields: fmt.key === 'CSV' ? ['id', 'text', 'label', 'split', 'label_source', 'guideline_version', ...p.contextFields] : fmt.key === 'CHAT_JSONL' ? ['messages[].role', 'messages[].content'] : ['id', 'text', 'label', 'split', 'label_source', 'guideline_version', 'context'], labels };
  const lineage = {
    source: { id: set.sourceId, firewallScanId: set.firewallScanId, note: 'Real source data never left the Firewall boundary.' },
    syntheticSet: { id: set.id, version: set.version, seed: set.seed, algorithm: set.algorithmVersion, multiplier: set.multiplier },
    labelingProject: { id: p.id, name: p.name, sendId: p.sendId, goldVersion: p.goldVersion, goldLockedAt: p.goldLockedAt },
    engineRun: report.run,
    guidelineVersion: guideline ? { id: guideline.id, version: guideline.version } : null,
    canary: { sendId: send.id, registeredValuesIncluded: registry.length },
  };
  const dataCard = {
    title: `${p.name} — v${exp.version}`,
    purpose: p.purpose,
    description: p.description,
    records: records.length,
    splits: splitCounts,
    labelDistribution: labelCounts,
    labelSources: sourceCounts,
    quality: { gate: report.gate, evaluation: report.evaluation && { accuracy: report.evaluation.accuracy, interval: report.evaluation.interval, n: report.evaluation.n, macroF1: report.evaluation.macroF1 }, humanAgreement: report.humanAgreement, reviewRate: report.reviewRate, audit: report.audit },
    override: exp.overrideReason ? { reason: exp.overrideReason, byUserId: exp.overrideById } : null,
    safety,
    limitations: [
      'Records are synthetic and derived from organizational data via AuthenQ Twin; they do not describe real people.',
      'Labels marked ENGINE_* were produced automatically and accepted by confidence routing; see label_source per record.',
      'Quality metrics are estimates from the locked test split and carry the stated confidence interval.',
    ],
  };
  const manifest = { authenq: '1.0', exportId: exp.id, version: exp.version, createdAt: new Date().toISOString(), format: fmt.key, dataFile, records: records.length, projectId: p.id, guidelineVersion: guideline?.version ?? null, goldVersion: p.goldVersion, gateReady: report.gate.ready, overrideReason: exp.overrideReason };
  const readme = `# ${p.name} — export v${exp.version}\n\n${p.description || ''}\n\n- Format: ${fmt.name} (\`${dataFile}\`)\n- Records: ${records.length} (${Object.entries(splitCounts).map(([k, v]) => `${k} ${v}`).join(', ')})\n- Labels: ${labels.join(', ')}\n- Guideline version: ${guideline?.version ?? 'n/a'}\n- Quality gate: ${report.gate.ready ? 'all checks within threshold' : `overridden — ${exp.overrideReason}`}\n\nAll records are **synthetic**. See \`data_card.json\` for quality, provenance and limitations, \`lineage.json\` for the full chain from source to export, and \`checksums.sha256\` to verify file integrity.\n`;
  const files: { name: string; data: string }[] = [
    { name: dataFile, data: dataText },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'schema.json', data: JSON.stringify(schema, null, 2) },
    { name: 'labels.json', data: JSON.stringify(labelsOf(p), null, 2) },
    { name: 'guidelines.md', data: guideline?.content ?? '' },
    { name: 'data_card.json', data: JSON.stringify(dataCard, null, 2) },
    { name: 'lineage.json', data: JSON.stringify(lineage, null, 2) },
    { name: 'provenance.jsonl', data: records.map((r) => JSON.stringify({ id: r.key, label_source: r.source, guideline_version: r.guidelineVersion, engine_confidence: r.confidence, split: r.split })).join('\n') + '\n' },
    { name: 'safety.json', data: JSON.stringify(safety, null, 2) },
    { name: 'quality.json', data: JSON.stringify(report.gate, null, 2) },
    { name: 'README.md', data: readme },
  ];
  if (fmt.key === 'HF_JSONL') files.push({ name: 'dataset_info.json', data: JSON.stringify({ features: { text: { dtype: 'string', _type: 'Value' }, label: { names: labels, _type: 'ClassLabel' } } }, null, 2) });
  const checksums = files.map((f) => `${sha256(f.data)}  ${f.name}`).join('\n') + '\n';
  const zip = createZip([...files, { name: 'checksums.sha256', data: checksums }]);
  const file = await prisma.file.create({ data: { orgId, name: `${p.name.replace(/[^\w-]+/g, '_')}_v${exp.version}.zip`, contentType: 'application/zip', size: zip.length, storageKey: '', checksum: sha256(zip), purpose: 'EXPORT', dataClass: 'SYNTHETIC', createdById: exp.createdById } });
  const key = storageKey(orgId, 'exports', file.id, 'zip');
  await storage.put(key, zip, 'application/zip');
  await prisma.file.update({ where: { id: file.id }, data: { storageKey: key } });
  await prisma.export.update({
    where: { id: exp.id },
    data: { status: 'COMPLETED', completedAt: new Date(), fileId: file.id, recordCount: records.length, checksum: file.checksum, manifest: manifest as Prisma.InputJsonValue, dataCard: dataCard as unknown as Prisma.InputJsonValue, safety },
  });
  await audit(ctx, { action: 'export.completed', resourceType: 'export', resourceId: exp.id, summary: `Export v${exp.version} ready: ${records.length} records, ${registry.length} Canary values exposed via download` });
  await recordUsage(orgId, 'exports.records', records.length, 'export', exp.id);
  await emit(orgId, 'export.completed', { exportId: exp.id, projectId: p.id, version: exp.version, records: records.length });
  return { records: records.length };
}

export async function getExport(ctx: RequestContext, projectId: string, exportId: string) {
  await getProjectOrThrow(ctx, projectId);
  const exp = await prisma.export.findFirst({ where: { id: exportId, projectId, deletedAt: null } });
  if (!exp) throw notFound('Export');
  return exp;
}

export async function downloadUrl(ctx: RequestContext, projectId: string, exportId: string) {
  const exp = await getExport(ctx, projectId, exportId);
  if (exp.status !== 'COMPLETED' || !exp.fileId) throw badRequest('This export is not ready to download.');
  const file = await prisma.file.findUniqueOrThrow({ where: { id: exp.fileId } });
  await audit(ctx, { action: 'export.downloaded', resourceType: 'export', resourceId: exp.id, summary: `Downloaded export v${exp.version}` });
  return { url: await storage.signedUrl(file.storageKey, file.name, 300), fileName: file.name, checksum: file.checksum };
}
