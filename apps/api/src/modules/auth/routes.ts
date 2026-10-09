import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret, hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { asyncHandler, parse } from '../../lib/http.js';
import { requireAuth, loadPermissions } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { audit } from '../audit.js';
import { ctxOf } from '../context.js';
import { sendEmail } from './email.js';
import { clearSessionCookies, createSession, CSRF_COOKIE } from './sessions.js';
import { newTotpSecret, verifyTotp } from './totp.js';
import { oidcRouter } from './oidc.js';

export const authRouter = Router();
authRouter.use(oidcRouter);

const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), 'Use letters and at least one number or symbol');
const email = z.string().trim().toLowerCase().email().max(200);

const ipKey = (prefix: string) => (req: { ip?: string }) => `${prefix}:${req.ip ?? 'unknown'}`;

async function issueToken(userId: string, type: 'EMAIL_VERIFY' | 'PASSWORD_RESET' | 'INVITE', hours: number) {
  const token = randomToken();
  await prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.authToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + hours * 3_600_000) } });
  return token;
}

async function findValidToken(token: string, type: string) {
  const record = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.type !== type || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('This link is invalid or has expired. Request a new one.');
  }
  return record;
}

async function markTokenUsed(id: string) {
  const r = await prisma.authToken.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } });
  if (!r.count) throw badRequest('This link is invalid or has expired. Request a new one.');
}

async function consumeToken(token: string, type: string) {
  const record = await findValidToken(token, type);
  await markTokenUsed(record.id);
  return record;
}

function slugify(name: string) {
  return (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org') + '-' + randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function profileFor(userId: string, orgId: string, sessionId?: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { mfaFactors: true } });
  const memberships = await prisma.organizationMember.findMany({
    where: { userId, status: 'ACTIVE', org: { deletedAt: null } },
    include: { org: true, role: true },
    orderBy: { createdAt: 'asc' },
  });
  const current = memberships.find((m) => m.orgId === orgId);
  if (!current) throw unauthorized();
  const session = sessionId ? await prisma.session.findUnique({ where: { id: sessionId } }) : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: !!user.emailVerifiedAt,
      mfaEnabled: user.mfaFactors.some((f) => f.verifiedAt),
    },
    org: { id: current.org.id, name: current.org.name, slug: current.org.slug, plan: current.org.plan },
    role: { key: current.role.key, name: current.role.name },
    permissions: [...(await loadPermissions(current.role.key, orgId))],
    organizations: memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role.name })),
    csrfToken: session?.csrfToken,
  };
}

authRouter.post(
  '/register',
  rateLimit('register', 10, 3600, ipKey('register')),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(120), email, password, orgName: z.string().trim().min(2).max(120) }),
      req.body,
    );
    if (body.password.toLowerCase().includes(body.email.split('@')[0]!)) throw badRequest('Your password must not contain your email name.');
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists. Sign in or reset your password.');
    const adminRole = await prisma.role.findFirstOrThrow({ where: { key: 'ADMIN', orgId: null } });
    const { user, org } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: body.email, name: body.name, passwordHash: await hashPassword(body.password) } });
      const org = await tx.organization.create({ data: { name: body.orgName, slug: slugify(body.orgName) } });
      await tx.organizationMember.create({ data: { orgId: org.id, userId: user.id, roleId: adminRole.id } });
      await tx.billingAccount.create({ data: { orgId: org.id } });
      return { user, org };
    });
    const token = await issueToken(user.id, 'EMAIL_VERIFY', 48);
    await sendEmail(user.email, 'Verify your AuthenQ email', `Open ${env.APP_URL}/verify-email?token=${token} to verify your email address.`);
    const session = await createSession(req, res, user.id, org.id, true);
    await audit({ orgId: org.id, userId: user.id, actorType: 'USER', actorLabel: user.name, roleKey: 'ADMIN', permissions: new Set(), ip: req.ip, requestId: req.requestId }, {
      action: 'org.created',
      resourceType: 'organization',
      resourceId: org.id,
      summary: `${user.name} created the organization ${org.name}`,
    });
    res.status(201).json(await profileFor(user.id, org.id, session.id));
  }),
);

function lockMinutes(failures: number) {
  if (failures < 5) return 0;
  return Math.min(15 * 2 ** Math.floor((failures - 5) / 5), 24 * 60);
}

