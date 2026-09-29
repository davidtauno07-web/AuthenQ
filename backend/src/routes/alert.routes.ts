import { Router } from 'express';
import { AlertSeverity, AlertStatus, AlertType, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { alertCounts, listAlerts, updateAlertStatus } from '../services/alert.service.js';
import { recordAudit } from '../services/audit.service.js';

export const alertRouter = Router();
alertRouter.use(authenticate);

alertRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({
        status: z.nativeEnum(AlertStatus).optional(),
        severity: z.nativeEnum(AlertSeverity).optional(),
        alertType: z.nativeEnum(AlertType).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      }),
      req,
    );
    res.json(await listAlerts(principal.organizationId, query));
  }),
);

alertRouter.get(
  '/counts',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await alertCounts(principal.organizationId));
  }),
);

alertRouter.patch(
  '/:id',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(z.object({ status: z.nativeEnum(AlertStatus) }), req);
    const alert = await updateAlertStatus(principal.organizationId, req.params.id, body.status);
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'ALERT_STATUS_CHANGED',
      resourceType: 'Alert',
      resourceId: alert.id,
      metadata: { status: alert.status },
    });
    res.json(alert);
  }),
);
