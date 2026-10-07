/**
 * Firewall classifier: inspects a sample of real values for each column and
 * produces an explained classification. Pure and deterministic so scans are
 * reproducible and versionable.
 */
export const CLASSIFIER_VERSION = 'firewall-rules-1.3';

export type Classification = 'SENSITIVE' | 'NEEDS_DECISION' | 'NON_SENSITIVE' | 'OUTCOME' | 'IDENTIFIER';
export type Action = 'REPLACE' | 'GENERALIZE' | 'KEEP' | 'DROP' | 'SCRUB_TEXT' | 'KEY';

export interface ColumnInput {
  table: string;
  name: string;
  values: unknown[];
  totalRows: number;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
}

export interface ColumnStats {
  sampled: number;
  nullRatio: number;
  distinct: number;
  distinctRatio: number;
  avgLength: number;
  patternHits: Record<string, number>;
  topValuesHidden: boolean;
  numeric?: { min: number; max: number; mean: number };
}

export interface ColumnFinding {
  classification: Classification;
  entityType: string | null;
  suggestedAction: Action;
  dataType: string;
  format: string | null;
  confidence: number;
  explanation: string;
  stats: ColumnStats;
  textEntities?: Record<string, number>;
}

export const PATTERNS: Record<string, RegExp> = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
  PHONE: /^\+?[\d\s().-]{7,20}$/,
  SSN: /^\d{3}-\d{2}-\d{4}$/,
  CREDIT_CARD: /^(?:\d[ -]?){13,19}$/,
  IBAN: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/,
  IP_ADDRESS: /^(?:\d{1,3}\.){3}\d{1,3}$/,
  POSTAL_CODE: /^\d{5}(?:-\d{4})?$/,
  DATE: /^\d{4}-\d{2}-\d{2}$/,
  DATETIME: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  URL: /^https?:\/\//i,
};

export const TEXT_ENTITY_PATTERNS: Record<string, RegExp> = {
  EMAIL: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  PHONE: /(?:\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){1,4}\d{2,4}|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
  ACCOUNT_ID: /\b(?:ACC|CUS|ORD|INV)-?\d{4,}\b/g,
};

const NAME_HINTS: [RegExp, string, Classification, Action][] = [
  [/(^|_)(first|last|full|given|family|sur)?_?name$/i, 'PERSON_NAME', 'SENSITIVE', 'REPLACE'],
  [/e-?mail/i, 'EMAIL', 'SENSITIVE', 'REPLACE'],
  [/phone|mobile|tel(ephone)?$/i, 'PHONE', 'SENSITIVE', 'REPLACE'],
  [/ssn|social_?security|national_?id|passport|tax_?id/i, 'GOVERNMENT_ID', 'SENSITIVE', 'REPLACE'],
  [/card|iban|account_?number|routing/i, 'FINANCIAL_ACCOUNT', 'SENSITIVE', 'REPLACE'],
  [/address|street/i, 'STREET_ADDRESS', 'SENSITIVE', 'REPLACE'],
  [/(^|_)(zip|postal)/i, 'POSTAL_CODE', 'NEEDS_DECISION', 'GENERALIZE'],
  [/birth|dob/i, 'DATE_OF_BIRTH', 'NEEDS_DECISION', 'GENERALIZE'],
  [/(^|_)(ip|ip_address)$/i, 'IP_ADDRESS', 'SENSITIVE', 'REPLACE'],
  [/(^|_)(city|town)$/i, 'CITY', 'NEEDS_DECISION', 'KEEP'],
  [/gender|sex|ethnicity|race|religion|health|diagnosis/i, 'SPECIAL_CATEGORY', 'NEEDS_DECISION', 'GENERALIZE'],
  [/password|secret|token/i, 'CREDENTIAL', 'SENSITIVE', 'DROP'],
];

const OUTCOME_HINTS = /(^|_)(category|label|outcome|resolution|status|priority|intent|sentiment|class|disposition|reason|type|tier|segment|channel)$/i;
const TEXT_HINTS = /(body|text|message|description|comment|notes?|subject|content|transcript)$/i;

