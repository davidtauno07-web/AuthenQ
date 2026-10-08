import { Fragment, useState } from 'react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, dec, duration, humanize, interval, num, pct } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Help, Json, Loading, Modal, Pagination, Panel, StatusBadge } from '../components/ui';
import { useProject } from './Projects';

type Interval = { low: number; high: number };

// ── Gold ────────────────────────────────────────────────────────────────────
interface GoldRes {
  goldVersion: number; lockedAt: string | null;
  summary: { split: string; status: string; count: number }[];
  records: { id: string; split: string; sampling: string; selectionReason: string | null; requiredLabels: number; status: string; finalLabels: { label: string } | null; task: { id: string; ordinal: number; key: string; text: string }; labels: { id: string; userId: string | null; values: { label: string }; createdAt: string; userName?: string }[] }[];
}
const SPLITS = ['EXAMPLE', 'TUNING', 'LOCKED_TEST'] as const;

export function Gold() {
  const { project: p, refetch } = useProject();
  const { can } = useAuth();
  const [split, setSplit] = useState('');
  const [status, setStatus] = useState('');
  const q = useApi<GoldRes>(`/projects/${p.id}/gold${qs({ split, status })}`);
  const [sample, setSample] = useState({ strategy: 'COVERAGE', count: 20, split: 'TUNING', requiredLabels: 2 });
  const [adj, setAdj] = useState<GoldRes['records'][number] | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const inv = [`/projects/${p.id}`];
  const doSample = useAction(() => api.post<{ added: number }>(`/projects/${p.id}/gold/sample`, sample), { success: (r) => `Added ${(r as { added?: number }).added ?? sample.count} records to gold.`, invalidate: inv, onSuccess: () => refetch() });
  const move = useAction((v: { id: string; split: string }) => api.patch(`/projects/${p.id}/gold/${v.id}`, { split: v.split }), { invalidate: inv });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const count = (s: string, st?: string) => d.summary.filter((x) => x.split === s && (!st || x.status === st)).reduce((a, x) => a + x.count, 0);
  return (
    <div className="stack lg">
      <div className="grid cols-4">
        {SPLITS.map((s) => <div key={s} className="stat"><div className="k">{humanize(s)}</div><div className="v">{count(s)}</div><div className="s">{count(s, 'FINAL')} final · {count(s, 'NEEDS_ADJUDICATION')} need adjudication</div></div>)}
        <div className="stat"><div className="k">Gold version</div><div className="v">v{d.goldVersion}</div><div className="s">{d.lockedAt ? `Locked ${dateTime(d.lockedAt)}` : 'Not locked'}</div></div>
      </div>
      {can('gold.manage') ? (
        <Panel title="Sample records into gold" actions={<button className={d.lockedAt ? '' : 'primary'} onClick={() => setLockOpen(true)}>{d.lockedAt ? 'Unlock (new version)' : 'Lock gold set'}</button>}>
          <div className="stack">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Strategy"><select value={sample.strategy} onChange={(e) => setSample({ ...sample, strategy: e.target.value })} style={{ width: 170 }}><option value="RANDOM">Random</option><option value="COVERAGE">Coverage (per slice)</option><option value="HARD_CASE">Hard cases</option><option value="DISAGREEMENT">Disagreement</option></select></Field>
              <Field label="Count"><input type="number" min={1} max={1000} value={sample.count} onChange={(e) => setSample({ ...sample, count: Number(e.target.value) })} style={{ width: 100 }} /></Field>
              <Field label="Split"><select value={sample.split} onChange={(e) => setSample({ ...sample, split: e.target.value })} style={{ width: 150 }}>{SPLITS.map((s) => <option key={s} value={s} disabled={s === 'LOCKED_TEST' && !!d.lockedAt}>{humanize(s)}</option>)}</select></Field>
              <Field label="Labels required"><input type="number" min={1} max={5} value={sample.requiredLabels} onChange={(e) => setSample({ ...sample, requiredLabels: Number(e.target.value) })} style={{ width: 100 }} /></Field>
              <button disabled={doSample.isPending} onClick={() => doSample.mutate(undefined)}>Sample</button>
            </div>
            <Help>Gold records are labeled independently by the required number of people in the workspace. Agreeing labels finalize automatically; disagreements go to adjudication. The locked test split is never shown to the engine and is the only basis for the accuracy gate.</Help>
          </div>
        </Panel>
      ) : null}
      <div className="row">
        <select aria-label="Split" value={split} onChange={(e) => setSplit(e.target.value)} style={{ width: 170 }}><option value="">All splits</option>{SPLITS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 170 }}><option value="">All statuses</option>{['PENDING', 'NEEDS_ADJUDICATION', 'FINAL'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
      </div>
      {!d.records.length ? <Empty title="No gold records">Sample records to start building the gold set.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 620 }}>
          <table>
            <thead><tr><th>Record</th><th>Split</th><th>Sampling</th><th>Labels</th><th>Final</th><th>Status</th><th /></tr></thead>
            <tbody>
              {d.records.map((r) => (
                <tr key={r.id}>
                  <td className="small" style={{ maxWidth: 420 }}><span className="mono muted">{r.task.key}</span><div className="truncate" title={r.task.text}>{r.task.text}</div></td>
                  <td>{can('gold.manage') && !(d.lockedAt && r.split === 'LOCKED_TEST') ? <select aria-label="Move split" value={r.split} onChange={(e) => move.mutate({ id: r.id, split: e.target.value })} style={{ width: 130 }}>{SPLITS.map((s) => <option key={s} value={s} disabled={s === 'LOCKED_TEST' && !!d.lockedAt}>{humanize(s)}</option>)}</select> : humanize(r.split)}</td>
                  <td className="small">{humanize(r.sampling)}<div className="muted">{r.selectionReason}</div></td>
                  <td className="small">{r.labels.map((l) => <div key={l.id}>{l.values.label} <span className="muted">· {l.userName ?? 'Unknown'}</span></div>)}<span className="muted">{r.labels.length}/{r.requiredLabels}</span></td>
                  <td>{r.finalLabels ? <strong>{r.finalLabels.label}</strong> : '—'}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{r.status === 'NEEDS_ADJUDICATION' && can('labeling.review') ? <button className="sm primary" onClick={() => setAdj(r)}>Adjudicate</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adj ? <Adjudicate record={adj} onClose={() => setAdj(null)} /> : null}
      {lockOpen ? <LockGold locked={!!d.lockedAt} onClose={() => setLockOpen(false)} /> : null}
    </div>
  );
}

function Adjudicate({ record, onClose }: { record: GoldRes['records'][number]; onClose: () => void }) {
  const { project: p } = useProject();
  const [label, setLabel] = useState(record.labels[0]?.values.label ?? '');
  const [reason, setReason] = useState('');
  const m = useAction(() => api.post(`/projects/${p.id}/gold/${record.id}/adjudicate`, { label, reason }), { success: 'Gold record finalized.', invalidate: [`/projects/${p.id}`], onSuccess: onClose, silentError: true });
  return (
    <Modal title="Adjudicate gold record" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={!label || m.isPending} onClick={() => m.mutate(undefined)}>Finalize</button></>}>
      <div className="stack">
        <div className="pre small">{record.task.text}</div>
        <div className="small">{record.labels.map((l) => <div key={l.id}>{l.userName}: <strong>{l.values.label}</strong></div>)}</div>
        <Field label="Final label"><select value={label} onChange={(e) => setLabel(e.target.value)}>{p.labels.map((l) => <option key={l.value}>{l.value}</option>)}</select></Field>
        <Field label="Reason"><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function LockGold({ locked, onClose }: { locked: boolean; onClose: () => void }) {
  const { project: p, refetch } = useProject();
  const [reason, setReason] = useState('');
  const m = useAction(() => api.post(`/projects/${p.id}/gold/lock`, { lock: !locked, reason: reason || undefined }), { success: locked ? 'Gold set unlocked. A new gold version was created.' : 'Gold set locked.', invalidate: [`/projects/${p.id}`], onSuccess: () => { refetch(); onClose(); }, silentError: true });
  return (
    <Modal title={locked ? 'Unlock gold set' : 'Lock gold set'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={(locked && reason.trim().length < 10) || m.isPending} onClick={() => m.mutate(undefined)}>{locked ? 'Unlock' : 'Lock'}</button></>}>
      <div className="stack">
        <p>{locked ? 'Unlocking increments the gold version. Quality results from the previous version will no longer apply.' : 'Locking freezes the locked test split. Engine accuracy is measured only against it.'}</p>
        <Field label={locked ? 'Reason (required)' : 'Note (optional)'}><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ── Engine ──────────────────────────────────────────────────────────────────
interface Run { id: string; runNumber: number; engineType: string; engineVersion: string; scope: string; status: string; estimate: Record<string, unknown>; totals: Record<string, unknown> | null; actualCost: number; spendCap: number | null; createdAt: string; startedAt: string | null; finishedAt: string | null; goldVersion: number }
interface Estimate { items: number; estimatedCost: number; costNote: string; expectedReview: number; expectedAutoAccepted: number; trainedOn: number; lockedTest: number; warnings: string[]; engineVersion: string }
interface Trial { id: string; name: string; config: Record<string, unknown>; metrics: Record<string, unknown>; createdAt: string }

function KV({ value }: { value: Record<string, unknown> | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <dl className="dl small">
      {Object.entries(value).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => <Fragment key={k}><dt>{humanize(k)}</dt><dd>{typeof v === 'number' ? (Number.isInteger(v) ? num(v) : dec(v, 3)) : String(v)}</dd></Fragment>)}
    </dl>
  );
}

export function Engine() {
  const { project: p, refetch } = useProject();
  const { can } = useAuth();
  const runs = useApi<Run[]>(`/projects/${p.id}/engine/runs`, { refetchInterval: (d) => (d?.some((r) => ['QUEUED', 'RUNNING'].includes(r.status)) ? 2500 : false) });
  const trials = useApi<Trial[]>(`/projects/${p.id}/trials`);
  const [scope, setScope] = useState('ALL_UNLABELED');
  const [engineType, setEngineType] = useState('DEMO');
  const [spendCap, setSpendCap] = useState('');
  const [est, setEst] = useState<Estimate | null>(null);
  const [trial, setTrial] = useState({ name: '', threshold: p.configResolved.autoAcceptThreshold, passes: p.configResolved.passes, dropout: p.configResolved.dropout });
  const inv = [`/projects/${p.id}`];
  const body = () => ({ scope, engineType, spendCap: spendCap ? Number(spendCap) : undefined });
  const estimate = useAction(() => api.post<Estimate>(`/projects/${p.id}/engine/estimate`, body()), { onSuccess: setEst });
  const start = useAction(() => api.post(`/projects/${p.id}/engine/runs`, body()), { success: 'Engine run queued.', invalidate: inv, onSuccess: () => { setEst(null); refetch(); } });
  const reprio = useAction(() => api.post(`/projects/${p.id}/engine/reprioritize`), { success: 'Tasks reprioritized by uncertainty.', invalidate: inv });
  const runTrial = useAction(() => api.post(`/projects/${p.id}/trials`, { name: trial.name, config: { autoAcceptThreshold: trial.threshold, passes: trial.passes, dropout: trial.dropout } }), { success: 'Setup trial finished.', invalidate: [`/projects/${p.id}/trials`] });
  return (
    <div className="stack lg">
      <div className="callout small"><strong>Demo engine:</strong> a deterministic multinomial Naive Bayes classifier with Laplace smoothing, seeded token-dropout self-consistency passes and keyword rules. It is not a large language model. Order of precedence: carried-over outcomes (only when enabled) → rules → model → human review below the confidence threshold.</div>
      {can('engine.run') ? (
        <Panel title="Start an engine run" actions={<button className="sm" onClick={() => reprio.mutate(undefined)}>Reprioritize open tasks</button>}>
          <div className="stack">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Scope"><select value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: 220 }}><option value="ALL_UNLABELED">All unlabeled tasks</option><option value="GUIDELINE_AFFECTED">Affected by guideline change</option></select></Field>
              <Field label="Engine"><select value={engineType} onChange={(e) => setEngineType(e.target.value)} style={{ width: 200 }}><option value="DEMO">Demo engine (local)</option><option value="AI">External AI provider</option></select></Field>
              {engineType === 'AI' ? <Field label="Spend cap (USD)"><input type="number" min={0} step="0.01" value={spendCap} onChange={(e) => setSpendCap(e.target.value)} style={{ width: 120 }} /></Field> : null}
              <button onClick={() => estimate.mutate(undefined)} disabled={estimate.isPending}>Estimate</button>
              <button className="primary" disabled={!est || start.isPending} onClick={() => start.mutate(undefined)}>Start run</button>
            </div>
            {est ? (
              <div className="callout small">
                <strong>{num(est.items)} tasks</strong> · expected {num(est.expectedAutoAccepted)} auto-accepted, {num(est.expectedReview)} to review · trained on {num(est.trainedOn)} labeled records · {num(est.lockedTest)} locked-test records held out · {est.costNote} · {est.engineVersion}
                {est.warnings?.length ? <ul>{est.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
              </div>
            ) : null}
            <ErrorBox error={estimate.error ?? start.error} />
          </div>
        </Panel>
      ) : null}
      <Panel title="Runs" flat>
        {runs.isLoading ? <Loading /> : !runs.data?.length ? <p className="muted" style={{ padding: 12 }}>No engine runs yet.</p> : (
          <table>
            <thead><tr><th>Run</th><th>Engine</th><th>Scope</th><th>Status</th><th>Totals</th><th>Started</th><th>Finished</th></tr></thead>
            <tbody>{runs.data.map((r) => <tr key={r.id}><td>#{r.runNumber}</td><td className="small">{humanize(r.engineType)}<div className="muted mono">{r.engineVersion}</div></td><td className="small">{humanize(r.scope)}</td><td><StatusBadge status={r.status} /></td><td><KV value={r.totals} /></td><td className="small muted">{dateTime(r.startedAt)}</td><td className="small muted">{dateTime(r.finishedAt)}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
      <Panel title="Setup trials (tuning split)">
        <div className="stack">
          {can('engine.run') ? (
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Trial name"><input value={trial.name} onChange={(e) => setTrial({ ...trial, name: e.target.value })} /></Field>
              <Field label="Threshold"><input type="number" step="0.01" min={0.5} max={1} value={trial.threshold} onChange={(e) => setTrial({ ...trial, threshold: Number(e.target.value) })} style={{ width: 100 }} /></Field>
              <Field label="Passes"><input type="number" min={1} max={7} value={trial.passes} onChange={(e) => setTrial({ ...trial, passes: Number(e.target.value) })} style={{ width: 90 }} /></Field>
              <Field label="Dropout"><input type="number" step="0.01" min={0} max={0.5} value={trial.dropout} onChange={(e) => setTrial({ ...trial, dropout: Number(e.target.value) })} style={{ width: 100 }} /></Field>
              <button disabled={!trial.name || runTrial.isPending} onClick={() => runTrial.mutate(undefined)}>Run trial</button>
            </div>
          ) : null}
          <Help>Trials evaluate a configuration against the tuning split only, so you can compare settings without touching the locked test set.</Help>
          {trials.data?.length ? (
            <table>
              <thead><tr><th>Trial</th><th>Metrics</th><th>When</th></tr></thead>
              <tbody>{trials.data.map((t) => <tr key={t.id}><td>{t.name}<div className="small muted mono">{JSON.stringify(t.config)}</div></td><td><KV value={t.metrics} /></td><td className="small muted">{dateTime(t.createdAt)}</td></tr>)}</tbody>
            </table>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

// ── Review ──────────────────────────────────────────────────────────────────
interface ReviewItem { id: string; taskId: string; ordinal: number; key: string; text: string; context: Record<string, unknown>; predicted: string; source: string; confidence: number; rationale: string; ruleCited: string | null; routingReason: string | null; passes: unknown; reviewStatus: string }

export function Review() {
  const { project: p } = useProject();
  const [mode, setMode] = useState<'review' | 'audit'>('review');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const q = useApi<{ total: number; items: ReviewItem[] }>(`/projects/${p.id}/review${qs({ mode, limit: 50, offset })}`, { keepPrevious: true });
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const inv = [`/projects/${p.id}`];
  const act = useAction((v: { id: string; action: 'accept' | 'correct'; label?: string; addToExamples?: boolean }) => api.post(`/projects/${p.id}/review/${v.id}`, v), { invalidate: inv });
  const bulk = useAction(() => api.post<{ accepted: number }>(`/projects/${p.id}/review-bulk-accept`, { itemIds: [...selected] }), { success: (r) => `Accepted ${(r as { accepted?: number }).accepted ?? selected.size} items.`, invalidate: inv, onSuccess: () => setSelected(new Set()) });
  const items = q.data?.items ?? [];
  return (
    <div className="stack lg">
      <div className="row">
        <div className="tabs" style={{ marginBottom: 0, border: 'none' }}>
          <button className={mode === 'review' ? 'active' : ''} onClick={() => { setMode('review'); setOffset(0); }}>Review queue</button>
          <button className={mode === 'audit' ? 'active' : ''} onClick={() => { setMode('audit'); setOffset(0); }}>Audit sample</button>
        </div>
        <span className="right small muted">{mode === 'review' ? 'Items the engine routed to people, lowest confidence first.' : 'A seeded random sample of auto-accepted items, used to measure audit accuracy.'}</span>
      </div>
      {selected.size ? <div className="callout row"><strong>{selected.size} selected</strong><button className="primary sm" onClick={() => bulk.mutate(undefined)}>Accept engine labels</button><button className="ghost sm" onClick={() => setSelected(new Set())}>Clear</button></div> : null}
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !items.length ? <Empty title={mode === 'review' ? 'Review queue is empty' : 'Nothing to audit'}>{mode === 'review' ? 'Every routed item has been reviewed.' : 'Run the engine to produce auto-accepted items.'}</Empty> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 32 }}><input type="checkbox" aria-label="Select all" checked={items.every((i) => selected.has(i.id))} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></th><th>Record</th><th>Engine output</th><th>Why</th><th style={{ width: 290 }}>Decision</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td><input type="checkbox" aria-label={`Select ${i.key}`} checked={selected.has(i.id)} onChange={() => { const s = new Set(selected); if (s.has(i.id)) s.delete(i.id); else s.add(i.id); setSelected(s); }} /></td>
                    <td className="small" style={{ maxWidth: 420 }}><span className="mono muted">{i.key}</span><div>{i.text.slice(0, 400)}</div><div className="muted">{Object.entries(i.context).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div></td>
                    <td><strong>{i.predicted}</strong><div className="small muted">{humanize(i.source)} · {pct(i.confidence, 0)}</div></td>
                    <td className="small" style={{ maxWidth: 280 }}>{i.rationale}{i.routingReason ? <div className="muted">{i.routingReason}</div> : null}</td>
                    <td>
                      <div className="row wrap">
                        <button className="sm" onClick={() => act.mutate({ id: i.id, action: 'accept' })}>Accept</button>
                        <select aria-label="Correct to" value={corrections[i.id] ?? ''} onChange={(e) => setCorrections({ ...corrections, [i.id]: e.target.value })} style={{ width: 140, height: 30 }}><option value="">Correct to…</option>{p.labels.filter((l) => l.value !== i.predicted).map((l) => <option key={l.value}>{l.value}</option>)}</select>
                        <button className="sm primary" disabled={!corrections[i.id]} onClick={() => act.mutate({ id: i.id, action: 'correct', label: corrections[i.id], addToExamples: true })} title="The original engine output is preserved.">Correct</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mode === 'review' ? <Pagination total={q.data!.total} limit={50} offset={offset} onChange={setOffset} /> : <p className="small muted">{items.length} of {num(q.data!.total)} auto-accepted items sampled.</p>}
        </>
      )}
      <Help>Corrections keep the original engine output on the item, add the corrected record to the example bank, and count toward the review correction rate.</Help>
    </div>
  );
}

// ── Quality ─────────────────────────────────────────────────────────────────
interface Check { key: string; label: string; value: number | null; threshold: number; within: boolean; wording: string; explanation: string }
interface QualityRes {
  goldVersion: number;
  run: { id: string; runNumber: number; engineType: string; engineVersion: string; finishedAt: string | null; trainedOn?: number } | null;
  evaluation: { n: number; correct: number; accuracy: number | null; interval: Interval; macroF1: number | null; perLabel: { label: string; support: number; precision: number | null; recall: number | null; f1: number | null }[]; confusion: { labels: string[]; matrix: number[][] }; wording?: string } | null;
  humanAgreement: { pairs: number; agreement: number | null; kappa: number | null; interval: Interval };
  calibration: { bins: { from: number; to: number; count: number; avgConfidence: number; accuracy: number }[]; expectedCalibrationError: number | null };
  reviewRate: number | null;
  review: { done: number; corrected: number; pending: number; correctionRate: number | null };
  audit: { total: number; correct: number; accuracy: number | null };
  slices: { slice: string; n: number; accuracy: number | null; interval: Interval; wording: string }[];
  errorClusters: { truth: string; predicted: string; count: number; examples: string[] }[];
  labelDistribution: { label: string; count: number }[];
  sourceDistribution: { source: string; count: number }[];
  timePerTask: { medianMs: number | null; samples: number };
  labelers: { userId: string; name: string; labels: number; goldCompared: number; agreementWithGold: number | null }[];
  gate: { ready: boolean; checks: Check[] };
}

export function Quality() {
  const { project: p } = useProject();
  const q = useApi<QualityRes>(`/projects/${p.id}/quality`);
  if (q.isLoading) return <Loading rows={8} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const ev = d.evaluation;
  const maxLabel = Math.max(1, ...d.labelDistribution.map((l) => l.count));
  const maxSource = Math.max(1, ...d.sourceDistribution.map((l) => l.count));
  const maxCell = ev ? Math.max(1, ...ev.confusion.matrix.flat()) : 1;
  return (
    <div className="stack lg">
      <div className={`callout ${d.gate.ready ? '' : 'strong'}`}>
        <strong>Quality gate: {d.gate.ready ? 'all checks within threshold' : 'one or more checks outside threshold'}</strong>
        <span className="small"> · gold v{d.goldVersion}{d.run ? ` · run #${d.run.runNumber} (${d.run.engineVersion})` : ' · no completed run'}</span>
      </div>
      <Panel title="Gate checks" flat>
        <table>
          <thead><tr><th>Check</th><th className="num">Value</th><th className="num">Threshold</th><th>Result</th><th>Explanation</th></tr></thead>
          <tbody>{d.gate.checks.map((c) => <tr key={c.key}><td><strong>{c.label}</strong></td><td className="num">{c.value === null ? '—' : c.value <= 1 && !Number.isInteger(c.value) ? pct(c.value, 1) : num(c.value)}</td><td className="num">{c.threshold <= 1 && !Number.isInteger(c.threshold) ? pct(c.threshold, 0) : num(c.threshold)}</td><td><Badge tone={c.within ? 'soft' : 'outline-strong'}>{c.wording}</Badge></td><td className="small">{c.explanation}</td></tr>)}</tbody>
        </table>
      </Panel>
      <div className="grid cols-4">
        <div className="stat"><div className="k">Accuracy (locked test)</div><div className="v">{ev ? pct(ev.accuracy, 1) : '—'}</div><div className="s">{ev ? `${ev.correct}/${ev.n} · 95% ${interval(ev.interval)}` : 'Lock gold and run the engine'}</div></div>
        <div className="stat"><div className="k">Macro F1</div><div className="v">{ev ? dec(ev.macroF1, 3) : '—'}</div></div>
        <div className="stat"><div className="k">Human agreement</div><div className="v">{pct(d.humanAgreement.agreement, 1)}</div><div className="s">κ = {dec(d.humanAgreement.kappa, 3)} · {d.humanAgreement.pairs} double-labeled</div></div>
        <div className="stat"><div className="k">Review rate</div><div className="v">{pct(d.reviewRate, 1)}</div><div className="s">{d.review.done} reviewed · {pct(d.review.correctionRate, 0)} corrected · {d.review.pending} pending</div></div>
        <div className="stat"><div className="k">Audit accuracy</div><div className="v">{pct(d.audit.accuracy, 1)}</div><div className="s">{d.audit.correct}/{d.audit.total} audited</div></div>
        <div className="stat"><div className="k">Median time per task</div><div className="v">{d.timePerTask.medianMs === null ? '—' : duration(d.timePerTask.medianMs)}</div><div className="s">{d.timePerTask.samples} timed labels</div></div>
        {ev && d.humanAgreement.agreement !== null && ev.accuracy !== null ? (
          <div className="stat"><div className="k">Engine vs. humans</div><div className="v small" style={{ fontSize: 15 }}>{ev.accuracy >= d.humanAgreement.agreement ? 'within human agreement level' : 'outside human agreement level'}</div></div>
        ) : null}
      </div>
      {ev ? (
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Panel title="Per label" flat>
            <table>
              <thead><tr><th>Label</th><th className="num">Precision</th><th className="num">Recall</th><th className="num">F1</th><th className="num">Support</th></tr></thead>
              <tbody>{ev.perLabel.map((l) => <tr key={l.label}><td>{l.label}</td><td className="num">{dec(l.precision, 3)}</td><td className="num">{dec(l.recall, 3)}</td><td className="num">{dec(l.f1, 3)}</td><td className="num">{l.support}</td></tr>)}</tbody>
            </table>
          </Panel>
          <Panel title="Confusion matrix (rows: truth, columns: engine)" flat>
            <div className="table-wrap" style={{ border: 'none' }}>
              <table className="confusion">
                <thead><tr><th />{ev.confusion.labels.map((l) => <th key={l} className="num small" title={l}>{l.slice(0, 8)}</th>)}</tr></thead>
                <tbody>{ev.confusion.matrix.map((row, i) => <tr key={i}><th className="small">{ev.confusion.labels[i]}</th>{row.map((v, j) => { const a = v / maxCell; return <td key={j} className="num" style={{ background: `rgba(0,0,0,${(a * 0.85).toFixed(3)})`, color: a > 0.45 ? '#fff' : '#000' }}>{v}</td>; })}</tr>)}</tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title={`Calibration${d.calibration.expectedCalibrationError != null ? ` · ECE ${dec(d.calibration.expectedCalibrationError, 3)}` : ''}`}>
          {d.calibration.bins.some((c) => c.count) ? (
            <table>
              <thead><tr><th>Confidence</th><th className="num">Items</th><th className="num">Avg. confidence</th><th className="num">Accuracy</th></tr></thead>
              <tbody>{d.calibration.bins.map((c) => <tr key={c.from}><td>{pct(c.from, 0)}–{pct(c.to, 0)}</td><td className="num">{c.count}</td><td className="num">{c.count ? pct(c.avgConfidence, 1) : '—'}</td><td className="num">{c.count ? pct(c.accuracy, 1) : '—'}</td></tr>)}</tbody>
            </table>
          ) : <p className="muted">No locked-test predictions yet.</p>}
        </Panel>
        <Panel title="Slices">
          {d.slices.length ? (
            <table>
              <thead><tr><th>Slice</th><th className="num">n</th><th className="num">Accuracy</th><th>95% interval</th><th>Result</th></tr></thead>
              <tbody>{d.slices.map((s) => <tr key={s.slice}><td>{s.slice}</td><td className="num">{s.n}</td><td className="num">{pct(s.accuracy, 1)}</td><td className="small">{interval(s.interval)}</td><td><Badge tone={s.wording === 'within threshold' ? 'soft' : 'outline-strong'}>{s.wording}</Badge></td></tr>)}</tbody>
            </table>
          ) : <p className="muted">{p.sliceField ? 'No locked-test predictions yet.' : 'No slice field configured for this project.'}</p>}
        </Panel>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title="Label distribution">
          <div className="stack" style={{ gap: 6 }}>{d.labelDistribution.map((l) => <div key={l.label} className="hbar"><span>{l.label}</span><div className="bar"><span style={{ width: `${(l.count / maxLabel) * 100}%` }} /></div><span className="num">{num(l.count)}</span></div>)}</div>
        </Panel>
        <Panel title="Label sources">
          <div className="stack" style={{ gap: 6 }}>{d.sourceDistribution.map((l) => <div key={l.source} className="hbar"><span>{humanize(l.source)}</span><div className="bar"><span style={{ width: `${(l.count / maxSource) * 100}%` }} /></div><span className="num">{num(l.count)}</span></div>)}</div>
        </Panel>
      </div>
      <Panel title="Error clusters">
        {d.errorClusters.length ? (
          <table>
            <thead><tr><th>Truth → engine</th><th className="num">Count</th><th>Examples</th></tr></thead>
            <tbody>{d.errorClusters.map((c) => <tr key={`${c.truth}-${c.predicted}`}><td><strong>{c.truth}</strong> → {c.predicted}</td><td className="num">{c.count}</td><td className="small">{c.examples.map((e, i) => <div key={i} className="truncate" style={{ maxWidth: 640 }}>{e}</div>)}</td></tr>)}</tbody>
          </table>
        ) : <p className="muted">No errors on the locked test split.</p>}
      </Panel>
      <Panel title="Labelers">
        {d.labelers.length ? (
          <table>
            <thead><tr><th>Labeler</th><th className="num">Labels</th><th className="num">Gold compared</th><th className="num">Agreement with gold</th></tr></thead>
            <tbody>{d.labelers.map((l) => <tr key={l.userId}><td>{l.name}</td><td className="num">{num(l.labels)}</td><td className="num">{l.goldCompared}</td><td className="num">{pct(l.agreementWithGold, 1)}</td></tr>)}</tbody>
          </table>
        ) : <p className="muted">No human labels yet.</p>}
      </Panel>
    </div>
  );
}

// ── Exports ─────────────────────────────────────────────────────────────────
interface ExportRow { id: string; version: number; format: string; status: string; options: { includeSplits?: string[] }; gate: { ready: boolean; checks?: Check[] } | null; safety: { passed: boolean; explanation: string; realValueMatches?: number; canaryValues?: number } | null; overrideReason: string | null; recordCount: number; checksum: string | null; createdAt: string; completedAt: string | null; manifest: unknown; dataCard: unknown }
interface Format { key: string; name: string; extension: string; description: string }

export function Exports() {
  const { project: p } = useProject();
  const { can } = useAuth();
  const list = useApi<ExportRow[]>(`/projects/${p.id}/exports`, { refetchInterval: (d) => (d?.some((e) => ['QUEUED', 'BUILDING'].includes(e.status)) ? 2500 : false) });
  const formats = useApi<Format[]>('/export-formats');
  const quality = useApi<QualityRes>(`/projects/${p.id}/quality`);
  const [format, setFormat] = useState('JSONL');
  const [splits, setSplits] = useState<string[]>(['TRAIN']);
  const [override, setOverride] = useState('');
  const [detail, setDetail] = useState<ExportRow | null>(null);
  const inv = [`/projects/${p.id}/exports`, '/canary'];
  const create = useAction(() => api.post(`/projects/${p.id}/exports`, { format, includeSplits: splits, overrideReason: override || undefined }), { success: 'Export queued.', invalidate: inv, onSuccess: () => setOverride('') });
  const download = useAction((id: string) => api.post<{ url: string; fileName: string }>(`/projects/${p.id}/exports/${id}/download`), { onSuccess: (r) => { window.location.href = r.url; } });
  const scan = useAction((id: string) => api.post<{ matches: unknown[] }>(`/canary/scan-export/${id}`), { success: (r) => `Canary scan complete: ${(r as { matches?: unknown[] }).matches?.length ?? 0} registered values found in this package (expected, since it is synthetic).`, invalidate: ['/canary'] });
  const gateReady = quality.data?.gate.ready;
  return (
    <div className="stack lg">
      {can('exports.create') ? (
        <Panel title="Create an export package">
          <div className="stack">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Format"><select value={format} onChange={(e) => setFormat(e.target.value)} style={{ width: 240 }}>{formats.data?.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}</select></Field>
              <fieldset><legend>Splits</legend><div className="row">{['TRAIN', 'VALIDATION', 'TEST'].map((s) => <label key={s} className="check"><input type="checkbox" checked={splits.includes(s)} onChange={() => setSplits(splits.includes(s) ? splits.filter((x) => x !== s) : [...splits, s])} />{humanize(s)}</label>)}</div></fieldset>
            </div>
            <p className="small muted">{formats.data?.find((f) => f.key === format)?.description}</p>
            {quality.data && !gateReady ? (
              <div className="callout strong small">
                The quality gate has checks outside threshold: {quality.data.gate.checks.filter((c) => !c.within).map((c) => c.label).join(', ')}.
                {can('exports.override') ? <Field label="Override reason (recorded in the manifest and audit log)"><textarea value={override} onChange={(e) => setOverride(e.target.value)} /></Field> : <div>Someone with the export override permission must create this export.</div>}
              </div>
            ) : null}
            <div><button className="primary" disabled={!splits.length || create.isPending || (quality.data && !gateReady && override.trim().length < 10)} onClick={() => create.mutate(undefined)}>Create export</button></div>
            <ErrorBox error={create.error} />
            <Help>Each package is a ZIP with the data file, manifest, schema, labels, guideline version, data card, lineage, provenance, safety report, checksums and a README. Before completing, every record is compared against the real sensitive values held in the Firewall; any match blocks the export.</Help>
          </div>
        </Panel>
      ) : null}
      <Panel title="Exports" flat>
        {list.isLoading ? <Loading /> : !list.data?.length ? <p className="muted" style={{ padding: 12 }}>No exports yet.</p> : (
          <table>
            <thead><tr><th>Version</th><th>Format</th><th>Status</th><th className="num">Records</th><th>Gate</th><th>Safety</th><th>Created</th><th /></tr></thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={e.id}>
                  <td>v{e.version}</td><td>{e.format}</td><td><StatusBadge status={e.status} /></td><td className="num">{num(e.recordCount)}</td>
                  <td>{e.gate?.ready ? <Badge tone="soft">within threshold</Badge> : e.overrideReason ? <Badge tone="outline-strong" title={e.overrideReason}>overridden</Badge> : e.gate ? <Badge tone="outline-strong">outside threshold</Badge> : '—'}</td>
                  <td className="small">{e.safety ? (e.safety.passed ? <Badge tone="soft">passed</Badge> : <Badge tone="outline-strong">blocked</Badge>) : '—'}</td>
                  <td className="small muted">{dateTime(e.createdAt)}</td>
                  <td><div className="row"><button className="sm" onClick={() => setDetail(e)}>Details</button>{e.status === 'COMPLETED' ? <><button className="sm primary" onClick={() => download.mutate(e.id)}>Download</button>{can('canary.scan') ? <button className="sm" onClick={() => scan.mutate(e.id)}>Canary scan</button> : null}</> : null}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {detail ? (
        <Modal title={`Export v${detail.version}`} onClose={() => setDetail(null)} wide>
          <div className="stack">
            <dl className="dl"><dt>Status</dt><dd><StatusBadge status={detail.status} /></dd><dt>Checksum (SHA-256)</dt><dd className="mono small" style={{ wordBreak: 'break-all' }}>{detail.checksum ?? '—'}</dd><dt>Splits</dt><dd>{detail.options.includeSplits?.join(', ')}</dd>{detail.overrideReason ? <><dt>Override reason</dt><dd>{detail.overrideReason}</dd></> : null}</dl>
            {detail.safety ? <div className="callout small"><strong>Safety:</strong> {detail.safety.explanation}</div> : null}
            {detail.dataCard ? <><h3>Data card</h3><Json value={detail.dataCard} /></> : null}
            {detail.manifest ? <><h3>Manifest</h3><Json value={detail.manifest} /></> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
