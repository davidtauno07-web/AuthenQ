import { prisma, Prisma } from '../lib/prisma.js';
import { decryptSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { createRng, hashSeed } from '../lib/prng.js';
import { DEMO_ENGINE_VERSION, estimateRun, NaiveBayes, predict, priorityFor, tokenize, type EngineConfig } from '../domain/engine.js';
import { evaluate } from '../domain/quality.js';
import { labelWithAi } from '../domain/aiGateway.js';
import { audit } from '../modules/audit.js';
import type { RequestContext } from '../modules/context.js';
import { enqueue, type JobReporter } from '../modules/jobs/queue.js';
import { emit, isFeatureEnabled, notifyRole, recordUsage } from '../modules/platform/events.js';
import { getProjectOrThrow, labelsOf, projectConfig, taskText, type ProjectConfig } from './labeling.js';

type Project = Awaited<ReturnType<typeof getProjectOrThrow>>;

function engineConfig(p: Project, override?: Partial<ProjectConfig>): EngineConfig {
  const c = { ...projectConfig(p), ...(override ?? {}) };
  return { labels: labelsOf(p).map((l) => l.value), rules: c.rules, autoAcceptThreshold: c.autoAcceptThreshold, passes: c.passes, dropout: c.dropout, seed: c.seed, carryOver: c.carryOver };
}

/**
 * Trains the demo model on human truth only: human/review/adjudicated labels,
 * example and tuning gold, and the example bank. Locked-test gold is never
 * used for training so evaluation stays independent.
 */
export async function trainModel(p: Project, opts: { excludeTuning?: boolean } = {}) {
  const labels = labelsOf(p).map((l) => l.value);
  const model = new NaiveBayes(labels);
  const tasks = await prisma.task.findMany({
    where: {
      projectId: p.id,
      finalSource: { in: ['HUMAN', 'REVIEW', 'ADJUDICATION', 'GOLD'] },
      OR: [{ gold: { is: null } }, { gold: { split: opts.excludeTuning ? 'EXAMPLE' : { in: ['EXAMPLE', 'TUNING'] } } }],
    },
    select: { finalLabels: true, syntheticRow: { select: { data: true } } },
  });
  for (const t of tasks) model.train(tokenize(taskText(p, t.syntheticRow.data as Record<string, unknown>)), (t.finalLabels as { label: string }).label);
  const examples = await prisma.exampleBank.findMany({ where: { projectId: p.id } });
  for (const e of examples) model.train(tokenize(e.text), (e.labels as { label: string }).label);
  return { model, trainedOn: tasks.length + examples.length };
}

async function scopeTasks(p: Project, scope: string, taskIds?: string[]) {
  const where: Prisma.TaskWhereInput = { projectId: p.id, gold: { is: null } };
  if (scope === 'TARGETED') {
    if (!taskIds?.length) throw badRequest('Choose the tasks to run the engine on.');
    where.id = { in: taskIds };
  } else if (scope === 'GUIDELINE_AFFECTED') {
    where.status = { in: ['DONE', 'IN_REVIEW'] };
    where.finalSource = { in: ['ENGINE_MODEL', 'ENGINE_RULE', 'ENGINE_CARRY_OVER'] };
    where.engineItems = { some: { guidelineVersionId: { not: p.activeGuidelineVersionId } } };
  } else where.status = { in: ['OPEN', 'SKIPPED'] };
  return prisma.task.findMany({ where, select: { id: true, ordinal: true, syntheticRow: { select: { data: true } } }, orderBy: { ordinal: 'asc' } });
}

export async function estimate(ctx: RequestContext, projectId: string, input: { scope: string; taskIds?: string[]; engineType: 'DEMO' | 'AI' }) {
  const p = await getProjectOrThrow(ctx, projectId);
  const tasks = await scopeTasks(p, input.scope, input.taskIds);
  const { model, trainedOn } = await trainModel(p);
  const cfg = engineConfig(p);
  const sample = tasks.slice(0, 200).map((t) => taskText(p, t.syntheticRow.data as Record<string, unknown>));
  const est = estimateRun(tasks.length, model, sample, cfg);
  const lockedTest = await prisma.goldRecord.count({ where: { projectId, split: 'LOCKED_TEST', status: 'FINAL' } });
  const warnings: string[] = [];
  if (trainedOn < 20) warnings.push(`Only ${trainedOn} human-labeled examples are available. Most items will be routed to review.`);
  if (lockedTest < projectConfig(p).quality.minLockedTest) warnings.push(`The locked test split has ${lockedTest} final records, so accuracy cannot be measured reliably yet.`);
  if (input.engineType === 'AI') {
    const provider = await prisma.aiProvider.findFirst({ where: { orgId: ctx.orgId, enabled: true } });
    if (!provider) warnings.push('No external AI provider is enabled. Configure one in Settings → AI providers, or use the demo engine.');
    est.estimatedCost = Math.round(tasks.length * 0.0006 * 100) / 100;
    est.costNote = 'Estimated from about 600 tokens per record at typical provider pricing; actual cost depends on your provider.';
  }
  return { ...est, trainedOn, lockedTest, warnings, engineVersion: input.engineType === 'DEMO' ? DEMO_ENGINE_VERSION : 'ai-gateway-1' };
}

export async function startRun(ctx: RequestContext, projectId: string, input: { scope: string; taskIds?: string[]; engineType: 'DEMO' | 'AI'; spendCap?: number; config?: Partial<ProjectConfig> }) {
  const p = await getProjectOrThrow(ctx, projectId);
  const running = await prisma.engineRun.count({ where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } } });
  if (running) throw badRequest('An engine run is already in progress for this project.');
  const est = await estimate(ctx, projectId, input);
  if (!est.items) throw badRequest('There are no tasks in this scope to run.');
  if (input.engineType === 'AI') {
    if (!(await isFeatureEnabled(ctx.orgId, 'engine.external_ai'))) throw badRequest('External AI engine runs are disabled for this organization. An admin can enable "engine.external_ai" in Settings → Feature flags.');
    if (!(await prisma.aiProvider.findFirst({ where: { orgId: ctx.orgId, enabled: true } }))) throw badRequest('No external AI provider is enabled. Configure one in Settings or use the demo engine.');
    if (input.spendCap !== undefined && est.estimatedCost > input.spendCap) throw badRequest(`The estimated cost (${est.estimatedCost}) exceeds the spend cap (${input.spendCap}).`);
  }
  const last = await prisma.engineRun.findFirst({ where: { projectId }, orderBy: { runNumber: 'desc' } });
  const run = await prisma.engineRun.create({
    data: {
      orgId: ctx.orgId,
      projectId,
      runNumber: (last?.runNumber ?? 0) + 1,
      engineType: input.engineType,
      engineVersion: est.engineVersion,
      scope: input.scope,
      config: { ...engineConfig(p, input.config), taskIds: input.taskIds ?? null } as unknown as Prisma.InputJsonValue,
      guidelineVersionId: p.activeGuidelineVersionId,
      goldVersion: p.goldVersion,
      estimate: est as unknown as Prisma.InputJsonValue,
      spendCap: input.spendCap,
      createdById: ctx.userId,
    },
  });
  const job = await enqueue({ orgId: ctx.orgId, type: 'ENGINE_RUN', payload: { runId: run.id }, resourceType: 'engine_run', resourceId: run.id, createdById: ctx.userId });
  await prisma.engineRun.update({ where: { id: run.id }, data: { jobId: job.id } });
  await audit(ctx, { action: 'engine.run_started', resourceType: 'engine_run', resourceId: run.id, summary: `Started ${input.engineType === 'DEMO' ? 'demo engine' : 'AI engine'} run #${run.runNumber} on ${est.items} tasks`, jobId: job.id });
  return { ...run, jobId: job.id };
}

