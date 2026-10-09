import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env, isProduction } from '../../config/env.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { audit } from '../audit.js';
import { createSession } from './sessions.js';

export const oidcRouter = Router();

const FLOW_COOKIE = 'aq_oidc';
const FLOW_PATH = '/api/v1/auth/google';
const FLOW_TTL_MS = 10 * 60_000;
const PROVIDER = 'GOOGLE';

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
interface Flow { state: string; nonce: string; verifier: string; next: string; exp: number }

const discoveryCache = new Map<string, { at: number; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }>();

export function googleConfigured() {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri() {
  return `${(env.API_PUBLIC_URL ?? env.APP_URL).replace(/\/$/, '')}${FLOW_PATH}/callback`;
}

export function resetOidcCache() {
  discoveryCache.clear();
}

async function discover() {
  const issuer = env.GOOGLE_OIDC_ISSUER.replace(/\/$/, '');
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < 3_600_000) return cached;
  const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`OIDC discovery failed with HTTP ${r.status}`);
  const doc = (await r.json()) as Discovery;
  if (doc.issuer.replace(/\/$/, '') !== issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('OIDC discovery document is invalid or its issuer does not match the configured issuer');
  }
  const entry = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: 8000 }) };
  discoveryCache.set(issuer, entry);
  return entry;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function safeNext(n: unknown) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') && n.length < 500 ? n : '/';
}

const cookieOpts = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProduction || env.APP_URL.startsWith('https://'),
  path: FLOW_PATH,
});

function finishWithError(req: Request, res: Response, code: string, detail?: string) {
  res.clearCookie(FLOW_COOKIE, cookieOpts());
  if (detail) logger.warn({ requestId: req.requestId, code, detail }, 'google sign-in failed');
  res.redirect(302, `${env.APP_URL}/login?sso_error=${encodeURIComponent(code)}`);
}

async function recordFailure(req: Request, email: string, reason: string, userId?: string) {
  await prisma.loginEvent.create({ data: { userId, email: email.slice(0, 200), success: false, reason: `GOOGLE_${reason}`, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) } });
}

const limiter = rateLimit('oidc', 30, 60, (req) => `oidc:${req.ip ?? 'unknown'}`);

oidcRouter.get('/providers', (_req, res) => {
  res.json({
    google: googleConfigured()
      ? { configured: true }
      : { configured: false, setup: 'Google sign-in is not configured on this server. An administrator must set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the API server and register the callback URL in Google Cloud Console.', callbackUrl: googleRedirectUri() },
  });
});

