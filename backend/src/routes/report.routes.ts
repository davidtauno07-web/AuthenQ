import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { ReportFormat, ReportType, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody } from '../middleware/validate.js';
import { generateReport, getReport, listReports } from '../services/report.service.js';
import { recordAudit } from '../services/audit.service.js';
import { notFound } from '../utils/errors.js';

export const reportRouter = Router();
reportRouter.use(authenticate);

const CONTENT_TYPES: Record<ReportFormat, string> = {
  PDF: 'application/pdf',
  JSON: 'application/json',
  CSV: 'text/csv',
};

reportRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listReports(principal.organizationId));
  }),
);

reportRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({
        reportType: z.nativeEnum(ReportType),
        format: z.nativeEnum(ReportFormat).default(ReportFormat.PDF),
        testRunId: z.string().uuid().nullable().optional(),
        modelId: z.string().uuid().nullable().optional(),
        rangeStart: z.coerce.date().nullable().optional(),
        rangeEnd: z.coerce.date().nullable().optional(),
        title: z.string().min(3).optional(),
      }),
      req,
    );
    const report = await generateReport({
      organizationId: principal.organizationId,
      userId: principal.userId,
      ...body,
    });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'REPORT_GENERATED',
      resourceType: 'Report',
      resourceId: report.id,
      metadata: { reportType: report.reportType, format: report.format },
    });
    res.status(201).json(report);
  }),
);

reportRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await getReport(principal.organizationId, req.params.id));
  }),
);

reportRouter.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const report = await getReport(principal.organizationId, req.params.id);
    if (!report.fileLocation || !fs.existsSync(report.fileLocation)) {
      throw notFound('Report file is no longer available');
    }
    res.setHeader('Content-Type', CONTENT_TYPES[report.format]);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFileName(report.title)}.${report.format.toLowerCase()}"`,
    );
    fs.createReadStream(path.resolve(report.fileLocation)).pipe(res);
  }),
);

const sanitizeFileName = (title: string): string =>
  title.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase().slice(0, 80) ||
  'authenq-report';
