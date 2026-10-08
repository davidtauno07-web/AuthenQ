import type { Request, Response } from 'express';
import { env, isProduction } from '../../config/env.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { prisma } from '../../lib/prisma.js';

export const SESSION_COOKIE = 'aq_session';
export const CSRF_COOKIE = 'aq_csrf';
const GRACE_MS = 2 * 60_000;

const cookieBase = { sameSite: 'lax' as const, secure: isProduction || env.APP_URL.startsWith('https://'), path: '/' };

export function setSessionCookies(res: Response, token: string, csrf: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true, expires: expiresAt });
  res.cookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, expires: expiresAt });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieBase);
  res.clearCookie(CSRF_COOKIE, cookieBase);
}

export async function createSession(req: Request, res: Response, userId: string, orgId: string, mfaVerified: boolean) {
  const token = randomToken();
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
  const session = await prisma.session.create({
    data: {
      userId,
      orgId,
      tokenHash: sha256(token),
      csrfToken: csrf,
      expiresAt,
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 300),
      mfaVerified,
    },
  });
  setSessionCookies(res, token, csrf, expiresAt);
  return session;
}

/**
 * Resolves a session from its cookie token and rotates the token when it is
 * older than SESSION_ROTATE_MINUTES. The previous token stays valid for a
 * short grace window so in-flight parallel requests do not fail.
 */
export async function resolveSession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length < 20) return null;
  const hash = sha256(token);
  let session = await prisma.session.findFirst({
    where: { OR: [{ tokenHash: hash }, { prevTokenHash: hash }], revokedAt: null, expiresAt: { gt: new Date() } },
  });
  if (!session) return null;
  if (session.prevTokenHash === hash && session.tokenHash !== hash) {
    if (Date.now() - session.rotatedAt.getTime() > GRACE_MS) return null;
    return session;
  }
  if (Date.now() - session.rotatedAt.getTime() > env.SESSION_ROTATE_MINUTES * 60_000) {
    const next = randomToken();
    session = await prisma.session.update({
      where: { id: session.id },
      data: { prevTokenHash: hash, tokenHash: sha256(next), rotatedAt: new Date(), lastSeenAt: new Date() },
    });
    setSessionCookies(res, next, session.csrfToken, session.expiresAt);
  } else if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return session;
}
