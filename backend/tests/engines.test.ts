import { describe, expect, it } from 'vitest';
import { scanSchemaForPii } from '../src/engines/privacy/piiDetector.js';
import { generateSyntheticRecords } from '../src/engines/privacy/syntheticGenerator.js';
import { generateAdversarialCases } from '../src/engines/privacy/adversarial.js';
import { scorePrivacy } from '../src/engines/privacy/privacyEngine.js';
import { buildCounterfactualPairs } from '../src/engines/fairness/counterfactual.js';
import { computeFairnessMetrics } from '../src/engines/fairness/metrics.js';

describe('privacy and fairness engines', () => {
  const schema = [
    { name: 'email', type: 'string' as const },
    { name: 'age', type: 'number' as const },
    { name: 'gender', type: 'string' as const },
  ];
  const source = Array.from({ length: 60 }, (_, index) => ({
    email: `person${index}@example.test`,
    age: 20 + index,
    gender: index % 2 ? 'female' : 'male',
  }));

  it('detects identifiers and masks sampled values', () => {
    const detections = scanSchemaForPii(schema, { sampleRecords: source });
    const email = detections.find((field) => field.fieldName === 'email');
    expect(email?.category).toBe('EMAIL');
    expect(email?.sampleMasked).not.toContain('person0@');
    expect(detections.find((field) => field.fieldName === 'age')?.category).toBe('QUASI_IDENTIFIER');
  });

  it('separates synthetic identifiers and suppresses rare quasi-identifier groups', () => {
    const detections = scanSchemaForPii(schema, { sampleRecords: source });
    const config = {
      suppressDirectIdentifiers: true,
      noiseLevel: 0.15,
      kAnonymityTarget: 5,
      generalizationBuckets: 8,
      seed: 'unit-test',
    };
    const result = generateSyntheticRecords(schema, source, detections, 60, config);
    expect(result.records).toHaveLength(60);
    expect(result.records.every((record) => !source.some((row) => row.email === record.email))).toBe(true);
    const adversarial = generateAdversarialCases(schema, result.records, detections, config, 50);
    expect(adversarial.kAnonymity).toBeGreaterThanOrEqual(5);
    const score = scorePrivacy({
      recordsTested: result.records.length,
      analysis: adversarial,
      statisticalSimilarity: result.statisticalSimilarity,
      suppressedDirectIdentifiers: result.suppressedFields.length,
      unsuppressedDirectIdentifiers: 0,
      threshold: 25,
    });
    expect(score.privacyScore).toBeLessThanOrEqual(100);
    expect(score.breakdown.methodology).toContain('not a differential privacy');
  });

  it('isolates protected-attribute changes and reports disparity with sample warning', () => {
    const pairs = buildCounterfactualPairs(
      [{ gender: 'male', title: 'Mr', income: 52000, ground_truth: true }],
      { name: 'gender', values: ['male', 'female'] },
      20,
      'unit-test',
    );
    expect(pairs).toHaveLength(20);
    expect(pairs[0]?.original).toMatchObject({ gender: 'male', title: 'Mr', income: 52000 });
    expect(pairs[0]?.counterfactual).toMatchObject({ gender: 'female', title: 'Ms', income: 52000 });
    const metrics = computeFairnessMetrics({
      groups: [
        { group: 'male', observations: Array.from({ length: 20 }, () => ({ positive: true, actualPositive: true })) },
        { group: 'female', observations: Array.from({ length: 20 }, () => ({ positive: false, actualPositive: true })) },
      ],
      baselineGroup: 'male',
      flippedCases: 20,
      totalPairs: 20,
    });
    expect(metrics.demographicParityDifference).toBe(1);
    expect(metrics.equalOpportunityDifference).toBe(1);
    expect(metrics.counterfactualFlipRate).toBe(1);
    expect(metrics.flipConfidenceLow).toBeLessThanOrEqual(metrics.counterfactualFlipRate);
    expect(metrics.flipConfidenceHigh).toBeGreaterThanOrEqual(metrics.counterfactualFlipRate);
    expect(metrics.sampleAdequacy).toBe('INSUFFICIENT');
  });

  it('bounds flip-rate uncertainty around changed pairs rather than group selection', () => {
    const metrics = computeFairnessMetrics({
      groups: [
        { group: 'male', observations: Array.from({ length: 20 }, () => ({ positive: true })) },
        { group: 'female', observations: Array.from({ length: 20 }, () => ({ positive: false })) },
      ],
      baselineGroup: 'male',
      flippedCases: 2,
      totalPairs: 20,
    });
    expect(metrics.counterfactualFlipRate).toBe(0.1);
    expect(metrics.comparison.confidenceHigh).toBeLessThan(0.2);
    expect(metrics.flipConfidenceLow).toBeLessThan(0.1);
    expect(metrics.flipConfidenceHigh).toBeGreaterThan(0.1);
  });
});