export async function runEngineJob(orgId: string, payload: { runId: string }, reporter: JobReporter) {
  const run = await prisma.engineRun.update({ where: { id: payload.runId }, data: { status: 'RUNNING', startedAt: new Date() } });
  const p = await prisma.labelProject.findUniqueOrThrow({ where: { id: run.projectId } });
  const cfg = run.config as unknown as EngineConfig & { taskIds: string[] | null };
  const { model, trainedOn } = await trainModel(p);
  const done = new Set((await prisma.engineItem.findMany({ where: { runId: run.id }, select: { taskId: true } })).map((x) => x.taskId));
  const tasks = (await scopeTasks(p, run.scope, cfg.taskIds ?? undefined)).filter((t) => !done.has(t.id));
  const carryField = (p.carryOverField as { field?: string } | null)?.field;
  const guideline = p.activeGuidelineVersionId ? await prisma.guidelineVersion.findUnique({ where: { id: p.activeGuidelineVersionId } }) : null;
  const provider = run.engineType === 'AI' ? await prisma.aiProvider.findFirst({ where: { orgId, enabled: true } }) : null;
  const examples = run.engineType === 'AI' ? await prisma.exampleBank.findMany({ where: { projectId: p.id }, take: 20 }) : [];
  const totals = { processed: done.size, autoAccepted: 0, review: 0, bySource: {} as Record<string, number> };
  let cost = run.actualCost;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const data = t.syntheticRow.data as Record<string, unknown>;
    const text = taskText(p, data);
    let pred = predict(model, text, cfg, `${run.id}:${t.id}`, carryField ? String(data[carryField] ?? '') : null);
    let modelInfo: Record<string, unknown> = { engine: DEMO_ENGINE_VERSION, algorithm: 'multinomial-naive-bayes', smoothing: 'laplace(1)', trainedOn };
    if (provider && pred.source === 'MODEL') {
      const r = await labelWithAi(
        { provider: provider.provider as 'OPENAI_COMPATIBLE', model: provider.model, baseUrl: provider.baseUrl, apiKey: provider.apiKeyEnc ? decryptSecret(provider.apiKeyEnc) : null },
        {
          guideline: { dataClass: 'GUIDELINE', content: guideline?.content ?? '' },
          examples: examples.map((e) => ({ dataClass: 'SYNTHETIC' as const, content: `${e.text}\n=> ${(e.labels as { label: string }).label}` })),
          record: { dataClass: 'SYNTHETIC', content: text },
        },
        cfg.labels,
      );
      cost += 0.0006;
      modelInfo = { engine: 'ai-gateway-1', provider: provider.provider, model: provider.model, attempts: r.attempts };
      const auto = r.ok && r.confidence >= cfg.autoAcceptThreshold;
      pred = {
        ...pred,
        label: r.label ?? pred.label,
        confidence: r.ok ? r.confidence : 0,
        rationale: r.rationale,
        routing: auto ? 'AUTO_ACCEPT' : 'REVIEW',
        routingReason: r.ok ? (auto ? 'AI confidence at or above threshold.' : 'AI confidence below threshold.') : `Malformed or failed AI response: ${r.error}`,
      };
      if (run.spendCap !== null && cost > run.spendCap) {
        await reporter.event('Spend cap reached; stopping the run.', 'WARN');
        break;
      }
    }
    const sourceLabel = pred.source === 'CARRY_OVER' ? 'ENGINE_CARRY_OVER' : pred.source === 'RULE' ? 'ENGINE_RULE' : 'ENGINE_MODEL';
    await prisma.$transaction(async (tx) => {
      const item = await tx.engineItem.create({
        data: {
          orgId,
          runId: run.id,
          projectId: p.id,
          taskId: t.id,
          predicted: { label: pred.label },
          source: pred.source,
          confidence: pred.confidence,
          rationale: pred.rationale,
          ruleCited: pred.ruleCited,
          modelInfo: modelInfo as Prisma.InputJsonValue,
          passes: pred.passes as unknown as Prisma.InputJsonValue,
          routing: pred.routing,
          routingReason: pred.routingReason,
          reviewStatus: pred.routing === 'REVIEW' ? 'PENDING' : 'NOT_REQUIRED',
          guidelineVersionId: p.activeGuidelineVersionId,
        },
      });
      if (pred.routing === 'AUTO_ACCEPT') {
        const l = await tx.label.create({ data: { orgId, projectId: p.id, taskId: t.id, values: { label: pred.label }, source: sourceLabel, kind: 'FINAL', engineRunId: run.id, engineItemId: item.id, guidelineVersionId: p.activeGuidelineVersionId } });
        await tx.task.update({ where: { id: t.id }, data: { status: 'DONE', finalLabels: { label: pred.label }, finalSource: sourceLabel, finalLabelId: l.id } });
      } else {
        await tx.task.update({ where: { id: t.id }, data: { status: 'IN_REVIEW' } });
      }
    });
    totals.processed++;
    if (pred.routing === 'AUTO_ACCEPT') totals.autoAccepted++;
    else totals.review++;
    totals.bySource[pred.source] = (totals.bySource[pred.source] ?? 0) + 1;
    if (i % 25 === 0 || i === tasks.length - 1) await reporter.progress(totals.processed, done.size + tasks.length, { processed: totals.processed });
  }

  // Independent evaluation on the locked test split (never used for training).
  const test = await prisma.goldRecord.findMany({ where: { projectId: p.id, split: 'LOCKED_TEST', status: 'FINAL' }, include: { task: { select: { id: true, syntheticRow: { select: { data: true } } } } } });
  const truth: string[] = [];
  const predicted: string[] = [];
  const calibrationItems: { confidence: number; correct: boolean }[] = [];
  for (const g of test) {
    const pr = predict(model, taskText(p, g.task.syntheticRow.data as Record<string, unknown>), { ...cfg, carryOver: { enabled: false } }, `${run.id}:eval:${g.taskId}`);
    const tl = (g.finalLabels as { label: string }).label;
    truth.push(tl);
    predicted.push(pr.label);
    calibrationItems.push({ confidence: pr.confidence, correct: pr.label === tl });
  }
  const evaluation = test.length ? { ...evaluate(truth, predicted, cfg.labels), calibrationItems } : null;
  await prisma.engineRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', finishedAt: new Date(), actualCost: cost, totals: { ...totals, trainedOn, evaluation } as unknown as Prisma.InputJsonValue } });
  await reprioritize(p.id, model);
  await recordUsage(orgId, 'engine.items', totals.processed, 'engine_run', run.id);
  await emit(orgId, 'engine_run.completed', { runId: run.id, projectId: p.id, totals });
  await notifyRole(orgId, ['ADMIN', 'PROJECT_MANAGER', 'REVIEWER'], 'engine.done', `Engine run #${run.runNumber} finished`, `${totals.autoAccepted} auto-accepted, ${totals.review} routed to review.`, `/projects/${p.id}/review`);
  return totals;
}