function luhn(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function inferType(values: string[]): { dataType: string; format: string | null } {
  if (!values.length) return { dataType: 'string', format: null };
  const all = (re: RegExp) => values.every((v) => re.test(v));
  if (all(/^-?\d+$/)) return { dataType: 'integer', format: null };
  if (all(/^-?\d+(\.\d+)?$/)) return { dataType: 'number', format: null };
  if (all(/^(true|false|yes|no|0|1)$/i)) return { dataType: 'boolean', format: null };
  if (all(PATTERNS.DATE!)) return { dataType: 'date', format: 'YYYY-MM-DD' };
  if (all(PATTERNS.DATETIME!)) return { dataType: 'datetime', format: 'ISO-8601' };
  const avg = values.reduce((a, v) => a + v.length, 0) / values.length;
  const prefixed = values.every((v) => /^[A-Z]{2,5}-\d+$/.test(v));
  if (prefixed) return { dataType: 'string', format: `${values[0]!.split('-')[0]}-#####` };
  return { dataType: avg > 60 ? 'text' : 'string', format: null };
}

export function detectTextEntities(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, re] of Object.entries(TEXT_ENTITY_PATTERNS)) {
    const matches = text.match(re);
    if (matches?.length) out[type] = matches;
  }
  return out;
}

export function classifyColumn(col: ColumnInput, knownPersonNames: Set<string> = new Set()): ColumnFinding {
  const raw = col.values;
  const present = raw.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map((v) => String(v).trim());
  const distinct = new Set(present).size;
  const stats: ColumnStats = {
    sampled: raw.length,
    nullRatio: raw.length ? 1 - present.length / raw.length : 0,
    distinct,
    distinctRatio: present.length ? distinct / present.length : 0,
    avgLength: present.length ? present.reduce((a, v) => a + v.length, 0) / present.length : 0,
    patternHits: {},
    topValuesHidden: true,
  };
  for (const [name, re] of Object.entries(PATTERNS)) {
    const hits = present.filter((v) => re.test(v)).length;
    if (hits) stats.patternHits[name] = hits / Math.max(present.length, 1);
  }
  const { dataType, format } = inferType(present.slice(0, 500));
  if (dataType === 'integer' || dataType === 'number') {
    const nums = present.map(Number);
    stats.numeric = { min: Math.min(...nums), max: Math.max(...nums), mean: nums.reduce((a, b) => a + b, 0) / nums.length };
  }
  const base = { dataType, format, stats };
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  if (col.isPrimaryKey || col.isForeignKey) {
    return {
      ...base,
      classification: 'IDENTIFIER',
      entityType: col.isPrimaryKey ? 'PRIMARY_KEY' : 'FOREIGN_KEY',
      suggestedAction: 'KEY',
      confidence: 0.99,
      explanation: col.isPrimaryKey
        ? `Primary key of ${col.table}: every sampled value is unique. Twin will issue new synthetic keys and keep relationships intact.`
        : `References another table. Twin will remap it to the matching synthetic parent key so relationships are preserved.`,
    };
  }

  const strongPattern = Object.entries(stats.patternHits).find(([k, v]) => v >= 0.8 && ['EMAIL', 'SSN', 'IBAN', 'IP_ADDRESS'].includes(k));
  if (strongPattern) {
    return {
      ...base,
      classification: 'SENSITIVE',
      entityType: strongPattern[0],
      suggestedAction: 'REPLACE',
      confidence: 0.97,
      explanation: `${pct(strongPattern[1])} of sampled values match the ${strongPattern[0].toLowerCase().replace('_', ' ')} format. Values will be replaced with synthetic equivalents that keep the same format.`,
    };
  }
  const cardHits = present.filter((v) => PATTERNS.CREDIT_CARD!.test(v) && luhn(v)).length;
  if (present.length && cardHits / present.length >= 0.8) {
    return {
      ...base,
      classification: 'SENSITIVE',
      entityType: 'CREDIT_CARD',
      suggestedAction: 'REPLACE',
      confidence: 0.96,
      explanation: `${pct(cardHits / present.length)} of sampled values are card-length numbers that pass the Luhn checksum.`,
    };
  }

  for (const [re, entity, cls, action] of NAME_HINTS) {
    if (re.test(col.name)) {
      const nameHits = entity === 'PERSON_NAME' ? present.filter((v) => /^[A-Z][a-z'-]+(?: [A-Z][a-z'-]+){0,3}$/.test(v)).length / Math.max(present.length, 1) : 0;
      const phoneHits = stats.patternHits.PHONE ?? 0;
      const evidence =
        entity === 'PERSON_NAME' ? ` ${pct(nameHits)} of sampled values look like personal names.` :
        entity === 'PHONE' ? ` ${pct(phoneHits)} of sampled values match a phone number format.` : '';
      return {
        ...base,
        classification: cls,
        entityType: entity,
        suggestedAction: action,
        confidence: cls === 'SENSITIVE' ? 0.9 : 0.7,
        explanation:
          cls === 'SENSITIVE'
            ? `The column name "${col.name}" indicates ${entity.toLowerCase().replace(/_/g, ' ')} data.${evidence} It must not leave the Firewall as-is.`
            : `"${col.name}" may identify a person when combined with other fields (combination risk). Choose whether to keep, generalize or replace it.`,
      };
    }
  }

  if (dataType === 'text' || TEXT_HINTS.test(col.name)) {
    const entityCounts: Record<string, number> = {};
    let personHits = 0;
    for (const v of present.slice(0, 400)) {
      for (const [type, m] of Object.entries(detectTextEntities(v))) entityCounts[type] = (entityCounts[type] ?? 0) + m.length;
      if (knownPersonNames.size && v.split(/\W+/).some((w) => knownPersonNames.has(w))) personHits++;
    }
    if (personHits) entityCounts.PERSON_NAME = personHits;
    const total = Object.values(entityCounts).reduce((a, b) => a + b, 0);
    const list = Object.entries(entityCounts).map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
    return {
      ...base,
      dataType: 'text',
      classification: total ? 'SENSITIVE' : 'NEEDS_DECISION',
      entityType: 'FREE_TEXT',
      suggestedAction: 'SCRUB_TEXT',
      confidence: total ? 0.88 : 0.6,
      textEntities: entityCounts,
      explanation: total
        ? `Free text containing embedded personal details in the sample (${list}). Twin will replace each detected entity and rebuild the text from synthetic sentences.`
        : `Free text. No embedded identifiers were found in the sample, but free text can still contain personal details. Scrubbing is recommended.`,
    };
  }

  if (stats.distinctRatio > 0.95 && present.length > 20 && dataType === 'string') {
    return {
      ...base,
      classification: 'NEEDS_DECISION',
      entityType: 'UNIQUE_VALUE',
      suggestedAction: 'REPLACE',
      confidence: 0.65,
      explanation: `${pct(stats.distinctRatio)} of values are unique, so this column could single out individual records. Replacing is recommended unless it is meaningless to identity.`,
    };
  }

  if (OUTCOME_HINTS.test(col.name) && distinct <= 30) {
    return {
      ...base,
      classification: 'OUTCOME',
      entityType: 'CATEGORICAL_OUTCOME',
      suggestedAction: 'KEEP',
      confidence: 0.8,
      explanation: `Low-cardinality field (${distinct} distinct values) that describes an outcome or category. It is not personal on its own and is useful for labeling and evaluation; its distribution will be preserved.`,
    };
  }

  return {
    ...base,
    classification: 'NON_SENSITIVE',
    entityType: null,
    suggestedAction: 'KEEP',
    confidence: 0.75,
    explanation:
      dataType === 'integer' || dataType === 'number'
        ? `Numeric measure with no identifying pattern. Twin will synthesize values that follow the same range and distribution.`
        : `No sensitive pattern, identifying name or high uniqueness was found in the sample. The distribution will be preserved.`,
  };
}

