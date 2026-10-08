import { readZip } from '../lib/zip.js';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { contextAround, extractCandidates, normalize, SCAN_DISCLAIMER, signature } from '../domain/canary.js';
import { audit } from '../modules/audit.js';
import type { RequestContext } from '../modules/context.js';
import { emit, notifyRole } from '../modules/platform/events.js';
import { storage } from '../lib/storage.js';

const MAX_SCAN_CHARS = 20_000_000;

export async function searchRegistry(ctx: RequestContext, q: string, limit = 50) {
  const term = q.trim();
  if (!term) {
    return prisma.canaryRegistry.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: limit, include: { _count: { select: { exposures: true, alerts: true } } } });
  }
  const variants = [...new Set(['GENERIC', 'PHONE', 'EMAIL'].map((t) => normalize(term, t)))];
  return prisma.canaryRegistry.findMany({
    where: { orgId: ctx.orgId, OR: [{ normalized: { in: variants } }, { normalized: { startsWith: variants[0]! } }, { signature: term }] },
    take: limit,
    include: { _count: { select: { exposures: true, alerts: true } } },
  });
}

export async function traceValue(ctx: RequestContext, registryId: string) {
  const entry = await prisma.canaryRegistry.findFirst({
    where: { id: registryId, orgId: ctx.orgId },
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
  const matches: Awaited<ReturnType<typeof prisma.canaryRegistry.findMany>> = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    matches.push(...(await prisma.canaryRegistry.findMany({ where: { orgId: ctx.orgId, normalized: { in: chunk } } })));
  }
  const unique = new Map(matches.map((m) => [m.id, m]));
  const scan = await prisma.canaryScan.create({
    data: { orgId: ctx.orgId, inputType: input.inputType, inputName: input.inputName.slice(0, 200), charCount: input.text.length, matchCount: unique.size, candidates: keys.length, createdById: ctx.userId },
  });
  const results = [];
  for (const m of unique.values()) {
    if (signature(env.CANARY_SECRET, m.entityType, m.normalized) !== m.signature) continue;
    const hit = candidates.get(m.normalized)!;
    const context = contextAround(input.text, hit.index, hit.raw.length);
    await prisma.leakAlert.create({ data: { orgId: ctx.orgId, scanId: scan.id, registryId: m.id, matchedText: hit.raw.slice(0, 200), context: context.slice(0, 500) } });
    const exposures = await prisma.exposure.findMany({ where: { registryId: m.id }, include: { send: true } });
    results.push({
      registryId: m.id,
      value: m.value,
      entityType: m.entityType,
      matchedText: hit.raw,
      context,
      origin: { setId: m.setId, table: m.tableName, column: m.columnName },
      exposures: exposures.map((e) => ({ recipient: e.send.recipient, channel: e.send.channel, at: e.createdAt })),
    });
  }
  await audit(ctx, { action: 'canary.scan', resourceType: 'canary_scan', resourceId: scan.id, summary: `Scanned "${scan.inputName}" (${input.text.length} chars): ${results.length} match(es)` });
  if (results.length) {
    await emit(ctx.orgId, 'canary.leak_alert', { scanId: scan.id, matches: results.length, inputName: scan.inputName });
    await notifyRole(ctx.orgId, ['ADMIN', 'DATA_ENGINEER'], 'canary.alert', 'Canary match found', `${results.length} registered synthetic value(s) found in "${scan.inputName}".`, `/canary?scan=${scan.id}`);
  }
  return { scanId: scan.id, candidates: keys.length, matches: results, disclaimer: SCAN_DISCLAIMER };
}

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

export async function listAlerts(ctx: RequestContext, status?: string) {
  return prisma.leakAlert.findMany({
    where: { orgId: ctx.orgId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { registry: { select: { value: true, entityType: true, tableName: true, columnName: true, setId: true } }, scan: { select: { inputName: true, inputType: true } } },
  });
}

export async function updateAlert(ctx: RequestContext, id: string, status: 'ACKNOWLEDGED' | 'RESOLVED' | 'OPEN', note?: string) {
  const alert = await prisma.leakAlert.findFirst({ where: { id, orgId: ctx.orgId } });
  if (!alert) throw notFound('Alert');
  const updated = await prisma.leakAlert.update({ where: { id }, data: { status, note, resolvedById: status === 'RESOLVED' ? ctx.userId : null } });
  await audit(ctx, { action: 'canary.alert_updated', resourceType: 'leak_alert', resourceId: id, summary: `Marked Canary alert as ${status.toLowerCase()}${note ? ` — ${note}` : ''}`, before: { status: alert.status }, after: { status } });
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
