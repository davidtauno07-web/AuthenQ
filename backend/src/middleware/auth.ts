import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Role } from '@prisma/client';
import { verifyAccessToken } from '../services/token.service.js';
import { prisma } from '../db/prisma.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import type { AuthPrincipal } from '../types/index.js';

export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized());
    return;
  }
  let token: AuthPrincipal;
  try {
    token = verifyAccessToken(header.slice('Bearer '.length).trim());
  } catch {
    next(unauthorized('Session token is invalid or has expired'));
    return;
  }
  try {
    const user = await prisma.user.findFirst({
      where: { id: token.userId, organizationId: token.organizationId },
      select: { role: true, name: true, email: true },
    });
    if (!user) {
      next(unauthorized('Session user no longer exists'));
      return;
    }
    req.principal = { ...token, role: user.role, name: user.name, email: user.email };
    next();
  } catch (error) {
    next(error);
  }
};

/** Role hierarchy: ORG_ADMIN ⊇ ANALYST ⊇ VIEWER. */
const RANK: Record<Role, number> = {
  [Role.VIEWER]: 0,
  [Role.ANALYST]: 1,
  [Role.ORG_ADMIN]: 2,
};

export const requireRole =
  (minimum: Role): RequestHandler =>
  (req, _res, next) => {
    const principal = req.principal;
    if (!principal) {
      next(unauthorized());
      return;
    }
    if (RANK[principal.role] < RANK[minimum]) {
      next(forbidden(`This action requires the ${minimum} role or higher`));
      return;
    }
    next();
  };

/**
 * Every tenant-scoped query must derive its organization filter from here so a
 * caller can never read or write another organization's rows.
 */
export const requirePrincipal = (req: Request): AuthPrincipal => {
  if (!req.principal) throw unauthorized();
  return req.principal;
};
