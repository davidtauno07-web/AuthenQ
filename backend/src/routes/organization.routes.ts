import { Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound } from '../utils/errors.js';
import { hashPassword } from '../services/auth.service.js';
import { listAudit, recordAudit } from '../services/audit.service.js';
import {
  getOrgSettings,
  settingsPatchSchema,
  updateOrganization,
  updateOrgSettings,
} from '../services/settings.service.js';

export const organizationRouter = Router();

organizationRouter.use(authenticate);

organizationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const organization = await prisma.organization.findUnique({
      where: { id: principal.organizationId },
      include: { _count: { select: { users: true, models: true, datasets: true } } },
    });
    if (!organization) throw notFound('Organization not found');
    res.json(organization);
  }),
);

organizationRouter.patch(
  '/',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({ name: z.string().min(2).optional(), industry: z.string().nullable().optional() }),
      req,
    );
    res.json(await updateOrganization(principal.organizationId, body));
  }),
);

organizationRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await getOrgSettings(principal.organizationId));
  }),
);

organizationRouter.put(
  '/settings',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(settingsPatchSchema, req);
    const settings = await updateOrgSettings(principal.organizationId, body);
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'SETTINGS_UPDATED',
      resourceType: 'Organization',
      resourceId: principal.organizationId,
      metadata: body,
    });
    res.json(settings);
  }),
);

organizationRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(
      await prisma.user.findMany({
        where: { organizationId: principal.organizationId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
    );
  }),
);

organizationRouter.post(
  '/users',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({
        name: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(8),
        role: z.nativeEnum(Role).default(Role.VIEWER),
      }),
      req,
    );
    const email = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw badRequest('An account with this email already exists');
    const user = await prisma.user.create({
      data: {
        organizationId: principal.organizationId,
        name: body.name,
        email,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'USER_INVITED',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { role: user.role },
    });
    res.status(201).json(user);
  }),
);

organizationRouter.patch(
  '/users/:userId',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(z.object({ role: z.nativeEnum(Role) }), req);
    const target = await prisma.user.findFirst({
      where: { id: req.params.userId, organizationId: principal.organizationId },
    });
    if (!target) throw notFound('User not found');
    if (target.id === principal.userId && body.role !== Role.ORG_ADMIN) {
      throw badRequest('You cannot remove your own administrator role');
    }
    const user = await prisma.user.update({
      where: { id: target.id },
      data: { role: body.role },
      select: { id: true, name: true, email: true, role: true },
    });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'USER_ROLE_CHANGED',
      resourceType: 'User',
      resourceId: user.id,
      metadata: { role: user.role },
    });
    res.json(user);
  }),
);

organizationRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        action: z.string().optional(),
        resourceType: z.string().optional(),
      }),
      req,
    );
    res.json(await listAudit(principal.organizationId, query));
  }),
);
