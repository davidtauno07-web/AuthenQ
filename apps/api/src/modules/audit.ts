import type { Db } from '../lib/prisma.js';
import { prisma, Prisma } from '../lib/prisma.js';
import type { RequestContext } from './context.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  details?: unknown;
  jobId?: string | null;
}

const json = (v: unknown) => (v === undefined ? undefined : v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

/** Appends an immutable activity record. Never pass real source values in before/after/details. */
export async function audit(ctx: RequestContext, entry: AuditEntry, db: Db = prisma): Promise<void> {
  await db.activityLog.create({
    data: {
      orgId: ctx.orgId,
      actorId: ctx.userId,
      actorType: ctx.actorType,
      actorLabel: ctx.actorLabel,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      summary: entry.summary,
      before: json(entry.before),
      after: json(entry.after),
      details: json(entry.details),
      ip: ctx.ip,
      userAgent: ctx.userAgent?.slice(0, 300),
      jobId: entry.jobId ?? null,
      requestId: ctx.requestId,
    },
  });
}