/** Active-learning priorities for the remaining open tasks. */
export async function reprioritize(projectId: string, model?: NaiveBayes) {
  const p = await prisma.labelProject.findUniqueOrThrow({ where: { id: projectId } });
  const m = model ?? (await trainModel(p)).model;
  const open = await prisma.task.findMany({ where: { projectId, status: 'OPEN' }, select: { id: true, syntheticRow: { select: { data: true } } }, take: 20_000 });
  for (let i = 0; i < open.length; i += 200) {
    await prisma.$transaction(
      open.slice(i, i + 200).map((t) => {
        const pr = priorityFor(m, taskText(p, t.syntheticRow.data as Record<string, unknown>));
        return prisma.task.update({ where: { id: t.id }, data: { priority: pr.priority, priorityReason: pr.reason } });
      }),
    );
  }
  return open.length;
}

export async function listRuns(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.engineRun.findMany({ where: { projectId }, orderBy: { runNumber: 'desc' } });
}

export async function getRun(ctx: RequestContext, projectId: string, runId: string) {
  await getProjectOrThrow(ctx, projectId);
  const run = await prisma.engineRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw notFound('Engine run');
  const routing = await prisma.engineItem.groupBy({ by: ['routing', 'reviewStatus'], where: { runId }, _count: { _all: true } });
  return { ...run, routing: routing.map((r) => ({ routing: r.routing, reviewStatus: r.reviewStatus, count: r._count._all })) };
}

