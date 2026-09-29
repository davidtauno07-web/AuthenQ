import { Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  createDataset,
  deleteDataset,
  getDataset,
  listDatasets,
  loadSyntheticRecords,
  scanDataset,
} from '../services/dataset.service.js';
import { generateSyntheticDataset } from '../services/synthetic.service.js';
import { recordAudit } from '../services/audit.service.js';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';

export const datasetRouter = Router();
datasetRouter.use(authenticate);

const schemaFieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date']),
  nullable: z.boolean().optional(),
  description: z.string().optional(),
});

datasetRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await listDatasets(principal.organizationId));
  }),
);

datasetRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({
        name: z.string().min(2),
        version: z.string().optional(),
        domain: z.string().nullable().optional(),
        dataSourceId: z.string().uuid().nullable().optional(),
        schema: z.array(schemaFieldSchema).min(1),
        records: z.array(z.record(z.unknown())).optional(),
      }),
      req,
    );
    const dataset = await createDataset({ ...body, organizationId: principal.organizationId });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'DATASET_CREATED',
      resourceType: 'Dataset',
      resourceId: dataset.id,
      metadata: { name: dataset.name, recordCount: dataset.recordCount },
    });
    res.status(201).json(dataset);
  }),
);

datasetRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await getDataset(principal.organizationId, req.params.id));
  }),
);

datasetRouter.post(
  '/:id/scan',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const result = await scanDataset(principal.organizationId, req.params.id);
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'DATASET_SCANNED',
      resourceType: 'Dataset',
      resourceId: req.params.id,
      metadata: { detected: result.detections.length },
    });
    res.json(result);
  }),
);

datasetRouter.post(
  '/:id/synthetic',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(
      z.object({
        recordCount: z.number().int().min(10).max(50_000).optional(),
        configuration: z
          .object({
            suppressDirectIdentifiers: z.boolean().optional(),
            noiseLevel: z.number().min(0).max(1).optional(),
            kAnonymityTarget: z.number().int().min(2).max(100).optional(),
            generalizationBuckets: z.number().int().min(2).max(50).optional(),
          })
          .optional(),
      }),
      req,
    );
    const result = await generateSyntheticDataset({
      organizationId: principal.organizationId,
      datasetId: req.params.id,
      recordCount: body.recordCount,
      configuration: body.configuration,
    });
    // Raw generated rows stay server side; the client gets a preview only.
    res.status(201).json({ ...result, records: result.records.slice(0, 25) });
  }),
);

datasetRouter.get(
  '/:id/synthetic/:syntheticId/preview',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      req,
    );
    const synthetic = await prisma.syntheticDataset.findFirst({
      where: {
        id: req.params.syntheticId,
        dataset: { id: req.params.id, organizationId: principal.organizationId },
      },
    });
    if (!synthetic) throw notFound('Synthetic dataset not found');
    res.json({
      syntheticDatasetId: synthetic.id,
      records: await loadSyntheticRecords(synthetic.id, query.limit),
    });
  }),
);

datasetRouter.get(
  '/:id/adversarial-cases',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const cases = await prisma.adversarialCase.findMany({
      where: {
        syntheticDataset: {
          dataset: { id: req.params.id, organizationId: principal.organizationId },
        },
      },
      orderBy: { riskScore: 'desc' },
      take: 100,
    });
    res.json(cases);
  }),
);

datasetRouter.delete(
  '/:id',
  requireRole(Role.ORG_ADMIN),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    await deleteDataset(principal.organizationId, req.params.id);
    res.status(204).end();
  }),
);
