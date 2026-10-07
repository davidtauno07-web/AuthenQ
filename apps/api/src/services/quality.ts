import { prisma } from '../lib/prisma.js';
import { agreementWording, calibration, cohensKappa, thresholdWording, wilson } from '../domain/quality.js';
import type { RequestContext } from '../modules/context.js';
import { getProjectOrThrow, labelsOf, projectConfig, taskText } from './labeling.js';

interface StoredEval {
  n: number;
  correct: number;
  accuracy: number | null;
  interval: { low: number; high: number };
  perLabel: unknown[];
  confusion: { labels: string[]; matrix: number[][] };
  macroF1: number | null;
  calibrationItems?: { confidence: number; correct: boolean }[];
}

/** Computes the full quality report for a project from stored labels and runs. */
export async function qualityReport(ctx: RequestContext, projectId: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const cfg = projectConfig(p);
  const labels = labelsOf(p).map((l) => l.value);
  const latestRun = await prisma.engineRun.findFirst({ where: { projectId, status: 'COMPLETED' }, orderBy: { runNumber: 'desc' } });
  const totals = (latestRun?.totals ?? null) as { processed: number; autoAccepted: number; review: number; evaluation: StoredEval | null; trainedOn: number } | null;
  const evaluation = totals?.evaluation ?? null;

  // Human agreement on double-labeled gold.
  const goldLabels = await prisma.label.findMany({ where: { projectId, kind: 'GOLD' }, orderBy: { createdAt: 'asc' }, select: { taskId: true, userId: true, values: true, durationMs: true } });
  const byTask = new Map<string, { userId: string | null; label: string }[]>();
  for (const l of goldLabels) byTask.set(l.taskId, [...(byTask.get(l.taskId) ?? []), { userId: l.userId, label: (l.values as { label: string }).label }]);
  const a: string[] = [];
  const b: string[] = [];
  for (const ls of byTask.values()) {
    const distinctUsers = ls.filter((l, i) => ls.findIndex((x) => x.userId === l.userId) === i);
    if (distinctUsers.length >= 2) {
      a.push(distinctUsers[0]!.label);
      b.push(distinctUsers[1]!.label);
    }
  }
  const agreeCount = a.filter((x, i) => x === b[i]).length;
  const humanAgreement = a.length ? agreeCount / a.length : null;
  const kappa = cohensKappa(a, b);

  // Review rate and audit accuracy.
  const items = await prisma.engineItem.groupBy({ by: ['routing', 'reviewStatus'], where: { projectId }, _count: { _all: true } });
  const count = (routing?: string, status?: string) => items.filter((i) => (!routing || i.routing === routing) && (!status || i.reviewStatus === status)).reduce((s, i) => s + i._count._all, 0);
  const totalItems = count();
  const reviewRate = totalItems ? count('REVIEW') / totalItems : null;
  const reviewCorrected = count('REVIEW', 'CORRECTED');
  const reviewDone = reviewCorrected + count('REVIEW', 'ACCEPTED');
  const auditCorrect = count('AUTO_ACCEPT', 'ACCEPTED');
  const auditTotal = auditCorrect + count('AUTO_ACCEPT', 'CORRECTED');
  const auditAccuracy = auditTotal ? auditCorrect / auditTotal : null;

  // Distributions.
  const finals = await prisma.task.findMany({ where: { projectId, finalLabels: { not: undefined } }, select: { finalLabels: true, finalSource: true, sliceValue: true, status: true } });
  const labelDist: Record<string, number> = {};
  const sourceDist: Record<string, number> = {};
  for (const t of finals) {
    const l = (t.finalLabels as { label?: string } | null)?.label;
    if (!l) continue;
    labelDist[l] = (labelDist[l] ?? 0) + 1;
    sourceDist[t.finalSource ?? 'UNKNOWN'] = (sourceDist[t.finalSource ?? 'UNKNOWN'] ?? 0) + 1;
  }
  const statusCounts = await prisma.task.groupBy({ by: ['status'], where: { projectId }, _count: { _all: true } });

  // Time per task and labeler agreement with final gold.
  const humanLabels = await prisma.label.findMany({ where: { projectId, source: { in: ['HUMAN', 'GOLD'] }, userId: { not: null } }, select: { userId: true, durationMs: true, taskId: true, values: true } });
  const durations = humanLabels.map((l) => l.durationMs).filter((d): d is number => typeof d === 'number' && d > 0);
  const medianMs = durations.length ? [...durations].sort((x, y) => x - y)[Math.floor(durations.length / 2)]! : null;
  const goldFinal = await prisma.goldRecord.findMany({ where: { projectId, status: 'FINAL' }, select: { taskId: true, finalLabels: true, split: true, task: { select: { sliceValue: true, syntheticRow: { select: { data: true } } } } } });
  const goldByTask = new Map(goldFinal.map((g) => [g.taskId, (g.finalLabels as { label: string }).label]));
  const perUser = new Map<string, { n: number; agree: number; count: number }>();
  for (const l of humanLabels) {
    const u = perUser.get(l.userId!) ?? { n: 0, agree: 0, count: 0 };
    u.count++;
    const g = goldByTask.get(l.taskId);
    if (g) {
      u.n++;
      if ((l.values as { label: string }).label === g) u.agree++;
    }
    perUser.set(l.userId!, u);
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...perUser.keys()] } }, select: { id: true, name: true } });

  // Slice performance and error clusters on locked test (recomputed from stored per-item eval ordering is not kept, so use run evaluation + slices from engine predictions on test).
  const lockedTest = goldFinal.filter((g) => g.split === 'LOCKED_TEST');
  const slices: { slice: string; n: number; accuracy: number | null; interval: { low: number; high: number }; wording: string }[] = [];
  const clusters: { truth: string; predicted: string; count: number; examples: string[] }[] = [];
  if (evaluation && latestRun) {
    const { trainModel } = await import('./engine.js');
    const { predict } = await import('../domain/engine.js');
    const { model } = await trainModel(p);
    const runCfg = latestRun.config as unknown as Parameters<typeof predict>[2];
    const bySlice = new Map<string, { n: number; c: number }>();
    const errs = new Map<string, { count: number; examples: string[] }>();
    for (const g of lockedTest) {
      const text = taskText(p, g.task.syntheticRow.data as Record<string, unknown>);
      const pr = predict(model, text, { ...runCfg, carryOver: { enabled: false } }, `${latestRun.id}:eval:${g.taskId}`);
      const truth = (g.finalLabels as { label: string }).label;
      const s = g.task.sliceValue ?? '(none)';
      const cur = bySlice.get(s) ?? { n: 0, c: 0 };
      cur.n++;
      if (pr.label === truth) cur.c++;
      else {
        const k = `${truth}→${pr.label}`;
        const e = errs.get(k) ?? { count: 0, examples: [] };
        e.count++;
        if (e.examples.length < 3) e.examples.push(text.slice(0, 200));
        errs.set(k, e);
      }
      bySlice.set(s, cur);
    }
    for (const [slice, v] of bySlice) slices.push({ slice, n: v.n, accuracy: v.n ? v.c / v.n : null, interval: wilson(v.c, v.n), wording: thresholdWording(v.n ? v.c / v.n : null, cfg.quality.minAccuracy) });
    for (const [k, v] of [...errs.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 8)) {
      const [truth, predicted] = k.split('→');
      clusters.push({ truth: truth!, predicted: predicted!, count: v.count, examples: v.examples });
    }
  }

  const cal = evaluation?.calibrationItems ? calibration(evaluation.calibrationItems) : null;
  const lockedFinal = lockedTest.length;
  const checks = [
    { key: 'locked_test_size', label: 'Locked test size', value: lockedFinal, threshold: cfg.quality.minLockedTest, within: lockedFinal >= cfg.quality.minLockedTest, explanation: `${lockedFinal} final records in the locked test split; at least ${cfg.quality.minLockedTest} are needed for a reliable estimate.` },
    { key: 'gold_locked', label: 'Gold set locked', value: p.goldLockedAt ? 1 : 0, threshold: 1, within: !!p.goldLockedAt, explanation: p.goldLockedAt ? `Locked on ${p.goldLockedAt.toISOString().slice(0, 10)} (gold v${p.goldVersion}).` : 'Lock the gold set so the test split cannot change during evaluation.' },
    { key: 'accuracy', label: 'Engine accuracy (locked test)', value: evaluation?.accuracy ?? null, threshold: cfg.quality.minAccuracy, within: (evaluation?.accuracy ?? 0) >= cfg.quality.minAccuracy, explanation: evaluation ? `${evaluation.correct} of ${evaluation.n} locked-test records correct (95% interval ${(evaluation.interval.low * 100).toFixed(1)}–${(evaluation.interval.high * 100).toFixed(1)}%).` : 'No completed engine run has been evaluated on the locked test split.' },
    { key: 'review_rate', label: 'Review rate', value: reviewRate, threshold: cfg.quality.maxReviewRate, within: reviewRate !== null && reviewRate <= cfg.quality.maxReviewRate, explanation: reviewRate === null ? 'No engine items yet.' : `${count('REVIEW')} of ${totalItems} engine items were routed to human review.` },
    { key: 'review_complete', label: 'Review queue complete', value: count('REVIEW', 'PENDING'), threshold: 0, within: count('REVIEW', 'PENDING') === 0, explanation: `${count('REVIEW', 'PENDING')} items are still waiting for review.` },
    { key: 'audit_accuracy', label: 'Audit accuracy', value: auditAccuracy, threshold: cfg.quality.minAuditAccuracy, within: auditAccuracy === null ? true : auditAccuracy >= cfg.quality.minAuditAccuracy, explanation: auditTotal ? `${auditCorrect} of ${auditTotal} audited auto-accepted labels were confirmed by a reviewer.` : 'No auto-accepted labels have been audited yet (recommended, not required).' },
  ].map((c) => ({ ...c, wording: c.within ? 'within threshold' : 'outside threshold' }));

  return {
    projectId,
    goldVersion: p.goldVersion,
    run: latestRun ? { id: latestRun.id, runNumber: latestRun.runNumber, engineType: latestRun.engineType, engineVersion: latestRun.engineVersion, finishedAt: latestRun.finishedAt, trainedOn: totals?.trainedOn } : null,
    evaluation: evaluation ? { n: evaluation.n, correct: evaluation.correct, accuracy: evaluation.accuracy, interval: evaluation.interval, macroF1: evaluation.macroF1, perLabel: evaluation.perLabel, confusion: evaluation.confusion, wording: thresholdWording(evaluation.accuracy, cfg.quality.minAccuracy), agreementWording: agreementWording(evaluation.accuracy, humanAgreement) } : null,
    humanAgreement: { pairs: a.length, agreement: humanAgreement, kappa, interval: wilson(agreeCount, a.length) },
    calibration: cal,
    reviewRate,
    review: { done: reviewDone, corrected: reviewCorrected, pending: count('REVIEW', 'PENDING'), correctionRate: reviewDone ? reviewCorrected / reviewDone : null },
    audit: { total: auditTotal, correct: auditCorrect, accuracy: auditAccuracy },
    slices,
    errorClusters: clusters,
    labelDistribution: labels.map((l) => ({ label: l, count: labelDist[l] ?? 0 })),
    sourceDistribution: Object.entries(sourceDist).map(([source, n]) => ({ source, count: n })),
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])),
    timePerTask: { medianMs, samples: durations.length },
    labelers: [...perUser.entries()].map(([id, u]) => ({ userId: id, name: users.find((x) => x.id === id)?.name ?? 'Unknown', labels: u.count, goldCompared: u.n, agreementWithGold: u.n ? u.agree / u.n : null })),
    gate: { ready: checks.filter((c) => c.key !== 'audit_accuracy').every((c) => c.within) && checks.find((c) => c.key === 'audit_accuracy')!.within, checks },
    thresholds: cfg.quality,
  };
}
