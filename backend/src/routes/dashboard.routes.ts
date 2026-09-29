import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal } from '../middleware/auth.js';
import { parseQuery } from '../middleware/validate.js';
import {
  coverage,
  dashboardSummary,
  recentActivity,
  riskTrend,
} from '../services/dashboard.service.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await dashboardSummary(principal.organizationId));
  }),
);

dashboardRouter.get(
  '/trend',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({ days: z.coerce.number().int().min(7).max(365).default(60) }),
      req,
    );
    res.json(await riskTrend(principal.organizationId, query.days));
  }),
);

dashboardRouter.get(
  '/activity',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await recentActivity(principal.organizationId));
  }),
);

dashboardRouter.get(
  '/coverage',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await coverage(principal.organizationId));
  }),
);
