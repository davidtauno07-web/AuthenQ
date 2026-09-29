import { SeededRandom } from '../../utils/random.js';
import { mean, round, stdDev } from '../../utils/stats.js';
import {
  isDirectIdentifier,
  isQuasiIdentifier,
  type PiiDetection,
  type SchemaField,
} from './piiDetector.js';

export interface ColumnProfile {
  name: string;
  type: SchemaField['type'];
  /** Categorical distribution, as value → frequency. */
  distribution?: Record<string, number>;
  numeric?: { mean: number; stdDev: number; min: number; max: number; integer: boolean };
  nullRate: number;
  distinctCount: number;
}

export interface PrivacyConfiguration {
  /** Direct identifiers are never carried over; they are regenerated. */
  suppressDirectIdentifiers: boolean;
  /** Numeric noise as a fraction of the column standard deviation. */
  noiseLevel: number;
  /** Smallest permitted group size for quasi-identifier combinations. */
  kAnonymityTarget: number;
  /** Numeric columns are bucketed to this many quantiles when generalising. */
  generalizationBuckets: number;
  seed: string;
}

export const DEFAULT_PRIVACY_CONFIGURATION: PrivacyConfiguration = {
  suppressDirectIdentifiers: true,
  noiseLevel: 0.15,
  kAnonymityTarget: 5,
  generalizationBuckets: 8,
  seed: 'authenq',
};

/**
 * Prototype Privacy Simulation.
 *
 * This is a statistical resampling + noise + suppression pipeline. It is NOT a
 * differential privacy implementation and must never be presented as providing
 * a mathematical privacy guarantee.
 */
export const GENERATION_METHOD = 'PROTOTYPE_PRIVACY_SIMULATION_V1';

