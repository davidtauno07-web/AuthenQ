import { Router } from 'express';
import { DataSourceType, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody } from '../middleware/validate.js';
import {
  createDataSource,
  deleteDataSource,
  listDataSources,
  testConnection,
  updateDataSource,
} from '../services/dataSource.service.js';
import { recordAudit } from '../services/audit.service.js';

export const dataSourceRouter = Router();
dataSourceRouter.use(authenticate);

const upsertSchema = z.object({
  name: z.string().min(2),
  type: z.nativeEnum(DataSourceType),
  configuration: z.record(z.unknown()).optional(),
});

dataSourceRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listDataSources(principal.organizationId));
  }),
);

dataSourceRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema, req);
    const source = await createDataSource({ ...body, organizationId: principal.organizationId });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'DATA_SOURCE_CREATED',
      resourceType: 'DataSource',
      resourceId: source.id,
      metadata: { name: source.name, type: source.type },
    });
    res.status(201).json(source);
  }),
);

dataSourceRouter.patch(
  '/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema.partial(), req);
    res.json(await updateDataSource(principal.organizationId, req.params.id, body));
  }),
);

dataSourceRouter.post(
  '/:id/test-connection',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await testConnection(principal.organizationId, req.params.id));
  }),
);

dataSourceRouter.delete(
  '/:id',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await deleteDataSource(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);
