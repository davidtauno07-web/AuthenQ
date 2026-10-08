import { describe, expect, it } from 'vitest';
import { generateDemoDataset, DEMO_LABELS, DEMO_RULES, demoTruthForText } from '../src/domain/demoData.js';
import { classifyColumn, detectTextEntities, inferRelations, guessPrimaryKey } from '../src/domain/firewall.js';
import { generateTwin, type TwinTable } from '../src/domain/twin.js';
import { extractCandidates, normalize, signature, SCAN_DISCLAIMER } from '../src/domain/canary.js';
import { NaiveBayes, predict, tokenize, matchRule, type EngineConfig } from '../src/domain/engine.js';
import { wilson, cohensKappa, evaluate, calibration, thresholdWording, agreementWording } from '../src/domain/quality.js';
import { assertSafeParts, labelWithAi, parseLabelResponse } from '../src/domain/aiGateway.js';
import { createZip, readZip, crc32 } from '../src/lib/zip.js';
import { createRng } from '../src/lib/prng.js';

describe('demo dataset', () => {
  it('has exactly 300 customers and 800 tickets and is deterministic', () => {
    const a = generateDemoDataset();
    const b = generateDemoDataset();
    expect(a.customers).toHaveLength(300);
    expect(a.tickets).toHaveLength(800);
    expect(JSON.stringify(a.tickets.slice(0, 5))).toBe(JSON.stringify(b.tickets.slice(0, 5)));
    const labels = new Set(a.truth.values());
    for (const l of DEMO_LABELS) expect(labels.has(l)).toBe(true);
  });
});

