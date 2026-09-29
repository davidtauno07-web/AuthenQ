import { TestRunStatus, TestType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { round } from '../utils/stats.js';

export interface RegressionFinding {
  metricName: string;
  previousValue: number;
  currentValue: number;
  delta: number;
  regressed: boolean;
  baselineTestRunId: string;
  baselineReference: string;
  baselineModelVersion: string | null;
  comparedAgainst: 'PREVIOUS_RUN' | 'PREVIOUS_MODEL_VERSION' | 'CONFIGURED_BASELINE';
}

/** Metrics where a larger value means a worse outcome. */
const HIGHER_IS_WORSE = new Set([
  'privacy_risk_score',
  'counterfactual_flip_rate',
  'demographic_parity_difference',
  'equal_opportunity_difference',
  'selection_rate_difference',
  'reidentification_rate',
]);

/**
 * Compares a completed run with the most recent comparable prior run for the
 * same model, and reports metrics that moved in the worsening direction by
 * more than the configured delta.
 */
export const detectRegressions = async (params: {
  organizationId: string;
  testRunId: string;
  modelId: string | null;
  testType: TestType;
  regressionDelta: number;
}): Promise<RegressionFinding[]> => {
  const current = await prisma.testRun.findFirst({
    where: { id: params.testRunId, organizationId: params.organizationId },
    include: { metrics: true },
  });
  if (!current) return [];

  const baseline = await prisma.testRun.findFirst({
    where: {
      organizationId: params.organizationId,
      modelId: params.modelId ?? undefined,
      testType: params.testType,
      status: TestRunStatus.COMPLETED,
      id: { not: params.testRunId },
      createdAt: { lt: current.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    include: { metrics: true },
  });
  if (!baseline) return [];

  const baselineMetrics = new Map(baseline.metrics.map((m) => [m.metricName, m.metricValue]));
  const findings: RegressionFinding[] = [];

  for (const metric of current.metrics) {
    if (!HIGHER_IS_WORSE.has(metric.metricName)) continue;
    const previousValue = baselineMetrics.get(metric.metricName);
    if (previousValue === undefined) continue;

    const delta = round(metric.metricValue - previousValue, 4);
    // Privacy scores are on a 0–100 scale; rates are ratios.
    const scaledDelta = metric.metricName === 'privacy_risk_score' ? delta / 100 : delta;

    findings.push({
      metricName: metric.metricName,
      previousValue: round(previousValue, 4),
      currentValue: round(metric.metricValue, 4),
      delta,
      regressed: scaledDelta > params.regressionDelta,
      baselineTestRunId: baseline.id,
      baselineReference: baseline.reference,
      baselineModelVersion: baseline.modelVersion,
      comparedAgainst:
        baseline.modelVersion && baseline.modelVersion !== current.modelVersion
          ? 'PREVIOUS_MODEL_VERSION'
          : 'PREVIOUS_RUN',
    });
  }

  return findings;
};

export const metricHistory = async (
  organizationId: string,
  metricName: string,
  options: { modelId?: string; limit?: number } = {},
) => {
  const rows = await prisma.metric.findMany({
    where: {
      metricName,
      testRun: {
        organizationId,
        status: TestRunStatus.COMPLETED,
        ...(options.modelId ? { modelId: options.modelId } : {}),
      },
    },
    orderBy: { createdAt: 'asc' },
    take: options.limit ?? 50,
    include: {
      testRun: {
        select: { id: true, reference: true, modelVersion: true, completedAt: true, result: true },
      },
    },
  });
  return rows.map((row) => ({
    testRunId: row.testRunId,
    reference: row.testRun.reference,
    modelVersion: row.testRun.modelVersion,
    value: row.metricValue,
    threshold: row.threshold,
    breached: row.breached,
    at: row.testRun.completedAt ?? row.createdAt,
    result: row.testRun.result,
  }));
};
