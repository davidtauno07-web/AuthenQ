import { SensitivityLevel } from '@prisma/client';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'categorical';

export interface SchemaField {
  name: string;
  type: FieldType;
  description?: string;
  /** Marks a column the organization treats as a protected attribute. */
  protectedAttribute?: boolean;
}

export interface PiiDetection {
  fieldName: string;
  category: PiiCategory;
  sensitivityLevel: SensitivityLevel;
  detectionMethod: 'NAME_PATTERN' | 'VALUE_PATTERN' | 'NAME_AND_VALUE_PATTERN' | 'QUASI_IDENTIFIER';
  confidence: number;
  sampleMasked: string | null;
}

export type PiiCategory =
  | 'NAME'
  | 'EMAIL'
  | 'PHONE'
  | 'ADDRESS'
  | 'DATE_OF_BIRTH'
  | 'NATIONAL_ID'
  | 'CUSTOMER_ID'
  | 'MEDICAL_RECORD_NUMBER'
  | 'FINANCIAL'
  | 'LOCATION'
  | 'HEALTH'
  | 'PROTECTED_ATTRIBUTE'
  | 'QUASI_IDENTIFIER';

interface CategoryRule {
  category: PiiCategory;
  sensitivityLevel: SensitivityLevel;
  namePattern: RegExp;
  valuePattern?: RegExp;
}

/**
 * Rule catalogue. Name matching alone is a weak signal, so a rule that also
 * matches sampled values is promoted to a higher confidence tier.
 */
const RULES: CategoryRule[] = [
  {
    category: 'EMAIL',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(e[-_]?mail|email_address)/i,
    valuePattern: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
  },
  {
    category: 'PHONE',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(phone|mobile|telephone|msisdn)/i,
    valuePattern: /^[+]?[\d][\d\s()\-.]{6,}$/,
  },
  {
    category: 'NATIONAL_ID',
    sensitivityLevel: SensitivityLevel.CRITICAL,
    namePattern: /(ssn|social_security|national_id|nin|personal_code|passport|id_number|isikukood)/i,
    valuePattern: /^(\d{3}-\d{2}-\d{4}|[A-Z]{0,2}\d{6,12})$/i,
  },
  {
    category: 'MEDICAL_RECORD_NUMBER',
    sensitivityLevel: SensitivityLevel.CRITICAL,
    namePattern: /(mrn|medical_record|patient_number|patient_id|chart_number)/i,
  },
  {
    category: 'FINANCIAL',
    sensitivityLevel: SensitivityLevel.CRITICAL,
    namePattern: /(iban|account_number|card_number|credit_card|routing|salary|income|annual_income|loan_amount|balance|debt|credit_score)/i,
    valuePattern: /^(\d{12,19}|[A-Z]{2}\d{2}[A-Z0-9]{10,30})$/i,
  },
  {
    category: 'DATE_OF_BIRTH',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(dob|date_of_birth|birth_date|birthdate|birthday)/i,
    valuePattern: /^\d{4}-\d{2}-\d{2}/,
  },
  {
    category: 'NAME',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(^name$|full_name|first_name|last_name|surname|given_name|family_name|applicant_name|patient_name)/i,
  },
  {
    category: 'ADDRESS',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(address|street|postcode|postal_code|zip|house_number)/i,
  },
  {
    category: 'LOCATION',
    sensitivityLevel: SensitivityLevel.MEDIUM,
    namePattern: /(city|region|county|district|municipality|country|latitude|longitude|geo|location)/i,
  },
  {
    category: 'HEALTH',
    sensitivityLevel: SensitivityLevel.CRITICAL,
    namePattern: /(diagnosis|icd|condition|treatment|medication|symptom|triage|blood|disability|health)/i,
  },
  {
    category: 'CUSTOMER_ID',
    sensitivityLevel: SensitivityLevel.MEDIUM,
    namePattern: /(customer_id|client_id|applicant_id|employee_id|member_id|account_id|^id$|_uuid$)/i,
  },
  {
    category: 'PROTECTED_ATTRIBUTE',
    sensitivityLevel: SensitivityLevel.HIGH,
    namePattern: /(gender|sex|race|ethnic|religion|nationality|marital_status|pregnan|sexual_orientation|veteran)/i,
  },
  {
    category: 'QUASI_IDENTIFIER',
    sensitivityLevel: SensitivityLevel.MEDIUM,
    namePattern: /(age|occupation|job_title|employer|education|zip_prefix|department|tenure|years_experience)/i,
  },
];

