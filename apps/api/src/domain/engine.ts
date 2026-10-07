import { createRng, hashSeed } from '../lib/prng.js';

/**
 * Demo labeling engine. A transparent, deterministic engine — not an AI model:
 * multinomial Naive Bayes with Laplace smoothing, seeded token-dropout passes
 * for self-consistency, deterministic rules, and confidence-based routing.
 */
export const DEMO_ENGINE_VERSION = 'demo-nb-1.1';

export interface Rule {
  id: string;
  label: string;
  /** Lowercase keywords; the rule matches when any keyword appears as a whole word or phrase. */
  keywords: string[];
  description: string;
}

export interface EngineConfig {
  labels: string[];
  rules: Rule[];
  autoAcceptThreshold: number;
  passes: number;
  dropout: number;
  seed: number;
  carryOver?: { enabled: boolean };
}

export interface Prediction {
  label: string;
  source: 'CARRY_OVER' | 'RULE' | 'MODEL';
  confidence: number;
  rationale: string;
  ruleCited: string | null;
  passes: { label: string; confidence: number }[];
  routing: 'AUTO_ACCEPT' | 'REVIEW';
  routingReason: string;
  topTokens: string[];
}

const STOP = new Set('a an the and or but if of to in on for with at by from is are was were be been am i me my we our you your it its this that these those have has had do does did not no so as can could would should will just very please thanks thank hi hello'.split(' '));

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !/^\d+$/.test(t));
}

export class NaiveBayes {
  private counts = new Map<string, Map<string, number>>();
  private totals = new Map<string, number>();
  private docs = new Map<string, number>();
  private vocab = new Set<string>();
  private nDocs = 0;
  constructor(private readonly labels: string[], private readonly alpha = 1) {
    for (const l of labels) {
      this.counts.set(l, new Map());
      this.totals.set(l, 0);
      this.docs.set(l, 0);
    }
  }
  train(tokens: string[], label: string) {
    if (!this.counts.has(label)) return;
    this.nDocs++;
    this.docs.set(label, this.docs.get(label)! + 1);
    const m = this.counts.get(label)!;
    for (const t of tokens) {
      this.vocab.add(t);
      m.set(t, (m.get(t) ?? 0) + 1);
      this.totals.set(label, this.totals.get(label)! + 1);
    }
  }
  get trainedOn() {
    return this.nDocs;
  }
  /** Returns posterior probabilities per label (softmax over log-likelihoods). */
  predict(tokens: string[]): Record<string, number> {
    const v = this.vocab.size || 1;
    const logs: Record<string, number> = {};
    for (const l of this.labels) {
      const prior = Math.log(((this.docs.get(l) ?? 0) + this.alpha) / (this.nDocs + this.alpha * this.labels.length));
      let s = prior;
      const m = this.counts.get(l)!;
      const total = this.totals.get(l)!;
      for (const t of tokens) if (this.vocab.has(t)) s += Math.log(((m.get(t) ?? 0) + this.alpha) / (total + this.alpha * v));
      logs[l] = s;
    }
    const max = Math.max(...Object.values(logs));
    const exp = Object.fromEntries(Object.entries(logs).map(([k, x]) => [k, Math.exp(x - max)]));
    const z = Object.values(exp).reduce((a, b) => a + b, 0);
    return Object.fromEntries(Object.entries(exp).map(([k, x]) => [k, x / z]));
  }
  /** Tokens that most favour `label` against the rest, for explanations. */
  evidence(tokens: string[], label: string, k = 4): string[] {
    const v = this.vocab.size || 1;
    const score = (t: string) => {
      const p = ((this.counts.get(label)!.get(t) ?? 0) + this.alpha) / (this.totals.get(label)! + this.alpha * v);
      const others = this.labels.filter((l) => l !== label);
      const q = others.reduce((a, l) => a + ((this.counts.get(l)!.get(t) ?? 0) + this.alpha) / (this.totals.get(l)! + this.alpha * v), 0) / (others.length || 1);
      return Math.log(p / q);
    };
    return [...new Set(tokens)].filter((t) => this.vocab.has(t)).sort((a, b) => score(b) - score(a)).slice(0, k).filter((t) => score(t) > 0);
  }
}

export function matchRule(text: string, rules: Rule[]): Rule | null {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const r of rules) if (r.keywords.some((k) => lower.includes(` ${k.toLowerCase()} `))) return r;
  return null;
}

