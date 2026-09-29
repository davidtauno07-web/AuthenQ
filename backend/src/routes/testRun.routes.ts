import { Router } from 'express';
import { Role, TestRunStatus, TestType } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authenticate, requirePrincipal, requireRole } from '../middleware/auth.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import {
  cancelTestRun,
  createTestRun,
  getTestRun,
  listTestRuns,
} from '../services/testRun.service.js';
import { recordAudit } from '../services/audit.service.js';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';

export const testRunRouter = Router();
testRunRouter.use(authenticate);

const protectedAttributeSchema = z.object({
  name: z.string().min(1),
  values: z.array(z.string()).min(2),
  label: z.string().optional(),
});

const createSchema = z.object({
  testType: z.nativeEnum(TestType),
  modelId: z.string().uuid().nullable().optional(),
  datasetId: z.string().uuid().nullable().optional(),
  configuration: z
    .object({
      sampleSize: z.number().int().min(50).max(50_000).optional(),
      caseCount: z.number().int().min(50).max(50_000).optional(),
      protectedAttributes: z.array(protectedAttributeSchema).optional(),
      generateReport: z.boolean().optional(),
      privacy: z
        .object({
          suppressDirectIdentifiers: z.boolean().optional(),
          noiseLevel: z.number().min(0).max(1).optional(),
          kAnonymityTarget: z.number().int().min(2).max(100).optional(),
          generalizationBuckets: z.number().int().min(2).max(50).optional(),
        })
        .optional(),
    })
    .optional(),
});

testRunRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({
        status: z.nativeEnum(TestRunStatus).optional(),
        testType: z.nativeEnum(TestType).optional(),
        modelId: z.string().uuid().optional(),
        datasetId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
      req,
    );
    res.json(await listTestRuns(principal.organizationId, query));
  }),
);

testRunRouter.post(
  '/',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const body = parseBody(createSchema, req);
    const run = await createTestRun({
      organizationId: principal.organizationId,
      userId: principal.userId,
      testType: body.testType,
      modelId: body.modelId ?? null,
      datasetId: body.datasetId ?? null,
      configuration: body.configuration,
    });
    await recordAudit({
      organizationId: principal.organizationId,
      userId: principal.userId,
      action: 'TEST_RUN_STARTED',
      resourceType: 'TestRun',
      resourceId: run.id,
      metadata: { testType: run.testType, reference: run.reference },
    });
    res.status(202).json(run);
  }),
);

testRunRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await getTestRun(principal.organizationId, req.params.id));
  }),
);

/** Lightweight polling endpoint used by the UI while a run is executing. */
testRunRouter.get(
  '/:id/progress',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const run = await prisma.testRun.findFirst({
      where: { id: req.params.id, organizationId: principal.organizationId },
      select: {
        id: true,
        reference: true,
        status: true,
        progress: true,
        stage: true,
        stages: true,
        result: true,
        riskScore: true,
        errorMessage: true,
        startedAt: true,
        completedAt: true,
      },
    });
    if (!run) throw notFound('Test run not found');
    res.json(run);
  }),
);

testRunRouter.get(
  '/:id/counterfactuals',
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    const query = parseQuery(
      z.object({
        changedOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req,
    );
    const cases = await prisma.counterfactualCase.findMany({
      where: {
        fairnessTest: { testRun: { id: req.params.id, organizationId: principal.organizationId } },
        ...(query.changedOnly ? { outcomeChanged: true } : {}),
      },
      take: query.limit,
      include: { fairnessTest: { select: { protectedAttribute: true } } },
    });
    res.json(cases);
  }),
);

testRunRouter.post(
  '/:id/cancel',
  requireRole(Role.ANALYST),
  asyncHandler(async (req, res) => {
    const principal = requirePrincipal(req);
    res.json(await cancelTestRun(principal.organizationId, req.params.id));
  }),
);
