import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, pageOf, param, parse } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { ctxOf } from '../modules/context.js';
import * as L from '../services/labeling.js';
import * as E from '../services/engine.js';
import * as X from '../services/exports.js';
import { qualityReport } from '../services/quality.js';

export const labelingRouter = Router();
const P = '/projects/:projectId';
const pid = (req: Parameters<typeof param>[0]) => param(req, 'projectId');

const labelDef = z.object({ value: z.string().trim().min(1).max(60), description: z.string().max(500).default(''), shortcut: z.string().max(3).optional() });
const configSchema = z
  .object({
    autoAcceptThreshold: z.number(),
    passes: z.number().int(),
    dropout: z.number().min(0).max(0.5),
    seed: z.number().int(),
    rules: z.array(z.object({ id: z.string(), label: z.string(), keywords: z.array(z.string()).max(50), description: z.string() })).max(100),
    carryOver: z.object({ enabled: z.boolean() }),
    quality: z.object({ minAccuracy: z.number().min(0).max(1), minLockedTest: z.number().int().min(1), maxReviewRate: z.number().min(0).max(1), minAuditAccuracy: z.number().min(0).max(1) }).partial(),
    auditRate: z.number().min(0).max(1),
    shortcuts: z.record(z.string().max(20)),
  })
  .partial();

labelingRouter.get('/projects', requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.listProjects(ctxOf(req)))));
labelingRouter.post(
  '/send-to-labeling',
  requirePermission('labeling.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        setId: z.string().uuid(),
        tableName: z.string(),
        name: z.string().trim().min(2).max(120),
        description: z.string().max(2000).optional(),
        purpose: z.string().max(2000).optional(),
        labels: z.array(labelDef).min(2).max(50),
        textFields: z.array(z.string()).min(1).max(10),
        contextFields: z.array(z.string()).max(20).optional(),
        sliceField: z.string().nullable().optional(),
        carryOverField: z.string().nullable().optional(),
        confirm: z.boolean(),
      }),
      req.body,
    );
    res.status(201).json(await L.sendToLabeling(ctxOf(req), body));
  }),
);
labelingRouter.get(P, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.projectDetail(ctxOf(req), pid(req)))));
labelingRouter.patch(
  P,
  requirePermission('labeling.manage'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ name: z.string().min(2).max(120).optional(), description: z.string().max(2000).optional(), purpose: z.string().max(2000).optional(), labels: z.array(labelDef).min(2).max(50).optional(), config: configSchema.optional(), status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).optional() }), req.body);
    res.json(await L.updateProject(ctxOf(req), pid(req), body as Parameters<typeof L.updateProject>[2]));
  }),
);
labelingRouter.post(`${P}/members`, requirePermission('labeling.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ userId: z.string().uuid(), role: z.enum(['LABELER', 'REVIEWER', 'PROJECT_MANAGER']) }), req.body);
  res.status(201).json(await L.addMember(ctxOf(req), pid(req), body.userId, body.role));
}));

// Guidelines & examples
labelingRouter.get(`${P}/guidelines`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.listGuidelineVersions(ctxOf(req), pid(req)))));
labelingRouter.post(`${P}/guidelines`, requirePermission('labeling.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ content: z.string().min(1).max(100_000), changeNote: z.string().min(3).max(500), decisionTree: z.unknown().optional(), publish: z.boolean().default(false) }), req.body);
  res.status(201).json(await L.createGuidelineVersion(ctxOf(req), pid(req), body));
}));
labelingRouter.post(`${P}/guidelines/:versionId/publish`, requirePermission('labeling.manage'), asyncHandler(async (req, res) => {
  await L.publishGuidelineVersion(ctxOf(req), pid(req), param(req, 'versionId'));
  res.json({ ok: true });
}));
labelingRouter.get(`${P}/examples`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.listExamples(ctxOf(req), pid(req)))));
labelingRouter.post(`${P}/examples`, requirePermission('labeling.review'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ text: z.string().min(1).max(10_000), label: z.string(), explanation: z.string().max(2000).optional(), taskId: z.string().uuid().optional() }), req.body);
  res.status(201).json(await L.addExample(ctxOf(req), pid(req), body));
}));
labelingRouter.delete(`${P}/examples/:id`, requirePermission('labeling.manage'), asyncHandler(async (req, res) => {
  await L.deleteExample(ctxOf(req), pid(req), param(req, 'id'));
  res.status(204).end();
}));

