import { readZip } from '../lib/zip.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { classifyFuzzy, contextAround, extractCandidates, extractFuzzy, normalize, SCAN_DISCLAIMER, signature, type MatchType } from '../domain/canary.js';
import { audit } from '../modules/audit.js';
import { can, type RequestContext } from '../modules/context.js';
import { emit, notifyRole } from '../modules/platform/events.js';
import { storage } from '../lib/storage.js';

const MAX_SCAN_CHARS = 20_000_000;

/** Values from sets still waiting for approval (or rejected) are visible only to people who can approve sets. */
async function setScope(ctx: RequestContext): Promise<{ setId?: { in: string[] } }> {
  if (can(ctx, 'firewall.signoff')) return {};
  const sets = await prisma.syntheticSet.findMany({ where: { orgId: ctx.orgId, approvalStatus: 'APPROVED' }, select: { id: true } });
  return { setId: { in: sets.map((s) => s.id) } };
}

export async function searchRegistry(ctx: RequestContext, q: string, limit = 50) {
  const term = q.trim();
  if (!term) {
    return prisma.canaryRegistry.findMany({ where: { orgId: ctx.orgId, ...(await setScope(ctx)) }, orderBy: { createdAt: 'desc' }, take: limit, include: { _count: { select: { exposures: true, alerts: true } } } });
  }
  const variants = [...new Set(['GENERIC', 'PHONE', 'EMAIL'].map((t) => normalize(term, t)))];
  return prisma.canaryRegistry.findMany({
    where: { orgId: ctx.orgId, ...(await setScope(ctx)), OR: [{ normalized: { in: variants } }, { normalized: { startsWith: variants[0]! } }, { signature: term }] },
    take: limit,
    include: { _count: { select: { exposures: true, alerts: true } } },
  });
}

