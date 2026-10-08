import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { prisma, Prisma } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, gateBlocked, notFound } from '../lib/errors.js';
import { storage, storageKey } from '../lib/storage.js';
import { CLASSIFIER_VERSION, classifyColumn, guessPrimaryKey, inferRelations, inferType } from '../domain/firewall.js';
import { audit } from '../modules/audit.js';
import type { RequestContext } from '../modules/context.js';
import { enqueue, type JobReporter } from '../modules/jobs/queue.js';
import { emit, notifyRole, recordUsage } from '../modules/platform/events.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
const MAX_COLUMNS = 500;
const SAMPLE_SIZE = 2000;
const ALLOWED_EXT = ['csv', 'tsv', 'xlsx', 'json', 'jsonl'];
const VALID_DECISIONS = ['REPLACE', 'GENERALIZE', 'KEEP', 'DROP', 'SCRUB_TEXT', 'KEY'] as const;
export type Decision = (typeof VALID_DECISIONS)[number];

export interface ParsedTable {
  name: string;
  rows: Record<string, unknown>[];
}

function cleanName(raw: string, fallback: string) {
  const n = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63);
  return n || fallback;
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (rows.length > MAX_ROWS) throw badRequest(`The file has ${rows.length.toLocaleString()} rows; the limit per table is ${MAX_ROWS.toLocaleString()}.`);
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const r of rows.slice(0, 1000)) {
    for (const k of Object.keys(r)) {
      if (keys.has(k)) continue;
      const base = cleanName(k, `column_${keys.size + 1}`);
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base.slice(0, 58)}_${n}`;
      used.add(name);
      keys.set(k, name);
    }
  }
  if (keys.size > MAX_COLUMNS) throw badRequest(`The file has ${keys.size} columns; the limit is ${MAX_COLUMNS}.`);
  if (!keys.size) throw badRequest('No columns were found in the file. Check that the first row contains column headers.');
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [orig, clean] of keys) {
      const v = r[orig];
      out[clean] = v === undefined || v === '' ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
    }
    return out;
  });
}

/** Parses an uploaded file into tables. Rejects unknown formats and binary content. */
export async function parseUpload(fileName: string, buffer: Buffer, tableName?: string): Promise<ParsedTable[]> {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXT.includes(ext)) throw badRequest(`".${ext}" files are not supported. Upload CSV, TSV, XLSX, JSON or JSONL.`);
  if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest('The file is larger than 50 MB. Use a connector for larger sources.');
  const base = cleanName(tableName ?? fileName.replace(/\.[^.]+$/, ''), 'table');
  if (ext === 'xlsx') {
    if (buffer.subarray(0, 2).toString('latin1') !== 'PK') throw badRequest('The file is not a valid XLSX workbook.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const tables: ParsedTable[] = [];
    wb.eachSheet((sheet) => {
      const header: string[] = [];
      const rows: Record<string, unknown>[] = [];
      sheet.eachRow((row, idx) => {
        const values = (row.values as unknown[]).slice(1).map((v) => (v && typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v instanceof Date ? v.toISOString() : v));
        if (idx === 1) values.forEach((v, i) => (header[i] = String(v ?? `column_${i + 1}`)));
        else rows.push(Object.fromEntries(header.map((h, i) => [h, values[i] ?? null])));
      });
      if (header.length) tables.push({ name: cleanName(sheet.name, base), rows: normalizeRows(rows) });
    });
    if (!tables.length) throw badRequest('The workbook has no sheets with a header row.');
    return tables;
  }
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) throw badRequest('The file appears to be binary. Upload a text-based CSV, TSV, JSON or JSONL file.');
  if (ext === 'csv' || ext === 'tsv') {
    let rows: Record<string, unknown>[];
    try {
      rows = parseCsv(text, { columns: true, skip_empty_lines: true, bom: true, delimiter: ext === 'tsv' ? '\t' : undefined, relax_column_count: true, trim: true });
    } catch (err) {
      throw badRequest(`The CSV could not be read: ${(err as Error).message}`);
    }
    return [{ name: base, rows: normalizeRows(rows) }];
  }
  let data: unknown;
  try {
    data = ext === 'jsonl' ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(text);
  } catch {
    throw badRequest('The JSON could not be parsed. Check the file for syntax errors.');
  }
  const isRows = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (isRows(data)) return [{ name: base, rows: normalizeRows(data) }];
  if (data && typeof data === 'object') {
    const tables = Object.entries(data as Record<string, unknown>).filter(([, v]) => isRows(v));
    if (tables.length) return tables.map(([k, v]) => ({ name: cleanName(k, base), rows: normalizeRows(v as Record<string, unknown>[]) }));
  }
  throw badRequest('The JSON must be an array of objects, or an object whose values are arrays of objects (one per table).');
}

export async function listSources(ctx: RequestContext) {
  return prisma.dataSource.findMany({
    where: { orgId: ctx.orgId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { tables: true, columns: true, sets: true } } },
  });
}

export async function getSourceOrThrow(ctx: RequestContext, id: string) {
  const s = await prisma.dataSource.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } });
  if (!s) throw notFound('Data source');
  return s;
}

export async function getSourceDetail(ctx: RequestContext, id: string) {
  await getSourceOrThrow(ctx, id);
  const source = await prisma.dataSource.findUniqueOrThrow({
    where: { id },
    include: {
      tables: { orderBy: { ordinal: 'asc' }, include: { columns: { orderBy: { ordinal: 'asc' } } } },
      relations: true,
      scans: { orderBy: { version: 'desc' }, take: 20 },
      sets: { where: { deletedAt: null }, orderBy: { version: 'desc' }, select: { id: true, name: true, version: true, status: true, rowCount: true, createdAt: true } },
    },
  });
  const decisions = await prisma.firewallDecision.findMany({
    where: { orgId: ctx.orgId, column: { sourceId: id } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { column: { select: { name: true, table: { select: { name: true } } } } },
  });
  return { ...source, gate: firewallGate(source), decisions };
}

export function firewallGate(source: {
  status: string;
  currentScanId: string | null;
  tables: { name: string; columns: { name: string; classification: string; decision: string | null; decisionSource: string | null; entityType?: string | null }[] }[];
}) {
  const reasons: string[] = [];
  if (!source.currentScanId) reasons.push('No Firewall scan has completed yet.');
  if (source.status === 'SCANNING' || source.status === 'INGESTING') reasons.push('A scan or upload is still running.');
  for (const t of source.tables) {
    for (const c of t.columns) {
      if (c.classification === 'UNSCANNED') reasons.push(`${t.name}.${c.name} has not been scanned.`);
      else if (c.classification === 'NEEDS_DECISION' && c.decisionSource !== 'HUMAN') reasons.push(`${t.name}.${c.name} needs a human decision.`);
      else if (c.classification === 'SENSITIVE' && c.decision === 'KEEP') reasons.push(`${t.name}.${c.name} is sensitive but set to Keep.`);
      else if (c.classification === 'SENSITIVE' && c.decision === 'SCRUB_TEXT' && c.entityType !== undefined && c.entityType !== 'FREE_TEXT') reasons.push(`${t.name}.${c.name} is not free text, so Scrub text cannot protect it. Choose Replace, Generalize or Drop.`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

export async function createSource(ctx: RequestContext, input: { name: string; description?: string; kind?: string }) {
  const source = await prisma.dataSource.create({
    data: { orgId: ctx.orgId, name: input.name, description: input.description ?? '', kind: input.kind ?? 'UPLOAD', createdById: ctx.userId },
  });
  await audit(ctx, { action: 'source.created', resourceType: 'data_source', resourceId: source.id, summary: `Created data source "${source.name}"` });
  return source;
}

export async function uploadToSource(ctx: RequestContext, sourceId: string, file: { originalname: string; buffer: Buffer; mimetype: string }, tableName?: string) {
  const source = await getSourceOrThrow(ctx, sourceId);
  const tables = await parseUpload(file.originalname, file.buffer, tableName);
  const record = await prisma.file.create({
    data: {
      orgId: ctx.orgId,
      name: file.originalname.slice(0, 200),
      contentType: file.mimetype || 'application/octet-stream',
      size: file.buffer.length,
      storageKey: '',
      checksum: sha256(file.buffer),
      purpose: 'SOURCE_UPLOAD',
      dataClass: 'REAL',
      createdById: ctx.userId,
    },
  });
  const key = storageKey(ctx.orgId, 'source-uploads', record.id, file.originalname.split('.').pop() ?? 'bin');
  await storage.put(key, file.buffer, record.contentType);
  await prisma.file.update({ where: { id: record.id }, data: { storageKey: key } });
  await prisma.dataSource.update({ where: { id: source.id }, data: { status: 'INGESTING', lastError: null } });
  const job = await enqueue({
    orgId: ctx.orgId,
    type: 'FIREWALL_INGEST',
    payload: { sourceId, fileId: record.id, tableName: tableName ?? null },
    resourceType: 'data_source',
    resourceId: sourceId,
    createdById: ctx.userId,
  });
  await audit(ctx, {
    action: 'source.uploaded',
    resourceType: 'data_source',
    resourceId: sourceId,
    summary: `Uploaded ${file.originalname} (${tables.map((t) => `${t.name}: ${t.rows.length} rows`).join(', ')})`,
    jobId: job.id,
  });
  await recordUsage(ctx.orgId, 'storage.bytes', file.buffer.length, 'file', record.id);
  return { job, preview: tables.map((t) => ({ name: t.name, rows: t.rows.length, columns: Object.keys(t.rows[0] ?? {}) })) };
}

/**
 * Writes parsed tables as real source rows. Replaces rows of tables with the same name.
 * Runs in one transaction so a failed import leaves the previous rows intact, and
 * locks the source row so a concurrent deletion cannot be undone by a late import.
 */
export async function ingestTables(orgId: string, sourceId: string, tables: ParsedTable[], reporter?: JobReporter) {
  const total = tables.reduce((a, t) => a + t.rows.length, 0);
  let done = 0;
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ deletedAt: Date | null }[]>`SELECT "deletedAt" FROM data_sources WHERE id = ${sourceId}::uuid AND "orgId" = ${orgId}::uuid FOR UPDATE`;
      if (!locked.length || locked[0]!.deletedAt) return { skipped: true as const };
      const existingCount = await tx.sourceTable.count({ where: { sourceId } });
      for (const [i, t] of tables.entries()) {
        const existing = await tx.sourceTable.findUnique({ where: { sourceId_name: { sourceId, name: t.name } } });
        if (existing) {
          await tx.sourceRow.deleteMany({ where: { tableId: existing.id } });
          await tx.sourceColumn.deleteMany({ where: { tableId: existing.id } });
        }
        const table = existing
          ? await tx.sourceTable.update({ where: { id: existing.id }, data: { rowCount: t.rows.length } })
          : await tx.sourceTable.create({ data: { orgId, sourceId, name: t.name, rowCount: t.rows.length, ordinal: existingCount + i } });
        const colNames = Object.keys(t.rows[0] ?? {});
        await tx.sourceColumn.createMany({
          data: colNames.map((name, ordinal) => ({ orgId, sourceId, tableId: table.id, name, ordinal })),
        });
        for (let start = 0; start < t.rows.length; start += 1000) {
          const chunk = t.rows.slice(start, start + 1000);
          await tx.sourceRow.createMany({
            data: chunk.map((data, k) => ({ orgId, sourceId, tableId: table.id, rowIndex: start + k, data: data as Prisma.InputJsonValue })),
          });
          done += chunk.length;
          await reporter?.progress(done, total);
        }
      }
      const rowCount = await tx.sourceTable.aggregate({ where: { sourceId }, _sum: { rowCount: true } });
      await tx.dataSource.update({ where: { id: sourceId }, data: { rowCount: rowCount._sum.rowCount ?? 0 } });
      return { skipped: false as const };
    },
    { timeout: 30 * 60_000, maxWait: 30_000 },
  );
}

export async function runIngestJob(
  orgId: string,
  payload: { sourceId: string; fileId?: string; tableName?: string | null; connectorId?: string; syncId?: string; tables?: string[] },
  reporter: JobReporter,
) {
  const target = await prisma.dataSource.findFirst({ where: { id: payload.sourceId, orgId }, select: { deletedAt: true } });
  if (!target || target.deletedAt) {
    await reporter.event('The data source was deleted before the import ran. Nothing was imported.');
    return { tables: [], scanId: null, skipped: true };
  }
  let tables: ParsedTable[];
  if (payload.connectorId) {
    const { readPostgresTables } = await import('./connectors.js');
    const { decryptSecret } = await import('../lib/crypto.js');
    const c = await prisma.connectorAccount.findFirstOrThrow({ where: { id: payload.connectorId, orgId } });
    try {
      tables = (await readPostgresTables(decryptSecret(c.credentialsEnc!), payload.tables ?? [])).map((t) => ({ name: t.name, rows: normalizeRows(t.rows) }));
      await prisma.connectorSync.update({ where: { id: payload.syncId! }, data: { status: 'COMPLETED', recordsRead: tables.reduce((a, t) => a + t.rows.length, 0), finishedAt: new Date() } });
      await prisma.connectorAccount.update({ where: { id: c.id }, data: { lastSyncAt: new Date() } });
    } catch (err) {
      await prisma.connectorSync.update({ where: { id: payload.syncId! }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 300), finishedAt: new Date() } });
      await prisma.dataSource.update({ where: { id: payload.sourceId }, data: { status: 'ERROR', lastError: 'Connector import failed.' } });
      throw err;
    }
  } else {
    const file = await prisma.file.findFirstOrThrow({ where: { id: payload.fileId!, orgId } });
    const buffer = await storage.get(file.storageKey);
    tables = await parseUpload(file.name, buffer, payload.tableName ?? undefined);
  }
  await reporter.event(`Parsed ${tables.length} table(s)`);
  const ingest = await ingestTables(orgId, payload.sourceId, tables, reporter);
  if (ingest.skipped) {
    await reporter.event('The data source was deleted during the import. Nothing was imported.');
    return { tables: [], scanId: null, skipped: true };
  }
  const scan = await queueScan(orgId, payload.sourceId, null);
  return { tables: tables.map((t) => ({ name: t.name, rows: t.rows.length })), scanId: scan.id };
}

async function queueScan(orgId: string, sourceId: string, userId: string | null) {
  const last = await prisma.firewallScan.findFirst({ where: { sourceId }, orderBy: { version: 'desc' } });
  const scan = await prisma.firewallScan.create({
    data: { orgId, sourceId, version: (last?.version ?? 0) + 1, classifierVersion: CLASSIFIER_VERSION, sampleSize: SAMPLE_SIZE, createdById: userId },
  });
  const job = await enqueue({ orgId, type: 'FIREWALL_SCAN', payload: { scanId: scan.id }, resourceType: 'data_source', resourceId: sourceId, createdById: userId });
  await prisma.firewallScan.update({ where: { id: scan.id }, data: { jobId: job.id } });
  await prisma.dataSource.update({ where: { id: sourceId }, data: { status: 'SCANNING' } });
  return scan;
}

export async function startScan(ctx: RequestContext, sourceId: string) {
  const source = await getSourceOrThrow(ctx, sourceId);
  if (source.status === 'INGESTING' || source.status === 'SCANNING') throw badRequest('A scan or upload is already running for this source.');
  const tables = await prisma.sourceTable.count({ where: { sourceId } });
  if (!tables) throw badRequest('Upload data or connect a source before scanning.');
  const scan = await queueScan(ctx.orgId, sourceId, ctx.userId);
  await audit(ctx, { action: 'firewall.scan_started', resourceType: 'data_source', resourceId: sourceId, summary: `Started Firewall scan v${scan.version}` });
  return scan;
}

async function sampleRows(tableId: string, rowCount: number) {
  const step = Math.max(1, Math.floor(rowCount / SAMPLE_SIZE));
  if (step === 1) return prisma.sourceRow.findMany({ where: { tableId }, orderBy: { rowIndex: 'asc' }, take: SAMPLE_SIZE });
  return prisma.$queryRaw<{ data: Record<string, unknown> }[]>`
    SELECT data FROM source_rows WHERE "tableId" = ${tableId}::uuid AND "rowIndex" % ${step} = 0 ORDER BY "rowIndex" LIMIT ${SAMPLE_SIZE}`;
}

/** Job handler: classifies every column and infers keys and relationships. Human decisions survive rescans. */
export async function runScanJob(orgId: string, payload: { scanId: string }, reporter: JobReporter) {
  const scan = await prisma.firewallScan.update({ where: { id: payload.scanId }, data: { status: 'RUNNING' } });
  const tables = await prisma.sourceTable.findMany({ where: { sourceId: scan.sourceId }, include: { columns: true }, orderBy: { ordinal: 'asc' } });
  const samples = new Map<string, Record<string, unknown>[]>();
  for (const t of tables) samples.set(t.id, (await sampleRows(t.id, t.rowCount)).map((r) => r.data as Record<string, unknown>));

  const keyInfo = await Promise.all(
    tables.map(async (t) => {
      const rows = samples.get(t.id)!;
      const columns: Record<string, string[]> = {};
      for (const c of t.columns) columns[c.name] = rows.map((r) => (r[c.name] == null ? '' : String(r[c.name])));
      const pk = guessPrimaryKey(t.name, columns);
      if (pk) {
        const all = await prisma.$queryRaw<{ v: string }[]>`SELECT data->>${pk} AS v FROM source_rows WHERE "tableId" = ${t.id}::uuid`;
        columns[pk] = all.map((r) => r.v);
      }
      return { name: t.name, primaryKey: pk, columns };
    }),
  );
  const relations = inferRelations(keyInfo);
  for (const r of relations) {
    await prisma.sourceRelation.upsert({
      where: { sourceId_fromTable_fromColumn_toTable_toColumn: { sourceId: scan.sourceId, fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn } },
      create: { orgId, sourceId: scan.sourceId, ...r },
      update: { confidence: r.confidence, explanation: r.explanation },
    });
  }

  const knownNames = new Set<string>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (/name$/i.test(c.name)) for (const r of samples.get(t.id)!) for (const w of String(r[c.name] ?? '').split(/\s+/)) if (w.length > 2) knownNames.add(w);
    }
  }

  const summary: Record<string, number> = { SENSITIVE: 0, NEEDS_DECISION: 0, NON_SENSITIVE: 0, OUTCOME: 0, IDENTIFIER: 0 };
  let done = 0;
  const totalCols = tables.reduce((a, t) => a + t.columns.length, 0);
  for (const [ti, t] of tables.entries()) {
    const info = keyInfo[ti]!;
    await prisma.sourceTable.update({ where: { id: t.id }, data: { primaryKey: info.primaryKey } });
    const rows = samples.get(t.id)!;
    for (const c of t.columns) {
      const isFk = relations.some((r) => r.fromTable === t.name && r.fromColumn === c.name);
      const f = classifyColumn(
        { table: t.name, name: c.name, values: rows.map((r) => r[c.name]), totalRows: t.rowCount, isPrimaryKey: info.primaryKey === c.name, isForeignKey: isFk },
        knownNames,
      );
      summary[f.classification] = (summary[f.classification] ?? 0) + 1;
      await prisma.firewallFinding.create({
        data: { scanId: scan.id, columnId: c.id, classification: f.classification, entityType: f.entityType, suggestedAction: f.suggestedAction, explanation: f.explanation, confidence: f.confidence, stats: { ...f.stats, textEntities: f.textEntities ?? null } as Prisma.InputJsonValue },
      });
      const human = c.decisionSource === 'HUMAN';
      await prisma.sourceColumn.update({
        where: { id: c.id },
        data: {
          classification: f.classification,
          entityType: f.entityType,
          explanation: f.explanation,
          confidence: f.confidence,
          dataType: f.dataType,
          format: f.format,
          isPrimaryKey: info.primaryKey === c.name,
          isForeignKey: isFk,
          ...(human ? {} : { decision: f.suggestedAction, decisionSource: 'SYSTEM' }),
        },
      });
      done++;
    }
    await reporter.progress(done, totalCols, undefined, `Scanned ${t.name}`);
  }
  await prisma.firewallScan.update({ where: { id: scan.id }, data: { status: 'COMPLETED', completedAt: new Date(), summary: { ...summary, relations: relations.length } } });
  await prisma.dataSource.update({ where: { id: scan.sourceId }, data: { status: 'NEEDS_REVIEW', currentScanId: scan.id, signedOffScanId: null, signedOffAt: null } });
  await emit(orgId, 'source.scanned', { sourceId: scan.sourceId, scanId: scan.id, version: scan.version, summary });
  await notifyRole(orgId, ['ADMIN', 'DATA_ENGINEER'], 'firewall.scan', 'Firewall scan complete', `Scan v${scan.version} found ${summary.SENSITIVE} sensitive and ${summary.NEEDS_DECISION} undecided columns.`, `/sources/${scan.sourceId}`);
  return { summary, relations: relations.length };
}

export async function decideColumn(ctx: RequestContext, columnId: string, input: { decision: Decision; reason?: string; generalization?: Record<string, unknown> }) {
  const col = await prisma.sourceColumn.findFirst({ where: { id: columnId, orgId: ctx.orgId }, include: { table: true, source: true } });
  if (!col || col.source.deletedAt) throw notFound('Column');
  if (!VALID_DECISIONS.includes(input.decision)) throw badRequest('Unknown decision.');
  if (col.classification === 'SENSITIVE' && input.decision === 'KEEP') {
    throw badRequest(`${col.table.name}.${col.name} is classified as sensitive. Choose Replace, Generalize, Scrub text or Drop — sensitive values cannot be kept.`);
  }
  if (input.decision === 'KEY' && !col.isPrimaryKey && !col.isForeignKey) throw badRequest('Only primary or foreign key columns can use the Key action.');
  if (input.decision === 'SCRUB_TEXT' && col.entityType !== 'FREE_TEXT') {
    throw badRequest(`${col.table.name}.${col.name} is not a free-text column. Scrub text only rebuilds free text; choose Replace, Generalize or Drop.`);
  }
  if (col.classification === 'NEEDS_DECISION' && input.decision === 'KEEP' && !input.reason?.trim()) {
    throw badRequest(`${col.table.name}.${col.name} may be identifying. Give a short reason for keeping its real values.`);
  }
  if (col.decisionSource === 'SYSTEM' && col.decision !== input.decision && !input.reason?.trim()) {
    throw badRequest('Give a short reason when overriding the Firewall suggestion.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.sourceColumn.update({
      where: { id: col.id },
      data: {
        decision: input.decision,
        decisionSource: 'HUMAN',
        decidedById: ctx.userId,
        decidedAt: new Date(),
        generalization: input.generalization ? (input.generalization as Prisma.InputJsonValue) : undefined,
      },
    });
    await tx.firewallDecision.create({
      data: { orgId: ctx.orgId, columnId: col.id, scanId: col.source.currentScanId, previous: col.decision, decision: input.decision, source: 'HUMAN', reason: input.reason, userId: ctx.userId },
    });
    if (col.source.signedOffScanId) await tx.dataSource.update({ where: { id: col.sourceId }, data: { status: 'NEEDS_REVIEW', signedOffScanId: null, signedOffAt: null } });
    await audit(ctx, {
      action: 'firewall.decision',
      resourceType: 'source_column',
      resourceId: col.id,
      summary: `Set ${col.table.name}.${col.name} to ${input.decision}${input.reason ? ` — ${input.reason}` : ''}`,
      before: { decision: col.decision, source: col.decisionSource },
      after: { decision: input.decision, source: 'HUMAN' },
    }, tx);
    return u;
  });
  return updated;
}

export async function confirmRelation(ctx: RequestContext, relationId: string, confirmed: boolean) {
  const rel = await prisma.sourceRelation.findFirst({ where: { id: relationId, orgId: ctx.orgId } });
  if (!rel) throw notFound('Relationship');
  const updated = await prisma.sourceRelation.update({ where: { id: rel.id }, data: { confirmed } });
  await audit(ctx, { action: confirmed ? 'firewall.relation_confirmed' : 'firewall.relation_rejected', resourceType: 'source_relation', resourceId: rel.id, summary: `${confirmed ? 'Confirmed' : 'Rejected'} ${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}` });
  return updated;
}

export async function signOff(ctx: RequestContext, sourceId: string) {
  await getSourceOrThrow(ctx, sourceId);
  const source = await prisma.dataSource.findUniqueOrThrow({ where: { id: sourceId }, include: { tables: { include: { columns: true } } } });
  const gate = firewallGate(source);
  if (!gate.ready) throw gateBlocked('Firewall sign-off', gate.reasons.slice(0, 20), [{ label: 'Review columns', href: `/sources/${sourceId}` }]);
  const updated = await prisma.dataSource.update({
    where: { id: sourceId },
    data: { status: 'SIGNED_OFF', signedOffScanId: source.currentScanId, signedOffAt: new Date(), signedOffById: ctx.userId },
  });
  await audit(ctx, { action: 'firewall.signed_off', resourceType: 'data_source', resourceId: sourceId, summary: `Signed off Firewall decisions for "${source.name}"`, details: { scanId: source.currentScanId } });
  return updated;
}

/** Real-value preview inside the Firewall boundary. Requires a dedicated permission and is always audited. */
export async function previewRealRows(ctx: RequestContext, sourceId: string, tableId: string, limit = 20) {
  await getSourceOrThrow(ctx, sourceId);
  const table = await prisma.sourceTable.findFirst({ where: { id: tableId, sourceId, orgId: ctx.orgId } });
  if (!table) throw notFound('Table');
  const rows = await prisma.sourceRow.findMany({ where: { tableId }, orderBy: { rowIndex: 'asc' }, take: Math.min(limit, 50) });
  await audit(ctx, { action: 'firewall.real_preview', resourceType: 'source_table', resourceId: tableId, summary: `Viewed ${rows.length} real rows of ${table.name} inside the Firewall` });
  return rows.map((r) => r.data);
}

export async function deleteSource(ctx: RequestContext, sourceId: string) {
  const s = await getSourceOrThrow(ctx, sourceId);
  await prisma.$transaction(async (tx) => {
    await tx.sourceRow.deleteMany({ where: { sourceId } });
    await tx.dataSource.update({ where: { id: sourceId }, data: { deletedAt: new Date(), status: 'DRAFT' } });
    await audit(ctx, { action: 'source.deleted', resourceType: 'data_source', resourceId: sourceId, summary: `Deleted data source "${s.name}" and its real rows` }, tx);
  });
}

export { inferType };
