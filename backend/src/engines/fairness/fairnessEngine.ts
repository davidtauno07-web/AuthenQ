import { TestResult } from '@prisma/client';
import { resolveProvider, type ModelDescriptor } from '../models/index.js';
import { POSITIVE_OUTCOME } from '../models/provider.js';
import { buildCounterfactualPairs, type ProtectedAttributeConfig } from './counterfactual.js';
import { computeFairnessMetrics, type FairnessMetrics, type GroupOutcomes } from './metrics.js';
import type { ModelProvider } from '@prisma/client';

export interface FairnessThresholds {
  counterfactualFlipRate: number;
  demographicParityDifference: number;
  equalOpportunityDifference: number;
}

export interface FairnessRunInput {
  descriptor: ModelDescriptor;
  provider: ModelProvider;
  profiles: Record<string, unknown>[];
  attribute: ProtectedAttributeConfig;
  caseCount: number;
  thresholds: FairnessThresholds;
  seed: string;
  onProgress?: (completed: number, total: number) => void;
}

export interface EvaluatedCase {
  originalProfile: Record<string, unknown>;
  counterfactualProfile: Record<string, unknown>;
  originalOutcome: string;
  counterfactualOutcome: string;
  originalScore: number;
  counterfactualScore: number;
  outcomeChanged: boolean;
}

export interface FairnessRunOutput {
  attribute: string;
  metrics: FairnessMetrics;
  cases: EvaluatedCase[];
  result: TestResult;
  breaches: { metric: string; observed: number; threshold: number; difference: number }[];
  interpretation: string;
}

/**
 * Executes the counterfactual red team: for every pair, both profiles are sent
 * through the model under test and the outcomes are compared.
 */
export const runFairnessTest = async (input: FairnessRunInput): Promise<FairnessRunOutput> => {
  const adapter = resolveProvider(input.provider);
  const pairs = buildCounterfactualPairs(
    input.profiles,
    input.attribute,
    input.caseCount,
    input.seed,
  );

  const cases: EvaluatedCase[] = [];
  const baselineObservations: GroupOutcomes = { group: input.attribute.values[0] as string, observations: [] };
  const variantObservations = new Map<string, GroupOutcomes>();
  let flipped = 0;

  for (const pair of pairs) {
    const [originalPrediction, counterfactualPrediction] = await Promise.all([
      adapter.predict(input.descriptor, pair.original),
      adapter.predict(input.descriptor, pair.counterfactual),
    ]);

    const outcomeChanged = originalPrediction.outcome !== counterfactualPrediction.outcome;
    if (outcomeChanged) flipped += 1;

    const actualPositive =
      typeof pair.original.ground_truth === 'boolean'
        ? (pair.original.ground_truth as boolean)
        : undefined;

    baselineObservations.observations.push({
      positive: originalPrediction.outcome === POSITIVE_OUTCOME,
      actualPositive,
    });

    const variantGroup = variantObservations.get(pair.variantValue) ?? {
      group: pair.variantValue,
      observations: [],
    };
    variantGroup.observations.push({
      positive: counterfactualPrediction.outcome === POSITIVE_OUTCOME,
      actualPositive,
    });
    variantObservations.set(pair.variantValue, variantGroup);

    cases.push({
      originalProfile: pair.original,
      counterfactualProfile: pair.counterfactual,
      originalOutcome: originalPrediction.outcome,
      counterfactualOutcome: counterfactualPrediction.outcome,
      originalScore: originalPrediction.score,
      counterfactualScore: counterfactualPrediction.score,
      outcomeChanged,
    });

    if (input.onProgress && pair.index % 50 === 0) {
      input.onProgress(pair.index + 1, pairs.length);
    }
  }

  input.onProgress?.(pairs.length, pairs.length);

  const metrics = computeFairnessMetrics({
    groups: [baselineObservations, ...variantObservations.values()],
    baselineGroup: baselineObservations.group,
    flippedCases: flipped,
    totalPairs: pairs.length,
  });

  const breaches = evaluateThresholds(metrics, input.thresholds);
  const result = resolveResult(metrics, breaches);

  return {
    attribute: input.attribute.name,
    metrics,
    cases,
    result,
    breaches,
    interpretation: buildInterpretation(result, metrics, breaches, input.attribute.name),
  };
};

const evaluateThresholds = (metrics: FairnessMetrics, thresholds: FairnessThresholds) => {
  const checks = [
    {
      metric: 'counterfactual_flip_rate',
      observed: metrics.counterfactualFlipRate,
      threshold: thresholds.counterfactualFlipRate,
    },
    {
      metric: 'demographic_parity_difference',
      observed: metrics.demographicParityDifference,
      threshold: thresholds.demographicParityDifference,
    },
    {
      metric: 'equal_opportunity_difference',
      observed: metrics.equalOpportunityDifference,
      threshold: thresholds.equalOpportunityDifference,
    },
  ];
  return checks
    .filter((check) => check.observed > check.threshold)
    .map((check) => ({ ...check, difference: Number((check.observed - check.threshold).toFixed(4)) }));
};

const resolveResult = (
  metrics: FairnessMetrics,
  breaches: { metric: string; difference: number }[],
): TestResult => {
  if (metrics.sampleAdequacy === 'INSUFFICIENT') return TestResult.INCONCLUSIVE;
  if (breaches.length === 0) return TestResult.PASS;
  // A large breach, or several breached metrics at once, is treated as a
  // failure; a single marginal breach is a warning for human review.
  const severe = breaches.some((b) => b.difference > 0.05) || breaches.length >= 2;
  return severe ? TestResult.FAIL : TestResult.WARNING;
};

const buildInterpretation = (
  result: TestResult,
  metrics: FairnessMetrics,
  breaches: { metric: string; observed: number; threshold: number }[],
  attribute: string,
): string => {
  const sampleNote =
    metrics.sampleAdequacy === 'ADEQUATE'
      ? ''
      : ` Sample adequacy is ${metrics.sampleAdequacy.toLowerCase()} (smallest group n=${Math.min(
          ...metrics.groups.map((g) => g.sampleSize),
        )}); treat these figures as indicative rather than definitive.`;

  if (result === TestResult.INCONCLUSIVE) {
    return `Inconclusive: the sample for "${attribute}" is too small to support a finding.${sampleNote}`;
  }
  if (result === TestResult.PASS) {
    return `No configured fairness threshold was exceeded for "${attribute}". Counterfactual flip rate ${(metrics.counterfactualFlipRate * 100).toFixed(1)}%.${sampleNote}`;
  }
  const detail = breaches
    .map(
      (b) =>
        `${b.metric.replace(/_/g, ' ')} observed ${(b.observed * 100).toFixed(1)}% against a threshold of ${(b.threshold * 100).toFixed(1)}%`,
    )
    .join('; ');
  return `THRESHOLD EXCEEDED for "${attribute}": ${detail}. Potential disparity detected — this is a signal for human review and does not by itself establish unlawful discrimination.${sampleNote}`;
};
