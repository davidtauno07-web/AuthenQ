import { Router } from 'express';
import { Frequency, Role, TestType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from '../services/monitoring.service.js';
import { metricHistory } from '../services/regression.service.js';

export const monitoringRouter = Router();
monitoringRouter.use(authenticate);

const upsertSchema = z.object({
  name: z.string().min(2),
  modelId: z.string().uuid().nullable().optional(),
  datasetId: z.string().uuid().nullable().optional(),
  testType: z.nativeEnum(TestType).optional(),
  frequency: z.nativeEnum(Frequency).optional(),
  intervalHours: z.number().int().min(1).max(8760).nullable().optional(),
  enabled: z.boolean().optional(),
  configuration: z.record(z.unknown()).optional(),
});

monitoringRouter.get(
  '/schedules',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listSchedules(principal.organizationId));
  }),
);

monitoringRouter.post(
  '/schedules',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema, req);
    res.status(201).json(
      await createSchedule({ ...body, organizationId: principal.organizationId }),
    );
  }),
);

monitoringRouter.patch(
  '/schedules/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(upsertSchema.partial(), req);
    res.json(await updateSchedule(principal.organizationId, req.params.id, body));
  }),
);

monitoringRouter.post(
  '/schedules/:id/run',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.status(202).json(await runScheduleNow(principal.organizationId, req.params.id));
  }),
);

monitoringRouter.delete(
  '/schedules/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await deleteSchedule(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);

monitoringRouter.get(
  '/history',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({
        metricName: z.string().min(1),
        modelId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(30),
      }),
      req,
    );
    res.json(
      await metricHistory(principal.organizationId, query.metricName, {
        modelId: query.modelId,
        limit: query.limit,
      }),
    );
  }),
);