export function predict(
  model: NaiveBayes,
  text: string,
  config: EngineConfig,
  key: string,
  carryOverLabel?: string | null,
): Prediction {
  if (config.carryOver?.enabled && carryOverLabel && config.labels.includes(carryOverLabel)) {
    return {
      label: carryOverLabel,
      source: 'CARRY_OVER',
      confidence: 0.99,
      rationale: `The record already carried the outcome "${carryOverLabel}" from the source system, and carry-over is enabled for this project.`,
      ruleCited: null,
      passes: [],
      routing: 'AUTO_ACCEPT',
      routingReason: 'Carried-over outcome explicitly enabled by the project manager.',
      topTokens: [],
    };
  }
  const rule = matchRule(text, config.rules);
  if (rule) {
    return {
      label: rule.label,
      source: 'RULE',
      confidence: 0.97,
      rationale: `Rule "${rule.id}" matched: ${rule.description}`,
      ruleCited: rule.id,
      passes: [],
      routing: 0.97 >= config.autoAcceptThreshold ? 'AUTO_ACCEPT' : 'REVIEW',
      routingReason: 0.97 >= config.autoAcceptThreshold ? 'Deterministic rule match above the auto-accept threshold.' : 'Rule confidence is below the configured auto-accept threshold.',
      topTokens: [],
    };
  }
  const tokens = tokenize(text);
  const rng = createRng(hashSeed(config.seed, key));
  const passes: { label: string; confidence: number }[] = [];
  for (let p = 0; p < Math.max(1, config.passes); p++) {
    const kept = p === 0 ? tokens : tokens.filter(() => rng.next() >= config.dropout);
    const probs = model.predict(kept);
    const [label, conf] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
    passes.push({ label, confidence: round(conf) });
  }
  const votes = new Map<string, number>();
  for (const p of passes) votes.set(p.label, (votes.get(p.label) ?? 0) + 1);
  const [label, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const agreement = count / passes.length;
  const meanConf = passes.filter((p) => p.label === label).reduce((a, p) => a + p.confidence, 0) / count;
  const confidence = round(meanConf * agreement);
  const topTokens = model.evidence(tokens, label);
  const auto = confidence >= config.autoAcceptThreshold && model.trainedOn > 0;
  return {
    label,
    source: 'MODEL',
    confidence,
    rationale: `${count} of ${passes.length} passes chose "${label}"${topTokens.length ? `; strongest evidence: ${topTokens.map((t) => `"${t}"`).join(', ')}` : ''}. Trained on ${model.trainedOn} human-labeled examples.`,
    ruleCited: null,
    passes,
    routing: auto ? 'AUTO_ACCEPT' : 'REVIEW',
    routingReason: auto
      ? `Confidence ${confidence.toFixed(2)} is at or above the auto-accept threshold ${config.autoAcceptThreshold.toFixed(2)}.`
      : model.trainedOn === 0
        ? 'No labeled examples are available yet, so every record goes to human review.'
        : `Confidence ${confidence.toFixed(2)} is below the auto-accept threshold ${config.autoAcceptThreshold.toFixed(2)}${agreement < 1 ? ' and the passes disagreed' : ''}.`,
    topTokens,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Uncertainty-first priority for active learning: lower margin = higher priority. */
export function priorityFor(model: NaiveBayes, text: string): { priority: number; reason: string } {
  if (model.trainedOn === 0) return { priority: 0.5, reason: 'No examples yet; ordered as imported.' };
  const probs = Object.values(model.predict(tokenize(text))).sort((a, b) => b - a);
  const margin = (probs[0] ?? 0) - (probs[1] ?? 0);
  return {
    priority: round(1 - margin),
    reason: margin < 0.2 ? `The engine is torn between two labels (margin ${margin.toFixed(2)}), so a human answer here teaches it the most.` : `Engine margin ${margin.toFixed(2)}; moderately informative.`,
  };
}

/** Estimates cost and expected routing before a run, using held-out gold if available. */
export function estimateRun(itemCount: number, model: NaiveBayes, sample: string[], config: EngineConfig) {
  let auto = 0;
  sample.forEach((t, i) => {
    if (predict(model, t, config, `estimate-${i}`).routing === 'AUTO_ACCEPT') auto++;
  });
  const autoRate = sample.length ? auto / sample.length : 0;
  return {
    items: itemCount,
    expectedAutoAccepted: Math.round(itemCount * autoRate),
    expectedReview: itemCount - Math.round(itemCount * autoRate),
    estimatedCost: 0,
    costNote: 'The demo engine runs locally and has no per-item cost.',
  };
}
