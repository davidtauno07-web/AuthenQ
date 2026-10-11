import type { Rng } from '../lib/prng.js';
import { K_MIN } from './firewall.js';

/**
 * Pattern learning for Twin. Learns the *structure* of a column (formats, prefixes, lengths,
 * domains, date formats) from aggregate statistics only, so synthetic values look like the
 * source without reproducing any identity. Groups seen fewer than K_MIN times are never used.
 */
export const PATTERN_VERSION = 'patterns-1.0';

export type PatternKind = 'PHONE' | 'EMAIL' | 'IDENTIFIER' | 'POSTAL_CODE' | 'DATE' | 'PERSON_NAME' | 'GENERIC';

export interface Share<T extends string = string> { value: T; share: number }

export interface LearnedPattern {
  table: string;
  column: string;
  kind: PatternKind;
  sampleSize: number;
  confidence: number;
  shapes: Share[];
  lengths: { min: number; max: number };
  prefixes: Share[];
  literalPrefix: string | null;
  emailDomains: Share[];
  emailStyles: Share[];
  dateFormat: string | null;
  yearRange: { min: number; max: number } | null;
  nameParts: Share[];
  preserves: string[];
  limitations: string[];
}

export const shapeOf = (v: string) => v.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9');

function shares(values: string[], key: (v: string) => string | null, limit = 8): Share[] {
  const counts = new Map<string, number>();
  let n = 0;
  for (const v of values) {
    const k = key(v);
    if (k == null) continue;
    n++;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= K_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, c]) => ({ value, share: Math.round((c / Math.max(n, 1)) * 1000) / 1000 }));
}

const covered = (xs: Share[]) => xs.reduce((a, x) => a + x.share, 0);

function leadingDigits(values: string[]): Share[] {
  // Extend the leading-digit prefix (3 to 6 digits) while it does not split groups or lose coverage,
  // so "+264 81…" keeps country and network code and "081…/085…" keeps the network code.
  const at = (len: number) =>
    shares(values, (v) => {
      const d = v.replace(/\D/g, '');
      return d.length > len + 3 ? `${v.trim().startsWith('+') ? '+' : ''}${d.slice(0, len)}` : null;
    });
  const base = at(3);
  if (covered(base) < 0.6) return [];
  let best = base;
  for (const len of [4, 5, 6]) {
    const s = at(len);
    if (s.length <= base.length && covered(s) >= covered(base) - 0.05) best = s;
    else break;
  }
  return best;
}

function commonLiteralPrefix(values: string[]): string | null {
  const s = shares(values, (v) => /^([A-Za-z]{1,6}[-_/]?)(?=\d)/.exec(v)?.[1] ?? null, 3);
  return s[0] && s[0].share >= 0.8 ? s[0].value : null;
}

