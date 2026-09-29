import { TestResult } from '@prisma/client';
import { clamp, round } from '../../utils/stats.js';
import type { AdversarialAnalysis, AdversarialCaseDraft } from './adversarial.js';

export interface PrivacyScoreInput {
  recordsTested: number;
  analysis: AdversarialAnalysis;
  statisticalSimilarity: number;
  suppressedDirectIdentifiers: number;
  unsuppressedDirectIdentifiers: number;
  threshold: number;
}

export interface PrivacyScoreOutput {
  privacyScore: number;
  result: TestResult;
  highRiskCases: number;
  reidentificationCases: number;
  adversarialCaseCount: number;
  breakdown: {
    components: { name: string; contribution: number; detail: string }[];
    kAnonymity: number;
    uniqueCombinations: number;
    equivalenceClasses: number;
    quasiIdentifiers: string[];
    statisticalSimilarity: number;
    threshold: number;
    /** Never claim a legal conclusion from a test result. */
    interpretation: string;
    methodology: string;
  };
}

export const HIGH_RISK_CASE_SCORE = 0.7;

/**
 * Privacy risk score, 0 (no measured risk) to 100 (maximum measured risk).
 * Higher is worse; a run passes while the score stays at or below the
 * organization's configured threshold.
 */
export const scorePrivacy = (input: PrivacyScoreInput): PrivacyScoreOutput => {
  const { analysis, recordsTested, threshold } = input;
  const cases = analysis.cases;
  const highRiskCases = cases.filter((c) => c.riskScore >= HIGH_RISK_CASE_SCORE).length;
  const reidentificationCases = cases.filter((c) => c.reidentification).length;
  const denominator = Math.max(recordsTested, 1);

  const components = [
    {
      name: 'Re-identification exposure',
      contribution: clamp((reidentificationCases / denominator) * 1_200, 0, 45),
      detail: `${reidentificationCases} of ${recordsTested} records are unique on their quasi-identifier combination`,
    },
    {
      name: 'High-risk adversarial cases',
      contribution: clamp((highRiskCases / denominator) * 400, 0, 25),
      detail: `${highRiskCases} adversarial cases scored at or above ${HIGH_RISK_CASE_SCORE}`,
    },
    {
      name: 'k-anonymity shortfall',
      contribution: kAnonymityPenalty(analysis.kAnonymity),
      detail: `Smallest equivalence class contains ${analysis.kAnonymity} record(s)`,
    },
    {
      name: 'Unsuppressed direct identifiers',
      contribution: clamp(input.unsuppressedDirectIdentifiers * 8, 0, 20),
      detail: `${input.unsuppressedDirectIdentifiers} direct identifier field(s) were not suppressed`,
    },
  ];

  const privacyScore = round(
    clamp(
      components.reduce((sum, component) => sum + component.contribution, 0),
      0,
      100,
    ),
    2,
  );

  const result =
    privacyScore <= threshold
      ? TestResult.PASS
      : privacyScore <= threshold * 1.5
        ? TestResult.WARNING
        : TestResult.FAIL;

  return {
    privacyScore,
    result,
    highRiskCases,
    reidentificationCases,
    adversarialCaseCount: cases.length,
    breakdown: {
      components: components.map((c) => ({ ...c, contribution: round(c.contribution, 2) })),
      kAnonymity: analysis.kAnonymity,
      uniqueCombinations: analysis.uniqueCombinations,
      equivalenceClasses: analysis.equivalenceClasses,
      quasiIdentifiers: analysis.quasiIdentifiers,
      statisticalSimilarity: input.statisticalSimilarity,
      threshold,
      interpretation: buildInterpretation(result, privacyScore, threshold),
      methodology:
        'Prototype Privacy Simulation: statistical resampling with suppression, generalization and calibrated noise, followed by adversarial k-anonymity and linkage analysis. This is not a differential privacy implementation and provides no mathematical privacy guarantee.',
    },
  };
};

const kAnonymityPenalty = (k: number): number => {
  if (k <= 1) return 20;
  if (k === 2) return 14;
  if (k === 3) return 9;
  if (k === 4) return 5;
  return 0;
};

const buildInterpretation = (result: TestResult, score: number, threshold: number): string => {
  switch (result) {
    case TestResult.PASS:
      return `Privacy risk score ${score} is within the configured threshold of ${threshold}. No privacy threshold violation was observed in this run.`;
    case TestResult.WARNING:
      return `PRIVACY THRESHOLD EXCEEDED. Privacy risk score ${score} exceeds the configured threshold of ${threshold}. This indicates potential re-identification exposure that warrants human review; it does not by itself establish a privacy violation.`;
    default:
      return `PRIVACY TEST FAILED. Privacy risk score ${score} substantially exceeds the configured threshold of ${threshold}. Investigate the flagged adversarial cases before releasing this dataset; a qualified reviewer must determine any compliance consequence.`;
  }
};

export const summarizeScenarios = (
  cases: AdversarialCaseDraft[],
): { scenarioType: string; count: number; averageRisk: number }[] => {
  const grouped = new Map<string, number[]>();
  for (const item of cases) {
    const bucket = grouped.get(item.scenarioType);
    if (bucket) bucket.push(item.riskScore);
    else grouped.set(item.scenarioType, [item.riskScore]);
  }
  return [...grouped.entries()]
    .map(([scenarioType, scores]) => ({
      scenarioType,
      count: scores.length,
      averageRisk: round(scores.reduce((a, b) => a + b, 0) / scores.length, 4),
    }))
    .sort((a, b) => b.count - a.count);
};
