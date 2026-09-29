export interface JobContext {
  jobId: string;
  signal: AbortSignal;
}

export type JobHandler<TPayload> = (payload: TPayload, context: JobContext) => Promise<void>;

interface QueuedJob {
  jobId: string;
  name: string;
  run: () => Promise<void>;
  controller: AbortController;
}

/**
 * Minimal in-process job runner.
 *
 * The queue interface (enqueue / register / concurrency / cancel) mirrors what
 * a Redis-backed BullMQ queue exposes, so moving long-running tests onto real
 * queue infrastructure is a swap of this class only.
 */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly queue: QueuedJob[] = [];
  private readonly running = new Map<string, QueuedJob>();
  private readonly concurrency: number;
  private onError?: (jobId: string, name: string, error: unknown) => void | Promise<void>;

  constructor(concurrency = 2) {
    this.concurrency = concurrency;
  }

  register<TPayload>(name: string, handler: JobHandler<TPayload>): void {
    this.handlers.set(name, handler as JobHandler<never>);
  }

  setErrorHandler(handler: (jobId: string, name: string, error: unknown) => void | Promise<void>) {
    this.onError = handler;
  }

  enqueue<TPayload>(name: string, jobId: string, payload: TPayload): void {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`No job handler registered for "${name}"`);
    const controller = new AbortController();
    this.queue.push({
      jobId,
      name,
      controller,
      run: () =>
        (handler as JobHandler<TPayload>)(payload, { jobId, signal: controller.signal }),
    });
    queueMicrotask(() => this.drain());
  }

  cancel(jobId: string): boolean {
    const queuedIndex = this.queue.findIndex((job) => job.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      return true;
    }
    const active = this.running.get(jobId);
    if (active) {
      active.controller.abort();
      return true;
    }
    return false;
  }

  get stats() {
    return { queued: this.queue.length, running: this.running.size, concurrency: this.concurrency };
  }

  /** Test helper: resolves once the queue is fully drained. */
  async idle(timeoutMs = 120_000): Promise<void> {
    const started = Date.now();
    while (this.queue.length > 0 || this.running.size > 0) {
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for jobs to finish');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private drain(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift() as QueuedJob;
      this.running.set(job.jobId, job);
      job
        .run()
        .catch(async (error) => {
          console.error(`[authenq] job ${job.name}/${job.jobId} failed`, error);
          await this.onError?.(job.jobId, job.name, error);
        })
        .finally(() => {
          this.running.delete(job.jobId);
          this.drain();
        });
    }
  }
}

export const jobRunner = new JobRunner(Number(process.env.JOB_CONCURRENCY ?? 2));
