import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, pageOf, param, parse } from '../lib/http.js';
import { requirePermission } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { ctxOf } from '../modules/context.js';
import * as firewall from '../services/firewall.js';
import * as twin from '../services/twin.js';
import * as canary from '../services/canary.js';
import { badRequest } from '../lib/errors.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: firewall.MAX_UPLOAD_BYTES, files: 1 } });
export const dataRouter = Router();

// ── Firewall / data sources ──────────────────────────────────────────────────
dataRouter.get('/sources', requirePermission('sources.read'), asyncHandler(async (req, res) => res.json(await firewall.listSources(ctxOf(req)))));
dataRouter.post(
  '/sources',
  requirePermission('sources.write'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(120), description: z.string().max(2000).optional() }), req.body);
    res.status(201).json(await firewall.createSource(ctxOf(req), body));
  }),
);
dataRouter.get('/sources/:id', requirePermission('sources.read'), asyncHandler(async (req, res) => res.json(await firewall.getSourceDetail(ctxOf(req), param(req, 'id')))));
dataRouter.delete('/sources/:id', requirePermission('deletion.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ confirm: z.string() }), req.body ?? {});
  const s = await firewall.getSourceOrThrow(ctxOf(req), param(req, 'id'));
  if (body.confirm !== s.name) throw badRequest(`Type the source name "${s.name}" to confirm deletion.`);
  await firewall.deleteSource(ctxOf(req), s.id);
  res.status(204).end();
}));
dataRouter.post(
  '/sources/:id/upload',
  requirePermission('sources.write'),
  rateLimit('upload', 30, 3600),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Choose a file to upload.');
    const tableName = typeof req.body?.tableName === 'string' && req.body.tableName ? req.body.tableName : undefined;
    res.status(202).json(await firewall.uploadToSource(ctxOf(req), param(req, 'id'), req.file, tableName));
  }),
);
dataRouter.post('/sources/:id/scan', requirePermission('sources.write'), asyncHandler(async (req, res) => res.status(202).json(await firewall.startScan(ctxOf(req), param(req, 'id')))));
dataRouter.post('/sources/:id/sign-off', requirePermission('firewall.signoff'), asyncHandler(async (req, res) => res.json(await firewall.signOff(ctxOf(req), param(req, 'id')))));
dataRouter.get(
  '/sources/:id/tables/:tableId/preview',
  requirePermission('sources.real.preview'),
  asyncHandler(async (req, res) => res.json({ boundary: 'FIREWALL', rows: await firewall.previewRealRows(ctxOf(req), param(req, 'id'), param(req, 'tableId'), Number(req.query.limit ?? 20)) })),
);
dataRouter.patch(
  '/columns/:id/decision',
  requirePermission('firewall.decide'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ decision: z.enum(['REPLACE', 'GENERALIZE', 'KEEP', 'DROP', 'SCRUB_TEXT', 'KEY']), reason: z.string().max(500).optional(), generalization: z.record(z.unknown()).optional() }),
      req.body,
    );
    res.json(await firewall.decideColumn(ctxOf(req), param(req, 'id'), body));
  }),
);
dataRouter.patch(
  '/relations/:id',
  requirePermission('firewall.decide'),
  asyncHandler(async (req, res) => res.json(await firewall.confirmRelation(ctxOf(req), param(req, 'id'), parse(z.object({ confirmed: z.boolean() }), req.body).confirmed))),
);

