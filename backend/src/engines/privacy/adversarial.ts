import { SeededRandom } from '../../utils/random.js';
import { clamp, percentile, round } from '../../utils/stats.js';
import { isQuasiIdentifier, type PiiDetection, type SchemaField } from './piiDetector.js';
import type { PrivacyConfiguration } from './syntheticGenerator.js';

export type AdversarialScenario =
  | 'RARE_DEMOGRAPHIC_COMBINATION'
  | 'RARE_GEOGRAPHIC_COMBINATION'
  | 'UNIQUE_OCCUPATION_LOCATION'
  | 'NEAR_DUPLICATE_RECORD'
  | 'SMALL_POPULATION_GROUP'
  | 'BOUNDARY_VALUE'
  | 'UNUSUAL_ATTRIBUTE_COMBINATION'
  | 'LINKAGE_REIDENTIFICATION';

export interface AdversarialCaseDraft {
  scenarioType: AdversarialScenario;
  riskScore: number;
  reidentification: boolean;
  metadata: Record<string, unknown>;
}

export interface AdversarialAnalysis {
  cases: AdversarialCaseDraft[];
  equivalenceClasses: number;
  smallestClassSize: number;
  kAnonymity: number;
  uniqueCombinations: number;
  quasiIdentifiers: string[];
}

const SCENARIO_WEIGHT: Record<AdversarialScenario, number> = {
  LINKAGE_REIDENTIFICATION: 1,
  UNIQUE_OCCUPATION_LOCATION: 0.9,
  RARE_DEMOGRAPHIC_COMBINATION: 0.8,
  RARE_GEOGRAPHIC_COMBINATION: 0.75,
  SMALL_POPULATION_GROUP: 0.6,
  NEAR_DUPLICATE_RECORD: 0.55,
  UNUSUAL_ATTRIBUTE_COMBINATION: 0.45,
  BOUNDARY_VALUE: 0.3,
};

/**
 * Adversarial edge-case generation.
 *
 * Rather than assuming anonymisation worked, this actively searches the
 * protected/synthetic representation for records that an attacker could single
 * out: small equivalence classes, unique quasi-identifier combinations,
 * near-duplicates and distribution boundaries.
 */
export const generateAdversarialCases = (
  schema: SchemaField[],
  records: Record<string, unknown>[],
  detections: PiiDetection[],
  configuration: PrivacyConfiguration,
  maxCases: number,
): AdversarialAnalysis => {
  const rng = new SeededRandom(`${configuration.seed}:adversarial`);
  const quasiIdentifiers = resolveQuasiIdentifiers(schema, detections);
  const cases: AdversarialCaseDraft[] = [];

  const classes = buildEquivalenceClasses(records, quasiIdentifiers, configuration);
  const classSizes = [...classes.values()].map((c) => c.length);
  const smallestClassSize = classSizes.length ? Math.min(...classSizes) : 0;
  const uniqueCombinations = classSizes.filter((size) => size === 1).length;

  for (const [key, indices] of classes) {
    if (indices.length >= configuration.kAnonymityTarget) continue;
    const attributes = JSON.parse(key) as Record<string, unknown>;
    const scenarioType = classifyScenario(attributes, indices.length);
    const severity = 1 - indices.length / configuration.kAnonymityTarget;
    cases.push({
      scenarioType,
      riskScore: round(clamp(SCENARIO_WEIGHT[scenarioType] * (0.4 + 0.6 * severity), 0, 1), 4),
      reidentification: indices.length === 1,
      metadata: {
        groupSize: indices.length,
        kAnonymityTarget: configuration.kAnonymityTarget,
        quasiIdentifierValues: attributes,
        affectedRecordCount: indices.length,
      },
    });
    if (cases.length >= maxCases) break;
  }

  if (cases.length < maxCases) {
    cases.push(...findNearDuplicates(records, quasiIdentifiers, maxCases - cases.length));
  }
  if (cases.length < maxCases) {
    cases.push(...findBoundaryValues(schema, records, maxCases - cases.length));
  }
  if (cases.length < maxCases) {
    cases.push(
      ...findUnusualCombinations(records, quasiIdentifiers, rng, maxCases - cases.length),
    );
  }

  return {
    cases: cases.slice(0, maxCases),
    equivalenceClasses: classes.size,
    smallestClassSize,
    kAnonymity: smallestClassSize,
    uniqueCombinations,
    quasiIdentifiers,
  };
};

