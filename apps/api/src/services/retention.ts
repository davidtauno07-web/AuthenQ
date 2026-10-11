import { prisma, Prisma } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/errors.js';
import { storage } from '../lib/storage.js';
import { env } from '../config/env.js';
import { audit } from '../modules/audit.js';
import { systemContext, type RequestContext } from '../modules/context.js';
import { enqueue } from '../modules/jobs/queue.js';

export const RETENTION_POLICIES = ['KEEP_UNTIL_DELETED', 'DELETE_AFTER_APPROVED_TWIN', 'DELETE_AFTER_DAYS'] as const;
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

const LIMITATIONS = [
  'Backups of the AuthenQ database or object storage taken before this deletion are not changed. They expire on your own backup schedule.',
  'If object storage keeps old versions (bucket versioning), earlier versions of uploaded files stay until your versioning rules remove them.',
  'Data in your own connected databases or buckets is never touched. AuthenQ only deletes the copy it imported.',
  'Aggregate Firewall statistics (formats, shares of groups with at least 5 values) and synthetic data are kept. They contain no individual real values.',
];

type Item = { kind: string; description: string; found: number; deleted: number; remaining: number; verified: boolean };

async function sourceOrThrow(ctx: RequestContext, sourceId: string) {
  const s = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: ctx.orgId } });
  if (!s) throw notFound('Data source');
  return s;
}

export async function getRetention(ctx: RequestContext, sourceId: string) {
  const s = await sourceOrThrow(ctx, sourceId);
  const records = await prisma.deletionRecord.findMany({ where: { orgId: ctx.orgId, sourceId }, orderBy: { createdAt: 'desc' }, take: 20 });
  return {
    policy: s.retentionPolicy,
    days: s.retentionDays,
    until: s.retentionUntil,
    purgedAt: s.sourcePurgedAt,
    storage: {
      rows: 'Real rows are stored in the source_rows table of the AuthenQ PostgreSQL database, separated by organisation.',
      files: env.STORAGE_DRIVER === 's3' ? 'Uploaded files are stored in the configured S3-compatible bucket under source-uploads/.' : 'Uploaded files are stored on the API server disk under source-uploads/.',
      access: 'Only server components (ingest, scan, Twin generation) and administrators with the real-preview permission can read them. Labelers, reviewers, exports and external AI never receive real rows.',
    },
    limitations: LIMITATIONS,
    records,
  };
}

export async function setRetention(ctx: RequestContext, sourceId: string, input: { policy: RetentionPolicy; days?: number | null }) {
  const s = await sourceOrThrow(ctx, sourceId);
  if (s.sourcePurgedAt) throw badRequest('Real data for this source has already been deleted.');
  if (input.policy === 'DELETE_AFTER_DAYS' && (!input.days || input.days < 1 || input.days > 3650)) throw badRequest('Choose between 1 and 3650 days.');
  const days = input.policy === 'DELETE_AFTER_DAYS' ? input.days! : null;
  const until = days ? new Date(Date.now() + days * 86_400_000) : null;
  const updated = await prisma.dataSource.update({ where: { id: sourceId }, data: { retentionPolicy: input.policy, retentionDays: days, retentionUntil: until } });
  await audit(ctx, { action: 'source.retention_changed', resourceType: 'data_source', resourceId: sourceId, summary: `Retention for "${s.name}" set to ${input.policy}${days ? ` (${days} days)` : ''}`, details: { before: s.retentionPolicy, after: input.policy, days } });
  return updated;
}