export const profileColumns = (
  schema: SchemaField[],
  records: Record<string, unknown>[],
): ColumnProfile[] =>
  schema.map((field) => {
    const raw = records.map((record) => record[field.name]);
    const present = raw.filter((value) => value !== null && value !== undefined);
    const nullRate = records.length === 0 ? 0 : 1 - present.length / records.length;

    if (field.type === 'number') {
      const numbers = present.map(Number).filter((n) => Number.isFinite(n));
      return {
        name: field.name,
        type: field.type,
        numeric: {
          mean: round(mean(numbers), 4),
          stdDev: round(stdDev(numbers), 4),
          min: numbers.length ? Math.min(...numbers) : 0,
          max: numbers.length ? Math.max(...numbers) : 0,
          integer: numbers.every((n) => Number.isInteger(n)),
        },
        nullRate: round(nullRate, 4),
        distinctCount: new Set(numbers).size,
      };
    }

    const distribution: Record<string, number> = {};
    for (const value of present) {
      const key = String(value);
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    return {
      name: field.name,
      type: field.type,
      distribution,
      nullRate: round(nullRate, 4),
      distinctCount: Object.keys(distribution).length,
    };
  });

export interface GenerationResult {
  records: Record<string, unknown>[];
  statisticalSimilarity: number;
  profiles: ColumnProfile[];
  suppressedFields: string[];
  generalizedFields: string[];
  suppressedRecordCount: number;
  method: string;
}

export const generateSyntheticRecords = (
  schema: SchemaField[],
  sourceRecords: Record<string, unknown>[],
  detections: PiiDetection[],
  targetCount: number,
  configuration: PrivacyConfiguration = DEFAULT_PRIVACY_CONFIGURATION,
): GenerationResult => {
  const rng = new SeededRandom(configuration.seed);
  const profiles = profileColumns(schema, sourceRecords);
  const detectionByField = new Map(detections.map((d) => [d.fieldName, d]));
  const suppressedFields = configuration.suppressDirectIdentifiers
    ? detections.filter((d) => isDirectIdentifier(d.category)).map((d) => d.fieldName)
    : [];

  const sourceFingerprints = new Set(sourceRecords.map(fingerprint));
  const records: Record<string, unknown>[] = [];

  let guard = 0;
  while (records.length < targetCount && guard < targetCount * 5) {
    guard += 1;
    const record: Record<string, unknown> = {};

    for (const profile of profiles) {
      const detection = detectionByField.get(profile.name);
      if (suppressedFields.includes(profile.name)) {
        record[profile.name] = synthesizeIdentifier(profile.name, detection?.category, rng);
        continue;
      }
      if (rng.next() < profile.nullRate) {
        record[profile.name] = null;
        continue;
      }
      record[profile.name] = sampleValue(profile, configuration, rng);
    }

    // Reject any synthetic row that reproduces a source row verbatim.
    if (sourceFingerprints.has(fingerprint(record))) continue;
    records.push(record);
  }

  // Utility is measured on the resampled distribution, before generalization
  // coarsens it; the generalization cost is reported separately.
  const statisticalSimilarity = round(
    computeStatisticalSimilarity(profiles, profileColumns(schema, records)),
    4,
  );

  const quasiIdentifiers = detections
    .filter((detection) => isQuasiIdentifier(detection.category))
    .map((detection) => detection.fieldName);
  const generalization = generalizeQuasiIdentifiers(records, quasiIdentifiers, configuration);

  return {
    records,
    statisticalSimilarity,
    profiles,
    suppressedFields,
    generalizedFields: generalization.generalizedFields,
    suppressedRecordCount: generalization.suppressedRecordCount,
    method: GENERATION_METHOD,
  };
};

/**
 * Generalization + residual suppression.
 *
 * Resampling alone leaves rare quasi-identifier combinations intact, so the
 * protected representation is coarsened until each combination reaches the
 * configured k, and whatever remains below k has its quasi-identifiers
 * suppressed. Mutates `records` in place.
 */
const generalizeQuasiIdentifiers = (
  records: Record<string, unknown>[],
  quasiIdentifiers: string[],
  configuration: PrivacyConfiguration,
): { generalizedFields: string[]; suppressedRecordCount: number } => {
  if (records.length === 0 || quasiIdentifiers.length === 0) {
    return { generalizedFields: [], suppressedRecordCount: 0 };
  }

  const generalizedFields: string[] = [];
  for (const field of quasiIdentifiers) {
    const values = records.map((record) => record[field]);
    const distinct = new Set(values.map((value) => String(value))).size;
    if (distinct <= configuration.generalizationBuckets) continue;

    const numbers = values.filter((value): value is number => typeof value === 'number');
    if (numbers.length === values.length) {
      const min = Math.min(...numbers);
      const max = Math.max(...numbers);
      const width = (max - min || 1) / configuration.generalizationBuckets;
      records.forEach((record) => {
        const value = record[field] as number;
        const bucket = Math.min(
          Math.floor((value - min) / width),
          configuration.generalizationBuckets - 1,
        );
        const low = round(min + bucket * width, 1);
        record[field] = `${low}–${round(low + width, 1)}`;
      });
    } else {
      records.forEach((record) => {
        record[field] = generalizeText(String(record[field] ?? ''));
      });
    }
    generalizedFields.push(field);
  }

  const classes = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    const key = quasiIdentifiers.map((field) => String(record[field] ?? '')).join('|');
    const bucket = classes.get(key);
    if (bucket) bucket.push(record);
    else classes.set(key, [record]);
  }

  let suppressedRecordCount = 0;
  for (const bucket of classes.values()) {
    if (bucket.length >= configuration.kAnonymityTarget) continue;
    for (const record of bucket) {
      for (const field of quasiIdentifiers) record[field] = null;
      suppressedRecordCount += 1;
    }
  }

  return { generalizedFields, suppressedRecordCount };
};

/** Dates collapse to the year; other text collapses to a coarse prefix. */
const generalizeText = (value: string): string => {
  const isoDate = /^(\d{4})-\d{2}-\d{2}/.exec(value);
  if (isoDate) return isoDate[1] as string;
  return value.split(/[\s,]+/)[0] ?? value;
};

