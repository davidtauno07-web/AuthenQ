import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { claimNext } from '../modules/jobs/queue.js';
import { deliverPendingWebhooks } from '../modules/platform/events.js';
import { runJob } from './handlers.js';

const workerId = `${hostname()}:${process.pid}`;
let stopping = false;
const active = new Set<Promise<unknown>>();

async function loop(slot: number) {
  while (!stopping) {
    try {
      const job = await claimNext(`${workerId}#${slot}`);
      if (!job) {
        await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
        continue;
      }
      logger.info({ jobId: job.id, type: job.type, attempt: job.attempts }, 'job started');
      const p = runJob(job);
      active.add(p);
      const r = await p;
      active.delete(p);
      logger.info({ jobId: job.id, ok: r.ok }, 'job finished');
    } catch (err) {
      logger.error({ err }, 'worker loop error');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function webhookLoop() {
  while (!stopping) {
    await deliverPendingWebhooks().catch((err) => logger.error({ err }, 'webhook delivery error'));
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function housekeeping() {
  while (!stopping) {
    await prisma.rateLimitBucket.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 86_400_000) } } }).catch(() => undefined);
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 15 * 60_000));
  }
}

logger.info({ workerId, concurrency: env.WORKER_CONCURRENCY }, 'AuthenQ worker started');
const loops = [...Array.from({ length: env.WORKER_CONCURRENCY }, (_, i) => loop(i)), webhookLoop(), housekeeping()];

async function shutdown(signal: string) {
  logger.info({ signal }, 'worker draining');
  stopping = true;
  await Promise.race([Promise.all(active), new Promise((r) => setTimeout(r, 30_000))]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
void Promise.all(loops);