// ── Review ───────────────────────────────────────────────────────────────────
export async function reviewQueue(ctx: RequestContext, projectId: string, mode: 'review' | 'audit', limit: number, offset: number) {
  const p = await getProjectOrThrow(ctx, projectId);
  const where: Prisma.EngineItemWhereInput =
    mode === 'review' ? { projectId, routing: 'REVIEW', reviewStatus: 'PENDING' } : { projectId, routing: 'AUTO_ACCEPT', reviewStatus: 'NOT_REQUIRED' };
  const total = await prisma.engineItem.count({ where });
  let items;
  if (mode === 'audit') {
    const cfg = projectConfig(p);
    const all = await prisma.engineItem.findMany({ where, select: { id: true } });
    const rng = createRng(hashSeed(projectId, 'audit', p.goldVersion));
    const sampleSize = Math.min(all.length, Math.max(1, Math.ceil(all.length * cfg.auditRate)));
    const ids = rng.shuffle(all.map((a) => a.id)).slice(0, sampleSize);
    items = await prisma.engineItem.findMany({ where: { id: { in: ids } }, include: { task: { include: { syntheticRow: { select: { data: true, syntheticKey: true } } } } } });
  } else {
    items = await prisma.engineItem.findMany({ where, orderBy: { confidence: 'asc' }, take: limit, skip: offset, include: { task: { include: { syntheticRow: { select: { data: true, syntheticKey: true } } } } } });
  }
  return {
    total,
    items: items.map((i) => ({
      id: i.id,
      taskId: i.taskId,
      ordinal: i.task.ordinal,
      key: i.task.syntheticRow.syntheticKey,
      text: taskText(p, i.task.syntheticRow.data as Record<string, unknown>),
      context: Object.fromEntries(p.contextFields.map((f) => [f, (i.task.syntheticRow.data as Record<string, unknown>)[f]])),
      predicted: (i.predicted as { label: string }).label,
      source: i.source,
      confidence: i.confidence,
      rationale: i.rationale,
      ruleCited: i.ruleCited,
      routingReason: i.routingReason,
      passes: i.passes,
      reviewStatus: i.reviewStatus,
    })),
  };
}