// Workspace
labelingRouter.get(`${P}/tasks`, requirePermission('labeling.read'), asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  res.json(await L.listTasks(ctxOf(req), pid(req), { ...pageOf(req.query, 500), status: q.status, label: q.label, source: q.source, slice: q.slice, q: q.q, sort: q.sort as L.TaskFilter['sort'], mine: q.mine === 'true', gold: q.gold === undefined ? undefined : q.gold === 'true' }));
}));
labelingRouter.get(`${P}/tasks/next`, requirePermission('labeling.label'), asyncHandler(async (req, res) => res.json(await L.nextTasks(ctxOf(req), pid(req), Number(req.query.count ?? 5), req.query.after ? String(req.query.after) : undefined))));
labelingRouter.get(`${P}/tasks/:taskId`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.getTask(ctxOf(req), pid(req), param(req, 'taskId')))));
labelingRouter.post(`${P}/labels`, requirePermission('labeling.label'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ taskId: z.string().uuid(), label: z.string(), durationMs: z.number().nonnegative().optional(), note: z.string().max(1000).optional() }), req.body);
  res.status(201).json(await L.submitLabel(ctxOf(req), pid(req), body));
}));
labelingRouter.post(`${P}/labels/bulk`, requirePermission('labeling.label'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ taskIds: z.array(z.string().uuid()).min(1).max(500), label: z.string() }), req.body);
  res.json(await L.bulkLabel(ctxOf(req), pid(req), body.taskIds, body.label));
}));
labelingRouter.post(`${P}/tasks/:taskId/:action(skip|flag|reopen)`, requirePermission('labeling.label'), asyncHandler(async (req, res) => {
  res.json(await L.setTaskStatus(ctxOf(req), pid(req), param(req, 'taskId'), req.params.action as 'skip' | 'flag' | 'reopen', typeof req.body?.note === 'string' ? req.body.note : undefined));
}));
labelingRouter.get(`${P}/views`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.listViews(ctxOf(req), pid(req)))));
labelingRouter.post(`${P}/views`, requirePermission('labeling.read'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1).max(80), filters: z.record(z.unknown()), shared: z.boolean().default(false) }), req.body);
  res.status(201).json(await L.saveView(ctxOf(req), pid(req), body));
}));
labelingRouter.delete(`${P}/views/:id`, requirePermission('labeling.read'), asyncHandler(async (req, res) => {
  await L.deleteView(ctxOf(req), pid(req), param(req, 'id'));
  res.status(204).end();
}));

// Gold
labelingRouter.get(`${P}/gold`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await L.listGold(ctxOf(req), pid(req), req.query.split as string | undefined, req.query.status as string | undefined))));
labelingRouter.post(`${P}/gold/sample`, requirePermission('gold.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ strategy: z.enum(['RANDOM', 'COVERAGE', 'HARD_CASE', 'DISAGREEMENT']), count: z.number().int().min(1).max(1000), split: z.enum(['EXAMPLE', 'TUNING', 'LOCKED_TEST']), requiredLabels: z.number().int().min(1).max(5).default(2) }), req.body);
  res.status(201).json(await L.sampleGold(ctxOf(req), pid(req), body));
}));
labelingRouter.patch(`${P}/gold/:id`, requirePermission('gold.manage'), asyncHandler(async (req, res) => {
  await L.moveGoldSplit(ctxOf(req), pid(req), param(req, 'id'), parse(z.object({ split: z.enum(['EXAMPLE', 'TUNING', 'LOCKED_TEST']) }), req.body).split);
  res.json({ ok: true });
}));
labelingRouter.post(`${P}/gold/:id/adjudicate`, requirePermission('labeling.review'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ label: z.string(), reason: z.string().max(1000) }), req.body);
  await L.adjudicate(ctxOf(req), pid(req), param(req, 'id'), body.label, body.reason);
  res.json({ ok: true });
}));
labelingRouter.post(`${P}/gold/lock`, requirePermission('gold.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ lock: z.boolean(), reason: z.string().max(1000).optional() }), req.body);
  await L.lockGold(ctxOf(req), pid(req), body.lock, body.reason);
  res.json({ ok: true });
}));

