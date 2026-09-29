import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal } from '../middleware/auth.js';
import { parseBody } from '../middleware/validate.js';
import {
  changePassword,
  login,
  register,
  requestPasswordReset,
  resetPassword,
} from '../services/auth.service.js';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';

const registerSchema = z
  .object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    organizationName: z.string().min(2),
    industry: z.string().optional(),
  })
  .strict();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRouter = Router();

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = parseBody(registerSchema, req);
    const session = await register(body, req.ip);
    res.status(201).json(session);
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req);
    res.json(await login(body.email, body.password, req.ip));
  }),
);

authRouter.post(
  '/logout',
  authenticate,
  asyncHandler(async (_req, res) => {
    // Access tokens are stateless and short lived; the client discards the token.
    res.json({ loggedOut: true });
  }),
);

authRouter.post(
  '/password-reset/request',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ email: z.string().email() }), req);
    res.json(await requestPasswordReset(body.email));
  }),
);

authRouter.post(
  '/password-reset/confirm',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ token: z.string().min(10), password: z.string().min(8) }),
      req,
    );
    res.json(await resetPassword(body.token, body.password));
  }),
);

authRouter.post(
  '/password',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) }),
      req,
    );
    res.json(await changePassword(principal.userId, body.currentPassword, body.newPassword));
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const user = await prisma.user.findFirst({
      where: { id: principal.userId, organizationId: principal.organizationId },
      include: { organization: true },
    });
    if (!user) throw notFound('User not found');
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        lastLoginAt: user.lastLoginAt,
      },
      organization: {
        id: user.organization.id,
        name: user.organization.name,
        slug: user.organization.slug,
        industry: user.organization.industry,
      },
    });
  }),
);
