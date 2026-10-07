import { createRng, hashSeed, type Rng } from '../lib/prng.js';
import { detectTextEntities } from './firewall.js';

/**
 * Twin: generates complete synthetic copies of a source. Pure function over
 * in-memory inputs so it is deterministic for a given seed and unit-testable.
 * Real values are never copied for REPLACE columns; KEEP columns are sampled
 * from the empirical distribution, numeric KEEP columns are perturbed.
 */
export const TWIN_ALGORITHM_VERSION = 'twin-1.2';

export interface TwinColumn {
  name: string;
  dataType: string;
  format: string | null;
  classification: string;
  entityType: string | null;
  decision: string;
  generalization?: { mode?: string; bucket?: number } | null;
  isPrimaryKey: boolean;
}

export interface TwinTable {
  name: string;
  primaryKey: string | null;
  columns: TwinColumn[];
  rows: Record<string, unknown>[];
}

export interface TwinRelation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface TwinConfig {
  seed: number;
  multiplier: number;
  amplify?: { table: string; column: string; value: string; factor: number }[];
}

export interface CanaryValue {
  tableName: string;
  rowIndex: number;
  columnName: string;
  value: string;
  entityType: string;
  meta: Record<string, unknown>;
}

export interface TwinOutput {
  tables: Record<string, { rows: Record<string, unknown>[]; keyColumn: string | null }>;
  canaries: CanaryValue[];
  report: QualityReport;
}

export interface MetricResult {
  key: string;
  label: string;
  value: number;
  threshold: number;
  withinThreshold: boolean;
  explanation: string;
}

export interface QualityReport {
  algorithmVersion: string;
  seed: number;
  metrics: MetricResult[];
  tables: { name: string; sourceRows: number; syntheticRows: number }[];
  columns: { table: string; column: string; decision: string; distance: number | null; note: string }[];
  safety: { realValueCollisions: number; copiedRealRows: number; passed: boolean; explanation: string };
}

const FIRST = ['Avery', 'Jordan', 'Riley', 'Quinn', 'Morgan', 'Rowan', 'Emery', 'Hayden', 'Sasha', 'Kendall', 'Marlow', 'Tatum', 'Arden', 'Lennox', 'Sloane', 'Reese', 'Ellis', 'Briar', 'Caden', 'Darcy', 'Ember', 'Finley', 'Greer', 'Harlow', 'Indy', 'Jules', 'Kai', 'Laken', 'Milan', 'Noor', 'Oakley', 'Peyton', 'Remy', 'Shiloh', 'Teagan', 'Vale', 'Wren', 'Zion'];
const LAST = ['Ashdown', 'Brightwater', 'Calloway', 'Dunmore', 'Everly', 'Fairbourne', 'Glenhart', 'Holloway', 'Ivers', 'Kingsley', 'Larkspur', 'Merriweather', 'Northcott', 'Oakridge', 'Penrose', 'Quill', 'Ravensworth', 'Stanwick', 'Thornbury', 'Underhill', 'Vantreese', 'Whitlock', 'Yardley', 'Ashcombe', 'Blackwood', 'Corriveau', 'Delacroix', 'Fenwick', 'Galloway', 'Hartigan'];
const STREETS = ['Alder', 'Birch', 'Cedar', 'Linden', 'Maple', 'Juniper', 'Sycamore', 'Willow', 'Hawthorn', 'Rowan', 'Elm', 'Aspen'];
const SUFFIX = ['St', 'Ave', 'Rd', 'Ln', 'Way', 'Ct', 'Pl'];
const DOMAINS = ['example.com', 'example.org', 'example.net', 'mail.example'];