describe('prng', () => {
  it('is reproducible for a seed', () => {
    const r1 = createRng(42);
    const r2 = createRng(42);
    const s1 = Array.from({ length: 10 }, () => r1.next());
    const s2 = Array.from({ length: 10 }, () => r2.next());
    expect(s1).toEqual(s2);
    expect(s1.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe('firewall classification', () => {
  it('flags emails as sensitive and explains why', () => {
    const f = classifyColumn({ table: 'customers', name: 'email', values: ['a@x.com', 'b@y.org', 'c@z.net'], totalRows: 3 });
    expect(f.classification).toBe('SENSITIVE');
    expect(f.entityType).toBe('EMAIL');
    expect(f.explanation.length).toBeGreaterThan(10);
  });
  it('detects international phone numbers in free text', () => {
    const e = detectTextEntities('Call me at +372 5226 8642 or mail me@example.com');
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['EMAIL']));
    expect(JSON.stringify(e)).toContain('5226');
  });
  it('infers primary keys and relationships', () => {
    const customers = { customer_id: ['C1', 'C2', 'C3'], name: ['a', 'b', 'c'] };
    const tickets = { ticket_id: ['T1', 'T2', 'T3', 'T4'], customer_id: ['C1', 'C1', 'C2', 'C3'] };
    expect(guessPrimaryKey('customers', customers)).toBe('customer_id');
    const rel = inferRelations([
      { name: 'customers', primaryKey: 'customer_id', columns: customers },
      { name: 'tickets', primaryKey: 'ticket_id', columns: tickets },
    ]);
    expect(rel.some((r) => r.fromTable === 'tickets' && r.toTable === 'customers')).toBe(true);
  });
});

function twinFixture(): TwinTable[] {
  const customers = Array.from({ length: 40 }, (_, i) => ({ id: `C${i}`, name: `Realperson${i} Surname${i}`, email: `real${i}@corp.example`, tier: i % 3 ? 'pro' : 'free' }));
  const tickets = Array.from({ length: 120 }, (_, i) => ({ id: `T${i}`, customer_id: `C${i % 40}`, body: `Hello, I am Realperson${i % 40}. Reach me at real${i % 40}@corp.example about my invoice.` }));
  return [
    { name: 'customers', primaryKey: 'id', rows: customers, columns: [
      { name: 'id', dataType: 'string', format: null, classification: 'IDENTIFIER', entityType: 'PRIMARY_KEY', decision: 'KEY', isPrimaryKey: true },
      { name: 'name', dataType: 'string', format: null, classification: 'SENSITIVE', entityType: 'PERSON_NAME', decision: 'REPLACE', isPrimaryKey: false },
      { name: 'email', dataType: 'string', format: null, classification: 'SENSITIVE', entityType: 'EMAIL', decision: 'REPLACE', isPrimaryKey: false },
      { name: 'tier', dataType: 'string', format: null, classification: 'NON_SENSITIVE', entityType: null, decision: 'KEEP', isPrimaryKey: false },
    ] },
    { name: 'tickets', primaryKey: 'id', rows: tickets, columns: [
      { name: 'id', dataType: 'string', format: null, classification: 'IDENTIFIER', entityType: 'PRIMARY_KEY', decision: 'KEY', isPrimaryKey: true },
      { name: 'customer_id', dataType: 'string', format: null, classification: 'IDENTIFIER', entityType: 'FOREIGN_KEY', decision: 'KEY', isPrimaryKey: false },
      { name: 'body', dataType: 'text', format: null, classification: 'NEEDS_DECISION', entityType: 'FREE_TEXT', decision: 'SCRUB_TEXT', isPrimaryKey: false },
    ] },
  ];
}

describe('twin generation', () => {
  const tables = twinFixture();
  const rel = [{ fromTable: 'tickets', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id' }];
  it('is reproducible with the same seed', () => {
    const a = generateTwin(tables, rel, { seed: 7, multiplier: 1 });
    const b = generateTwin(tables, rel, { seed: 7, multiplier: 1 });
    expect(JSON.stringify(a.tables)).toBe(JSON.stringify(b.tables));
    const c = generateTwin(tables, rel, { seed: 8, multiplier: 1 });
    expect(JSON.stringify(c.tables)).not.toBe(JSON.stringify(a.tables));
  });
  it('never reproduces real sensitive values, in columns or free text', () => {
    const out = generateTwin(tables, rel, { seed: 1, multiplier: 2 });
    const blob = JSON.stringify(out.tables).toLowerCase();
    for (const c of tables[0]!.rows) {
      expect(blob).not.toContain(String(c.email).toLowerCase());
      expect(blob).not.toContain(String(c.name).toLowerCase());
    }
    expect(out.report.safety.passed).toBe(true);
    expect(out.tables.customers!.rows).toHaveLength(80);
  });
  it('keeps referential integrity and registers canaries', () => {
    const out = generateTwin(tables, rel, { seed: 3, multiplier: 1 });
    const ids = new Set(out.tables.customers!.rows.map((r) => r.id));
    expect(out.tables.tickets!.rows.every((t) => ids.has(t.customer_id))).toBe(true);
    expect(out.canaries.length).toBeGreaterThan(0);
    expect(out.report.metrics.find((m) => m.key === 'structure')?.withinThreshold).toBe(true);
  });
});

describe('canary', () => {
  it('produces deterministic, secret-dependent signatures', () => {
    const n = normalize('  Jane.Doe@Example.com ', 'EMAIL');
    expect(n).toBe('jane.doe@example.com');
    expect(signature('s1', 'EMAIL', n)).toBe(signature('s1', 'EMAIL', n));
    expect(signature('s1', 'EMAIL', n)).not.toBe(signature('s2', 'EMAIL', n));
  });
  it('extracts candidates from text for indexed lookup', () => {
    const c = extractCandidates('Leaked: jane.doe@example.com and +372 5226 8642');
    expect([...c.keys()].some((k) => k.includes('jane.doe@example.com'))).toBe(true);
  });
  it('never claims a clean scan proves no leak', () => {
    expect(SCAN_DISCLAIMER.toLowerCase()).toContain('not');
  });
});

describe('demo engine', () => {
  const ds = generateDemoDataset();
  const labels = [...DEMO_LABELS];
  const text = (t: Record<string, string | number>) => `${t.subject}\n\n${t.body}`;
  const train = ds.tickets.slice(0, 400);
  const test = ds.tickets.slice(400, 600);
  const model = new NaiveBayes(labels);
  for (const t of train) model.train(tokenize(text(t)), ds.truth.get(String(t.ticket_id))!);
  const cfg: EngineConfig = { labels, rules: DEMO_RULES as unknown as EngineConfig['rules'], autoAcceptThreshold: 0.85, passes: 5, dropout: 0.15, seed: 11 };

  it('is deterministic and routes by confidence', () => {
    const t = text(test[0]!);
    const a = predict(model, t, cfg, 'k1');
    const b = predict(model, t, cfg, 'k1');
    expect(a).toEqual(b);
    expect(a.routing).toBe(a.confidence >= cfg.autoAcceptThreshold ? 'AUTO_ACCEPT' : 'REVIEW');
    expect(a.passes).toHaveLength(a.source === 'MODEL' ? 5 : a.passes.length);
  });
  it('beats chance on held-out tickets', () => {
    const truth = test.map((t) => ds.truth.get(String(t.ticket_id))!);
    const pred = test.map((t, i) => predict(model, text(t), cfg, `k${i}`).label);
    expect(evaluate(truth, pred, labels).accuracy!).toBeGreaterThan(0.6);
  });
  it('only uses carried-over outcomes when explicitly enabled', () => {
    const t = text(test[1]!);
    expect(predict(model, t, cfg, 'k', 'Billing').source).not.toBe('CARRY_OVER');
    expect(predict(model, t, { ...cfg, carryOver: { enabled: true } }, 'k', 'Billing').source).toBe('CARRY_OVER');
  });
  it('applies keyword rules', () => {
    const r = DEMO_RULES[0]!;
    expect(matchRule(`something ${r.keywords[0]} here`, DEMO_RULES as unknown as EngineConfig['rules'])?.label).toBe(r.label);
  });
  it('ground-truth helper agrees with dataset truth', () => {
    const t = ds.tickets[0]!;
    expect(demoTruthForText(text(t))).toBe(ds.truth.get(String(t.ticket_id)));
  });
});

describe('quality statistics', () => {
  it('computes Wilson intervals', () => {
    const w = wilson(80, 100);
    expect(w.low).toBeCloseTo(0.711, 2);
    expect(w.high).toBeCloseTo(0.867, 2);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 0 });
  });
  it('computes Cohen kappa', () => {
    expect(cohensKappa(['a', 'b', 'a', 'b'], ['a', 'b', 'a', 'b'])).toBeCloseTo(1);
    expect(cohensKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b'])).toBeCloseTo(0);
  });
  it('computes per-label precision/recall/F1 and confusion', () => {
    const e = evaluate(['a', 'a', 'b', 'b'], ['a', 'b', 'b', 'b'], ['a', 'b']);
    expect(e.accuracy).toBeCloseTo(0.75);
    const a = e.perLabel.find((p) => p.label === 'a')!;
    expect(a.precision).toBeCloseTo(1);
    expect(a.recall).toBeCloseTo(0.5);
    expect(e.confusion.matrix).toEqual([[1, 1], [0, 2]]);
  });
  it('bins calibration', () => {
    const c = calibration([{ confidence: 0.95, correct: true }, { confidence: 0.1, correct: false }]);
    expect(JSON.stringify(c)).toContain('"count":1');
  });
  it('uses neutral wording', () => {
    expect(thresholdWording(0.9, 0.85)).toBe('within threshold');
    expect(thresholdWording(0.8, 0.85)).toBe('outside threshold');
    expect(agreementWording(0.9, 0.85)).toBe('within human agreement level');
    expect(agreementWording(0.7, 0.85)).toBe('outside human agreement level');
  });
});

describe('AI gateway', () => {
  const cfg = { provider: 'OPENAI_COMPATIBLE' as const, model: 'm', baseUrl: 'https://example.invalid', apiKey: 'k' };
  const parts = (cls: 'REAL' | 'SYNTHETIC') => ({ guideline: { dataClass: 'GUIDELINE' as const, content: 'g' }, examples: [], record: { dataClass: cls, content: 'r' } });
  it('rejects real data before any request is made', async () => {
    let called = false;
    await expect(labelWithAi(cfg, parts('REAL'), ['A'], async () => { called = true; return '{}'; })).rejects.toThrow(/Blocked/);
    expect(called).toBe(false);
    expect(() => assertSafeParts([{ dataClass: 'REAL', content: 'x' }])).toThrow();
  });
  it('validates JSON, labels and retries once before routing to review', async () => {
    let n = 0;
    const r = await labelWithAi(cfg, parts('SYNTHETIC'), ['A', 'B'], async () => { n++; return 'not json'; });
    expect(r.ok).toBe(false);
    expect(n).toBe(2);
    const ok = await labelWithAi(cfg, parts('SYNTHETIC'), ['A', 'B'], async () => '{"label":"B","confidence":0.9,"rationale":"x"}');
    expect(ok).toMatchObject({ ok: true, label: 'B' });
    expect(() => parseLabelResponse('{"label":"Z","confidence":0.9,"rationale":"x"}', ['A'])).toThrow();
  });
});

describe('zip', () => {
  it('round-trips files with correct CRCs', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.json', data: Buffer.from('{"x":1}') }]);
    const files = readZip(zip);
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'dir/b.json']);
    expect(files[0]!.data.toString()).toBe('hello');
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
  });
});
