import { createHash } from 'node:crypto';

export type Split = 'TRAIN' | 'VALIDATION' | 'TEST';
export type SplitStrategy = 'RANDOM' | 'STRATIFIED' | 'GROUPED';
export interface SplitRatios { train: number; validation: number; test: number }
export interface SplitRecord { id: string; text: string; label: string; group?: string | null; fixedSplit?: Split | null }

export const DEFAULT_RATIOS: SplitRatios = { train: 0.8, validation: 0.1, test: 0.1 };

/** Case, spacing and punctuation-insensitive form used to find duplicates and cross-split leakage. */
export function normalizeText(text: string) {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const unit = (seed: string) => parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 12), 16) / 0x1000000000000;

/**
 * Assigns train/validation/test splits. Records with the same normalized text (and, for GROUPED, the same group value)
 * always land in the same split, so no duplicate leaks across splits. Fixed splits (gold) pull their whole group with them.
 */
export function assignSplits(records: SplitRecord[], strategy: SplitStrategy, ratios: SplitRatios, seed: string): Map<string, Split> {
  const total = ratios.train + ratios.validation + ratios.test;
  if (!(total > 0)) throw new Error('Split ratios must add up to more than zero.');
  const r = { train: ratios.train / total, validation: ratios.validation / total };
  const groups = new Map<string, SplitRecord[]>();
  for (const rec of records) {
    const key = strategy === 'GROUPED' && rec.group ? `g:${rec.group}` : `t:${normalizeText(rec.text)}`;
    groups.set(key, [...(groups.get(key) ?? []), rec]);
  }
  // Duplicate text inside a GROUPED group must also stay together: merge groups that share text.
  const out = new Map<string, Split>();
  const pick = (u: number): Split => (u < r.train ? 'TRAIN' : u < r.train + r.validation ? 'VALIDATION' : 'TEST');
  const free: { key: string; recs: SplitRecord[] }[] = [];
  for (const [key, recs] of groups) {
    const fixed = recs.map((x) => x.fixedSplit).find((s): s is Split => !!s);
    if (fixed) for (const x of recs) out.set(x.id, fixed);
    else free.push({ key, recs });
  }
  if (strategy === 'STRATIFIED') {
    const byLabel = new Map<string, typeof free>();
    for (const g of free) byLabel.set(g.recs[0]!.label, [...(byLabel.get(g.recs[0]!.label) ?? []), g]);
    for (const gs of byLabel.values()) {
      gs.sort((a, b) => unit(`${seed}:${a.key}`) - unit(`${seed}:${b.key}`));
      const n = gs.reduce((s, g) => s + g.recs.length, 0);
      let seen = 0;
      for (const g of gs) {
        const split = pick((seen + g.recs.length / 2) / n);
        seen += g.recs.length;
        for (const x of g.recs) out.set(x.id, split);
      }
    }
  } else {
    for (const g of free) {
      const split = pick(unit(`${seed}:${g.key}`));
      for (const x of g.recs) out.set(x.id, split);
    }
  }
  return out;
}

export interface ReadinessCriteria { minPerLabel: number; maxImbalance: number; allowFlagged: boolean }
export const DEFAULT_CRITERIA: ReadinessCriteria = { minPerLabel: 10, maxImbalance: 20, allowFlagged: false };

export interface ReadinessCheck { key: string; label: string; affected: number; passed: boolean; blocking: boolean; explanation: string }