/** Detects likely foreign keys by name and value containment. */
export function inferRelations(tables: { name: string; primaryKey: string | null; columns: Record<string, string[]> }[]) {
  const out: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; confidence: number; explanation: string }[] = [];
  for (const parent of tables) {
    if (!parent.primaryKey) continue;
    const parentValues = new Set(parent.columns[parent.primaryKey] ?? []);
    if (!parentValues.size) continue;
    for (const child of tables) {
      if (child === parent) continue;
      for (const [colName, values] of Object.entries(child.columns)) {
        if (colName === child.primaryKey) continue;
        const nameMatch = colName === parent.primaryKey || colName.replace(/_?id$/i, '') === parent.name.replace(/s$/, '');
        const present = values.filter(Boolean);
        if (!present.length) continue;
        const contained = present.filter((v) => parentValues.has(v)).length / present.length;
        if (contained >= 0.98 && (nameMatch || contained === 1)) {
          out.push({
            fromTable: child.name,
            fromColumn: colName,
            toTable: parent.name,
            toColumn: parent.primaryKey,
            confidence: nameMatch ? 0.98 : 0.85,
            explanation: `${Math.round(contained * 100)}% of ${child.name}.${colName} values exist in ${parent.name}.${parent.primaryKey}${nameMatch ? ' and the column names match' : ''}.`,
          });
        }
      }
    }
  }
  return out;
}

/** Guesses a primary key: a column named id/<table>_id that is unique and non-null. */
export function guessPrimaryKey(table: string, columns: Record<string, string[]>): string | null {
  const singular = table.replace(/s$/, '');
  const candidates = Object.keys(columns).sort((a, b) => {
    const score = (c: string) => (c === 'id' ? 0 : c === `${singular}_id` ? 1 : /_id$/.test(c) ? 2 : 3);
    return score(a) - score(b);
  });
  for (const c of candidates) {
    const vals = columns[c]!;
    if (!/(^id$|_id$)/i.test(c)) continue;
    if (vals.every(Boolean) && new Set(vals).size === vals.length) return c;
  }
  return null;
}
