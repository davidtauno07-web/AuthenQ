/**
 * Quality statistics used by Review & Quality, the export gate and setup trials.
 * All functions are pure. Wording stays neutral: "within threshold" /
 * "outside threshold" rather than pass/fail.
 */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

export function cohensKappa(a: string[], b: string[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  const labels = [...new Set([...a, ...b])];
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  const po = agree / n;
  let pe = 0;
  for (const l of labels) pe += (a.slice(0, n).filter((x) => x === l).length / n) * (b.slice(0, n).filter((x) => x === l).length / n);
  if (pe === 1) return 1;
  return (po - pe) / (1 - pe);
}

export interface PerLabel {
  label: string;
  support: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function confusion(truth: string[], pred: string[], labels: string[]) {
  const idx = new Map(labels.map((l, i) => [l, i]));
  const matrix = labels.map(() => labels.map(() => 0));
  for (let i = 0; i < truth.length; i++) {
    const t = idx.get(truth[i]!);
    const p = idx.get(pred[i]!);
    if (t !== undefined && p !== undefined) matrix[t]![p]!++;
  }
  const perLabel: PerLabel[] = labels.map((label, i) => {
    const tp = matrix[i]![i]!;
    const fp = matrix.reduce((a, row, r) => (r === i ? a : a + row[i]!), 0);
    const fn = matrix[i]!.reduce((a, v, c) => (c === i ? a : a + v), 0);
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
    return { label, support: tp + fn, precision, recall, f1 };
  });
  return { labels, matrix, perLabel };
}

export function calibration(items: { confidence: number; correct: boolean }[], bins = 5) {
  const out = Array.from({ length: bins }, (_, i) => ({ from: i / bins, to: (i + 1) / bins, count: 0, avgConfidence: 0, accuracy: 0 }));
  for (const it of items) {
    const b = Math.min(bins - 1, Math.floor(it.confidence * bins));
    const bin = out[b]!;
    bin.count++;
    bin.avgConfidence += it.confidence;
    bin.accuracy += it.correct ? 1 : 0;
  }
  for (const bin of out) {
    if (bin.count) {
      bin.avgConfidence /= bin.count;
      bin.accuracy /= bin.count;
    }
  }
  const ece = out.reduce((a, b) => a + (b.count / (items.length || 1)) * Math.abs(b.accuracy - b.avgConfidence), 0);
  return { bins: out, expectedCalibrationError: ece };
}

export interface Evaluation {
  n: number;
  correct: number;
  accuracy: number | null;
  interval: { low: number; high: number };
  perLabel: PerLabel[];
  confusion: { labels: string[]; matrix: number[][] };
  macroF1: number | null;
}

export function evaluate(truth: string[], pred: string[], labels: string[]): Evaluation {
  const n = truth.length;
  let correct = 0;
  for (let i = 0; i < n; i++) if (truth[i] === pred[i]) correct++;
  const c = confusion(truth, pred, labels);
  const f1s = c.perLabel.filter((p) => p.support > 0 && p.f1 !== null).map((p) => p.f1!);
  return {
    n,
    correct,
    accuracy: n ? correct / n : null,
    interval: wilson(correct, n),
    perLabel: c.perLabel,
    confusion: { labels: c.labels, matrix: c.matrix },
    macroF1: f1s.length ? f1s.reduce((a, b) => a + b, 0) / f1s.length : null,
  };
}

export function thresholdWording(value: number | null, threshold: number) {
  if (value === null) return 'not enough evidence yet';
  return value >= threshold ? 'within threshold' : 'outside threshold';
}

export function agreementWording(engineAccuracy: number | null, humanAgreement: number | null) {
  if (engineAccuracy === null || humanAgreement === null) return 'human agreement level not yet measured';
  return engineAccuracy >= humanAgreement - 0.02 ? 'within human agreement level' : 'outside human agreement level';
}
