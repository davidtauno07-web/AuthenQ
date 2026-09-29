import { round, twoProportionZ, wilsonInterval } from '../../utils/stats.js';

export interface OutcomeObservation {
  positive: boolean;
  /** Ground-truth label, when the dataset provides one. */
  actualPositive?: boolean;
}

export interface GroupOutcomes {
  group: string;
  observations: OutcomeObservation[];
}

export interface GroupMetrics {
  group: string;
  sampleSize: number;
  selectionRate: number;
  approvalRate: number;
  rejectionRate: number;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  truePositiveRate: number | null;
  confidenceLow: number;
  confidenceHigh: number;
}

export interface FairnessMetrics {
  groups: GroupMetrics[];
  baseline: GroupMetrics;
  comparison: GroupMetrics;
  selectionRateDifference: number;
  demographicParityDifference: number;
  disparateImpactRatio: number;
  equalOpportunityDifference: number;
  counterfactualFlipRate: number;
  flipConfidenceLow: number;
  flipConfidenceHigh: number;
  flippedCases: number;
  totalPairs: number;
  zStatistic: number;
  /** Small samples must not be presented as definitive. */
  sampleAdequacy: 'ADEQUATE' | 'LIMITED' | 'INSUFFICIENT';
}

export const flipRateInterval = (flippedCases: number, totalPairs: number) => {
  const interval = wilsonInterval(flippedCases, totalPairs);
  return { low: round(interval.low, 4), high: round(interval.high, 4) };
};

export const flipIntervalFromSummary = (summary: unknown) => {
  if (!summary || typeof summary !== 'object' || !('flippedCases' in summary) || !('totalPairs' in summary)) {
    return null;
  }
  const { flippedCases, totalPairs } = summary;
  if (
    typeof flippedCases !== 'number' || !Number.isInteger(flippedCases) ||
    typeof totalPairs !== 'number' || !Number.isInteger(totalPairs) ||
    totalPairs < 0 || flippedCases < 0 || flippedCases > totalPairs
  ) return null;
  return flipRateInterval(flippedCases, totalPairs);
};

export const computeGroupMetrics = ({ group, observations }: GroupOutcomes): GroupMetrics => {
  const total = observations.length;
  const positives = observations.filter((o) => o.positive).length;
  const selectionRate = total === 0 ? 0 : positives / total;
  const interval = wilsonInterval(positives, total);

  const labelled = observations.filter((o) => o.actualPositive !== undefined);
  const actualNegatives = labelled.filter((o) => o.actualPositive === false);
  const actualPositives = labelled.filter((o) => o.actualPositive === true);
  const falsePositives = actualNegatives.filter((o) => o.positive).length;
  const falseNegatives = actualPositives.filter((o) => !o.positive).length;
  const truePositives = actualPositives.filter((o) => o.positive).length;

  return {
    group,
    sampleSize: total,
    selectionRate: round(selectionRate, 4),
    approvalRate: round(selectionRate, 4),
    rejectionRate: round(1 - selectionRate, 4),
    falsePositiveRate:
      actualNegatives.length === 0 ? null : round(falsePositives / actualNegatives.length, 4),
    falseNegativeRate:
      actualPositives.length === 0 ? null : round(falseNegatives / actualPositives.length, 4),
    truePositiveRate:
      actualPositives.length === 0 ? null : round(truePositives / actualPositives.length, 4),
    confidenceLow: round(interval.low, 4),
    confidenceHigh: round(interval.high, 4),
  };
};

export interface FairnessMetricsInput {
  groups: GroupOutcomes[];
  baselineGroup: string;
  flippedCases: number;
  totalPairs: number;
}

export const computeFairnessMetrics = (input: FairnessMetricsInput): FairnessMetrics => {
  const groups = input.groups.map(computeGroupMetrics);
  const baseline =
    groups.find((g) => g.group === input.baselineGroup) ?? (groups[0] as GroupMetrics);
  // The comparison group is the one furthest from the baseline selection rate:
  // reporting the largest observed disparity is the conservative choice.
  const comparison =
    groups
      .filter((g) => g.group !== baseline.group)
      .sort(
        (a, b) =>
          Math.abs(b.selectionRate - baseline.selectionRate) -
          Math.abs(a.selectionRate - baseline.selectionRate),
      )[0] ?? baseline;

  const selectionRateDifference = round(baseline.selectionRate - comparison.selectionRate, 4);
  const disparateImpactRatio =
    baseline.selectionRate === 0
      ? 0
      : round(comparison.selectionRate / baseline.selectionRate, 4);

  const equalOpportunityDifference =
    baseline.truePositiveRate !== null && comparison.truePositiveRate !== null
      ? round(Math.abs(baseline.truePositiveRate - comparison.truePositiveRate), 4)
      : 0;

  const counterfactualFlipRate =
    input.totalPairs === 0 ? 0 : round(input.flippedCases / input.totalPairs, 4);
  const flipInterval = flipRateInterval(input.flippedCases, input.totalPairs);

  const smallestSample = Math.min(...groups.map((g) => g.sampleSize));

  return {
    groups,
    baseline,
    comparison,
    selectionRateDifference,
    demographicParityDifference: round(Math.abs(selectionRateDifference), 4),
    disparateImpactRatio,
    equalOpportunityDifference,
    counterfactualFlipRate,
    flipConfidenceLow: flipInterval.low,
    flipConfidenceHigh: flipInterval.high,
    flippedCases: input.flippedCases,
    totalPairs: input.totalPairs,
    zStatistic: round(
      twoProportionZ(
        Math.round(baseline.selectionRate * baseline.sampleSize),
        baseline.sampleSize,
        Math.round(comparison.selectionRate * comparison.sampleSize),
        comparison.sampleSize,
      ),
      4,
    ),
    sampleAdequacy:
      smallestSample >= 384 ? 'ADEQUATE' : smallestSample >= 100 ? 'LIMITED' : 'INSUFFICIENT',
  };
};
