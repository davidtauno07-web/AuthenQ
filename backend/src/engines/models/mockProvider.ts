import { SeededRandom } from '../../utils/random.js';
import { clamp, round } from '../../utils/stats.js';
import {
  NEGATIVE_OUTCOME,
  POSITIVE_OUTCOME,
  type ModelDescriptor,
  type ModelInvocationProfile,
  type ModelPrediction,
  type ModelProviderAdapter,
} from './provider.js';

export type DemoBehavior =
  | 'FAIR'
  | 'GENDER_SENSITIVE'
  | 'AGE_SENSITIVE'
  | 'LOCATION_SENSITIVE'
  | 'STABLE'
  | 'DRIFTING';

export const DEMO_BEHAVIORS: { value: DemoBehavior; label: string; description: string }[] = [
  {
    value: 'FAIR',
    label: 'Fair demo model',
    description: 'Outcomes depend only on merit features; protected attributes are ignored.',
  },
  {
    value: 'GENDER_SENSITIVE',
    label: 'Gender-sensitive demo model',
    description: 'Intentionally shifts its decision boundary based on the gender attribute.',
  },
  {
    value: 'AGE_SENSITIVE',
    label: 'Age-sensitive demo model',
    description: 'Intentionally penalises applicants above an age boundary.',
  },
  {
    value: 'LOCATION_SENSITIVE',
    label: 'Location-sensitive demo model',
    description: 'Intentionally uses region as a proxy feature.',
  },
  {
    value: 'STABLE',
    label: 'Stable demo model',
    description: 'Produces consistent outcomes across versions; used as a regression baseline.',
  },
  {
    value: 'DRIFTING',
    label: 'Drifting demo model',
    description: 'Disparity grows with the model version; used to demonstrate regression detection.',
  },
];

/**
 * DEMO MODEL provider.
 *
 * These models exist only to exercise AuthenQ's testing engines. They are not
 * production models and their outputs carry no real-world meaning.
 */
export class MockModelProvider implements ModelProviderAdapter {
  readonly kind = 'MOCK';

  async predict(
    descriptor: ModelDescriptor,
    profile: ModelInvocationProfile,
  ): Promise<ModelPrediction> {
    const behavior = (descriptor.demoBehavior ?? 'FAIR') as DemoBehavior;
    const score = scoreProfile(behavior, descriptor.version, profile);
    return {
      outcome: score >= 0.5 ? POSITIVE_OUTCOME : NEGATIVE_OUTCOME,
      score: round(score, 4),
      latencyMs: 0,
      raw: { behavior, demo: true, modelVersion: descriptor.version },
    };
  }

  async healthCheck(descriptor: ModelDescriptor) {
    return { healthy: true, message: `DEMO MODEL "${descriptor.name}" responding locally` };
  }
}

const numeric = (profile: ModelInvocationProfile, keys: string[], fallback = 0): number => {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return fallback;
};

const text = (profile: ModelInvocationProfile, keys: string[]): string => {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === 'string') return value.toLowerCase();
  }
  return '';
};

/** Merit signal shared by every demo behavior, so comparisons stay meaningful. */
const meritScore = (profile: ModelInvocationProfile): number => {
  const experience = numeric(profile, ['years_experience', 'experience', 'tenure_years'], 5);
  const income = numeric(profile, ['annual_income', 'income', 'salary', 'loan_amount'], 55_000);
  const education = text(profile, ['education', 'education_level']);
  const educationBonus = education.includes('phd')
    ? 0.18
    : education.includes('master')
      ? 0.12
      : education.includes('bachelor')
        ? 0.07
        : 0;
  const creditScore = numeric(profile, ['credit_score'], 680);

  return clamp(
    0.08 +
      clamp(experience / 25, 0, 0.26) +
      clamp((income - 30_000) / 200_000, 0, 0.2) +
      educationBonus +
      clamp((creditScore - 550) / 1_200, 0, 0.16),
    0,
    1,
  );
};

const scoreProfile = (
  behavior: DemoBehavior,
  version: string,
  profile: ModelInvocationProfile,
): number => {
  // Deterministic jitter keyed on the profile: repeated calls with the same
  // inputs must return the same outcome, otherwise counterfactual pairs would
  // differ for reasons unrelated to the protected attribute.
  const rng = new SeededRandom(`${behavior}:${version}:${JSON.stringify(profile)}`);
  let score = meritScore(profile) + rng.float(-0.04, 0.04);

  const gender = text(profile, ['gender', 'sex']);
  const age = numeric(profile, ['age'], 35);
  const region = text(profile, ['region', 'city', 'location', 'district']);
  const versionFactor = versionWeight(version);

  switch (behavior) {
    case 'GENDER_SENSITIVE':
      if (gender.startsWith('f')) score -= 0.14;
      if (gender === 'non-binary' || gender === 'other') score -= 0.18;
      break;
    case 'AGE_SENSITIVE':
      if (age >= 50) score -= 0.16;
      if (age <= 22) score -= 0.08;
      break;
    case 'LOCATION_SENSITIVE':
      if (/(rural|north|east)/.test(region)) score -= 0.13;
      break;
    case 'DRIFTING':
      if (gender.startsWith('f')) score -= 0.05 * versionFactor;
      if (age >= 50) score -= 0.04 * versionFactor;
      break;
    case 'STABLE':
    case 'FAIR':
    default:
      break;
  }

  return clamp(score, 0, 1);
};

/** Later versions drift further, which drives the regression demo. */
const versionWeight = (version: string): number => {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] ?? 1) + (parts[1] ?? 0) / 10;
};