export const resolveQuasiIdentifiers = (
  schema: SchemaField[],
  detections: PiiDetection[],
): string[] => {
  const fromDetections = detections.filter((d) => isQuasiIdentifier(d.category)).map((d) => d.fieldName);
  if (fromDetections.length > 0) return fromDetections;
  // Fall back to low-cardinality columns, which behave like quasi-identifiers.
  return schema.filter((field) => field.type !== 'number').slice(0, 4).map((field) => field.name);
};

const buildEquivalenceClasses = (
  records: Record<string, unknown>[],
  quasiIdentifiers: string[],
  configuration: PrivacyConfiguration,
): Map<string, number[]> => {
  const numericRanges = computeNumericRanges(records, quasiIdentifiers);
  const classes = new Map<string, number[]>();

  records.forEach((record, index) => {
    const key: Record<string, unknown> = {};
    for (const field of quasiIdentifiers) {
      const value = record[field];
      const range = numericRanges.get(field);
      key[field] =
        range && typeof value === 'number'
          ? generalizeNumeric(value, range, configuration.generalizationBuckets)
          : (value ?? null);
    }
    const serialized = JSON.stringify(key);
    const bucket = classes.get(serialized);
    if (bucket) bucket.push(index);
    else classes.set(serialized, [index]);
  });

  return classes;
};

const computeNumericRanges = (
  records: Record<string, unknown>[],
  fields: string[],
): Map<string, { min: number; max: number }> => {
  const ranges = new Map<string, { min: number; max: number }>();
  for (const field of fields) {
    const numbers = records
      .map((record) => record[field])
      .filter((value): value is number => typeof value === 'number');
    if (numbers.length > records.length * 0.5 && numbers.length > 0) {
      ranges.set(field, { min: Math.min(...numbers), max: Math.max(...numbers) });
    }
  }
  return ranges;
};

const generalizeNumeric = (
  value: number,
  range: { min: number; max: number },
  buckets: number,
): string => {
  const span = range.max - range.min || 1;
  const width = span / buckets;
  const bucket = Math.min(Math.floor((value - range.min) / width), buckets - 1);
  const low = round(range.min + bucket * width, 1);
  const high = round(low + width, 1);
  return `${low}–${high}`;
};

const DEMOGRAPHIC_HINT = /(gender|sex|race|ethnic|age|religion|disab|marital|nationality)/i;
const GEOGRAPHIC_HINT = /(city|region|country|zip|postal|district|county|location|municipality)/i;
const OCCUPATION_HINT = /(occupation|job|employer|role|department|industry)/i;

const classifyScenario = (
  attributes: Record<string, unknown>,
  groupSize: number,
): AdversarialScenario => {
  const keys = Object.keys(attributes);
  const hasGeo = keys.some((k) => GEOGRAPHIC_HINT.test(k));
  const hasOccupation = keys.some((k) => OCCUPATION_HINT.test(k));
  const hasDemographic = keys.some((k) => DEMOGRAPHIC_HINT.test(k));

  if (groupSize === 1 && hasGeo && hasOccupation) return 'UNIQUE_OCCUPATION_LOCATION';
  if (groupSize === 1) return 'LINKAGE_REIDENTIFICATION';
  if (hasGeo && hasDemographic) return 'RARE_GEOGRAPHIC_COMBINATION';
  if (hasDemographic) return 'RARE_DEMOGRAPHIC_COMBINATION';
  return 'SMALL_POPULATION_GROUP';
};