export async function reviewItem(ctx: RequestContext, projectId: string, itemId: string, input: { action: 'accept' | 'correct'; label?: string; note?: string; addToExamples?: boolean }) {
  const p = await getProjectOrThrow(ctx, projectId);
  const item = await prisma.engineItem.findFirst({ where: { id: itemId, projectId }, include: { task: { include: { syntheticRow: true } } } });
  if (!item) throw notFound('Engine item');
  if (['ACCEPTED', 'CORRECTED'].includes(item.reviewStatus)) throw badRequest('This item has already been reviewed.');
  const predicted = (item.predicted as { label: string }).label;
  const final = input.action === 'accept' ? predicted : input.label;
  if (!final || !labelsOf(p).some((l) => l.value === final)) throw badRequest('Choose a valid label for the correction.');
  if (input.action === 'correct' && final === predicted) throw badRequest('The correction is the same as the engine prediction. Use Accept instead.');
  await prisma.$transaction(async (tx) => {
    const l = await tx.label.create({ data: { orgId: ctx.orgId, projectId, taskId: item.taskId, userId: ctx.userId, values: { label: final }, source: 'REVIEW', kind: 'REVIEW', engineRunId: item.runId, engineItemId: item.id, guidelineVersionId: p.activeGuidelineVersionId, note: input.note } });
    // Original engine output stays on the engine item; the task's final label becomes the reviewed truth.
    await tx.engineItem.update({ where: { id: item.id }, data: { reviewStatus: input.action === 'accept' ? 'ACCEPTED' : 'CORRECTED', reviewedById: ctx.userId, reviewedAt: new Date() } });
    await tx.task.update({ where: { id: item.taskId }, data: { status: 'DONE', finalLabels: { label: final }, finalSource: 'REVIEW', finalLabelId: l.id } });
    if (input.action === 'correct' && input.addToExamples) {
      await tx.exampleBank.create({ data: { orgId: ctx.orgId, projectId, taskId: item.taskId, text: taskText(p, item.task.syntheticRow.data as Record<string, unknown>), labels: { label: final }, explanation: input.note ?? `Engine predicted ${predicted}; reviewer corrected.`, source: 'REVIEW_CORRECTION', createdById: ctx.userId } });
    }
    if (input.action === 'correct') await audit(ctx, { action: 'review.corrected', resourceType: 'engine_item', resourceId: item.id, summary: `Corrected engine label on task #${item.task.ordinal} from "${predicted}" to "${final}"`, before: { label: predicted }, after: { label: final } }, tx);
  });
  return { final };
}

