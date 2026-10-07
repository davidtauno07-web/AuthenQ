import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { sha256, safeEqual } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { SYSTEM_ROLES, type PermissionKey } from '../modules/authz.js';
import type { RequestContext } from '../modules/context.js';
import { resolveSession } from '../modules/auth/sessions.js';

export async function loadPermissions(roleKey: string, orgId: string): Promise<Set<PermissionKey>> {
  const role = await prisma.role.findFirst({
    where: { key: roleKey, OR: [{ orgId }, { orgId: null }] },
    include: { permissions: { include: { permission: true } } },
    orderBy: { orgId: { sort: 'desc', nulls: 'last' } },
  });
  if (role) return new Set(role.permissions.map((p) => p.permission.key as PermissionKey));
  return new Set(SYSTEM_ROLES[roleKey]?.permissions ?? []);
}

async function fromApiKey(req: Request): Promise<RequestContext | null> {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer aq_')) return null;
  const raw = header.slice(7).trim();
  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(raw) }, include: { serviceAccount: true } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date()) || key.serviceAccount?.disabledAt) {
    throw unauthorized('The API key is invalid, expired or revoked.');
  }
  const roleKey = key.serviceAccount?.roleKey ?? 'VIEWER';
  const rolePerms = await loadPermissions(roleKey, key.orgId);
  const scoped = new Set([...rolePerms].filter((p) => key.scopes.includes(p)));
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return {
    orgId: key.orgId,
    userId: null,
    actorType: 'API_KEY',
    actorLabel: `API key ${key.prefix} (${key.name})`,
    roleKey,
    permissions: scoped,
    apiKeyId: key.id,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    requestId: req.requestId,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Authenticates via session cookie (with CSRF check on mutations) or API key. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const apiCtx = await fromApiKey(req);
    if (apiCtx) {
      req.ctx = apiCtx;
      return next();
    }
    const session = await resolveSession(req, res);
    if (!session) throw unauthorized();
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.get('x-csrf-token') ?? '';
      if (!safeEqual(header, session.csrfToken)) throw forbidden('Your session security token is missing or outdated. Refresh the page and try again.');
    }
    const member = await prisma.organizationMember.findUnique({
      where: { orgId_userId: { orgId: session.orgId, userId: session.userId } },
      include: { role: true, user: true },
    });
    if (!member || member.status !== 'ACTIVE' || member.user.deletedAt) throw unauthorized('Your membership in this organization is no longer active.');
    req.ctx = {
      orgId: session.orgId,
      userId: session.userId,
      actorType: 'USER',
      actorLabel: member.user.name,
      roleKey: member.role.key,
      permissions: await loadPermissions(member.role.key, session.orgId),
      sessionId: session.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.requestId,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...perms: PermissionKey[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(unauthorized());
    if (!perms.every((p) => req.ctx!.permissions.has(p))) return next(forbidden());
    next();
  };
}
