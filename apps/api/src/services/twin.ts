import { env } from '../config/env.js';
import { prisma, Prisma } from '../lib/prisma.js';
import { badRequest, forbidden, gateBlocked, notFound } from '../lib/errors.js';
import { normalize, signature, fuzzyKey } from '../domain/canary.js';
import { generateTwin, TWIN_ALGORITHM_VERSION, type TwinTable } from '../domain/twin.js';
import { learnPattern } from '../domain/patterns.js';
import { enqueuePolicyPurge } from './retention.js';
import { audit } from '../modules/audit.js';
import { can, type RequestContext } from '../modules/context.js';
import { enqueue, type JobReporter } from '../modules/jobs/queue.js';
import { emit, notifyRole, recordUsage } from '../modules/platform/events.js';

const MAX_ROWS_PER_TABLE = 250_000;

export interface TwinRequest {
  name?: string;
  seed?: number;
  multiplier?: number;
  amplify?: { table: string; column: string; value: string; factor: number }[];
  strategies?: Record<string, 'PATTERN' | 'GENERIC'>;
  acknowledgeReview?: boolean;
}

const PLAN_SAMPLE = 5000;
const TREATMENT: Record<string, string> = {
  KEEP: 'Values follow the real distribution (categories by frequency, numbers jittered within range, dates shifted up to 7 days).',
  GENERALIZE: 'Values coarsened (postcodes to prefix, dates to year, numbers to ranges).',
  DROP: 'Removed from the synthetic copy.',
  KEY: 'New synthetic keys; relationships preserved.',
  SCRUB_TEXT: 'Rebuilt from sentence pools; every detected entity and every known real value replaced.',
};

/** Pre-generation plan: what Twin will learn, preserve and replace per column. Returns aggregates only. */
export async function twinPlan(ctx: RequestContext, sourceId: string) {
  const source = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: ctx.orgId, deletedAt: null } });
  if (!source) throw notFound('Data source');
  const tables = await prisma.sourceTable.findMany({ where: { sourceId }, include: { columns: { orderBy: { ordinal: 'asc' } } }, orderBy: { ordinal: 'asc' } });
  const items = [];
  for (const t of tables) {
    const needs = t.columns.some((c) => c.decision === 'REPLACE' && !c.isPrimaryKey);
    const rows = needs ? (await prisma.sourceRow.findMany({ where: { tableId: t.id }, orderBy: { rowIndex: 'asc' }, take: PLAN_SAMPLE, select: { data: true } })).map((r) => r.data as Record<string, unknown>) : [];
    for (const c of t.columns) {
      const decision = c.decision ?? 'KEEP';
      if (decision === 'REPLACE' && !c.isPrimaryKey) {
        const pattern = learnPattern(t.name, c, rows.map((r) => r[c.name]));
        const review = pattern.confidence < 0.6;
        items.push({ table: t.name, column: c.name, classification: c.classification, entityType: c.entityType, decision, strategy: 'PATTERN', treatment: `Replaced with synthetic values that keep: ${pattern.preserves.join(', ')}.`, pattern, review, reviewReason: review ? 'The learned pattern is weak, so generated values may not look like the source. Choose Generic or accept the limitation.' : null });
      } else {
        items.push({ table: t.name, column: c.name, classification: c.classification, entityType: c.entityType, decision, strategy: null, treatment: TREATMENT[decision] ?? TREATMENT.KEEP!, pattern: null, review: false, reviewReason: null });
      }
    }
  }
  return { sourceId, sampledRowsPerTable: PLAN_SAMPLE, items, needsAcknowledgement: items.some((i) => i.review) };
}

