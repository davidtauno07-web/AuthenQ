import { Router } from 'express';
import {
  Frequency,
  ModelEnvironment,
  ModelProvider,
  ModelType,
  Role,
} from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody } from '../middleware/validate.js';
import {
  checkModelHealth,
  createModel,
  deleteModel,
  getModel,
  listModels,
  updateModel,
} from '../services/model.service.js';
import { DEMO_BEHAVIORS } from '../engines/models/index.js';
import { recordAudit } from '../services/audit.service.js';

export const modelRouter = Router();
modelRouter.use(authenticate);

const upsertSchema = z.object({
  name: z.string().min(2),
  description: z.string().nullable().optional(),
  version: z.string().min(1).optional(),
  modelType: z.nativeEnum(ModelType).optional(),
  provider: z.nativeEnum(ModelProvider).optional(),
  endpoint: z.string().url().nullable().optional(),
  authConfig: z.record(z.unknown()).optional(),
  owner: z.string().nullable().optional(),
  environment: z.nativeEnum(ModelEnvironment).optional(),
  testFrequency: z.nativeEnum(Frequency).optional(),
  demoBehavior: z.string().nullable().optional(),
  isDemo: z.boolean().optional(),
});

modelRouter.get(
  '/demo-behaviors',
  asyncHandler(async (_req, res) => {
    res.json(DEMO_BEHAVIORS);
  }),
);

modelRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listModels(principal.organizationId));
  }),
);

modelRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema, req);
    const model = await createModel({ ...body, organizationId: principal.organizationId });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'MODEL_REGISTERED',
      resourceType: 'Model',
      resourceId: model.id,
      metadata: { name: model.name, version: model.version, provider: model.provider },
    });
    res.status(201).json(model);
  }),
);

modelRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await getModel(principal.organizationId, req.params.id));
  }),
);

modelRouter.patch(
  '/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema.partial(), req);
    const model = await updateModel(principal.organizationId, req.params.id, body);
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'MODEL_UPDATED',
      resourceType: 'Model',
      resourceId: model.id,
      metadata: { version: model.version },
    });
    res.json(model);
  }),
);

modelRouter.post(
  '/:id/health',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await checkModelHealth(principal.organizationId, req.params.id));
  }),
);

modelRouter.delete(
  '/:id',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await deleteModel(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);