/** Purification and training-readiness checks over labeled records with their assigned splits. */
export function readinessChecks(
  records: { id: string; text: string; label: string; split: Split }[],
  ctx: { labels: string[]; unlabeled: number; flagged: number; criteria: ReadinessCriteria },
): { checks: ReadinessCheck[]; ready: boolean } {
  const byText = new Map<string, { labels: Set<string>; splits: Set<Split>; n: number }>();
  let empty = 0;
  for (const r of records) {
    const t = normalizeText(r.text);
    if (!t) {
      empty++;
      continue;
    }
    const e = byText.get(t) ?? { labels: new Set(), splits: new Set(), n: 0 };
    e.labels.add(r.label);
    e.splits.add(r.split);
    e.n++;
    byText.set(t, e);
  }
  const dups = [...byText.values()].filter((e) => e.n > 1);
  const duplicateRecords = dups.reduce((s, e) => s + e.n - 1, 0);
  const conflicting = dups.filter((e) => e.labels.size > 1);
  const leaking = [...byText.values()].filter((e) => e.splits.size > 1);
  const counts = new Map(ctx.labels.map((l) => [l, 0]));
  for (const r of records) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const rare = [...counts.entries()].filter(([, n]) => n < ctx.criteria.minPerLabel);
  const nonzero = [...counts.values()].filter((n) => n > 0);
  const imbalance = nonzero.length ? Math.max(...nonzero) / Math.min(...nonzero) : 0;
  const unknown = records.filter((r) => !ctx.labels.includes(r.label)).length;
  const splitCounts = records.reduce<Record<string, number>>((a, r) => ((a[r.split] = (a[r.split] ?? 0) + 1), a), {});
  const checks: ReadinessCheck[] = [
    { key: 'empty_text', label: 'Empty records', affected: empty, passed: empty === 0, blocking: true, explanation: empty ? `${empty} labeled records have no text to train on.` : 'Every labeled record has text.' },
    { key: 'unknown_labels', label: 'Labels outside the schema', affected: unknown, passed: unknown === 0, blocking: true, explanation: unknown ? `${unknown} records use a label that is no longer in the project's label list.` : 'Every label is in the project schema.' },
    { key: 'conflicting_duplicates', label: 'Conflicting duplicates', affected: conflicting.reduce((s, e) => s + e.n, 0), passed: conflicting.length === 0, blocking: true, explanation: conflicting.length ? `${conflicting.length} texts appear more than once with different labels. Resolve them so the model is not trained on contradictions.` : 'No identical text has two different labels.' },
    { key: 'split_leakage', label: 'Leakage between splits', affected: leaking.reduce((s, e) => s + e.n, 0), passed: leaking.length === 0, blocking: true, explanation: leaking.length ? `${leaking.length} texts appear in more than one split, so evaluation would overstate quality.` : 'No text appears in more than one split.' },
    { key: 'duplicates', label: 'Duplicate records', affected: duplicateRecords, passed: duplicateRecords === 0, blocking: false, explanation: duplicateRecords ? `${duplicateRecords} records repeat an earlier text (same label). They are kept together in one split; consider removing them.` : 'No duplicate texts.' },
    { key: 'rare_labels', label: 'Labels with too few examples', affected: rare.length, passed: rare.length === 0, blocking: true, explanation: rare.length ? `${rare.map(([l, n]) => `${l} (${n})`).join(', ')} have fewer than ${ctx.criteria.minPerLabel} labeled records.` : `Every label has at least ${ctx.criteria.minPerLabel} records.` },
    { key: 'imbalance', label: 'Label imbalance', affected: Math.round(imbalance * 10) / 10, passed: imbalance <= ctx.criteria.maxImbalance, blocking: false, explanation: `The most common label has ${imbalance.toFixed(1)}× the records of the least common one (limit ${ctx.criteria.maxImbalance}×).` },
    { key: 'unlabeled', label: 'Unlabeled records', affected: ctx.unlabeled, passed: true, blocking: false, explanation: ctx.unlabeled ? `${ctx.unlabeled} records in the project are not labeled yet and are left out.` : 'Every record is labeled.' },
    { key: 'flagged', label: 'Flagged records', affected: ctx.flagged, passed: ctx.criteria.allowFlagged || ctx.flagged === 0, blocking: !ctx.criteria.allowFlagged, explanation: ctx.flagged ? `${ctx.flagged} records are flagged (for example, import conflicts) and need a decision.` : 'No flagged records.' },
    { key: 'splits', label: 'Train, validation and test present', affected: 3 - Object.keys(splitCounts).length, passed: ['TRAIN', 'VALIDATION', 'TEST'].every((s) => (splitCounts[s] ?? 0) > 0), blocking: true, explanation: `Train ${splitCounts.TRAIN ?? 0}, validation ${splitCounts.VALIDATION ?? 0}, test ${splitCounts.TEST ?? 0}.` },
  ];
  return { checks, ready: checks.every((c) => c.passed || !c.blocking) };
}
