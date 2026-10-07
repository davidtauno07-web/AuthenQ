import type { ProcessingJob } from '@prisma/client';
import type { JobReporter } from '../modules/jobs/queue.js';
import { runIngestJob, runScanJob } from '../services/firewall.js';
import { runTwinJob } from '../services/twin.js';
import { runEngineJob } from '../services/engine.js';
import { runExportJob } from '../services/exports.js';
import { prisma } from '../lib/prisma.js';

type Handler = (orgId: string, payload: never, reporter: JobReporter) => Promise<unknown>;

export const HANDLERS: Record<string, Handler> = {
  FIREWALL_INGEST: runIngestJob as Handler,
  FIREWALL_SCAN: runScanJob as Handler,
  TWIN_GENERATE: runTwinJob as Handler,
  ENGINE_RUN: runEngineJob as Handler,
  EXPORT_BUILD: runExportJob as Handler,
};

/** Marks the domain resource as failed when its job fails permanently. */
export async function markResourceFailed(job: ProcessingJob, message: string) {
  const p = job.payload as Record<string, string>;
  const err = message.slice(0, 300);
  if (job.type === 'FIREWALL_INGEST' || job.type === 'FIREWALL_SCAN') {
    if (job.resourceId) await prisma.dataSource.update({ where: { id: job.resourceId }, data: { status: 'ERROR', lastError: err } }).catch(() => undefined);
    if (p.scanId) await prisma.firewallScan.update({ where: { id: p.scanId }, data: { status: 'FAILED' } }).catch(() => undefined);
  } else if (job.type === 'TWIN_GENERATE') {
    await prisma.syntheticSet.update({ where: { id: p.setId! }, data: { status: 'FAILED' } }).catch(() => undefined);
  } else if (job.type === 'ENGINE_RUN') {
    await prisma.engineRun.update({ where: { id: p.runId! }, data: { status: 'FAILED', finishedAt: new Date() } }).catch(() => undefined);
  } else if (job.type === 'EXPORT_BUILD') {
    await prisma.export.update({ where: { id: p.exportId! }, data: { status: 'FAILED' } }).catch(() => undefined);
  }
}

/** Runs one claimed job to completion; used by the worker loop and by tests. */
export async function runJob(job: ProcessingJob) {
  const { completeJob, failJob, JobReporter, JobInterrupted } = await import('../modules/jobs/queue.js');
  const { emit } = await import('../modules/platform/events.js');
  const handler = HANDLERS[job.type];
  const reporter = new JobReporter(job.id);
  try {
    if (!handler) throw Object.assign(new Error(`No handler for ${job.type}`), { permanent: true });
    const result = await handler(job.orgId, job.payload as never, reporter);
    await completeJob(job.id, result ?? {});
    return { ok: true as const, result };
  } catch (err) {
    await failJob(job.id, err);
    const fresh = await prisma.processingJob.findUnique({ where: { id: job.id } });
    if (fresh?.status === 'FAILED') {
      await markResourceFailed(job, (err as Error).message);
      await emit(job.orgId, 'job.failed', { jobId: job.id, type: job.type, error: (err as Error).message.slice(0, 300) });
    } else if (fresh?.status === 'CANCELLED' && !(err instanceof JobInterrupted)) {
      await markResourceFailed(job, 'Cancelled');
    }
    return { ok: false as const, error: err };
  }
}

/** Drains all queued jobs synchronously (tests, seed). */
export async function drainJobs(maxJobs = 100) {
  const { claimNext } = await import('../modules/jobs/queue.js');
  let n = 0;
  for (; n < maxJobs; n++) {
    const job = await claimNext('inline');
    if (!job) break;
    await runJob(job);
  }
  return n;
}
