import type { Request } from 'express';
import type { PermissionKey } from './authz.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface RequestContext {
  orgId: string;
  userId: string | null;
  actorType: 'USER' | 'API_KEY' | 'SYSTEM';
  actorLabel: string;
  roleKey: string;
  permissions: Set<PermissionKey>;
  sessionId?: string;
  apiKeyId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: RequestContext;
    requestId?: string;
  }
}

export function ctxOf(req: Request): RequestContext {
  if (!req.ctx) throw unauthorized();
  return req.ctx;
}

export function can(ctx: RequestContext, permission: PermissionKey): boolean {
  return ctx.permissions.has(permission);
}

export function assertCan(ctx: RequestContext, permission: PermissionKey): void {
  if (!can(ctx, permission)) throw forbidden();
}

export function systemContext(orgId: string, label = 'AuthenQ system'): RequestContext {
  return { orgId, userId: null, actorType: 'SYSTEM', actorLabel: label, roleKey: 'SYSTEM', permissions: new Set() };
}
