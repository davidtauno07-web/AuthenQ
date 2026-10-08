import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, dec, humanize, num } from '../lib/format';
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
  qualityReport: { metrics?: Metric[]; columns?: { table: string; column: string; decision: string; distance: number | null; note: string }[] } | null;
  tables: { name: string; rows: number }[];
  sends: { id: string; recipient: string; recipientType: string; channel: string; recordCount: number; createdAt: string }[];
  completedAt: string | null;
}

export function SyntheticDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useApi<SetDetailRes>(`/synthetic-sets/${id}`, { refetchInterval: (d) => (d && ['QUEUED', 'GENERATING', 'CHECKING'].includes(d.status) ? 2000 : false) });
  const [table, setTable] = useState('');
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [release, setRelease] = useState(false);
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
            {can('labeling.manage') ? <button className="primary" disabled={s.status !== 'READY'} onClick={() => nav(`/projects/new?setId=${s.id}`)}>Send to labeling</button> : null}
          </>
        }
      />
      {s.status === 'SAFETY_HOLD' ? <div className="callout strong">This set failed a privacy safety check and cannot be sent anywhere until the hold is released with a documented reason.</div> : null}
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
