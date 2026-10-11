import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, dec, humanize, num, pct } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, PageHead, Pagination, Panel, StatusBadge } from '../components/ui';

interface SetRow {
  id: string;
  name: string;
  version: number;
  seed: number;
  multiplier: number;
  status: string;
  safetyPassed: boolean | null;
  rowCount: number;
  canaryCount: number;
  createdAt: string;
  algorithmVersion: string;
  source: { id: string; name: string };
  _count: { sends: number };
}

export function SyntheticSets() {
  const q = useApi<SetRow[]>('/synthetic-sets', { refetchInterval: 10_000 });
  return (
    <div className="stack lg">
      <PageHead title="Synthetic Sets" description="Twin generates complete synthetic copies that keep schema, relationships and distributions, with every value registered in Canary." />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <Empty title="No synthetic sets yet" action={<Link className="btn" to="/sources">Open Data Sources</Link>}>Sign off a data source in the Firewall, then generate a synthetic twin.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Source</th><th>Status</th><th>Safety</th><th className="num">Rows</th><th className="num">Canary values</th><th className="num">Sends</th><th>Created</th></tr></thead>
            <tbody>
              {q.data!.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/synthetic/${s.id}`}><strong>{s.name}</strong></Link><div className="small muted">v{s.version} · seed {s.seed}</div></td>
                  <td><Link to={`/sources/${s.source.id}`}>{s.source.name}</Link></td>
                  <td><StatusBadge status={s.status} /></td>
                  <td>{s.safetyPassed === null ? '—' : s.safetyPassed ? <Badge tone="soft">Passed</Badge> : <Badge tone="outline-strong">Held</Badge>}</td>
                  <td className="num">{num(s.rowCount)}</td>
                  <td className="num">{num(s.canaryCount)}</td>
                  <td className="num">{s._count.sends}</td>
                  <td className="small muted">{dateTime(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface Metric { key: string; label: string; value: number; threshold: number; withinThreshold: boolean; explanation: string }
interface SetDetailRes extends SetRow {
  sourceId: string;
  config: Record<string, unknown>;
  qualityReport: { patterns?: PatternRow[]; metrics?: Metric[]; columns?: { table: string; column: string; decision: string; distance: number | null; note: string }[] } | null;
  tables: { name: string; rows: number }[];
  sends: { id: string; recipient: string; recipientType: string; channel: string; recordCount: number; createdAt: string }[];
  completedAt: string | null;
  approvalStatus: string;
  approvalReason: string | null;
  approvedAt: string | null;
}
interface PatternRow { table: string; column: string; kind: string; strategy: string; confidence: number; conformance: number; preserves: string[]; limitations: string[] }

export function SyntheticDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useApi<SetDetailRes>(`/synthetic-sets/${id}`, { refetchInterval: (d) => (d && ['QUEUED', 'GENERATING', 'CHECKING'].includes(d.status) ? 2000 : false) });
  const [table, setTable] = useState('');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [release, setRelease] = useState(false);
  const [reviewing, setReviewing] = useState<null | boolean>(null);
  const [comparing, setComparing] = useState(false);
  const activeTable = table || q.data?.tables[0]?.name || '';
  const rows = useApi<{ rows: { id: string; key: string; data: Record<string, unknown> }[]; total: number }>(activeTable ? `/synthetic-sets/${id}/rows${qs({ table: activeTable, limit: 50, offset, q: search })}` : null, { keepPrevious: true });
  if (q.isLoading) return <Loading rows={8} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const metrics = s.qualityReport?.metrics ?? [];
  const cols = rows.data?.rows[0] ? Object.keys(rows.data.rows[0].data) : [];
  return (
    <div className="stack lg">
      <PageHead
        crumbs={[{ to: '/synthetic', label: 'Synthetic Sets' }, { label: s.name }]}
        title={<span className="row">{s.name} <StatusBadge status={s.status} /></span>}
        description={<>Synthetic copy of <Link to={`/sources/${s.sourceId}`}>{s.source?.name ?? 'source'}</Link>. Seed {s.seed}, multiplier {s.multiplier}, algorithm {s.algorithmVersion}.</>}
        actions={
          <>
            {s.status === 'SAFETY_HOLD' && can('firewall.signoff') ? <button onClick={() => setRelease(true)}>Release safety hold</button> : null}
            {s.status === 'READY' && s.approvalStatus === 'PENDING' && can('firewall.signoff') ? <><button onClick={() => setReviewing(false)}>Reject</button><button className="primary" onClick={() => setReviewing(true)}>Approve set</button></> : null}
            {can('sources.real.preview') && s.status === 'READY' ? <button onClick={() => setComparing(true)}>Compare with source</button> : null}
            {can('labeling.manage') ? <button className={s.approvalStatus === 'APPROVED' ? 'primary' : ''} disabled={s.status !== 'READY' || s.approvalStatus !== 'APPROVED'} title={s.approvalStatus !== 'APPROVED' ? 'An administrator must approve this set first' : undefined} onClick={() => nav(`/projects/new?setId=${s.id}`)}>Send to labeling</button> : null}
          </>
        }
      />
      {s.status === 'SAFETY_HOLD' ? <div className="callout strong">This set failed a privacy safety check and cannot be sent anywhere until the hold is released with a documented reason.</div> : null}
      {s.status === 'READY' && s.approvalStatus === 'PENDING' ? <div className="callout">Awaiting approval. Review the quality, pattern and safety report below. The set cannot be sent to labeling or exported until an administrator approves it.</div> : null}
      {s.approvalStatus === 'REJECTED' ? <div className="callout strong">Rejected{s.approvalReason ? `: ${s.approvalReason}` : ''}. This set cannot be used. Adjust the Firewall decisions or generation plan and generate a new version.</div> : null}
      {s.approvalStatus === 'APPROVED' && s.approvalReason ? <div className="callout small">Approved {s.approvedAt ? dateTime(s.approvedAt) : ''}: {s.approvalReason}</div> : null}
      {['QUEUED', 'GENERATING', 'CHECKING'].includes(s.status) ? <div className="callout">Generation in progress. This page refreshes automatically.</div> : null}
      <div className="grid cols-4">
        <div className="stat"><div className="k">Rows</div><div className="v">{num(s.rowCount)}</div></div>
        <div className="stat"><div className="k">Tables</div><div className="v">{s.tables.length}</div></div>
        <div className="stat"><div className="k">Canary values</div><div className="v">{num(s.canaryCount)}</div><div className="s"><Link to="/canary?tab=registry">Open registry</Link></div></div>
        <div className="stat"><div className="k">Sends</div><div className="v">{s.sends.length}</div></div>
      </div>
      {metrics.length ? (
        <Panel title="Quality and safety report">
          <table>
            <thead><tr><th>Metric</th><th className="num">Value</th><th className="num">Threshold</th><th>Result</th><th>Explanation</th></tr></thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.key}>
                  <td><strong>{m.label}</strong></td>
                  <td className="num">{dec(m.value, 3)}</td>
                  <td className="num">{dec(m.threshold, 2)}</td>
                  <td>{m.withinThreshold ? <Badge tone="soft">within threshold</Badge> : <Badge tone="outline-strong">outside threshold</Badge>}</td>
                  <td className="small">{m.explanation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}
      {s.qualityReport?.patterns?.length ? (
        <Panel title="Learned patterns">
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>Column</th><th>Strategy</th><th>Preserved</th><th className="num">Pattern confidence</th><th className="num">Conformance</th><th>Limitations</th></tr></thead>
              <tbody>{s.qualityReport.patterns.map((p) => <tr key={`${p.table}.${p.column}`}><td><code>{p.table}.{p.column}</code><div className="small muted">{humanize(p.kind)}</div></td><td>{p.strategy === 'PATTERN' ? 'Learned pattern' : 'Generic format'}</td><td className="small">{p.preserves.join(', ')}</td><td className="num">{pct(p.confidence, 0)}</td><td className="num">{pct(p.conformance, 0)}</td><td className="small muted">{p.limitations.join(' ') || '—'}</td></tr>)}</tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      {s.qualityReport?.columns?.length ? (
        <Panel title="Per-column treatment">
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>Column</th><th>Decision</th><th className="num">Distribution distance</th><th>Note</th></tr></thead>
              <tbody>{s.qualityReport.columns.map((c) => <tr key={`${c.table}.${c.column}`}><td><code>{c.table}.{c.column}</code></td><td>{humanize(c.decision)}</td><td className="num">{c.distance === null ? '—' : dec(c.distance, 3)}</td><td className="small">{c.note}</td></tr>)}</tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      {s.tables.length ? (
        <Panel
          flat
          title="Synthetic rows"
          actions={
            <>
              <select aria-label="Table" value={activeTable} onChange={(e) => { setTable(e.target.value); setOffset(0); }} style={{ width: 180 }}>
                {s.tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({num(t.rows)})</option>)}
              </select>
              <input placeholder="Search synthetic key" aria-label="Search synthetic key" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} style={{ width: 200 }} />
            </>
          }
        >
          <div className="table-wrap" style={{ border: 'none', maxHeight: 460 }}>
            <table>
              <thead><tr><th>Key</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{rows.data?.rows.map((r) => <tr key={r.id}><td className="mono small nowrap">{r.key}</td>{cols.map((c) => <td key={c} className="small truncate" title={String(r.data[c] ?? '')}>{String(r.data[c] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div style={{ padding: 10 }}><Pagination total={rows.data?.total ?? 0} limit={50} offset={offset} onChange={setOffset} /></div>
        </Panel>
      ) : null}
      <Panel title="Sends (Canary exposure history)">
        {s.sends.length === 0 ? <p className="muted">This set has not been sent anywhere yet.</p> : (
          <table>
            <thead><tr><th>Recipient</th><th>Type</th><th>Channel</th><th className="num">Records</th><th>When</th></tr></thead>
            <tbody>{s.sends.map((x) => <tr key={x.id}><td>{x.recipient}</td><td>{humanize(x.recipientType)}</td><td>{x.channel}</td><td className="num">{num(x.recordCount)}</td><td className="small muted">{dateTime(x.createdAt)}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
      {release ? <ReleaseHold id={s.id} onClose={() => setRelease(false)} /> : null}
      {reviewing !== null ? <ReviewSet id={s.id} approve={reviewing} failing={metrics.filter((m) => !m.withinThreshold).map((m) => m.label)} onClose={() => setReviewing(null)} /> : null}
      {comparing ? <Compare id={s.id} tables={s.tables.map((t) => t.name)} onClose={() => setComparing(false)} /> : null}
    </div>
  );
}

function ReleaseHold({ id, onClose }: { id: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useAction(() => api.post(`/synthetic-sets/${id}/release-hold`, { reason }), { success: 'Safety hold released.', invalidate: [`/synthetic-sets`], onSuccess: onClose, silentError: true });
  return (
    <Modal title="Release safety hold" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={reason.trim().length < 15 || m.isPending} onClick={() => m.mutate(undefined)}>Release</button></>}>
      <div className="stack">
        <p>Releasing the hold is recorded in the audit log with your reason.</p>
        <Field label="Reason (at least 15 characters)"><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function ReviewSet({ id, approve, failing, onClose }: { id: string; approve: boolean; failing: string[]; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const needReason = !approve || failing.length > 0;
  const m = useAction(() => api.post(`/synthetic-sets/${id}/review`, { approve, reason: reason || undefined }), { success: approve ? 'Synthetic set approved.' : 'Synthetic set rejected.', invalidate: ['/synthetic-sets'], onSuccess: onClose, silentError: true });
  return (
    <Modal title={approve ? 'Approve synthetic set' : 'Reject synthetic set'} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={m.isPending || (needReason && !reason.trim())} onClick={() => m.mutate(undefined)}>{approve ? 'Approve' : 'Reject'}</button></>}>
      <div className="stack">
        {approve && failing.length ? <div className="callout strong">Outside threshold: {failing.join(', ')}. Explain why the set is acceptable.</div> : null}
        <Field label={needReason ? 'Reason (required)' : 'Reason (optional)'}><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function Compare({ id, tables, onClose }: { id: string; tables: string[]; onClose: () => void }) {
  const [table, setTable] = useState(tables[0] ?? '');
  const q = useApi<{ real: Record<string, unknown>[]; synthetic: Record<string, unknown>[] }>(table ? `/synthetic-sets/${id}/compare${qs({ table, limit: 8 })}` : null);
  const grid = (rows: Record<string, unknown>[]) => {
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    return (
      <div className="table-wrap" style={{ maxHeight: 280 }}>
        <table><thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="small truncate">{String(r[c] ?? '')}</td>)}</tr>)}</tbody></table>
      </div>
    );
  };
  return (
    <Modal wide title="Compare with source" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <div className="stack">
        <div className="callout small">Real rows are shown inside the Firewall boundary to authorised administrators only, and this view is recorded in the activity log. Rows are not paired: synthetic rows are not copies of particular real rows.</div>
        <select aria-label="Table" value={table} onChange={(e) => setTable(e.target.value)} style={{ maxWidth: 220 }}>{tables.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        {q.isLoading ? <Loading rows={4} /> : q.error ? <ErrorBox error={q.error} /> : q.data ? (
          <div className="grid cols-2">
            <div><h4>Real (source)</h4>{grid(q.data.real)}</div>
            <div><h4>Synthetic</h4>{grid(q.data.synthetic)}</div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