const DATE_FORMATS: [RegExp, string][] = [
  [/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD'],
  [/^\d{2}\/\d{2}\/\d{4}$/, 'DD/MM/YYYY'],
  [/^\d{2}\.\d{2}\.\d{4}$/, 'DD.MM.YYYY'],
  [/^\d{2}-\d{2}-\d{4}$/, 'DD-MM-YYYY'],
];

function emailStyle(local: string): string {
  if (/^[a-z]+\.[a-z]+$/i.test(local)) return 'first.last';
  if (/^[a-z]\.[a-z]+$/i.test(local)) return 'f.last';
  if (/^[a-z]+_[a-z]+$/i.test(local)) return 'first_last';
  if (/^[a-z]+\.?[a-z]*\d+$/i.test(local)) return 'name+digits';
  if (/^[a-z]+$/i.test(local)) return 'word';
  return 'other';
}

function kindOf(entityType: string | null, dataType: string): PatternKind {
  if (entityType === 'PHONE') return 'PHONE';
  if (entityType === 'EMAIL') return 'EMAIL';
  if (entityType === 'POSTAL_CODE') return 'POSTAL_CODE';
  if (entityType === 'DATE_OF_BIRTH' || dataType === 'date') return 'DATE';
  if (entityType === 'PERSON_NAME') return 'PERSON_NAME';
  if (entityType === 'GOVERNMENT_ID' || entityType === 'FINANCIAL_ACCOUNT' || entityType === 'UNIQUE_VALUE') return 'IDENTIFIER';
  return 'GENERIC';
}

export function learnPattern(table: string, column: { name: string; entityType: string | null; dataType: string }, raw: unknown[]): LearnedPattern {
  const values = raw.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').map((v) => String(v).trim());
  const kind = kindOf(column.entityType, column.dataType);
  const shapes = shares(values, shapeOf);
  const lens = values.map((v) => v.length);
  const p: LearnedPattern = {
    table,
    column: column.name,
    kind,
    sampleSize: values.length,
    confidence: 0,
    shapes,
    lengths: { min: lens.length ? Math.min(...lens) : 0, max: lens.length ? Math.max(...lens) : 0 },
    prefixes: [],
    literalPrefix: null,
    emailDomains: [],
    emailStyles: [],
    dateFormat: null,
    yearRange: null,
    nameParts: [],
    preserves: [],
    limitations: [],
  };
  if (kind === 'PHONE') {
    p.prefixes = leadingDigits(values);
    if (p.prefixes.length) p.preserves.push(`dialling prefixes (${p.prefixes.slice(0, 3).map((x) => x.value).join(', ')})`);
  }
  if (kind === 'IDENTIFIER' || kind === 'GENERIC' || kind === 'POSTAL_CODE') {
    p.literalPrefix = commonLiteralPrefix(values);
    if (p.literalPrefix) p.preserves.push(`identifier prefix "${p.literalPrefix}"`);
  }
  if (kind === 'EMAIL') {
    const emails = values.filter((v) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v));
    p.emailDomains = shares(emails, (v) => v.split('@')[1]!.toLowerCase());
    p.emailStyles = shares(emails, (v) => emailStyle(v.split('@')[0]!));
    if (p.emailDomains.length) p.preserves.push(`shared email domains (${p.emailDomains.length})`);
    if (p.emailStyles.length) p.preserves.push('address style (e.g. first.last)');
    if (covered(p.emailDomains) < 1) p.limitations.push('Domains used by fewer than 5 records are replaced with reserved example domains, so they cannot identify anyone.');
  }
  if (kind === 'DATE') {
    const fmt = DATE_FORMATS.find(([re]) => values.filter((v) => re.test(v)).length >= values.length * 0.8);
    p.dateFormat = fmt?.[1] ?? null;
    const years = values.map((v) => Number(/(\d{4})/.exec(v)?.[1])).filter((y) => y > 1800 && y < 2200).sort((a, b) => a - b);
    if (years.length >= K_MIN) p.yearRange = { min: years[Math.floor(years.length * 0.05)]!, max: years[Math.floor(years.length * 0.95)]! };
    if (p.dateFormat) p.preserves.push(`date format ${p.dateFormat}`);
    if (p.yearRange) p.preserves.push(`year range ${p.yearRange.min}–${p.yearRange.max} (5th–95th percentile)`);
  }
  if (kind === 'PERSON_NAME') {
    p.nameParts = shares(values, (v) => `${v.split(/\s+/).length}`);
    if (p.nameParts.length) p.preserves.push('number of name parts');
    p.limitations.push('Names come from a built-in synthetic name list, not from a country-specific reference list.');
  }
  if (shapes.length) p.preserves.push(`value formats (${shapes.length} common shape${shapes.length > 1 ? 's' : ''})`);
  p.preserves.push(`length ${p.lengths.min}–${p.lengths.max}`);

  const share = (re: RegExp) => values.filter((v) => re.test(v)).length / Math.max(values.length, 1);
  const shapeCover =
    kind === 'EMAIL' ? share(/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i)
    : kind === 'PERSON_NAME' ? share(/^[A-Z][a-z'-]+(?: [A-Z][a-z'-]+){0,3}$/)
    : kind === 'DATE' ? (p.dateFormat ? share(DATE_FORMATS.find(([, f]) => f === p.dateFormat)![0]) : 0)
    : covered(shapes);
  p.confidence = Math.round(Math.min(1, values.length >= 30 ? shapeCover : shapeCover * (values.length / 30)) * 100) / 100;
  if (values.length < 30) p.limitations.push(`Only ${values.length} values were available to learn from.`);
  if (shapeCover < 0.6) p.limitations.push(`Formats vary a lot: the common formats cover ${Math.round(shapeCover * 100)}% of values. Rare formats fall back to a generic format-preserving replacement.`);
  return p;
}

