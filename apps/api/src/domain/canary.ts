import { hmac } from '../lib/crypto.js';

/**
 * Canary: every synthetic value Twin creates for a sensitive column gets a
 * deterministic signature. Matching uses normalized values that are indexed in
 * PostgreSQL, so a scan looks up candidate tokens instead of comparing every
 * value against every registry entry.
 */
export function normalize(value: string, entityType: string): string {
  const v = value.normalize('NFKC').trim().toLowerCase();
  if (['PHONE', 'CREDIT_CARD', 'GOVERNMENT_ID', 'FINANCIAL_ACCOUNT'].includes(entityType)) return v.replace(/\D/g, '');
  return v.replace(/\s+/g, ' ');
}

export function signature(secret: string, entityType: string, normalized: string): string {
  return hmac(secret, `${entityType}:${normalized}`).slice(0, 32);
}

const DIGIT_TYPES = ['PHONE', 'CREDIT_CARD', 'GOVERNMENT_ID', 'FINANCIAL_ACCOUNT'];

/** Key used for approximate matching. Null when the entity type has no meaningful approximate form. */
export function fuzzyKey(normalized: string, entityType: string): string | null {
  if (DIGIT_TYPES.includes(entityType)) return normalized.length >= 7 ? `d:${normalized.slice(-7)}` : null;
  if (entityType === 'EMAIL') {
    const local = normalized.split('@')[0] ?? '';
    return local.length >= 5 ? `e:${local}` : null;
  }
  if (entityType === 'PERSON_NAME') {
    const parts = normalized.split(' ').filter(Boolean);
    return parts.length >= 2 ? `n:${[...parts].sort().join(' ')}` : null;
  }
  return null;
}

export type MatchType = 'EXACT' | 'NORMALIZED' | 'APPROXIMATE' | 'HEURISTIC';

/** How a fuzzy-key hit relates to the registered value, with a confidence in [0, 1]. */
export function classifyFuzzy(key: string): { matchType: MatchType; confidence: number; explanation: string } {
  if (key.startsWith('d:')) return { matchType: 'APPROXIMATE', confidence: 0.7, explanation: 'The last 7 digits match a registered value, but the prefix or format differs.' };
  if (key.startsWith('n:')) return { matchType: 'APPROXIMATE', confidence: 0.75, explanation: 'The same name parts appear in a different order.' };
  return { matchType: 'HEURISTIC', confidence: 0.45, explanation: 'The email address before the @ matches a registered value, but the domain differs. This could be a coincidence.' };
}

/** Extracts fuzzy keys from text for approximate lookup. */
export function extractFuzzy(text: string): Map<string, { raw: string; index: number }> {
  const out = new Map<string, { raw: string; index: number }>();
  const add = (key: string | null, raw: string, index: number) => {
    if (key && out.size < MAX_CANDIDATES && !out.has(key)) out.set(key, { raw, index });
  };
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) add(fuzzyKey(m[0].toLowerCase(), 'EMAIL'), m[0], m.index ?? 0);
  for (const m of text.matchAll(/\+?[\d][\d\s().-]{5,22}\d/g)) add(fuzzyKey(m[0].replace(/\D/g, ''), 'PHONE'), m[0], m.index ?? 0);
  const words = [...text.matchAll(/\p{Lu}[\p{L}'-]+/gu)];
  for (let i = 0; i + 1 < words.length; i++) {
    for (const n of [2, 3]) {
      const ws = words.slice(i, i + n);
      if (ws.length < n) continue;
      const last = ws[ws.length - 1]!;
      if (text.slice(ws[0]!.index!, last.index! + last[0].length).length > ws.reduce((a, w) => a + w[0].length + 1, 0) + 2) continue;
      add(fuzzyKey(ws.map((w) => w[0].toLowerCase()).join(' '), 'PERSON_NAME'), ws.map((w) => w[0]).join(' '), ws[0]!.index ?? 0);
    }
  }
  return out;
}

const MAX_CANDIDATES = 50_000;

/** Extracts normalized candidate tokens from text for indexed lookup. */
export function extractCandidates(text: string): Map<string, { raw: string; index: number }> {
  const out = new Map<string, { raw: string; index: number }>();
  const add = (raw: string, index: number, norm: string) => {
    if (norm.length < 4 || out.size >= MAX_CANDIDATES) return;
    if (!out.has(norm)) out.set(norm, { raw, index });
  };
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) add(m[0], m.index ?? 0, m[0].toLowerCase());
  for (const m of text.matchAll(/\+?[\d][\d\s().-]{6,22}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 7) add(m[0], m.index ?? 0, digits);
  }
  for (const m of text.matchAll(/\b[A-Z]{2,5}-S?\d{3,}\b/gi)) add(m[0], m.index ?? 0, m[0].toLowerCase());
  const words = [...text.matchAll(/[\p{L}\p{N}'#.-]+/gu)];
  for (let i = 0; i < words.length; i++) {
    let phrase = '';
    for (let n = 0; n < 6 && i + n < words.length; n++) {
      phrase = n === 0 ? words[i]![0] : `${phrase} ${words[i + n]![0]}`;
      const cleaned = phrase.replace(/[.,]+$/, '');
      if (n >= 1 || /\d/.test(cleaned)) add(cleaned, words[i]!.index ?? 0, cleaned.toLowerCase().replace(/\s+/g, ' '));
    }
  }
  return out;
}

export function contextAround(text: string, index: number, length: number, radius = 60): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

export const SCAN_DISCLAIMER =
  'A scan with no matches means no registered synthetic values were found in this input. It does not prove that no leak occurred elsewhere or in another form.';
