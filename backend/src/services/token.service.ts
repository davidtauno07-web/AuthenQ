import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { env } from '../config/env.js';
import type { AuthPrincipal } from '../types/index.js';

const tokenSchema = z.object({
  userId: z.string().uuid(),
  organizationId: z.string().uuid(),
  email: z.string().email(),
  role: z.nativeEnum(Role),
  name: z.string().min(1),
});

export const signAccessToken = (principal: AuthPrincipal): string =>
  jwt.sign(principal, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);

export const verifyAccessToken = (token: string): AuthPrincipal => {
  return tokenSchema.parse(jwt.verify(token, env.JWT_SECRET));
};

export const generateOpaqueToken = (): { token: string; hash: string } => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
};

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