export interface ScanOptions {
  /** Sampled records; values are inspected but never returned unmasked. */
  sampleRecords?: Record<string, unknown>[];
  maxSamples?: number;
}

export const scanSchemaForPii = (
  schema: SchemaField[],
  options: ScanOptions = {},
): PiiDetection[] => {
  const samples = (options.sampleRecords ?? []).slice(0, options.maxSamples ?? 200);
  const detections: PiiDetection[] = [];

  for (const field of schema) {
    const values = samples
      .map((record) => record[field.name])
      .filter((value): value is string | number => value !== null && value !== undefined)
      .map((value) => String(value));

    let best: PiiDetection | null = null;

    for (const rule of RULES) {
      const nameMatch = rule.namePattern.test(field.name);
      const valueMatchRatio =
        rule.valuePattern && values.length > 0
          ? values.filter((value) => rule.valuePattern!.test(value)).length / values.length
          : 0;
      const valueMatch = valueMatchRatio >= 0.6;

      if (!nameMatch && !valueMatch) continue;

      const method: PiiDetection['detectionMethod'] =
        nameMatch && valueMatch
          ? 'NAME_AND_VALUE_PATTERN'
          : valueMatch
            ? 'VALUE_PATTERN'
            : rule.category === 'QUASI_IDENTIFIER'
              ? 'QUASI_IDENTIFIER'
              : 'NAME_PATTERN';

      const confidence = nameMatch && valueMatch ? 0.98 : valueMatch ? 0.86 : 0.74;

      const candidate: PiiDetection = {
        fieldName: field.name,
        category: rule.category,
        sensitivityLevel: rule.sensitivityLevel,
        detectionMethod: method,
        confidence,
        sampleMasked: values.length > 0 ? maskValue(values[0] as string) : null,
      };

      if (!best || rankDetection(candidate) > rankDetection(best)) best = candidate;
    }

    if (!best && field.protectedAttribute) {
      best = {
        fieldName: field.name,
        category: 'PROTECTED_ATTRIBUTE',
        sensitivityLevel: SensitivityLevel.HIGH,
        detectionMethod: 'NAME_PATTERN',
        confidence: 0.9,
        sampleMasked: values.length > 0 ? maskValue(values[0] as string) : null,
      };
    }

    if (best) detections.push(best);
  }

  return detections;
};

const SENSITIVITY_RANK: Record<SensitivityLevel, number> = {
  [SensitivityLevel.LOW]: 0,
  [SensitivityLevel.MEDIUM]: 1,
  [SensitivityLevel.HIGH]: 2,
  [SensitivityLevel.CRITICAL]: 3,
};

const rankDetection = (detection: PiiDetection): number =>
  SENSITIVITY_RANK[detection.sensitivityLevel] * 10 + detection.confidence;

/** Masks a sampled value so evidence can be shown without exposing raw data. */
export const maskValue = (value: string): string => {
  if (value.length <= 2) return '••';
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${(local as string).slice(0, 1)}••••@${(domain as string).replace(/^[^.]*/, '••••')}`;
  }
  return `${value.slice(0, 1)}${'•'.repeat(Math.min(value.length - 2, 8))}${value.slice(-1)}`;
};

export const DIRECT_IDENTIFIER_CATEGORIES: PiiCategory[] = [
  'NAME',
  'EMAIL',
  'PHONE',
  'ADDRESS',
  'NATIONAL_ID',
  'MEDICAL_RECORD_NUMBER',
  'CUSTOMER_ID',
];

export const QUASI_IDENTIFIER_CATEGORIES: PiiCategory[] = [
  'DATE_OF_BIRTH',
  'LOCATION',
  'PROTECTED_ATTRIBUTE',
  'QUASI_IDENTIFIER',
];

export const isDirectIdentifier = (category: string): boolean =>
  DIRECT_IDENTIFIER_CATEGORIES.includes(category as PiiCategory);

export const isQuasiIdentifier = (category: string): boolean =>
  QUASI_IDENTIFIER_CATEGORIES.includes(category as PiiCategory);