export async function createSyntheticSet(ctx: RequestContext, sourceId: string, input: TwinRequest) {
  const source = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: ctx.orgId, deletedAt: null } });
  if (!source) throw notFound('Data source');
  if (source.status !== 'SIGNED_OFF' || !source.signedOffScanId || source.signedOffScanId !== source.currentScanId) {
    throw gateBlocked('Twin generation', ['The Firewall decisions for this source must be signed off on the latest scan before synthetic data can be generated.'], [{ label: 'Open Firewall review', href: `/sources/${sourceId}` }]);
  }
  const multiplier = input.multiplier ?? 1;
  if (multiplier <= 0 || multiplier > 10) throw badRequest('The multiplier must be between 0.1 and 10.');
  const total = source.rowCount * multiplier;
  if (total > 2_000_000) throw badRequest('The requested synthetic set would exceed 2,000,000 rows. Lower the multiplier.');
  if (source.sourcePurgedAt) throw gateBlocked('Twin generation', ['The real data for this source was deleted under its retention policy, so no new synthetic sets can be generated. Upload the data again as a new source.'], []);
  const plan = await twinPlan(ctx, sourceId);
  const strategies = input.strategies ?? {};
  const validKeys = new Set(plan.items.filter((i) => i.strategy).map((i) => `${i.table}.${i.column}`));
  for (const k of Object.keys(strategies)) if (!validKeys.has(k)) throw badRequest(`${k} is not a replaced column, so it has no generation strategy.`);
  const flagged = plan.items.filter((i) => i.review && (strategies[`${i.table}.${i.column}`] ?? 'PATTERN') === 'PATTERN');
  if (flagged.length && !input.acknowledgeReview) {
    throw gateBlocked('Twin generation', flagged.map((i) => `${i.table}.${i.column}: ${i.reviewReason}`), [{ label: 'Review generation plan', href: `/sources/${sourceId}` }]);
  }
  const last = await prisma.syntheticSet.findFirst({ where: { sourceId }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
  const set = await prisma.syntheticSet.create({
    data: {
      orgId: ctx.orgId,
      sourceId,
      name: input.name?.trim() || `${source.name} — synthetic v${version}`,
      version,
      seed,
      multiplier,
      algorithmVersion: TWIN_ALGORITHM_VERSION,
      firewallScanId: source.signedOffScanId,
      config: { amplify: input.amplify ?? [], strategies, acknowledgedReview: flagged.map((i) => `${i.table}.${i.column}`) } as Prisma.InputJsonValue,
      createdById: ctx.userId,
    },
  });
  const job = await enqueue({ orgId: ctx.orgId, type: 'TWIN_GENERATE', payload: { setId: set.id }, resourceType: 'synthetic_set', resourceId: set.id, createdById: ctx.userId });
  await prisma.syntheticSet.update({ where: { id: set.id }, data: { jobId: job.id } });
  await audit(ctx, { action: 'twin.generation_started', resourceType: 'synthetic_set', resourceId: set.id, summary: `Started synthetic set "${set.name}" (seed ${seed}, ×${multiplier})`, jobId: job.id, details: { strategies, acknowledgedReview: flagged.length } });
  return { ...set, jobId: job.id };
}

export async function runTwinJob(orgId: string, payload: { setId: string }, reporter: JobReporter) {
  const set = await prisma.syntheticSet.update({ where: { id: payload.setId }, data: { status: 'GENERATING' } });
  // Resume safety: clear any partial output from an interrupted attempt.
  await prisma.canaryRegistry.deleteMany({ where: { setId: set.id } });
  await prisma.syntheticRow.deleteMany({ where: { setId: set.id } });
  const tables = await prisma.sourceTable.findMany({ where: { sourceId: set.sourceId }, include: { columns: { orderBy: { ordinal: 'asc' } } }, orderBy: { ordinal: 'asc' } });
  const relations = await prisma.sourceRelation.findMany({ where: { sourceId: set.sourceId } });
  const twinTables: TwinTable[] = [];
  for (const t of tables) {
    if (t.rowCount > MAX_ROWS_PER_TABLE) throw Object.assign(new Error(`${t.name} has more than ${MAX_ROWS_PER_TABLE} rows; split the source before generating.`), { permanent: true });
    const rows = await prisma.sourceRow.findMany({ where: { tableId: t.id }, orderBy: { rowIndex: 'asc' }, select: { data: true } });
    twinTables.push({
      name: t.name,
      primaryKey: t.primaryKey,
      rows: rows.map((r) => r.data as Record<string, unknown>),
      columns: t.columns.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        format: c.format,
        classification: c.classification,
        entityType: c.entityType,
        decision: c.decision ?? 'KEEP',
        generalization: c.generalization as { mode?: string; bucket?: number } | null,
        isPrimaryKey: c.isPrimaryKey,
      })),
    });
  }
  await reporter.event(`Loaded ${twinTables.reduce((a, t) => a + t.rows.length, 0)} source rows inside the Twin boundary`);
  const cfg = set.config as { amplify?: TwinRequest['amplify']; strategies?: TwinRequest['strategies'] };
  const out = generateTwin(twinTables, relations.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn })), {
    seed: set.seed,
    multiplier: set.multiplier,
    amplify: cfg.amplify ?? [],
    strategies: cfg.strategies ?? {},
  });
  const total = Object.values(out.tables).reduce((a, t) => a + t.rows.length, 0);
  let written = 0;
  for (const [tableName, t] of Object.entries(out.tables)) {
    for (let start = 0; start < t.rows.length; start += 1000) {
      const chunk = t.rows.slice(start, start + 1000);
      await prisma.syntheticRow.createMany({
        data: chunk.map((data, k) => ({
          orgId,
          setId: set.id,
          tableName,
          rowIndex: start + k,
          syntheticKey: t.keyColumn ? String(data[t.keyColumn]) : `${tableName}-${start + k}`,
          data: data as Prisma.InputJsonValue,
        })),
      });
      written += chunk.length;
      await reporter.progress(written, total + out.canaries.length);
    }
  }
  await prisma.syntheticSet.update({ where: { id: set.id }, data: { status: 'CHECKING' } });
  const ids = await prisma.syntheticRow.findMany({ where: { setId: set.id }, select: { id: true, tableName: true, rowIndex: true } });
  const idOf = new Map(ids.map((r) => [`${r.tableName}:${r.rowIndex}`, r.id]));
  for (let start = 0; start < out.canaries.length; start += 2000) {
    const chunk = out.canaries.slice(start, start + 2000);
    await prisma.canaryRegistry.createMany({
      data: chunk.map((c) => {
        const norm = normalize(c.value, c.entityType);
        return {
          orgId,
          setId: set.id,
          syntheticRowId: idOf.get(`${c.tableName}:${c.rowIndex}`)!,
          tableName: c.tableName,
          columnName: c.columnName,
          value: c.value,
          normalized: norm,
          signature: signature(env.CANARY_SECRET, c.entityType, norm),
          entityType: c.entityType,
          fuzzyKey: fuzzyKey(norm, c.entityType),
          generationMeta: { ...c.meta, seed: set.seed, setVersion: set.version, rowIndex: c.rowIndex } as Prisma.InputJsonValue,
        };
      }),
    });
    await reporter.progress(written + start + chunk.length, total + out.canaries.length);
  }
  const status = out.report.safety.passed ? 'READY' : 'SAFETY_HOLD';
  await prisma.syntheticSet.update({
    where: { id: set.id },
    data: { status, safetyPassed: out.report.safety.passed, qualityReport: out.report as unknown as Prisma.InputJsonValue, rowCount: total, canaryCount: out.canaries.length, completedAt: new Date() },
  });
  await recordUsage(orgId, 'synthetic.rows', total, 'synthetic_set', set.id);
  await emit(orgId, 'synthetic_set.completed', { setId: set.id, status, rows: total });
  await notifyRole(orgId, ['ADMIN', 'DATA_ENGINEER', 'PROJECT_MANAGER'], 'twin.ready', status === 'READY' ? 'Synthetic set ready' : 'Synthetic set held for safety review', `${set.name}: ${total} rows, ${out.canaries.length} Canary values registered.`, `/synthetic/${set.id}`);
  return { rows: total, canaries: out.canaries.length, status };
}

