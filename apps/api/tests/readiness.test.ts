import { describe, expect, it } from 'vitest';
import { assignSplits, DEFAULT_CRITERIA, normalizeText, readinessChecks } from '../src/domain/readiness.js';

const recs = Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, text: `ticket ${i % 380} about ${i % 3 ? 'billing' : 'login'}`, label: i % 3 ? 'billing' : 'access', group: `cust-${i % 50}` }));

describe('training splits', () => {
  it('keeps duplicate text in one split and honours fixed gold splits', () => {
    const fixed = recs.map((r, i) => (i < 5 ? { ...r, fixedSplit: 'TEST' as const } : r));
    for (const strategy of ['RANDOM', 'STRATIFIED', 'GROUPED'] as const) {
      const s = assignSplits(fixed, strategy, { train: 0.8, validation: 0.1, test: 0.1 }, 'seed');
      expect(s.size).toBe(recs.length);
      for (let i = 0; i < 5; i++) expect(s.get(`r${i}`)).toBe('TEST');
      const byText = new Map<string, Set<string>>();
      for (const r of fixed) byText.set(normalizeText(r.text), (byText.get(normalizeText(r.text)) ?? new Set()).add(s.get(r.id)!));
      if (strategy !== 'GROUPED') for (const v of byText.values()) expect(v.size).toBe(1);
      const train = [...s.values()].filter((x) => x === 'TRAIN').length;
      expect(train / recs.length).toBeGreaterThan(0.6);
      expect(train / recs.length).toBeLessThan(0.95);
    }
    expect(assignSplits(recs, 'RANDOM', { train: 8, validation: 1, test: 1 }, 'a')).toEqual(assignSplits(recs, 'RANDOM', { train: 8, validation: 1, test: 1 }, 'a'));
  });
  it('keeps every record of a group together in GROUPED mode', () => {
    const s = assignSplits(recs, 'GROUPED', { train: 0.7, validation: 0.15, test: 0.15 }, 'x');
    const byGroup = new Map<string, Set<string>>();
    for (const r of recs) byGroup.set(r.group, (byGroup.get(r.group) ?? new Set()).add(s.get(r.id)!));
    for (const v of byGroup.values()) expect(v.size).toBe(1);
  });
});

describe('readiness checks', () => {
  it('flags conflicting duplicates, leakage, rare labels and flagged records', () => {
    const records = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, text: `refund request ${i}`, label: 'billing', split: (i % 3 === 0 ? 'TEST' : i % 3 === 1 ? 'VALIDATION' : 'TRAIN') as never })),
      { id: 'c1', text: 'Reset my password!', label: 'access', split: 'TRAIN' as never },
      { id: 'c2', text: 'reset my  password', label: 'billing', split: 'TEST' as never },
    ];
    const r = readinessChecks(records, { labels: ['billing', 'access'], unlabeled: 3, flagged: 2, criteria: DEFAULT_CRITERIA });
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.conflicting_duplicates!.passed).toBe(false);
    expect(by.split_leakage!.passed).toBe(false);
    expect(by.rare_labels!.explanation).toMatch(/access \(1\)/);
    expect(by.flagged!.passed).toBe(false);
    expect(r.ready).toBe(false);
    const clean = readinessChecks(records.slice(0, 12).concat(Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, text: `cannot log in ${i}`, label: 'access', split: (['TRAIN', 'VALIDATION', 'TEST'] as const)[i % 3] as never }))), { labels: ['billing', 'access'], unlabeled: 0, flagged: 0, criteria: DEFAULT_CRITERIA });
    expect(clean.ready).toBe(true);
  });
});
