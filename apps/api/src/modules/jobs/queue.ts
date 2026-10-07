import { prisma, Prisma } from '../../lib/prisma.js';
import type { Db } from '../../lib/prisma.js';
import { notFound, badRequest } from '../../lib/errors.js';

/**
 * Durable job queue on PostgreSQL. Workers claim jobs with
 * `FOR UPDATE SKIP LOCKED`, so multiple worker processes can run safely.
 * Jobs carry checkpoints so they resume after interruption, and support
 * cancel/pause requests and bounded retries with backoff.
 */
export type JobType =
  | 'FIREWALL_INGEST'
  | 'FIREWALL_SCAN'
  | 'TWIN_GENERATE'
  | 'SEND_TO_LABELING'
  | 'ENGINE_RUN'
  | 'EXPORT_BUILD'
  | 'CANARY_SCAN'
  | 'WEBHOOK_DELIVER';

export interface EnqueueInput {
  orgId: string;
  type: JobType;
  payload: Record<string, unknown>;
  resourceType?: string;
  resourceId?: string;
  createdById?: string | null;
  maxAttempts?: number;
}

export async function enqueue(input: EnqueueInput, db: Db = prisma) {
  const job = await db.processingJob.create({
    data: {
      orgId: input.orgId,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      createdById: input.createdById ?? null,
      maxAttempts: input.maxAttempts ?? 3,
    },
  });
  await db.jobEvent.create({ data: { jobId: job.id, message: 'Queued' } });
  return job;
}

export async function claimNext(workerId: string, types?: string[]) {
  const staleCutoff = new Date(Date.now() - 5 * 60_000);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE processing_jobs SET status = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${workerId},
      "heartbeatAt" = now(), attempts = attempts + 1, "startedAt" = COALESCE("startedAt", now())
    WHERE id = (
      SELECT id FROM processing_jobs
      WHERE ((status = 'QUEUED' AND "runAfter" <= now())
          OR (status = 'RUNNING' AND "heartbeatAt" < ${staleCutoff}))
        ${types?.length ? Prisma.sql`AND type IN (${Prisma.join(types)})` : Prisma.empty}
      ORDER BY "runAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  if (!rows[0]) return null;
  return prisma.processingJob.findUnique({ where: { id: rows[0].id } });
}

export class JobInterrupted extends Error {
  constructor(public readonly reason: 'CANCELLED' | 'PAUSED') {
    super(reason);
  }
}

/** Reporter used inside handlers to persist progress/checkpoints and honour cancel/pause. */
export class JobReporter {
  constructor(public readonly jobId: string) {}
  async progress(processed: number, total: number, checkpoint?: unknown, message?: string) {
    const job = await prisma.processingJob.update({
      where: { id: this.jobId },
      data: {
        processed,
        total,
        progress: total > 0 ? Math.min(processed / total, 1) : 0,
        heartbeatAt: new Date(),
        ...(checkpoint !== undefined ? { checkpoint: checkpoint as Prisma.InputJsonValue } : {}),
      },
    });
    if (message) await this.event(message);
    if (job.cancelRequested) throw new JobInterrupted('CANCELLED');
    if (job.pauseRequested) throw new JobInterrupted('PAUSED');
  }
  async event(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO', data?: unknown) {
    await prisma.jobEvent.create({
      data: { jobId: this.jobId, message, level, data: data === undefined ? undefined : (data as Prisma.InputJsonValue) },
    });
  }
}

export async function completeJob(jobId: string, result: unknown) {
  await prisma.processingJob.update({
    where: { id: jobId },
    data: { status: 'COMPLETED', progress: 1, result: result as Prisma.InputJsonValue, finishedAt: new Date(), lockedBy: null },
  });
  await prisma.jobEvent.create({ data: { jobId, message: 'Completed' } });
}

export async function failJob(jobId: string, err: unknown) {
  const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof JobInterrupted) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: err.reason, lockedBy: null, finishedAt: err.reason === 'CANCELLED' ? new Date() : null },
    });
    await prisma.jobEvent.create({ data: { jobId, message: err.reason === 'CANCELLED' ? 'Cancelled by user' : 'Paused by user' } });
    return;
  }
  const retry = job.attempts < job.maxAttempts && !(err as { permanent?: boolean })?.permanent;
  await prisma.processingJob.update({
    where: { id: jobId },
    data: retry
      ? { status: 'QUEUED', runAfter: new Date(Date.now() + 2 ** job.attempts * 1000), lockedBy: null, error: message.slice(0, 500) }
      : { status: 'FAILED', error: message.slice(0, 500), errorDetail: (err as Error)?.stack?.slice(0, 4000), finishedAt: new Date(), lockedBy: null },
  });
  await prisma.jobEvent.create({
    data: { jobId, level: retry ? 'WARN' : 'ERROR', message: retry ? `Attempt ${job.attempts} failed, will retry: ${message}` : `Failed: ${message}` },
  });
}

export async function getJob(orgId: string, id: string) {
  const job = await prisma.processingJob.findFirst({ where: { id, orgId }, include: { events: { orderBy: { createdAt: 'asc' }, take: 200 } } });
  if (!job) throw notFound('Job');
  return job;
}

export async function controlJob(orgId: string, id: string, action: 'cancel' | 'pause' | 'resume' | 'retry') {
  const job = await getJob(orgId, id);
  const terminal = ['COMPLETED', 'CANCELLED'].includes(job.status);
  if (action === 'cancel') {
    if (terminal) throw badRequest('This job has already finished.');
    if (job.status === 'QUEUED' || job.status === 'PAUSED' || job.status === 'FAILED') {
      await prisma.processingJob.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    } else await prisma.processingJob.update({ where: { id }, data: { cancelRequested: true } });
  } else if (action === 'pause') {
    if (job.status !== 'RUNNING' && job.status !== 'QUEUED') throw badRequest('Only queued or running jobs can be paused.');
    if (job.status === 'QUEUED') await prisma.processingJob.update({ where: { id }, data: { status: 'PAUSED' } });
    else await prisma.processingJob.update({ where: { id }, data: { pauseRequested: true } });
  } else if (action === 'resume') {
    if (job.status !== 'PAUSED') throw badRequest('Only paused jobs can be resumed.');
    await prisma.processingJob.update({ where: { id }, data: { status: 'QUEUED', pauseRequested: false, runAfter: new Date() } });
  } else {
    if (job.status !== 'FAILED') throw badRequest('Only failed jobs can be retried.');
    await prisma.processingJob.update({
      where: { id },
      data: { status: 'QUEUED', attempts: 0, error: null, errorDetail: null, runAfter: new Date(), finishedAt: null },
    });
  }
  await prisma.jobEvent.create({ data: { jobId: id, message: `Requested ${action}` } });
  return getJob(orgId, id);
}