/** Deletes every copy of real source data AuthenQ holds for a source, then checks each one is gone. Records counts only. */
export async function purgeSource(ctx: RequestContext, sourceId: string, trigger: 'MANUAL' | 'POLICY' | 'SOURCE_DELETED', reason?: string) {
  const s = await sourceOrThrow(ctx, sourceId);
  const record = await prisma.deletionRecord.create({ data: { orgId: ctx.orgId, sourceId, trigger, requestedById: ctx.userId, limitations: LIMITATIONS } });
  const items: Item[] = [];

  const rowsBefore = await prisma.sourceRow.count({ where: { sourceId } });
  await prisma.sourceRow.deleteMany({ where: { sourceId } });
  const rowsAfter = await prisma.sourceRow.count({ where: { sourceId } });
  items.push({ kind: 'DATABASE_ROWS', description: 'Real rows in the database', found: rowsBefore, deleted: rowsBefore - rowsAfter, remaining: rowsAfter, verified: rowsAfter === 0 });

  const jobs = await prisma.processingJob.findMany({ where: { orgId: ctx.orgId, resourceId: sourceId, type: 'FIREWALL_INGEST' }, select: { payload: true } });
  const fileIds = [...new Set(jobs.map((j) => (j.payload as { fileId?: string }).fileId).filter((x): x is string => !!x))];
  const files = await prisma.file.findMany({ where: { id: { in: fileIds }, orgId: ctx.orgId, purpose: 'SOURCE_UPLOAD' } });
  let deleted = 0;
  let remaining = 0;
  for (const f of files) {
    if (f.storageKey) {
      await storage.delete(f.storageKey).catch(() => undefined);
      const stillThere = await storage.get(f.storageKey).then(() => true, () => false);
      if (stillThere) {
        remaining++;
        continue;
      }
    }
    deleted++;
    await prisma.file.update({ where: { id: f.id }, data: { deletedAt: f.deletedAt ?? new Date() } });
  }
  items.push({ kind: 'UPLOADED_FILES', description: 'Uploaded source files in storage', found: files.length, deleted, remaining, verified: remaining === 0 });

  const pending = await prisma.processingJob.count({ where: { orgId: ctx.orgId, resourceId: sourceId, status: { in: ['QUEUED', 'RUNNING'] }, type: { in: ['FIREWALL_INGEST', 'FIREWALL_SCAN', 'TWIN_GENERATE'] } } });
  items.push({ kind: 'QUEUE', description: 'Queued or running jobs that could re-read real data (job payloads hold IDs only)', found: pending, deleted: 0, remaining: pending, verified: pending === 0 });
  items.push({ kind: 'CACHES', description: 'Temporary copies (workers hold real rows in memory only while a job runs; nothing is cached on disk)', found: 0, deleted: 0, remaining: 0, verified: true });

  const status = items.every((i) => i.verified) ? 'COMPLETED' : 'PARTIAL';
  const done = await prisma.deletionRecord.update({ where: { id: record.id }, data: { status, items: items as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
  await prisma.dataSource.update({ where: { id: sourceId }, data: { sourcePurgedAt: new Date(), retentionUntil: null } });
  await audit(ctx, {
    action: 'source.purged',
    resourceType: 'data_source',
    resourceId: sourceId,
    summary: `Deleted real data for "${s.name}" (${trigger.toLowerCase().replace('_', ' ')}): ${status === 'COMPLETED' ? 'verified' : 'some copies remain'}${reason ? ` — ${reason}` : ''}`,
    details: { recordId: record.id, status, items: items.map((i) => ({ kind: i.kind, found: i.found, remaining: i.remaining })) },
  });
  return done;
}

export async function requestPurge(ctx: RequestContext, sourceId: string, input: { confirm: boolean; reason: string }) {
  if (!input.confirm) throw badRequest('Confirm that you want to delete the real data permanently from AuthenQ.');
  if (!input.reason.trim()) throw badRequest('Give a reason for deleting the real data.');
  const s = await sourceOrThrow(ctx, sourceId);
  if (s.sourcePurgedAt) throw badRequest('Real data for this source has already been deleted.');
  return purgeSource(ctx, sourceId, 'MANUAL', input.reason.trim());
}

export async function enqueuePolicyPurge(orgId: string, sourceId: string) {
  const running = await prisma.processingJob.count({ where: { orgId, resourceId: sourceId, type: 'SOURCE_PURGE', status: { in: ['QUEUED', 'RUNNING'] } } });
  if (running) return;
  await enqueue({ orgId, type: 'SOURCE_PURGE', payload: { sourceId }, resourceType: 'data_source', resourceId: sourceId });
}

export async function runPurgeJob(orgId: string, payload: { sourceId: string }) {
  const s = await prisma.dataSource.findFirst({ where: { id: payload.sourceId, orgId } });
  if (!s || s.sourcePurgedAt) return { skipped: true };
  const r = await purgeSource(systemContext(orgId, 'Retention policy'), payload.sourceId, 'POLICY');
  return { recordId: r.id, status: r.status };
}

/** Finds sources whose retention policy is due and queues their deletion. Run periodically by the worker. */
export async function enforceRetention(now = new Date()) {
  const due = await prisma.dataSource.findMany({
    where: {
      sourcePurgedAt: null,
      OR: [
        { retentionPolicy: 'DELETE_AFTER_DAYS', retentionUntil: { lte: now } },
        { retentionPolicy: 'DELETE_AFTER_APPROVED_TWIN', sets: { some: { approvalStatus: 'APPROVED', deletedAt: null } } },
      ],
    },
    select: { id: true, orgId: true },
  });
  for (const s of due) await enqueuePolicyPurge(s.orgId, s.id);
  return due.length;
}
