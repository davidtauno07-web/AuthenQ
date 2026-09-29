import { SeededRandom } from '../../utils/random.js';

export interface ProtectedAttributeConfig {
  /** Column name in the dataset, e.g. "gender". */
  name: string;
  /** Values the attribute can take; the first is treated as the baseline. */
  values: string[];
  label?: string;
}

export interface CounterfactualPair {
  index: number;
  attribute: string;
  baselineValue: string;
  variantValue: string;
  original: Record<string, unknown>;
  counterfactual: Record<string, unknown>;
}

/**
 * Counterfactual mutation: a pair differs in exactly one protected attribute,
 * so any outcome change is attributable to that attribute alone.
 */
export const buildCounterfactualPairs = (
  profiles: Record<string, unknown>[],
  attribute: ProtectedAttributeConfig,
  caseCount: number,
  seed: string,
): CounterfactualPair[] => {
  if (profiles.length === 0 || attribute.values.length < 2) return [];
  const rng = new SeededRandom(`${seed}:${attribute.name}`);
  const [baselineValue, ...variants] = attribute.values;
  const pairs: CounterfactualPair[] = [];

  for (let index = 0; index < caseCount; index += 1) {
    const source = profiles[index % profiles.length] as Record<string, unknown>;
    const variantValue = variants[rng.int(0, variants.length - 1)] as string;
    const original = { ...source, [attribute.name]: baselineValue };
    const counterfactual = { ...source, [attribute.name]: variantValue };

    // Derived columns must move with the attribute, otherwise the pair encodes
    // a contradiction the model can exploit (e.g. gender vs. title).
    applyDerivedAttributes(original, attribute.name, baselineValue as string);
    applyDerivedAttributes(counterfactual, attribute.name, variantValue);

    pairs.push({
      index,
      attribute: attribute.name,
      baselineValue: baselineValue as string,
      variantValue,
      original,
      counterfactual,
    });
  }

  return pairs;
};

const TITLE_BY_GENDER: Record<string, string> = {
  male: 'Mr',
  female: 'Ms',
  'non-binary': 'Mx',
  other: 'Mx',
};

const applyDerivedAttributes = (
  profile: Record<string, unknown>,
  attributeName: string,
  value: string,
): void => {
  if (attributeName === 'gender' && 'title' in profile) {
    profile.title = TITLE_BY_GENDER[value.toLowerCase()] ?? 'Mx';
  }
  if (attributeName === 'age' && 'age_band' in profile) {
    const age = Number(value);
    profile.age_band = Number.isFinite(age) ? bandForAge(age) : profile.age_band;
  }
};

const bandForAge = (age: number): string => {
  if (age < 25) return '18-24';
  if (age < 35) return '25-34';
  if (age < 45) return '35-44';
  if (age < 55) return '45-54';
  return '55+';
};
