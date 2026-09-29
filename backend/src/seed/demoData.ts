import { SeededRandom } from '../utils/random.js';
import type { SchemaField } from '../engines/privacy/piiDetector.js';

/**
 * All demo data is fictional. It is generated deterministically so screenshots,
 * tests and demos stay reproducible across environments.
 */

export interface DemoDatasetDefinition {
  name: string;
  domain: string;
  version: string;
  schema: SchemaField[];
  recordCount: number;
  build: (rng: SeededRandom, index: number) => Record<string, unknown>;
}

const FIRST_NAMES = [
  'Amara', 'Beatriz', 'Chen', 'Dmitri', 'Elif', 'Farid', 'Grace', 'Hannah', 'Ibrahim', 'Jonas',
  'Kavya', 'Liam', 'Mira', 'Noah', 'Olu', 'Petra', 'Quinn', 'Rafael', 'Sofia', 'Tomas',
];
const LAST_NAMES = [
  'Achebe', 'Bergström', 'Costa', 'Dubois', 'Eriksen', 'Ferreira', 'Gallagher', 'Haddad',
  'Ivanov', 'Jansen', 'Kowalski', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov',
];
const CITIES = ['Tallinn', 'Tartu', 'Helsinki', 'Riga', 'Vilnius', 'Stockholm'];
const REGIONS = ['north', 'south', 'east', 'west', 'central', 'rural'];
const GENDERS = ['male', 'female', 'non-binary'];
const ETHNICITIES = ['group-a', 'group-b', 'group-c'];
const EDUCATION = ['high-school', 'bachelor', 'master', 'phd'];
const DISABILITY = ['none', 'declared'];

const pick = <T>(rng: SeededRandom, values: T[]): T => values[rng.int(0, values.length - 1)] as T;

const personFields = (rng: SeededRandom, index: number) => {
  const firstName = pick(rng, FIRST_NAMES);
  const lastName = pick(rng, LAST_NAMES);
  const gender = pick(rng, GENDERS);
  const age = rng.int(21, 68);
  return {
    full_name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index}@example-demo.test`,
    phone_number: `+372 5${rng.int(100_0000, 999_9999)}`,
    national_id: `${rng.int(30_000_000_000, 60_000_000_000)}`,
    date_of_birth: new Date(Date.UTC(2026 - age, rng.int(0, 11), rng.int(1, 28)))
      .toISOString()
      .slice(0, 10),
    address: `${pick(rng, CITIES)}, ${rng.int(1, 120)} Demo Street`,
    city: pick(rng, CITIES),
    region: pick(rng, REGIONS),
    gender,
    age,
    ethnicity: pick(rng, ETHNICITIES),
    disability_status: rng.float(0, 1) < 0.12 ? DISABILITY[1] : DISABILITY[0],
  };
};

const PERSON_SCHEMA: SchemaField[] = [
  { name: 'full_name', type: 'string', description: 'Applicant full name' },
  { name: 'email', type: 'string' },
  { name: 'phone_number', type: 'string' },
  { name: 'national_id', type: 'string', description: 'National identification number' },
  { name: 'date_of_birth', type: 'date' },
  { name: 'address', type: 'string' },
  { name: 'city', type: 'categorical' },
  { name: 'region', type: 'categorical', protectedAttribute: true },
  { name: 'gender', type: 'categorical', protectedAttribute: true },
  { name: 'age', type: 'number', protectedAttribute: true },
  { name: 'ethnicity', type: 'categorical', protectedAttribute: true },
  { name: 'disability_status', type: 'categorical', protectedAttribute: true },
];

export const DEMO_DATASETS: DemoDatasetDefinition[] = [
  {
    name: 'Consumer Lending Applications',
    domain: 'Financial services',
    version: '2026.03',
    recordCount: 1_200,
    schema: [
      ...PERSON_SCHEMA,
      { name: 'annual_income', type: 'number' },
      { name: 'credit_score', type: 'number' },
      { name: 'loan_amount', type: 'number' },
      { name: 'years_experience', type: 'number' },
      { name: 'education', type: 'categorical' },
      { name: 'existing_customer', type: 'boolean' },
      { name: 'ground_truth', type: 'boolean', description: 'Historical repayment outcome' },
    ],
    build: (rng, index) => ({
      ...personFields(rng, index),
      annual_income: rng.int(18_000, 145_000),
      credit_score: rng.int(520, 840),
      loan_amount: rng.int(2_000, 90_000),
      years_experience: rng.int(0, 35),
      education: pick(rng, EDUCATION),
      existing_customer: rng.float(0, 1) < 0.4,
      ground_truth: rng.float(0, 1) < 0.55,
    }),
  },
  {
    name: 'Graduate Hiring Candidates',
    domain: 'Human resources',
    version: '2026.02',
    recordCount: 900,
    schema: [
      ...PERSON_SCHEMA,
      { name: 'years_experience', type: 'number' },
      { name: 'education', type: 'categorical' },
      { name: 'assessment_score', type: 'number' },
      { name: 'referred', type: 'boolean' },
      { name: 'ground_truth', type: 'boolean', description: 'Historical hiring outcome' },
    ],
    build: (rng, index) => ({
      ...personFields(rng, index),
      years_experience: rng.int(0, 18),
      education: pick(rng, EDUCATION),
      assessment_score: rng.int(40, 100),
      referred: rng.float(0, 1) < 0.25,
      ground_truth: rng.float(0, 1) < 0.45,
    }),
  },
  {
    name: 'Patient Triage Records',
    domain: 'Healthcare',
    version: '2026.01',
    recordCount: 700,
    schema: [
      ...PERSON_SCHEMA,
      { name: 'medical_record_number', type: 'string' },
      { name: 'diagnosis_code', type: 'categorical' },
      { name: 'risk_score', type: 'number' },
      { name: 'prior_admissions', type: 'number' },
    ],
    build: (rng, index) => ({
      ...personFields(rng, index),
      medical_record_number: `MRN-${rng.int(100_000, 999_999)}`,
      diagnosis_code: pick(rng, ['E11', 'I10', 'J45', 'M54', 'F41']),
      risk_score: rng.int(1, 99),
      prior_admissions: rng.int(0, 7),
    }),
  },
];

export const buildRecords = (definition: DemoDatasetDefinition, seed: string) => {
  const rng = new SeededRandom(`${seed}:${definition.name}`);
  return Array.from({ length: definition.recordCount }, (_unused, index) =>
    definition.build(rng, index),
  );
};