export async function bulkAccept(ctx: RequestContext, projectId: string, itemIds: string[]) {
  let n = 0;
  for (const id of itemIds.slice(0, 200)) {
    await reviewItem(ctx, projectId, id, { action: 'accept' }).then(() => n++).catch(() => undefined);
  }
  await audit(ctx, { action: 'review.bulk_accept', resourceType: 'label_project', resourceId: projectId, summary: `Accepted ${n} engine labels in bulk` });
  return { accepted: n };
}

// ── Setup trials ─────────────────────────────────────────────────────────────
export async function runSetupTrial(ctx: RequestContext, projectId: string, input: { name: string; config: Partial<ProjectConfig> }) {
  const p = await getProjectOrThrow(ctx, projectId);
  const tuning = await prisma.goldRecord.findMany({ where: { projectId, split: 'TUNING', status: 'FINAL' }, include: { task: { select: { syntheticRow: { select: { data: true } } } } } });
  if (tuning.length < 10) throw badRequest(`Setup trials need at least 10 final tuning gold records (there are ${tuning.length}).`);
  const { model, trainedOn } = await trainModel(p, { excludeTuning: true });
  const cfg = engineConfig(p, input.config);
  const truth: string[] = [];
  const pred: string[] = [];
  let auto = 0;
  let autoCorrect = 0;
  tuning.forEach((g, i) => {
    const pr = predict(model, taskText(p, g.task.syntheticRow.data as Record<string, unknown>), { ...cfg, carryOver: { enabled: false } }, `trial:${i}`);
    const tl = (g.finalLabels as { label: string }).label;
    truth.push(tl);
    pred.push(pr.label);
    if (pr.routing === 'AUTO_ACCEPT') {
      auto++;
      if (pr.label === tl) autoCorrect++;
    }
  });
  const ev = evaluate(truth, pred, cfg.labels);
  const metrics = { n: tuning.length, trainedOn, accuracy: ev.accuracy, interval: ev.interval, macroF1: ev.macroF1, autoRate: auto / tuning.length, autoAccuracy: auto ? autoCorrect / auto : null };
  const trial = await prisma.setupTrial.create({ data: { orgId: ctx.orgId, projectId, name: input.name, config: cfg as unknown as Prisma.InputJsonValue, metrics: metrics as unknown as Prisma.InputJsonValue, createdById: ctx.userId } });
  await audit(ctx, { action: 'engine.setup_trial', resourceType: 'setup_trial', resourceId: trial.id, summary: `Ran setup trial "${input.name}" on ${tuning.length} tuning records` });
  return trial;
}

export async function listTrials(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.setupTrial.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
}