// ── Twin / synthetic sets ───────────────────────────────────────────────────
dataRouter.get('/synthetic-sets', requirePermission('synthetic.read'), asyncHandler(async (req, res) => res.json(await twin.listSets(ctxOf(req)))));
dataRouter.post(
  '/sources/:id/synthetic-sets',
  requirePermission('synthetic.write'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().max(120).optional(),
        seed: z.number().int().min(0).max(2 ** 31).optional(),
        multiplier: z.number().min(0.1).max(10).optional(),
        amplify: z.array(z.object({ table: z.string(), column: z.string(), value: z.string(), factor: z.number().min(1).max(20) })).max(20).optional(),
      }),
      req.body,
    );
    res.status(202).json(await twin.createSyntheticSet(ctxOf(req), param(req, 'id'), body));
  }),
);
dataRouter.get('/synthetic-sets/:id', requirePermission('synthetic.read'), asyncHandler(async (req, res) => res.json(await twin.getSetDetail(ctxOf(req), param(req, 'id')))));
dataRouter.get(
  '/synthetic-sets/:id/rows',
  requirePermission('synthetic.read'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageOf(req.query);
    res.json(await twin.listSyntheticRows(ctxOf(req), param(req, 'id'), String(req.query.table ?? ''), limit, offset, req.query.q ? String(req.query.q) : undefined));
  }),
);
dataRouter.post(
  '/synthetic-sets/:id/release-hold',
  requirePermission('firewall.signoff'),
  asyncHandler(async (req, res) => {
    await twin.releaseSafetyHold(ctxOf(req), param(req, 'id'), parse(z.object({ reason: z.string() }), req.body).reason);
    res.json({ ok: true });
  }),
);
dataRouter.delete('/synthetic-sets/:id', requirePermission('deletion.manage'), asyncHandler(async (req, res) => {
  await twin.deleteSet(ctxOf(req), param(req, 'id'));
  res.status(204).end();
}));

// ── Canary ──────────────────────────────────────────────────────────────────
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
dataRouter.get('/canary/overview', requirePermission('canary.read'), asyncHandler(async (req, res) => res.json(await canary.canaryOverview(ctxOf(req)))));
dataRouter.get('/canary/registry', requirePermission('canary.read'), asyncHandler(async (req, res) => res.json(await canary.searchRegistry(ctxOf(req), String(req.query.q ?? ''), Math.min(Number(req.query.limit ?? 50), 200)))));
dataRouter.get('/canary/registry/:id', requirePermission('canary.read'), asyncHandler(async (req, res) => res.json(await canary.traceValue(ctxOf(req), param(req, 'id')))));
dataRouter.get('/canary/sends', requirePermission('canary.read'), asyncHandler(async (req, res) => res.json(await canary.listSends(ctxOf(req)))));
dataRouter.get('/canary/alerts', requirePermission('canary.read'), asyncHandler(async (req, res) => res.json(await canary.listAlerts(ctxOf(req), req.query.status ? String(req.query.status) : undefined))));
dataRouter.patch(
  '/canary/alerts/:id',
  requirePermission('canary.scan'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']), note: z.string().max(1000).optional() }), req.body);
    res.json(await canary.updateAlert(ctxOf(req), param(req, 'id'), body.status, body.note));
  }),
);
dataRouter.post(
  '/canary/scan',
  requirePermission('canary.scan'),
  rateLimit('canary-scan', 60, 3600),
  scanUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (req.file) {
      const ext = req.file.originalname.split('.').pop()?.toLowerCase() ?? '';
      if (!['txt', 'csv', 'tsv', 'json', 'jsonl', 'md', 'log'].includes(ext)) throw badRequest('Scan text-based files only: TXT, CSV, TSV, JSON, JSONL, MD or LOG.');
      const text = req.file.buffer.toString('utf8');
      if (text.includes('\u0000')) throw badRequest('The file appears to be binary.');
      res.json(await canary.scanText(ctxOf(req), { text, inputName: req.file.originalname, inputType: 'FILE' }));
      return;
    }
    const body = parse(z.object({ text: z.string().max(20_000_000), inputName: z.string().max(200).default('Pasted text') }), req.body);
    res.json(await canary.scanText(ctxOf(req), { text: body.text, inputName: body.inputName, inputType: req.ctx?.actorType === 'API_KEY' ? 'API' : 'TEXT' }));
  }),
);
dataRouter.post('/canary/scan-export/:id', requirePermission('canary.scan'), asyncHandler(async (req, res) => res.json(await canary.scanExport(ctxOf(req), param(req, 'id')))));