function syntheticName(rng: Rng) {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

function digits(rng: Rng, n: number) {
  let s = '';
  for (let i = 0; i < n; i++) s += String(rng.int(0, 9));
  return s;
}

function matchFormat(template: string, rng: Rng) {
  return template.replace(/\d/g, () => String(rng.int(0, 9))).replace(/[A-Z]/g, () => String.fromCharCode(65 + rng.int(0, 25))).replace(/[a-z]/g, () => String.fromCharCode(97 + rng.int(0, 25)));
}

function luhnComplete(prefix: string) {
  let sum = 0;
  for (let i = 0; i < prefix.length; i++) {
    let d = Number(prefix[prefix.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return prefix + String((10 - (sum % 10)) % 10);
}

/** Generates a value for a REPLACE column that keeps the format of the real value. */
export function replaceValue(entityType: string | null, sample: string, rng: Rng, nameHint?: string): string {
  switch (entityType) {
    case 'PERSON_NAME': {
      const parts = sample.trim().split(/\s+/).length;
      return parts === 1 ? rng.pick(FIRST) : syntheticName(rng);
    }
    case 'EMAIL': {
      const base = (nameHint ?? syntheticName(rng)).toLowerCase().replace(/[^a-z]+/g, '.');
      return `${base}.${digits(rng, 3)}@${rng.pick(DOMAINS)}`;
    }
    case 'PHONE':
      return sample.replace(/\d/g, () => String(rng.int(0, 9))).replace(/^(\+?\d?\D*)(\d{3})/, (_m, p, _a) => `${p}555`);
    case 'CREDIT_CARD':
      return luhnComplete('4000' + digits(rng, 11)).replace(/(\d{4})(?=\d)/g, sample.includes('-') ? '$1-' : sample.includes(' ') ? '$1 ' : '$1');
    case 'GOVERNMENT_ID':
      return `9${digits(rng, 2)}-${digits(rng, 2)}-${digits(rng, 4)}`;
    case 'STREET_ADDRESS':
      return `${rng.int(10, 9899)} ${rng.pick(STREETS)} ${rng.pick(SUFFIX)}`;
    case 'IP_ADDRESS':
      return `198.51.100.${rng.int(1, 254)}`;
    default:
      return matchFormat(sample || 'XXXX-0000', rng);
  }
}

function generalize(value: unknown, col: TwinColumn): unknown {
  if (value === null || value === undefined || value === '') return value;
  const s = String(value);
  const mode = col.generalization?.mode;
  if (col.entityType === 'POSTAL_CODE' || mode === 'PREFIX') return `${s.slice(0, 3)}**`;
  if (col.entityType === 'DATE_OF_BIRTH' || col.dataType === 'date' || mode === 'YEAR') return s.slice(0, 4);
  if (col.dataType === 'integer' || col.dataType === 'number') {
    const b = col.generalization?.bucket ?? 10;
    const lo = Math.floor(Number(s) / b) * b;
    return `${lo}-${lo + b - 1}`;
  }
  return s.length > 3 ? `${s.slice(0, 1)}***` : '***';
}

const SENTENCE = /[^.!?\n]+[.!?]?/g;

interface TextModel {
  byGroup: Map<string, string[][]>;
  all: string[][];
  openers: string[];
  closers: string[];
}

/**
 * Sentence model grouped by an outcome value so the label signal survives.
 * Openers and closers are drawn from the whole column; the body comes from a
 * donor record of the same group, then every detected entity is replaced.
 */
function buildTextModel(rows: Record<string, unknown>[], col: string, groupCol: string | null): TextModel {
  const byGroup = new Map<string, string[][]>();
  const all: string[][] = [];
  const openers: string[] = [];
  const closers: string[] = [];
  for (const r of rows) {
    const text = String(r[col] ?? '');
    const sentences = (text.match(SENTENCE) ?? []).map((s) => s.trim()).filter(Boolean);
    if (!sentences.length) continue;
    if (sentences.length >= 3) {
      openers.push(sentences[0]!);
      closers.push(sentences[sentences.length - 1]!);
    }
    const g = groupCol ? String(r[groupCol] ?? '') : '';
    const list = byGroup.get(g) ?? [];
    list.push(sentences);
    byGroup.set(g, list);
    all.push(sentences);
  }
  return { byGroup, all, openers, closers };
}

function synthText(model: TextModel, group: string, rng: Rng, replaceEntity: (type: string, raw: string) => string): string {
  const donors = model.byGroup.get(group) ?? model.all;
  if (!donors.length) return '';
  const donor = rng.pick(donors);
  let parts = [...donor];
  if (parts.length >= 3 && model.openers.length) {
    parts[0] = rng.pick(model.openers);
    parts[parts.length - 1] = rng.pick(model.closers);
  }
  parts = parts.filter(Boolean);
  let text = parts.join(' ');
  for (const [type, matches] of Object.entries(detectTextEntities(text))) {
    for (const m of matches) text = text.split(m).join(replaceEntity(type, m));
  }
  return text;
}

interface RealValueIndex {
  full: Map<string, string>; // lowercase real value -> entity type
  nameTokens: Set<string>; // lowercase first/last name tokens from real name columns
}

/** Index of real values from replaced columns, used to catch anything the text patterns missed. */
function realValueIndex(tables: TwinTable[]): RealValueIndex {
  const full = new Map<string, string>();
  const nameTokens = new Set<string>();
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.decision !== 'REPLACE') continue;
      for (const r of t.rows) {
        const v = r[c.name];
        if (v == null) continue;
        const s = String(v).trim();
        if (s.length >= 4) full.set(s.toLowerCase(), c.entityType ?? 'GENERIC');
        if (c.entityType === 'PERSON_NAME') for (const w of s.split(/\s+/)) if (w.length >= 3) nameTokens.add(w.toLowerCase());
      }
    }
  }
  return { full, nameTokens };
}

const EDGE = /^[\s"'([]+|[\s"'.,;:!?)\]]+$/g;

/** Finds spans of real values (up to six whitespace-separated tokens) in a text. */
function realSpans(text: string, index: RealValueIndex, includeNames: boolean): { start: number; end: number; raw: string; type: string }[] {
  const tokens = [...text.matchAll(/\S+/g)];
  const spans: { start: number; end: number; raw: string; type: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let found: (typeof spans)[number] | null = null;
    for (let n = Math.min(6, tokens.length - i); n >= 1 && !found; n--) {
      const first = tokens[i]!;
      const last = tokens[i + n - 1]!;
      const rawSpan = text.slice(first.index!, last.index! + last[0].length);
      const lead = rawSpan.length - rawSpan.replace(/^[\s"'([]+/, '').length;
      const raw = rawSpan.replace(EDGE, '');
      if (!raw) continue;
      const key = raw.toLowerCase();
      const start = first.index! + lead;
      const type = index.full.get(key);
      if (type) found = { start, end: start + raw.length, raw, type };
      else if (includeNames && n === 1 && /^\p{Lu}/u.test(raw) && index.nameTokens.has(key)) found = { start, end: start + raw.length, raw, type: 'PERSON_NAME_TOKEN' };
    }
    if (found) {
      spans.push(found);
      while (i + 1 < tokens.length && tokens[i + 1]!.index! < found.end) i++;
    }
  }
  return spans;
}

function replaceSpans(text: string, spans: { start: number; end: number; raw: string; type: string }[], replace: (type: string, raw: string) => string): string {
  let out = '';
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start) + replace(s.type, s.raw);
    pos = s.end;
  }
  return out + text.slice(pos);
}

function tvDistance(a: unknown[], b: unknown[]): number {
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  a.forEach((v) => ca.set(String(v), (ca.get(String(v)) ?? 0) + 1));
  b.forEach((v) => cb.set(String(v), (cb.get(String(v)) ?? 0) + 1));
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  let d = 0;
  for (const k of keys) d += Math.abs((ca.get(k) ?? 0) / (a.length || 1) - (cb.get(k) ?? 0) / (b.length || 1));
  return d / 2;
}

function meanStd(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1));
  return { m, s };
}