// Engine
const runBody = z.object({ scope: z.enum(['ALL_UNLABELED', 'TARGETED', 'GUIDELINE_AFFECTED']), taskIds: z.array(z.string().uuid()).max(10_000).optional(), engineType: z.enum(['DEMO', 'AI']).default('DEMO'), spendCap: z.number().positive().optional(), config: configSchema.optional() });
labelingRouter.post(`${P}/engine/estimate`, requirePermission('engine.run'), asyncHandler(async (req, res) => res.json(await E.estimate(ctxOf(req), pid(req), parse(runBody, req.body)))));
labelingRouter.post(`${P}/engine/runs`, requirePermission('engine.run'), asyncHandler(async (req, res) => res.status(202).json(await E.startRun(ctxOf(req), pid(req), parse(runBody, req.body) as Parameters<typeof E.startRun>[2]))));
labelingRouter.get(`${P}/engine/runs`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await E.listRuns(ctxOf(req), pid(req)))));
labelingRouter.get(`${P}/engine/runs/:runId`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await E.getRun(ctxOf(req), pid(req), param(req, 'runId')))));
labelingRouter.post(`${P}/engine/reprioritize`, requirePermission('engine.run'), asyncHandler(async (req, res) => {
  await L.getProjectOrThrow(ctxOf(req), pid(req));
  res.json({ updated: await E.reprioritize(pid(req)) });
}));
labelingRouter.get(`${P}/trials`, requirePermission('labeling.read'), asyncHandler(async (req, res) => res.json(await E.listTrials(ctxOf(req), pid(req)))));
labelingRouter.post(`${P}/trials`, requirePermission('engine.run'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1).max(80), config: configSchema }), req.body);
  res.status(201).json(await E.runSetupTrial(ctxOf(req), pid(req), body as Parameters<typeof E.runSetupTrial>[2]));
}));

// Review
labelingRouter.get(`${P}/review`, requirePermission('labeling.review'), asyncHandler(async (req, res) => {
  const { limit, offset } = pageOf(req.query);
  res.json(await E.reviewQueue(ctxOf(req), pid(req), req.query.mode === 'audit' ? 'audit' : 'review', limit, offset));
}));
labelingRouter.post(`${P}/review/:itemId`, requirePermission('labeling.review'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ action: z.enum(['accept', 'correct']), label: z.string().optional(), note: z.string().max(1000).optional(), addToExamples: z.boolean().optional() }), req.body);
  res.json(await E.reviewItem(ctxOf(req), pid(req), param(req, 'itemId'), body));
}));
labelingRouter.post(`${P}/review-bulk-accept`, requirePermission('labeling.review'), asyncHandler(async (req, res) => {
  res.json(await E.bulkAccept(ctxOf(req), pid(req), parse(z.object({ itemIds: z.array(z.string().uuid()).min(1).max(200) }), req.body).itemIds));
}));

// Quality
labelingRouter.get(`${P}/quality`, requirePermission('quality.read'), asyncHandler(async (req, res) => res.json(await qualityReport(ctxOf(req), pid(req)))));

// Exports
labelingRouter.get('/export-formats', requirePermission('exports.read'), (_req, res) => {
  res.json(Object.values(X.FORMATS).map(({ key, name, extension, description }) => ({ key, name, extension, description })));
});
labelingRouter.get(`${P}/exports`, requirePermission('exports.read'), asyncHandler(async (req, res) => res.json(await X.listExports(ctxOf(req), pid(req)))));
labelingRouter.post(`${P}/exports`, requirePermission('exports.create'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ format: z.string(), includeSplits: z.array(z.enum(['TRAIN', 'VALIDATION', 'TEST'])).min(1).default(['TRAIN']), overrideReason: z.string().max(2000).optional() }), req.body);
  res.status(202).json(await X.createExport(ctxOf(req), pid(req), body));
}));
labelingRouter.get(`${P}/exports/:exportId`, requirePermission('exports.read'), asyncHandler(async (req, res) => res.json(await X.getExport(ctxOf(req), pid(req), param(req, 'exportId')))));
labelingRouter.post(`${P}/exports/:exportId/download`, requirePermission('exports.read'), asyncHandler(async (req, res) => res.json(await X.downloadUrl(ctxOf(req), pid(req), param(req, 'exportId')))));