const sampleValue = (
  profile: ColumnProfile,
  configuration: PrivacyConfiguration,
  rng: SeededRandom,
): unknown => {
  if (profile.numeric) {
    const { mean: m, stdDev: sd, min, max, integer } = profile.numeric;
    const noise = sd * configuration.noiseLevel;
    const value = rng.normal(m, Math.max(sd, Math.abs(m) * 0.05)) + rng.float(-noise, noise);
    const bounded = Math.min(max, Math.max(min, value));
    return integer ? Math.round(bounded) : round(bounded, 2);
  }

  const distribution = profile.distribution ?? {};
  const entries = Object.entries(distribution);
  if (entries.length === 0) return null;
  return rng.weighted(entries.map(([value, weight]) => ({ value, weight })));
};

const synthesizeIdentifier = (
  fieldName: string,
  category: string | undefined,
  rng: SeededRandom,
): string => {
  const token = rng.int(100000, 999999);
  switch (category) {
    case 'EMAIL':
      return `synthetic.${token}@example.invalid`;
    case 'PHONE':
      return `+1555${rng.int(1000000, 9999999)}`;
    case 'NAME':
      return `${rng.pick(SYNTHETIC_FIRST_NAMES)} ${rng.pick(SYNTHETIC_LAST_NAMES)}`;
    case 'ADDRESS':
      return `${rng.int(1, 999)} ${rng.pick(SYNTHETIC_STREETS)}`;
    case 'NATIONAL_ID':
      return `SYN-${token}-${rng.int(10, 99)}`;
    case 'MEDICAL_RECORD_NUMBER':
      return `MRN-SYN-${token}`;
    default:
      return `SYN-${fieldName.toUpperCase().slice(0, 6)}-${token}`;
  }
};

const SYNTHETIC_FIRST_NAMES = [
  'Avery', 'Jordan', 'Riley', 'Quinn', 'Morgan', 'Casey', 'Rowan', 'Sasha', 'Noor', 'Emil',
];
const SYNTHETIC_LAST_NAMES = [
  'Hale', 'Vance', 'Okonkwo', 'Larsen', 'Ferreira', 'Novak', 'Haruna', 'Kask', 'Bright', 'Oduya',
];
const SYNTHETIC_STREETS = [
  'Meridian Way', 'Atlas Street', 'Northstar Road', 'Nova Lane', 'Harbour Close', 'Vector Avenue',
];

const fingerprint = (record: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  );

/**
 * Similarity is the mean per-column agreement: total-variation overlap for
 * categorical columns and normalised mean/σ agreement for numeric columns.
 */
export const computeStatisticalSimilarity = (
  sourceProfiles: ColumnProfile[],
  syntheticProfiles: ColumnProfile[],
): number => {
  const syntheticByName = new Map(syntheticProfiles.map((p) => [p.name, p]));
  const scores: number[] = [];

  for (const source of sourceProfiles) {
    const synthetic = syntheticByName.get(source.name);
    if (!synthetic) continue;

    if (source.numeric && synthetic.numeric) {
      const scale = Math.max(Math.abs(source.numeric.mean), 1);
      const meanScore = 1 - Math.min(Math.abs(source.numeric.mean - synthetic.numeric.mean) / scale, 1);
      const sdScale = Math.max(source.numeric.stdDev, 1);
      const sdScore = 1 - Math.min(Math.abs(source.numeric.stdDev - synthetic.numeric.stdDev) / sdScale, 1);
      scores.push((meanScore + sdScore) / 2);
      continue;
    }

    const sourceDist = normalize(source.distribution ?? {});
    const syntheticDist = normalize(synthetic.distribution ?? {});
    const keys = new Set([...Object.keys(sourceDist), ...Object.keys(syntheticDist)]);
    let totalVariation = 0;
    for (const key of keys) {
      totalVariation += Math.abs((sourceDist[key] ?? 0) - (syntheticDist[key] ?? 0));
    }
    scores.push(1 - totalVariation / 2);
  }

  return scores.length === 0 ? 0 : mean(scores);
};

const normalize = (distribution: Record<string, number>): Record<string, number> => {
  const total = Object.values(distribution).reduce((sum, v) => sum + v, 0);
  if (total === 0) return {};
  return Object.fromEntries(Object.entries(distribution).map(([k, v]) => [k, v / total]));
};