const findNearDuplicates = (
  records: Record<string, unknown>[],
  quasiIdentifiers: string[],
  limit: number,
): AdversarialCaseDraft[] => {
  const drafts: AdversarialCaseDraft[] = [];
  const seen = new Map<string, number>();
  const sampleSize = Math.min(records.length, 1_500);

  for (let index = 0; index < sampleSize; index += 1) {
    const record = records[index] as Record<string, unknown>;
    // Drop one quasi-identifier at a time: two records agreeing on all but one
    // attribute are a linkage risk even when neither is unique on its own.
    for (const omitted of quasiIdentifiers) {
      const key = quasiIdentifiers
        .filter((field) => field !== omitted)
        .map((field) => `${field}=${String(record[field] ?? '')}`)
        .join('|');
      const previous = seen.get(key);
      if (previous !== undefined && previous !== index) {
        drafts.push({
          scenarioType: 'NEAR_DUPLICATE_RECORD',
          riskScore: SCENARIO_WEIGHT.NEAR_DUPLICATE_RECORD,
          reidentification: false,
          metadata: { matchedOnAllExcept: omitted, recordIndexes: [previous, index] },
        });
        if (drafts.length >= limit) return drafts;
      } else {
        seen.set(key, index);
      }
    }
  }
  return drafts;
};

const findBoundaryValues = (
  schema: SchemaField[],
  records: Record<string, unknown>[],
  limit: number,
): AdversarialCaseDraft[] => {
  const drafts: AdversarialCaseDraft[] = [];
  for (const field of schema.filter((f) => f.type === 'number')) {
    const numbers = records
      .map((record) => record[field.name])
      .filter((value): value is number => typeof value === 'number');
    if (numbers.length < 10) continue;
    const p99 = percentile(numbers, 99);
    const p1 = percentile(numbers, 1);
    const outliers = numbers.filter((n) => n >= p99 || n <= p1).length;
    if (outliers === 0) continue;
    drafts.push({
      scenarioType: 'BOUNDARY_VALUE',
      riskScore: SCENARIO_WEIGHT.BOUNDARY_VALUE,
      reidentification: false,
      metadata: { field: field.name, p1, p99, outlierCount: outliers },
    });
    if (drafts.length >= limit) break;
  }
  return drafts;
};

const findUnusualCombinations = (
  records: Record<string, unknown>[],
  quasiIdentifiers: string[],
  rng: SeededRandom,
  limit: number,
): AdversarialCaseDraft[] => {
  if (quasiIdentifiers.length < 2 || records.length === 0) return [];
  const drafts: AdversarialCaseDraft[] = [];
  const frequency = new Map<string, number>();

  for (const record of records) {
    for (let i = 0; i < quasiIdentifiers.length - 1; i += 1) {
      for (let j = i + 1; j < quasiIdentifiers.length; j += 1) {
        const key = `${quasiIdentifiers[i]}=${String(record[quasiIdentifiers[i] as string] ?? '')}|${quasiIdentifiers[j]}=${String(record[quasiIdentifiers[j] as string] ?? '')}`;
        frequency.set(key, (frequency.get(key) ?? 0) + 1);
      }
    }
  }

  const rare = [...frequency.entries()]
    .filter(([, count]) => count <= Math.max(2, Math.floor(records.length * 0.002)))
    .slice(0, limit);

  for (const [key, count] of rare) {
    drafts.push({
      scenarioType: 'UNUSUAL_ATTRIBUTE_COMBINATION',
      riskScore: round(
        clamp(SCENARIO_WEIGHT.UNUSUAL_ATTRIBUTE_COMBINATION + rng.float(0, 0.1), 0, 1),
        4,
      ),
      reidentification: false,
      metadata: { combination: key, occurrences: count, populationSize: records.length },
    });
  }
  return drafts;
};