function pick(xs: Share[], rng: Rng): string | null {
  if (!xs.length) return null;
  const total = covered(xs);
  let r = rng.next() * total;
  for (const x of xs) if ((r -= x.share) <= 0) return x.value;
  return xs[xs.length - 1]!.value;
}

function fillShape(shape: string, rng: Rng, digitPrefix = ''): string {
  let di = 0;
  const pre = digitPrefix.replace(/\D/g, '');
  return shape.replace(/[A9a]/g, (ch) => {
    if (ch === '9') return di < pre.length ? pre[di++]! : (di++, String(rng.int(0, 9)));
    if (ch === 'A') return String.fromCharCode(65 + rng.int(0, 25));
    return String.fromCharCode(97 + rng.int(0, 25));
  });
}

const EXAMPLE_DOMAINS = ['example.com', 'example.org', 'example.net'];

function formatDate(y: number, m: number, d: number, fmt: string | null) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  if (fmt === 'DD/MM/YYYY') return `${dd}/${mm}/${y}`;
  if (fmt === 'DD.MM.YYYY') return `${dd}.${mm}.${y}`;
  if (fmt === 'DD-MM-YYYY') return `${dd}-${mm}-${y}`;
  return `${y}-${mm}-${dd}`;
}

/** Generates a synthetic value that follows the learned pattern, or null when the pattern cannot drive generation. */
export function generateFromPattern(p: LearnedPattern, rng: Rng, personName: string): string | null {
  switch (p.kind) {
    case 'PHONE': {
      const shape = pick(p.shapes, rng);
      if (!shape) return null;
      return fillShape(shape, rng, pick(p.prefixes, rng) ?? '');
    }
    case 'EMAIL': {
      const [first, last] = personName.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
      const style = pick(p.emailStyles, rng) ?? 'first.last';
      const n = String(rng.int(10, 999));
      const local =
        style === 'f.last' ? `${first![0]}.${last}` : style === 'first_last' ? `${first}_${last}` : style === 'word' ? `${first}${last}` : style === 'name+digits' ? `${first}${n}` : `${first}.${last}`;
      const domain = rng.next() < covered(p.emailDomains) ? pick(p.emailDomains, rng)! : rng.pick(EXAMPLE_DOMAINS);
      return `${local}.${String(rng.int(100, 999))}@${domain}`.replace(/\.(\d+)@/, style === 'name+digits' ? '@' : '.$1@');
    }
    case 'DATE': {
      if (!p.yearRange) return null;
      return formatDate(rng.int(p.yearRange.min, p.yearRange.max), rng.int(1, 12), rng.int(1, 28), p.dateFormat);
    }
    case 'IDENTIFIER':
    case 'POSTAL_CODE':
    case 'GENERIC': {
      const shape = pick(p.shapes, rng);
      if (!shape) return null;
      if (p.literalPrefix && shapeOf(p.literalPrefix) === shape.slice(0, p.literalPrefix.length)) return p.literalPrefix + fillShape(shape.slice(p.literalPrefix.length), rng);
      return fillShape(shape, rng);
    }
    default:
      return null;
  }
}

/** Share of generated values whose shape is one the source uses (or that fit the learned length range). */
export function conformance(p: LearnedPattern, generated: string[]): number {
  if (!generated.length) return 1;
  const known = new Set(p.shapes.map((s) => s.value));
  let ok = 0;
  for (const g of generated) {
    if (p.kind === 'EMAIL') ok += /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(g) ? 1 : 0;
    else if (p.kind === 'PERSON_NAME') ok += /^[A-Z][a-z'-]+( [A-Z][a-z'-]+)*$/.test(g) ? 1 : 0;
    else if (p.kind === 'DATE') ok += DATE_FORMATS.some(([re, f]) => (p.dateFormat ? f === p.dateFormat : true) && re.test(g)) ? 1 : 0;
    else ok += known.size ? (known.has(shapeOf(g)) ? 1 : 0) : g.length >= p.lengths.min && g.length <= p.lengths.max ? 1 : 0;
  }
  return Math.round((ok / generated.length) * 1000) / 1000;
}