oidcRouter.get('/google/start', limiter, asyncHandler(async (req, res) => {
  if (!googleConfigured()) return finishWithError(req, res, 'not_configured');
  let d: Awaited<ReturnType<typeof discover>>;
  try {
    d = await discover();
  } catch (e) {
    return finishWithError(req, res, 'provider_unavailable', (e as Error).message);
  }
  const flow: Flow = { state: b64url(crypto.randomBytes(24)), nonce: b64url(crypto.randomBytes(24)), verifier: b64url(crypto.randomBytes(48)), next: safeNext(req.query.next), exp: Date.now() + FLOW_TTL_MS };
  const challenge = b64url(crypto.createHash('sha256').update(flow.verifier).digest());
  res.cookie(FLOW_COOKIE, encryptSecret(JSON.stringify(flow)), { ...cookieOpts(), maxAge: FLOW_TTL_MS });
  const url = new URL(d.doc.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: googleRedirectUri(),
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  res.redirect(302, url.toString());
}));

function readFlow(req: Request): Flow | null {
  const raw = req.cookies?.[FLOW_COOKIE];
  if (typeof raw !== 'string') return null;
  try {
    const f = JSON.parse(decryptSecret(raw)) as Flow;
    return f.exp > Date.now() ? f : null;
  } catch {
    return null;
  }
}

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

oidcRouter.get('/google/callback', limiter, asyncHandler(async (req, res) => {
  const flow = readFlow(req);
  res.clearCookie(FLOW_COOKIE, cookieOpts());
  const q = req.query as Record<string, unknown>;
  if (typeof q.error === 'string') return finishWithError(req, res, q.error === 'access_denied' ? 'cancelled' : 'provider_error', q.error);
  if (!googleConfigured()) return finishWithError(req, res, 'not_configured');
  if (!flow) return finishWithError(req, res, 'expired');
  if (typeof q.state !== 'string' || !sameString(q.state, flow.state)) return finishWithError(req, res, 'invalid_state');
  if (typeof q.code !== 'string' || !q.code || q.code.length > 2048) return finishWithError(req, res, 'invalid_callback');

  let claims: JWTPayload & { email?: string; email_verified?: boolean; name?: string; hd?: string; nonce?: string };
  try {
    const d = await discover();
    const tr = await fetch(d.doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.code, redirect_uri: googleRedirectUri(), client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tr.ok) return finishWithError(req, res, 'provider_error', `token endpoint HTTP ${tr.status}`);
    const tokens = (await tr.json()) as { id_token?: string };
    if (!tokens.id_token) return finishWithError(req, res, 'provider_error', 'no id_token returned');
    const v = await jwtVerify(tokens.id_token, d.jwks, { issuer: d.doc.issuer, audience: env.GOOGLE_CLIENT_ID!, algorithms: ['RS256', 'ES256'], clockTolerance: 60 });
    claims = v.payload as typeof claims;
  } catch (e) {
    return finishWithError(req, res, 'invalid_token', (e as Error).message);
  }
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, flow.nonce)) return finishWithError(req, res, 'invalid_token', 'nonce mismatch');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!claims.sub || !email || claims.email_verified !== true) {
    await recordFailure(req, email || 'unknown', 'EMAIL_UNVERIFIED');
    return finishWithError(req, res, 'email_unverified');
  }
  const allowed = env.GOOGLE_ALLOWED_DOMAINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(email.split('@')[1]!)) {
    await recordFailure(req, email, 'DOMAIN_NOT_ALLOWED');
    return finishWithError(req, res, 'domain_not_allowed');
  }

  const identity = await prisma.userIdentity.findUnique({ where: { provider_subject: { provider: PROVIDER, subject: claims.sub } } });
  const user = identity
    ? await prisma.user.findUnique({ where: { id: identity.userId }, include: { mfaFactors: true } })
    : await prisma.user.findUnique({ where: { email }, include: { mfaFactors: true } });
  if (!user || user.deletedAt) {
    await recordFailure(req, email, 'NO_ACCOUNT');
    return finishWithError(req, res, 'no_account');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordFailure(req, email, 'LOCKED', user.id);
    return finishWithError(req, res, 'locked');
  }
  if (user.mfaFactors.some((f) => f.verifiedAt)) {
    await recordFailure(req, email, 'MFA_REQUIRED', user.id);
    return finishWithError(req, res, 'mfa_required');
  }
  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, status: 'ACTIVE', org: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    include: { role: true, org: true },
  });
  if (!membership) {
    await recordFailure(req, email, 'NO_MEMBERSHIP', user.id);
    return finishWithError(req, res, 'no_membership');
  }
  const ctx = { orgId: membership.orgId, userId: user.id, actorType: 'USER' as const, actorLabel: user.name, roleKey: membership.role.key, permissions: new Set<never>(), ip: req.ip, requestId: req.requestId };
  if (!identity) {
    await prisma.userIdentity.create({ data: { userId: user.id, provider: PROVIDER, subject: claims.sub, email } });
    await audit(ctx, { action: 'auth.identity.linked', resourceType: 'user', resourceId: user.id, summary: `${user.name} linked a Google account` });
  } else {
    await prisma.userIdentity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date(), email } });
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lastLoginAt: new Date(), ...(user.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }) } });
  await prisma.loginEvent.create({ data: { userId: user.id, email, success: true, reason: 'GOOGLE', ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) } });
  await createSession(req, res, user.id, membership.orgId, false);
  await audit(ctx, { action: 'auth.login.google', resourceType: 'user', resourceId: user.id, summary: `${user.name} signed in with Google` });
  res.redirect(302, `${env.APP_URL}${flow.next}`);
}));