function sortTables(tables: TwinTable[], relations: TwinRelation[]): TwinTable[] {
  const done = new Set<string>();
  const out: TwinTable[] = [];
  let guard = 0;
  while (out.length < tables.length && guard++ < 100) {
    for (const t of tables) {
      if (done.has(t.name)) continue;
      const parents = relations.filter((r) => r.fromTable === t.name && r.toTable !== t.name).map((r) => r.toTable);
      if (parents.every((p) => done.has(p))) {
        out.push(t);
        done.add(t.name);
      }
    }
  }
  return out.length === tables.length ? out : tables;
}

export function generateTwin(tables: TwinTable[], relations: TwinRelation[], config: TwinConfig): TwinOutput {
  const ordered = sortTables(tables, relations);
  const output: TwinOutput['tables'] = {};
  const canaries: CanaryValue[] = [];
  const keyMaps = new Map<string, Map<string, string>>(); // table -> realKey -> syntheticKey
  const syntheticKeysByTable = new Map<string, string[]>();
  const realIndex = realValueIndex(tables);
  const realValues = new Set<string>();
  for (const t of tables) for (const c of t.columns) if (c.decision === 'REPLACE') for (const r of t.rows) if (r[c.name] != null) realValues.add(String(r[c.name]).toLowerCase());
  const issued = new Set<string>();
  const columnReport: QualityReport['columns'] = [];
  let collisions = 0;

  for (const table of ordered) {
    const rng = createRng(hashSeed(config.seed, table.name));
    const outgoing = relations.filter((r) => r.fromTable === table.name);
    const count = Math.max(1, Math.round(table.rows.length * config.multiplier));
    const amplify = (config.amplify ?? []).filter((a) => a.table === table.name);
    const weights = table.rows.map((r, idx) => [idx, amplify.reduce((w, a) => (String(r[a.column]) === a.value ? w * a.factor : w), 1)] as const);
    const keyCol = table.primaryKey;
    const prefix = keyCol ? (String(table.rows[0]?.[keyCol] ?? '').match(/^([A-Za-z]+)-/)?.[1] ?? table.name.slice(0, 3).toUpperCase()) : null;
    const keyMap = new Map<string, string>();
    const outRows: Record<string, unknown>[] = [];
    const outcomes = table.columns.filter((c) => c.classification === 'OUTCOME' && c.decision === 'KEEP');
    const outcomeCol = (outcomes.find((c) => /category|label|intent|outcome|class/i.test(c.name)) ?? outcomes[0])?.name ?? null;
    const textModels = new Map<string, TextModel>();
    for (const c of table.columns) if (c.decision === 'SCRUB_TEXT') textModels.set(c.name, buildTextModel(table.rows, c.name, outcomeCol));
    const numericStats = new Map<string, { m: number; s: number; min: number; max: number }>();
    for (const c of table.columns) {
      if (c.decision === 'KEEP' && (c.dataType === 'integer' || c.dataType === 'number')) {
        const xs = table.rows.map((r) => Number(r[c.name])).filter(Number.isFinite);
        numericStats.set(c.name, { ...meanStd(xs), min: Math.min(...xs), max: Math.max(...xs) });
      }
    }

    for (let i = 0; i < count; i++) {
      const template = table.rows.length ? table.rows[rng.weighted(weights)]! : {};
      const row: Record<string, unknown> = {};
      const personName = syntheticName(rng);
      const fresh = (gen: () => string) => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const v = gen();
          const k = v.toLowerCase();
          if (!realValues.has(k) && !issued.has(k)) {
            issued.add(k);
            return v;
          }
        }
        collisions++;
        return gen() + `-${i}`;
      };
      for (const col of table.columns) {
        const real = template[col.name];
        const fk = outgoing.find((r) => r.fromColumn === col.name);
        if (col.decision === 'DROP') continue;
        if (col.isPrimaryKey || col.name === keyCol) {
          const key = `${prefix}-S${String(i + 1).padStart(6, '0')}`;
          row[col.name] = key;
          if (i < table.rows.length) keyMap.set(String(table.rows[i]![col.name]), key);
          continue;
        }
        if (fk) {
          const parentKeys = syntheticKeysByTable.get(fk.toTable) ?? [];
          const mapped = keyMaps.get(fk.toTable)?.get(String(real));
          row[col.name] = config.multiplier === 1 && mapped ? mapped : parentKeys.length ? rng.pick(parentKeys) : null;
          continue;
        }
        if (real === null || real === undefined || real === '') {
          row[col.name] = real ?? null;
          continue;
        }
        switch (col.decision) {
          case 'REPLACE': {
            const v = fresh(() => replaceValue(col.entityType, String(real), rng, personName));
            row[col.name] = v;
            canaries.push({ tableName: table.name, rowIndex: i, columnName: col.name, value: v, entityType: col.entityType ?? 'GENERIC', meta: { algorithm: TWIN_ALGORITHM_VERSION, decision: 'REPLACE' } });
            break;
          }
          case 'GENERALIZE':
            row[col.name] = generalize(real, col);
            break;
          case 'SCRUB_TEXT': {
            const model = textModels.get(col.name)!;
            const replacements: { type: string; value: string }[] = [];
            const replaceEntity = (type: string, raw: string) => {
              if (type === 'PERSON_NAME_TOKEN') return personName.split(' ')[0]!;
              const v = fresh(() => replaceValue(type === 'ACCOUNT_ID' ? null : type, raw, rng, personName));
              replacements.push({ type, value: v });
              return v;
            };
            const patterned = synthText(model, outcomeCol ? String(template[outcomeCol] ?? '') : '', rng, replaceEntity);
            // Second pass: any real value or real name token the patterns missed is replaced too.
            const text = replaceSpans(patterned, realSpans(patterned, realIndex, true), replaceEntity);
            row[col.name] = text;
            for (const rep of replacements) canaries.push({ tableName: table.name, rowIndex: i, columnName: col.name, value: rep.value, entityType: rep.type, meta: { algorithm: TWIN_ALGORITHM_VERSION, decision: 'SCRUB_TEXT', embedded: true } });
            break;
          }
          default: {
            const st = numericStats.get(col.name);
            if (st) {
              const jitter = rng.normal() * st.s * 0.15;
              let v = Math.min(st.max, Math.max(st.min, Number(real) + jitter));
              if (col.dataType === 'integer') v = Math.round(v);
              else v = Math.round(v * 100) / 100;
              row[col.name] = v;
            } else if (col.dataType === 'date' || col.dataType === 'datetime') {
              const d = new Date(String(real));
              if (Number.isNaN(d.getTime())) row[col.name] = real;
              else {
                d.setUTCDate(d.getUTCDate() + rng.int(-7, 7));
                row[col.name] = col.dataType === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
              }
            } else {
              // Categorical: mostly follow the template row (keeps joint distributions), sometimes the marginal.
              row[col.name] = rng.next() < 0.85 ? real : table.rows[rng.int(0, table.rows.length - 1)]![col.name];
            }
          }
        }
      }
      outRows.push(row);
    }
    keyMaps.set(table.name, keyMap);
    if (keyCol) syntheticKeysByTable.set(table.name, outRows.map((r) => String(r[keyCol])));
    output[table.name] = { rows: outRows, keyColumn: keyCol };

    for (const col of table.columns) {
      if (col.decision === 'DROP') {
        columnReport.push({ table: table.name, column: col.name, decision: col.decision, distance: null, note: 'Removed from the synthetic copy.' });
        continue;
      }
      if (col.decision === 'KEEP' && !col.isPrimaryKey && !outgoing.some((r) => r.fromColumn === col.name)) {
        const st = numericStats.get(col.name);
        if (st) {
          const syn = meanStd(outRows.map((r) => Number(r[col.name])).filter(Number.isFinite));
          const d = st.s ? Math.abs(syn.m - st.m) / st.s : 0;
          columnReport.push({ table: table.name, column: col.name, decision: col.decision, distance: round(d), note: `Mean shift of ${round(d)} standard deviations.` });
        } else if (col.dataType !== 'date' && col.dataType !== 'datetime') {
          const d = tvDistance(table.rows.map((r) => r[col.name]), outRows.map((r) => r[col.name]));
          columnReport.push({ table: table.name, column: col.name, decision: col.decision, distance: round(d), note: `Total variation distance ${round(d)} between real and synthetic category frequencies.` });
        }
      } else {
        columnReport.push({ table: table.name, column: col.name, decision: col.decision, distance: null, note: col.decision === 'REPLACE' ? 'Every value replaced with a format-preserving synthetic value.' : col.decision === 'SCRUB_TEXT' ? 'Rebuilt from sentence pools with every detected entity replaced.' : col.decision === 'GENERALIZE' ? 'Generalized to a coarser value.' : 'Key remapped to synthetic keys.' });
      }
    }
  }

  const report = buildReport(tables, relations, output, columnReport, collisions, config);
  return { tables: output, canaries, report };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function buildReport(
  tables: TwinTable[],
  relations: TwinRelation[],
  output: TwinOutput['tables'],
  columns: QualityReport['columns'],
  collisions: number,
  config: TwinConfig,
): QualityReport {
  const metrics: MetricResult[] = [];
  const kept = tables.flatMap((t) => t.columns.filter((c) => c.decision !== 'DROP').map((c) => ({ t: t.name, c: c.name })));
  const present = kept.filter(({ t, c }) => output[t]?.rows[0] && c in output[t]!.rows[0]!).length;
  metrics.push({ key: 'structure', label: 'Structural fidelity', value: round(present / (kept.length || 1)), threshold: 1, withinThreshold: present === kept.length, explanation: `${present} of ${kept.length} non-dropped columns are present in every synthetic table.` });

  const dists = columns.filter((c) => c.distance !== null && !c.note.startsWith('Mean')).map((c) => c.distance!);
  const avgTv = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 0;
  metrics.push({ key: 'distribution', label: 'Distribution similarity', value: round(1 - avgTv), threshold: 0.85, withinThreshold: 1 - avgTv >= 0.85, explanation: `Average category-frequency similarity across ${dists.length} kept categorical columns (1 − total variation distance).` });

  let fkTotal = 0;
  let fkOk = 0;
  for (const r of relations) {
    const parent = new Set((output[r.toTable]?.rows ?? []).map((x) => String(x[r.toColumn])));
    for (const row of output[r.fromTable]?.rows ?? []) {
      if (row[r.fromColumn] == null) continue;
      fkTotal++;
      if (parent.has(String(row[r.fromColumn]))) fkOk++;
    }
  }
  metrics.push({ key: 'relationships', label: 'Relationship integrity', value: round(fkTotal ? fkOk / fkTotal : 1), threshold: 1, withinThreshold: fkOk === fkTotal, explanation: `${fkOk} of ${fkTotal} foreign-key references point to an existing synthetic parent row.` });

  let uniqueOk = true;
  for (const t of tables) {
    const key = output[t.name]?.keyColumn;
    if (!key) continue;
    const vals = output[t.name]!.rows.map((r) => r[key]);
    if (new Set(vals).size !== vals.length) uniqueOk = false;
  }
  metrics.push({ key: 'uniqueness', label: 'Key uniqueness', value: uniqueOk ? 1 : 0, threshold: 1, withinThreshold: uniqueOk, explanation: uniqueOk ? 'Every primary key in every synthetic table is unique.' : 'Duplicate synthetic keys were detected.' });

  let copied = 0;
  let compared = 0;
  for (const t of tables) {
    const sensitive = t.columns.filter((c) => ['REPLACE', 'SCRUB_TEXT'].includes(c.decision)).map((c) => c.name);
    if (!sensitive.length) continue;
    const realSigs = new Set(t.rows.map((r) => sensitive.map((c) => String(r[c] ?? '')).join('\u0001')));
    for (const r of output[t.name]?.rows ?? []) {
      compared++;
      if (realSigs.has(sensitive.map((c) => String(r[c] ?? '')).join('\u0001'))) copied++;
    }
  }
  const index = realValueIndex(tables);
  let textLeaks = 0;
  for (const t of tables) {
    for (const c of t.columns.filter((x) => x.decision === 'SCRUB_TEXT')) {
      for (const r of output[t.name]?.rows ?? []) if (r[c.name] && realSpans(String(r[c.name]), index, false).length) textLeaks++;
    }
  }
  copied += textLeaks;
  const safetyPassed = collisions === 0 && copied === 0;
  metrics.push({ key: 'safety', label: 'Privacy safety', value: round(compared ? 1 - copied / compared : 1), threshold: 1, withinThreshold: safetyPassed, explanation: `${copied} synthetic rows reproduce real sensitive values (${textLeaks} inside free text); ${collisions} generated values collided with real values.` });

  const variety = columns.filter((c) => c.decision === 'REPLACE').length;
  metrics.push({ key: 'variety', label: 'Variety', value: 1, threshold: 1, withinThreshold: true, explanation: `${variety} replaced columns use generators that produce distinct values per row.` });
  return {
    algorithmVersion: TWIN_ALGORITHM_VERSION,
    seed: config.seed,
    metrics,
    tables: tables.map((t) => ({ name: t.name, sourceRows: t.rows.length, syntheticRows: output[t.name]?.rows.length ?? 0 })),
    columns,
    safety: {
      realValueCollisions: collisions,
      copiedRealRows: copied,
      passed: safetyPassed,
      explanation: safetyPassed
        ? 'No synthetic row reproduces a real sensitive value, and no generated value collides with a real one.'
        : 'Some synthetic values match real values. The set is held until the issue is reviewed.',
    },
  };
}
