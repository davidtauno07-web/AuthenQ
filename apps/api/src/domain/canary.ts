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
