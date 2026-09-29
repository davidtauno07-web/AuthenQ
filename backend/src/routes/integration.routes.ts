import { Router } from 'express';
import { IntegrationStatus, IntegrationType, Role, TestType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody } from '../middleware/validate.js';
import {
  createApiKey,
  createIntegration,
  deleteIntegration,
  handlePipelineEvent,
  listApiKeys,
  listIntegrations,
  revokeApiKey,
  updateIntegration,
} from '../services/integration.service.js';
import { recordAudit } from '../services/audit.service.js';

export const integrationRouter = Router();
integrationRouter.use(authenticate);

const upsertSchema = z.object({
  integrationType: z.nativeEnum(IntegrationType),
  name: z.string().min(2),
  repository: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  status: z.nativeEnum(IntegrationStatus).optional(),
  configuration: z.record(z.unknown()).optional(),
});

integrationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listIntegrations(principal.organizationId));
  }),
);

integrationRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema, req);
    res.status(201).json(
      await createIntegration({ ...body, organizationId: principal.organizationId }),
    );
  }),
);

integrationRouter.patch(
  '/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema.partial(), req);
    res.json(await updateIntegration(principal.organizationId, req.params.id, body));
  }),
);

/** Simulated pipeline event — what a GitHub Action would POST on push. */
integrationRouter.post(
  '/:id/events',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({
        commit: z.string().min(4).optional(),
        branch: z.string().optional(),
        modelId: z.string().uuid().nullable().optional(),
        datasetId: z.string().uuid().nullable().optional(),
        testType: z.nativeEnum(TestType).optional(),
      }),
      req,
    );
    const result = await handlePipelineEvent(
      principal.organizationId,
      req.params.id,
      body,
    );
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'PIPELINE_EVENT_RECEIVED',
      resourceType: 'Integration',
      resourceId: req.params.id,
      metadata: { commit: body.commit ?? null, testRunId: result.testRunId },
    });
    res.status(202).json(result);
  }),
);

integrationRouter.delete(
  '/:id',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await deleteIntegration(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);

integrationRouter.get(
  '/api-keys/list',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listApiKeys(principal.organizationId));
  }),
);

integrationRouter.post(
  '/api-keys',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(z.object({ name: z.string().min(2) }), req);
    const key = await createApiKey(principal.organizationId, body.name);
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'API_KEY_CREATED',
      resourceType: 'ApiKey',
      resourceId: key.id,
      metadata: { name: key.name },
    });
    res.status(201).json(key);
  }),
);

integrationRouter.delete(
  '/api-keys/:id',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await revokeApiKey(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);