export async function getSetOrThrow(ctx: RequestContext, id: string) {
  const set = await prisma.syntheticSet.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null }, include: { source: { select: { id: true, name: true } } } });
  if (!set) throw notFound('Synthetic set');
  return set;
}

export async function listSets(ctx: RequestContext) {
  return prisma.syntheticSet.findMany({
    where: { orgId: ctx.orgId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { source: { select: { id: true, name: true } }, _count: { select: { sends: true } } },
  });
}

export async function getSetDetail(ctx: RequestContext, id: string) {
  const set = await getSetOrThrow(ctx, id);
  const tables = await prisma.syntheticRow.groupBy({ by: ['tableName'], where: { setId: id }, _count: { _all: true } });
  const sends = await prisma.send.findMany({ where: { setId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
  return { ...set, tables: tables.map((t) => ({ name: t.tableName, rows: t._count._all })), sends };
}

export async function listSyntheticRows(ctx: RequestContext, setId: string, tableName: string, limit: number, offset: number, q?: string) {
  const set = await getSetOrThrow(ctx, setId);
  if (set.approvalStatus !== 'APPROVED' && !can(ctx, 'firewall.signoff')) throw forbidden('This synthetic set has not been approved yet. Only reviewers who can approve sets can view its rows.');
  const where: Prisma.SyntheticRowWhereInput = { setId, tableName, ...(q ? { syntheticKey: { contains: q, mode: 'insensitive' } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.syntheticRow.findMany({ where, orderBy: { rowIndex: 'asc' }, take: limit, skip: offset }),
    prisma.syntheticRow.count({ where }),
  ]);
  return { rows: rows.map((r) => ({ id: r.id, key: r.syntheticKey, rowIndex: r.rowIndex, data: r.data })), total };
}

export async function releaseSafetyHold(ctx: RequestContext, setId: string, reason: string) {
  const set = await getSetOrThrow(ctx, setId);
  if (set.status !== 'SAFETY_HOLD') throw badRequest('This set is not on safety hold.');
  if (reason.trim().length < 10) throw badRequest('Explain why the safety findings are acceptable (at least 10 characters).');
  await prisma.syntheticSet.update({ where: { id: setId }, data: { status: 'READY' } });
  await audit(ctx, { action: 'twin.safety_override', resourceType: 'synthetic_set', resourceId: setId, summary: `Released safety hold: ${reason}` });
}

/** Post-generation human approval. Only approved sets can be sent to labeling or exported. */
export async function reviewSet(ctx: RequestContext, setId: string, input: { approve: boolean; reason?: string }) {
  const set = await getSetOrThrow(ctx, setId);
  if (set.status !== 'READY') throw badRequest(`Only ready sets can be reviewed (this one is ${set.status.toLowerCase().replace('_', ' ')}).`);
  if (set.approvalStatus !== 'PENDING') throw badRequest(`This set was already ${set.approvalStatus.toLowerCase()}.`);
  const reason = input.reason?.trim();
  const report = set.qualityReport as { metrics?: { label: string; withinThreshold: boolean }[] } | null;
  const failing = (report?.metrics ?? []).filter((m) => !m.withinThreshold).map((m) => m.label);
  if (!input.approve && !reason) throw badRequest('Give a reason for rejecting the set.');
  if (input.approve && failing.length && !reason) throw badRequest(`These checks are outside their thresholds: ${failing.join(', ')}. Give a reason for approving anyway.`);
  const status = input.approve ? 'APPROVED' : 'REJECTED';
  const src = await prisma.dataSource.findFirst({ where: { id: set.sourceId, orgId: ctx.orgId }, select: { retentionPolicy: true, sourcePurgedAt: true } });
  const updated = await prisma.syntheticSet.update({ where: { id: setId }, data: { approvalStatus: status, approvalReason: reason ?? null, approvedById: ctx.userId, approvedAt: new Date() } });
  await audit(ctx, { action: input.approve ? 'twin.approved' : 'twin.rejected', resourceType: 'synthetic_set', resourceId: setId, summary: `${input.approve ? 'Approved' : 'Rejected'} synthetic set "${set.name}"${reason ? ` — ${reason}` : ''}`, details: { failingChecks: failing } });
  if (input.approve && src?.retentionPolicy === 'DELETE_AFTER_APPROVED_TWIN' && !src.sourcePurgedAt) await enqueuePolicyPurge(ctx.orgId, set.sourceId);
  return updated;
}

/** Admin-only comparison of real and synthetic rows. Rows are deliberately not paired. Always audited. */
export async function compareSet(ctx: RequestContext, setId: string, tableName: string, limit: number) {
  const set = await getSetOrThrow(ctx, setId);
  const src = await prisma.dataSource.findFirst({ where: { id: set.sourceId, orgId: ctx.orgId }, select: { sourcePurgedAt: true } });
  if (src?.sourcePurgedAt) throw badRequest('The real data for this source has been deleted, so there is nothing to compare with.');
  const table = await prisma.sourceTable.findFirst({ where: { sourceId: set.sourceId, name: tableName } });
  if (!table) throw notFound('Table');
  const take = Math.min(Math.max(limit, 1), 20);
  const [real, synthetic] = await Promise.all([
    prisma.sourceRow.findMany({ where: { tableId: table.id }, orderBy: { rowIndex: 'asc' }, take, select: { data: true } }),
    prisma.syntheticRow.findMany({ where: { setId, tableName }, orderBy: { rowIndex: 'desc' }, take, select: { data: true, syntheticKey: true } }),
  ]);
  await audit(ctx, { action: 'twin.compared', resourceType: 'synthetic_set', resourceId: setId, summary: `Viewed ${real.length} real and ${synthetic.length} synthetic ${tableName} rows side by side` });
  return { boundary: 'FIREWALL', paired: false, real: real.map((r) => r.data), synthetic: synthetic.map((r) => r.data) };
}

export async function deleteSet(ctx: RequestContext, setId: string) {
  const set = await getSetOrThrow(ctx, setId);
  const projects = await prisma.labelProject.count({ where: { setId, deletedAt: null } });
  if (projects) throw badRequest(`This set is used by ${projects} labeling project(s). Archive or delete them first.`);
  await prisma.syntheticSet.update({ where: { id: setId }, data: { deletedAt: new Date() } });
  await audit(ctx, { action: 'twin.deleted', resourceType: 'synthetic_set', resourceId: setId, summary: `Deleted synthetic set "${set.name}"` });
}
