import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import type { JsonObject } from '../types/index.js';

export interface AuditEntry {
  organizationId: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: JsonObject;
  ipAddress?: string | null;
}

/**
 * Audit writes must never break the action they describe, so failures are
 * logged and swallowed rather than propagated to the caller.
 */
export const recordAudit = async (entry: AuditEntry): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        userId: entry.userId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  } catch (error) {
    console.error('[authenq] failed to write audit log', error);
  }
};

export const listAudit = async (
  organizationId: string,
  options: { page: number; pageSize: number; action?: string; resourceType?: string },
) => {
  const where = {
    organizationId,
    ...(options.action ? { action: options.action } : {}),
    ...(options.resourceType ? { resourceType: options.resourceType } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);
  return { items, total, page: options.page, pageSize: options.pageSize };
};
