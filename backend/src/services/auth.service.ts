import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { badRequest, conflict, notFound, unauthorized } from '../utils/errors.js';
import { generateOpaqueToken, hashToken, signAccessToken } from './token.service.js';
import { recordAudit } from './audit.service.js';
import { DEFAULT_ORG_SETTINGS } from './settings.service.js';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'organization';

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, env.BCRYPT_ROUNDS);

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  organizationName: string;
  industry?: string;
}

export const register = async (input: RegisterInput, ipAddress?: string) => {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('An account with this email already exists');

  const result = await prisma.$transaction(async (tx) => {
    const base = slugify(input.organizationName);
    let slug = base;
    let suffix = 1;
    while (await tx.organization.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    const org = await tx.organization.create({
      data: {
        name: input.organizationName,
        slug,
        industry: input.industry ?? null,
        settings: DEFAULT_ORG_SETTINGS,
      },
    });

    const user = await tx.user.create({
      data: {
        organizationId: org.id,
        name: input.name,
        email,
        passwordHash: await hashPassword(input.password),
        role: Role.ORG_ADMIN,
      },
      include: { organization: true },
    });
    return user;
  });

  await recordAudit({
    organizationId: result.organizationId,
    userId: result.id,
    action: 'USER_REGISTERED',
    resourceType: 'User',
    resourceId: result.id,
    metadata: { email: result.email, role: result.role },
    ipAddress,
  });

  return buildSession(result);
};

export const login = async (email: string, password: string, ipAddress?: string) => {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { organization: true },
  });
  // Same error for unknown email and wrong password — no account enumeration.
  if (!user) throw unauthorized('Invalid email or password');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw unauthorized('Invalid email or password');

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'USER_LOGIN',
    resourceType: 'User',
    resourceId: user.id,
    ipAddress,
  });

  return buildSession(user);
};

export const requestPasswordReset = async (email: string) => {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  // Always report success so the endpoint cannot be used to probe for accounts.
  if (!user) return { delivered: true, token: null };

  const { token, hash } = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await recordAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: 'PASSWORD_RESET_REQUESTED',
    resourceType: 'User',
    resourceId: user.id,
  });
  // No mail transport in the prototype: the token is returned outside production
  // so the reset flow is demonstrable end to end.
  return { delivered: true, token: env.isProduction ? null : token };
};

export const resetPassword = async (token: string, newPassword: string) => {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('Password reset token is invalid or has expired');
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await hashPassword(newPassword) },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);
  await recordAudit({
    organizationId: record.user.organizationId,
    userId: record.userId,
    action: 'PASSWORD_RESET_COMPLETED',
    resourceType: 'User',
    resourceId: record.userId,
  });
  return { reset: true };
};

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User not found');
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw badRequest('Current password is incorrect');
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  await recordAudit({
    organizationId: user.organizationId,
    userId,
    action: 'PASSWORD_CHANGED',
    resourceType: 'User',
    resourceId: userId,
  });
  return { changed: true };
};

type UserWithOrg = Awaited<ReturnType<typeof prisma.user.findFirstOrThrow>> & {
  organization: { id: string; name: string; slug: string; industry: string | null };
};

const buildSession = (user: UserWithOrg) => ({
  token: signAccessToken({
    userId: user.id,
    organizationId: user.organizationId,
    email: user.email,
    role: user.role,
    name: user.name,
  }),
  user: {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    organizationId: user.organizationId,
  },
  organization: {
    id: user.organization.id,
    name: user.organization.name,
    slug: user.organization.slug,
    industry: user.organization.industry,
  },
});