authRouter.post(
  '/login',
  rateLimit('login-ip', 30, 60, ipKey('login')),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(200), mfaCode: z.string().max(10).optional() }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { mfaFactors: true } });
    const fail = async (reason: string) => {
      await prisma.loginEvent.create({ data: { userId: user?.id, email: body.email, success: false, reason, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) } });
    };
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await fail('LOCKED');
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again after ${user.lockedUntil.toISOString()} or reset your password.`);
    }
    const ok = user?.passwordHash && !user.deletedAt ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !ok) {
      if (user) {
        const failures = user.failedLoginCount + 1;
        const minutes = lockMinutes(failures);
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: failures, lockedUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null },
        });
      }
      await fail('INVALID_CREDENTIALS');
      throw unauthorized('The email or password is incorrect.');
    }
    const factor = user.mfaFactors.find((f) => f.verifiedAt);
    if (factor) {
      if (!body.mfaCode) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
      if (!verifyTotp(decryptSecret(factor.secretEnc), body.mfaCode)) {
        await fail('MFA_INVALID');
        throw new AppError(401, 'MFA_INVALID', 'The authentication code is incorrect.');
      }
    }
    const membership = await prisma.organizationMember.findFirst({
      where: { userId: user.id, status: 'ACTIVE', org: { deletedAt: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw unauthorized('Your account is not a member of any active organization.');
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await prisma.loginEvent.create({ data: { userId: user.id, email: user.email, success: true, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) } });
    const session = await createSession(req, res, user.id, membership.orgId, !!factor);
    res.json(await profileFor(user.id, membership.orgId, session.id));
  }),
);

authRouter.post(
  '/forgot-password',
  rateLimit('forgot', 5, 900, ipKey('forgot')),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (user && !user.deletedAt) {
      const token = await issueToken(user.id, 'PASSWORD_RESET', 1);
      await sendEmail(user.email, 'Reset your AuthenQ password', `Open ${env.APP_URL}/reset-password?token=${token} within 1 hour to choose a new password.`);
    }
    res.json({ ok: true, message: 'If an account exists for this email, a reset link has been sent.' });
  }),
);

authRouter.post(
  '/reset-password',
  rateLimit('reset', 10, 900, ipKey('reset')),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(20), password, mfaCode: z.string().max(10).optional() }), req.body);
    const record = await findValidToken(body.token, 'PASSWORD_RESET');
    // A reset link alone must not take over an MFA-protected account.
    const factor = await prisma.mfaFactor.findFirst({ where: { userId: record.userId, verifiedAt: { not: null } } });
    if (factor) {
      if (!body.mfaCode) throw new AppError(401, 'MFA_REQUIRED', 'Enter the 6-digit code from your authenticator app to reset your password.');
      if (!verifyTotp(decryptSecret(factor.secretEnc), body.mfaCode)) throw new AppError(401, 'MFA_INVALID', 'The authentication code is incorrect.');
    }
    await markTokenUsed(record.id);
    await prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(body.password), failedLoginCount: 0, lockedUntil: null } });
    await prisma.session.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await prisma.securityEvent.create({ data: { userId: record.userId, type: 'PASSWORD_RESET', ip: req.ip } });
    res.json({ ok: true, message: 'Your password has been changed. Sign in with the new password.' });
  }),
);

authRouter.post(
  '/verify-email',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(20) }), req.body);
    const record = await consumeToken(body.token, 'EMAIL_VERIFY');
    await prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/accept-invite',
  rateLimit('invite', 10, 900, ipKey('invite')),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(20), name: z.string().trim().min(1).max(120), password }), req.body);
    const record = await findValidToken(body.token, 'INVITE');
    const invited = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    // Existing accounts confirm the invitation with their current password; it is not changed.
    if (invited.passwordHash && !(await verifyPassword(body.password, invited.passwordHash))) {
      throw unauthorized('You already have an AuthenQ account. Enter its current password to accept the invitation.');
    }
    await markTokenUsed(record.id);
    const user = invited.passwordHash
      ? await prisma.user.update({ where: { id: invited.id }, data: { emailVerifiedAt: invited.emailVerifiedAt ?? new Date() } })
      : await prisma.user.update({
          where: { id: invited.id },
          data: { name: body.name, passwordHash: await hashPassword(body.password), emailVerifiedAt: new Date() },
        });
    await prisma.organizationMember.updateMany({ where: { userId: user.id, status: 'INVITED' }, data: { status: 'ACTIVE' } });
    const membership = await prisma.organizationMember.findFirst({ where: { userId: user.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
    if (!membership) throw notFound('Invitation');
    const session = await createSession(req, res, user.id, membership.orgId, false);
    res.json(await profileFor(user.id, membership.orgId, session.id));
  }),
);

authRouter.get('/sso/discover', asyncHandler(async (req, res) => {
  const domain = String(req.query.email ?? '').split('@')[1]?.toLowerCase();
  const conn = domain ? await prisma.ssoConnection.findFirst({ where: { domain, status: 'ACTIVE' } }) : null;
  res.json({ sso: !!conn, protocol: conn?.protocol ?? null, provider: conn?.provider ?? null });
}));

// ── Authenticated ────────────────────────────────────────────────────────────
authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  if (!ctx.userId) {
    res.json({ apiKey: true, orgId: ctx.orgId, permissions: [...ctx.permissions] });
    return;
  }
  res.json(await profileFor(ctx.userId, ctx.orgId, ctx.sessionId));
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.sessionId) await prisma.session.update({ where: { id: ctx.sessionId }, data: { revokedAt: new Date() } });
  clearSessionCookies(res);
  res.json({ ok: true });
}));

authRouter.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  if (ctx.userId) await prisma.session.updateMany({ where: { userId: ctx.userId, revokedAt: null }, data: { revokedAt: new Date() } });
  clearSessionCookies(res);
  res.json({ ok: true });
}));

authRouter.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const sessions = await prisma.session.findMany({
    where: { userId: ctx.userId ?? '', revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
  });
  res.json(sessions.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.id === ctx.sessionId })));
}));

authRouter.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const result = await prisma.session.updateMany({ where: { id: req.params.id, userId: ctx.userId ?? '' }, data: { revokedAt: new Date() } });
  if (!result.count) throw notFound('Session');
  res.json({ ok: true });
}));

authRouter.post('/switch-org', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ orgId: z.string().uuid() }), req.body);
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: body.orgId, userId: ctx.userId ?? '' } } });
  if (!member || member.status !== 'ACTIVE') throw notFound('Organization');
  await prisma.session.update({ where: { id: ctx.sessionId }, data: { orgId: body.orgId } });
  res.json(await profileFor(ctx.userId!, body.orgId, ctx.sessionId));
}));

authRouter.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId ?? '' } });
  if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) throw badRequest('The current password is incorrect.');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: ctx.sessionId } }, data: { revokedAt: new Date() } });
  await prisma.securityEvent.create({ data: { orgId: ctx.orgId, userId: user.id, type: 'PASSWORD_CHANGED', ip: req.ip } });
  res.json({ ok: true });
}));

authRouter.post('/resend-verification', requireAuth, rateLimit('resend', 3, 900), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId ?? '' } });
  if (user.emailVerifiedAt) {
    res.json({ ok: true, message: 'Your email is already verified.' });
    return;
  }
  const token = await issueToken(user.id, 'EMAIL_VERIFY', 48);
  await sendEmail(user.email, 'Verify your AuthenQ email', `Open ${env.APP_URL}/verify-email?token=${token} to verify your email address.`);
  res.json({ ok: true, message: 'A new verification link has been sent.' });
}));

authRouter.post('/mfa/enroll', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId ?? '' } });
  await prisma.mfaFactor.deleteMany({ where: { userId: user.id, verifiedAt: null } });
  const secret = newTotpSecret();
  await prisma.mfaFactor.create({ data: { userId: user.id, secretEnc: encryptSecret(secret) } });
  const uri = `otpauth://totp/AuthenQ:${encodeURIComponent(user.email)}?secret=${secret}&issuer=AuthenQ`;
  res.json({ secret, uri });
}));

authRouter.post('/mfa/verify', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
  const factor = await prisma.mfaFactor.findFirst({ where: { userId: ctx.userId ?? '', verifiedAt: null }, orderBy: { createdAt: 'desc' } });
  if (!factor) throw badRequest('Start MFA enrollment first.');
  if (!verifyTotp(decryptSecret(factor.secretEnc), body.code)) throw badRequest('The authentication code is incorrect.');
  await prisma.mfaFactor.update({ where: { id: factor.id }, data: { verifiedAt: new Date() } });
  await prisma.securityEvent.create({ data: { orgId: ctx.orgId, userId: ctx.userId, type: 'MFA_ENABLED', ip: req.ip } });
  res.json({ ok: true });
}));

authRouter.delete('/mfa', requireAuth, asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ password: z.string().min(1) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ctx.userId ?? '' } });
  if (!user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) throw badRequest('The password is incorrect.');
  await prisma.mfaFactor.deleteMany({ where: { userId: user.id } });
  await prisma.securityEvent.create({ data: { orgId: ctx.orgId, userId: user.id, type: 'MFA_DISABLED', severity: 'WARN', ip: req.ip } });
  res.json({ ok: true });
}));

export { CSRF_COOKIE, issueToken };