export async function traceValue(ctx: RequestContext, registryId: string) {
  const entry = await prisma.canaryRegistry.findFirst({
    where: { id: registryId, orgId: ctx.orgId, ...(await setScope(ctx)) },
    include: {
      exposures: { include: { send: true }, orderBy: { createdAt: 'asc' } },
      alerts: { include: { scan: true }, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!entry) throw notFound('Canary value');
  const set = await prisma.syntheticSet.findUnique({ where: { id: entry.setId }, select: { id: true, name: true, version: true, seed: true, algorithmVersion: true, source: { select: { id: true, name: true } } } });
  const row = await prisma.syntheticRow.findUnique({ where: { id: entry.syntheticRowId }, select: { syntheticKey: true, tableName: true, rowIndex: true } });
  return {
    id: entry.id,
    value: entry.value,
    signature: entry.signature,
    entityType: entry.entityType,
    origin: { set, table: entry.tableName, column: entry.columnName, record: row, generation: entry.generationMeta, createdAt: entry.createdAt },
    exposures: entry.exposures.map((e) => ({ at: e.createdAt, recipient: e.send.recipient, recipientType: e.send.recipientType, channel: e.send.channel, sendId: e.sendId })),
    alerts: entry.alerts.map((a) => ({ id: a.id, status: a.status, at: a.createdAt, input: a.scan.inputName, context: a.context })),
  };
}

/** Scans text for registered synthetic values using indexed lookup of candidate tokens. */
export async function scanText(ctx: RequestContext, input: { text: string; inputName: string; inputType: 'TEXT' | 'FILE' | 'EXPORT' | 'API' }) {
  if (!input.text.trim()) throw badRequest('Paste some text or choose a file to scan.');
  if (input.text.length > MAX_SCAN_CHARS) throw badRequest('The input is larger than 20 million characters. Split it into smaller files.');
  const candidates = extractCandidates(input.text);
  const keys = [...candidates.keys()];
  const scope = await setScope(ctx);
  const matches: Awaited<ReturnType<typeof prisma.canaryRegistry.findMany>> = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    matches.push(...(await prisma.canaryRegistry.findMany({ where: { orgId: ctx.orgId, ...scope, normalized: { in: chunk } } })));
  }
  const unique = new Map(matches.map((m) => [m.id, m]));
  const fuzzy = extractFuzzy(input.text);
  const fkeys = [...fuzzy.keys()];
  const fuzzyHits: typeof matches = [];
  for (let i = 0; i < fkeys.length && fuzzyHits.length < MAX_FUZZY; i += 1000) {
    fuzzyHits.push(...(await prisma.canaryRegistry.findMany({ where: { orgId: ctx.orgId, ...scope, fuzzyKey: { in: fkeys.slice(i, i + 1000) } }, take: MAX_FUZZY })));
  }
  type Hit = { m: (typeof matches)[number]; raw: string; index: number; matchType: MatchType; confidence: number; explanation: string };
  const hits: Hit[] = [];
  for (const m of unique.values()) {
    if (signature(env.CANARY_SECRET, m.entityType, m.normalized) !== m.signature) continue;
    const h = candidates.get(m.normalized)!;
    const exact = h.raw === m.value;
    hits.push({ m, raw: h.raw, index: h.index, matchType: exact ? 'EXACT' : 'NORMALIZED', confidence: exact ? 1 : 0.95, explanation: exact ? 'The registered value appears exactly.' : 'The registered value appears with different case, spacing or punctuation.' });
  }
  for (const m of fuzzyHits) {
    if (unique.has(m.id) || !m.fuzzyKey || signature(env.CANARY_SECRET, m.entityType, m.normalized) !== m.signature) continue;
    const h = fuzzy.get(m.fuzzyKey);
    if (!h) continue;
    unique.set(m.id, m);
    hits.push({ m, raw: h.raw, index: h.index, ...classifyFuzzy(m.fuzzyKey) });
  }
  const scan = await prisma.canaryScan.create({
    data: { orgId: ctx.orgId, inputType: input.inputType, inputName: input.inputName.slice(0, 200), charCount: input.text.length, matchCount: hits.length, candidates: keys.length + fkeys.length, createdById: ctx.userId },
  });
  const results = [];
  for (const h of hits) {
    const context = contextAround(input.text, h.index, h.raw.length);
    await prisma.leakAlert.create({ data: { orgId: ctx.orgId, scanId: scan.id, registryId: h.m.id, matchedText: h.raw.slice(0, 200), context: context.slice(0, 500), matchType: h.matchType, confidence: h.confidence } });
    const exposures = await prisma.exposure.findMany({ where: { registryId: h.m.id }, include: { send: true } });
    results.push({
      registryId: h.m.id,
      value: h.m.value,
      entityType: h.m.entityType,
      matchedText: h.raw,
      matchType: h.matchType,
      confidence: h.confidence,
      explanation: h.explanation,
      context,
      origin: { setId: h.m.setId, table: h.m.tableName, column: h.m.columnName },
      exposures: exposures.map((e) => ({ recipient: e.send.recipient, recipientType: e.send.recipientType, channel: e.send.channel, projectId: e.send.projectId, exportId: e.send.exportId, at: e.createdAt })),
    });
  }
  results.sort((x, y) => y.confidence - x.confidence);
  const strong = results.filter((r) => r.confidence >= 0.9);
  const verdict = strong.length ? 'FOUND' : results.length ? 'POSSIBLE' : 'NOT_FOUND';
  const recipients = [...new Map(results.flatMap((r) => r.exposures).map((e) => [`${e.recipientType}:${e.recipient}`, { recipient: e.recipient, recipientType: e.recipientType, channel: e.channel }])).values()];
  await audit(ctx, { action: 'canary.scan', resourceType: 'canary_scan', resourceId: scan.id, summary: `Scanned "${scan.inputName}" (${input.text.length} chars): ${strong.length} exact/normalized and ${results.length - strong.length} approximate match(es)` });
  if (results.length) {
    await emit(ctx.orgId, 'canary.leak_alert', { scanId: scan.id, matches: results.length, inputName: scan.inputName });
    await notifyRole(ctx.orgId, ['ADMIN', 'DATA_ENGINEER'], 'canary.alert', 'Canary match found', `${results.length} registered synthetic value(s) found in "${scan.inputName}".`, `/canary?scan=${scan.id}`);
  }
  return { scanId: scan.id, candidates: keys.length + fkeys.length, verdict, recipients, matches: results, disclaimer: SCAN_DISCLAIMER, limitations: SCAN_LIMITATIONS };
}

const MAX_FUZZY = 500;
const SCAN_LIMITATIONS = [
  SCAN_DISCLAIMER,
  'Only values Twin replaced in sensitive columns are registered. Kept categories, numbers and generalised values cannot be traced.',
  'Exposure history only covers sends recorded by AuthenQ (labeling projects, exports, external tools). Copies made after a send are not visible.',
  'Approximate and heuristic matches can be coincidences. Review the context before acting on them.',
  'Only text content is scanned. Images, PDFs and archives other than AuthenQ export packages are not read.',
];

export async function scanExport(ctx: RequestContext, exportId: string) {
  const exp = await prisma.export.findFirst({ where: { id: exportId, orgId: ctx.orgId, deletedAt: null } });
  if (!exp?.fileId) throw notFound('Export file');
  const file = await prisma.file.findUniqueOrThrow({ where: { id: exp.fileId } });
  const buf = await storage.get(file.storageKey);
  // Export packages are zips; scan the decoded data file rather than the whole archive.
  const dataEntry = buf.subarray(0, 2).toString('latin1') === 'PK' ? readZip(buf).find((e) => e.name.startsWith('data.')) : undefined;
  const text = (dataEntry?.data ?? buf).toString('utf8');
  return scanText(ctx, { text, inputName: `Export v${exp.version} (${exp.format})`, inputType: 'EXPORT' });
}

export const ALERT_STATUSES = ['OPEN', 'INVESTIGATING', 'REVIEWED', 'RESOLVED', 'FALSE_POSITIVE', 'ACKNOWLEDGED'] as const;

export async function listAlerts(ctx: RequestContext, status?: string, filters: { matchType?: string; q?: string; assignedToMe?: boolean } = {}) {
  const q = filters.q?.trim();
  return prisma.leakAlert.findMany({
    where: {
      orgId: ctx.orgId,
      ...(status ? { status } : {}),
      ...(filters.matchType ? { matchType: filters.matchType } : {}),
      ...(filters.assignedToMe ? { assignedToId: ctx.userId } : {}),
      ...(q ? { OR: [{ matchedText: { contains: q, mode: 'insensitive' as const } }, { context: { contains: q, mode: 'insensitive' as const } }, { scan: { inputName: { contains: q, mode: 'insensitive' as const } } }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { registry: { select: { value: true, entityType: true, tableName: true, columnName: true, setId: true } }, scan: { select: { inputName: true, inputType: true } } },
  });
}

export async function updateAlert(ctx: RequestContext, id: string, input: { status?: (typeof ALERT_STATUSES)[number]; note?: string; assignedToId?: string | null }) {
  const alert = await prisma.leakAlert.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!alert) throw notFound('Alert');
  if (input.assignedToId) {
    const member = await prisma.organizationMember.findFirst({ where: { orgId: ctx.orgId, userId: input.assignedToId, status: 'ACTIVE' } });
    if (!member) throw badRequest('Alerts can only be assigned to active members of this organisation.');
  }
  if ((input.status === 'RESOLVED' || input.status === 'FALSE_POSITIVE') && !input.note?.trim() && !alert.note) throw badRequest('Add a note explaining the outcome before closing the alert.');
  const note = input.note?.trim() ? `${alert.note ? `${alert.note}\n` : ''}[${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${ctx.actorLabel}] ${input.note.trim()}`.slice(-4000) : alert.note;
  const status = input.status ?? alert.status;
  const updated = await prisma.leakAlert.update({
    where: { id },
    data: { status, note, ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}), resolvedById: ['RESOLVED', 'FALSE_POSITIVE'].includes(status) ? ctx.userId : null },
  });
  await audit(ctx, { action: 'canary.alert_updated', resourceType: 'leak_alert', resourceId: id, summary: `Updated Canary alert: ${status.toLowerCase().replace('_', ' ')}${input.note ? ` — ${input.note}` : ''}`, before: { status: alert.status, assignedToId: alert.assignedToId }, after: { status, assignedToId: updated.assignedToId } });
  return updated;
}

export async function listSends(ctx: RequestContext) {
  return prisma.send.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 200, include: { set: { select: { name: true, version: true } }, _count: { select: { exposures: true } } } });
}

export async function canaryOverview(ctx: RequestContext) {
  const [registered, exposures, open, scans] = await Promise.all([
    prisma.canaryRegistry.count({ where: { orgId: ctx.orgId } }),
    prisma.exposure.count({ where: { orgId: ctx.orgId } }),
    prisma.leakAlert.count({ where: { orgId: ctx.orgId, status: 'OPEN' } }),
    prisma.canaryScan.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  return { registered, exposures, openAlerts: open, recentScans: scans, disclaimer: SCAN_DISCLAIMER };
}
