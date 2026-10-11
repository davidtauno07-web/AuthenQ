import { describe, expect, it } from 'vitest';
import { conformance, generateFromPattern, learnPattern, shapeOf } from '../src/domain/patterns.js';
import { generateTwin, type TwinTable } from '../src/domain/twin.js';
import { createRng } from '../src/lib/prng.js';

const rep = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe('twin pattern learning', () => {
  const phones = rep(60, (i) => `${i % 3 === 0 ? "081" : "085"} ${String(((i * 137) % 900) + 100)} ${String(((i * 7919) % 9000) + 1000)}`);

  it('learns Namibian-style mobile prefixes and generates values with the same prefixes and format', () => {
    const p = learnPattern('c', { name: 'phone', entityType: 'PHONE', dataType: 'string' }, phones);
    expect(p.prefixes.map((x) => x.value)).toEqual(expect.arrayContaining(['081', '085']));
    const rng = createRng(1);
    const gen = rep(200, () => generateFromPattern(p, rng, 'Avery Quill')!);
    expect(gen.every((g) => /^08[15] \d{3} \d{4}$/.test(g))).toBe(true);
    expect(conformance(p, gen)).toBe(1);
  });

  it('keeps shared email domains and address style but never rare domains', () => {
    const emails = [...rep(40, (i) => `user.n${String.fromCharCode(97 + (i % 26))}@corp.na`), 'solo.person@rare-family.com'];
    const p = learnPattern('c', { name: 'email', entityType: 'EMAIL', dataType: 'string' }, emails);
    expect(p.emailDomains.map((d) => d.value)).toEqual(['corp.na']);
    const rng = createRng(2);
    const gen = rep(100, () => generateFromPattern(p, rng, 'Riley Penrose')!);
    expect(gen.some((g) => g.endsWith('@corp.na'))).toBe(true);
    expect(gen.some((g) => g.includes('rare-family'))).toBe(false);
  });

  it('keeps identifier prefixes and lengths', () => {
    const p = learnPattern('c', { name: 'national_id', entityType: 'GOVERNMENT_ID', dataType: 'string' }, rep(50, (i) => `NA${String(10000000 + i * 37)}`));
    expect(p.literalPrefix).toBe('NA');
    const g = generateFromPattern(p, createRng(3), 'x y')!;
    expect(g).toMatch(/^NA\d{8}$/);
    expect(shapeOf(g)).toBe('AA99999999');
  });

  it('flags weak patterns as limitations', () => {
    const p = learnPattern('c', { name: 'x', entityType: null, dataType: 'string' }, rep(40, (i) => 'z'.repeat(i + 1)));
    expect(p.confidence).toBeLessThan(0.6);
    expect(p.limitations.join(' ')).toMatch(/Formats vary/);
  });

  it('generateTwin follows learned patterns, reports conformance and supports the generic strategy', () => {
    const tables: TwinTable[] = [{
      name: 'customers',
      primaryKey: 'id',
      columns: [
        { name: 'id', dataType: 'string', format: null, classification: 'IDENTIFIER', entityType: 'PRIMARY_KEY', decision: 'KEY', isPrimaryKey: true },
        { name: 'phone', dataType: 'string', format: null, classification: 'SENSITIVE', entityType: 'PHONE', decision: 'REPLACE', isPrimaryKey: false },
      ],
      rows: phones.map((ph, i) => ({ id: `CUS-${1000 + i}`, phone: ph })),
    }];
    const out = generateTwin(tables, [], { seed: 5, multiplier: 1 });
    const real = new Set(phones);
    const synth = out.tables.customers!.rows.map((r) => String(r.phone));
    expect(synth.every((v) => /^08[15] /.test(v) && !real.has(v))).toBe(true);
    expect(out.report.metrics.find((m) => m.key === 'patterns')!.withinThreshold).toBe(true);
    expect(out.report.patterns![0]).toMatchObject({ column: 'phone', strategy: 'PATTERN', conformance: 1 });
    const generic = generateTwin(tables, [], { seed: 5, multiplier: 1, strategies: { 'customers.phone': 'GENERIC' } });
    expect(generic.report.patterns![0]!.strategy).toBe('GENERIC');
    expect(out.report.safety.passed).toBe(true);
  });
});
