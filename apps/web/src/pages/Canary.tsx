import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, humanize, num } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Help, Json, Loading, PageHead, Panel, StatusBadge } from '../components/ui';

interface Overview { registered: number; exposures: number; openAlerts: number; recentScans: { id: string; inputName: string; inputType: string; createdAt: string; matchCount?: number; candidates?: number }[]; disclaimer: string }
interface RegistryRow { id: string; value: string; entityType: string; tableName: string; columnName: string; setId: string; createdAt: string; _count: { exposures: number; alerts: number } }
interface AlertRow { id: string; status: string; matchedText: string; context: string; note: string | null; createdAt: string; registryId: string; registry: { value: string; entityType: string; tableName: string; columnName: string; setId: string }; scan: { inputName: string; inputType: string } }
interface SendRow { id: string; recipient: string; recipientType: string; channel: string; recordCount: number; createdAt: string; set: { name: string; version: number }; _count: { exposures: number } }
interface ScanResult { scanId: string; candidates: number; matches: { registryId: string; value: string; entityType: string; matchedText: string; context: string; origin: { setId: string; table: string; column: string }; exposures: { recipient: string; channel: string; at: string }[] }[]; disclaimer: string }

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'scan', label: 'Scan' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'registry', label: 'Registry' },
  { key: 'sends', label: 'Sends' },
];

export function Canary() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'overview';
  const ov = useApi<Overview>('/canary/overview');
  return (
    <div className="stack lg">
      <PageHead title="Canary" description="Every synthetic value carries a signature. Canary shows where a value came from, who received it, and finds it again in text, files and exports." />
      <nav className="tabs" aria-label="Canary sections">
        {TABS.map((t) => <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setParams({ tab: t.key })}>{t.label}{t.key === 'alerts' && ov.data?.openAlerts ? <> <span className="badge solid">{ov.data.openAlerts}</span></> : null}</button>)}
      </nav>
      {tab === 'overview' ? <CanaryOverview q={ov} /> : null}
      {tab === 'scan' ? <ScanPanel /> : null}
      {tab === 'alerts' ? <Alerts /> : null}
      {tab === 'registry' ? <Registry /> : null}
      {tab === 'sends' ? <Sends /> : null}
    </div>
  );
}

function CanaryOverview({ q }: { q: ReturnType<typeof useApi<Overview>> }) {
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  return (
    <div className="stack lg">
      <div className="grid cols-3">
        <div className="stat"><div className="k">Registered values</div><div className="v">{num(d.registered)}</div></div>
        <div className="stat"><div className="k">Exposure records</div><div className="v">{num(d.exposures)}</div></div>
        <div className="stat"><div className="k">Open alerts</div><div className="v">{num(d.openAlerts)}</div></div>
      </div>
      <div className="callout small">{d.disclaimer}</div>
      <Panel title="Recent scans">
        {d.recentScans.length === 0 ? <p className="muted">No scans yet.</p> : (
          <table>
            <thead><tr><th>Input</th><th>Type</th><th>When</th></tr></thead>
            <tbody>{d.recentScans.map((s) => <tr key={s.id}><td>{s.inputName}</td><td>{humanize(s.inputType)}</td><td className="small muted">{dateTime(s.createdAt)}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function ScanPanel() {
  const { can } = useAuth();
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const scan = useAction(
    async () => {
      if (file) {
        const f = new FormData();
        f.append('file', file);
        return api.upload<ScanResult>('/canary/scan', f);
      }
      return api.post<ScanResult>('/canary/scan', { text, inputName: 'Pasted text' });
    },
    { invalidate: ['/canary'], onSuccess: setResult },
  );
  if (!can('canary.scan')) return <p className="muted">Your role cannot run Canary scans.</p>;
  return (
    <div className="stack lg">
      <Panel title="Scan text or a file">
        <div className="stack">
          <Field label="Paste text" hint="Emails, forum posts, documents, model outputs — anything that may contain synthetic values.">
            <textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); setFile(null); }} />
          </Field>
          <Field label="Or upload a file" hint="TXT, CSV, TSV, JSON, JSONL, MD or LOG up to 20 MB.">
            <input type="file" accept=".txt,.csv,.tsv,.json,.jsonl,.md,.log" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <div><button className="primary" disabled={(!text.trim() && !file) || scan.isPending} onClick={() => scan.mutate(undefined)}>{scan.isPending ? 'Scanning…' : 'Scan'}</button></div>
          <Help>Candidates (emails, phone numbers, identifiers and short phrases) are normalized and looked up in the indexed registry; each match is verified against its signature.</Help>
        </div>
      </Panel>
      {result ? (
        <Panel title={`Result: ${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} from ${num(result.candidates)} candidates`}>
          <div className="stack">
            {result.matches.length === 0 ? <div className="callout">No registered synthetic values were found. {result.disclaimer}</div> : (
              <table>
                <thead><tr><th>Value</th><th>Origin</th><th>Context</th><th>Previously sent to</th></tr></thead>
                <tbody>
                  {result.matches.map((m) => (
                    <tr key={m.registryId}>
                      <td><Link to={`/canary/values/${m.registryId}`}><strong>{m.value}</strong></Link><div className="small muted">{humanize(m.entityType)}</div></td>
                      <td className="small"><code>{m.origin.table}.{m.origin.column}</code></td>
                      <td className="small" style={{ maxWidth: 360 }}>{m.context}</td>
                      <td className="small">{m.exposures.length ? m.exposures.map((e, i) => <div key={i}>{e.recipient} · {e.channel} · {dateTime(e.at)}</div>) : <span className="muted">No recorded sends</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Alerts() {
  const { can } = useAuth();
  const [status, setStatus] = useState('OPEN');
  const q = useApi<AlertRow[]>(`/canary/alerts${qs({ status })}`);
  const update = useAction((v: { id: string; status: string }) => api.patch(`/canary/alerts/${v.id}`, { status: v.status }), { success: 'Alert updated.', invalidate: ['/canary'] });
  return (
    <div className="stack">
      <div className="row">
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 200 }}>
          <option value="OPEN">Open</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="RESOLVED">Resolved</option><option value="">All</option>
        </select>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <Empty title="No alerts">No alerts match this filter.</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Value</th><th>Found in</th><th>Context</th><th>Status</th><th>When</th><th /></tr></thead>
            <tbody>
              {q.data!.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/canary/values/${a.registryId}`}><strong>{a.registry.value}</strong></Link><div className="small muted"><code>{a.registry.tableName}.{a.registry.columnName}</code></div></td>
                  <td>{a.scan.inputName}<div className="small muted">{humanize(a.scan.inputType)}</div></td>
                  <td className="small" style={{ maxWidth: 360 }}>{a.context}</td>
                  <td><StatusBadge status={a.status} /></td>
                  <td className="small muted">{dateTime(a.createdAt)}</td>
                  <td>{can('canary.scan') ? <div className="row">{a.status !== 'ACKNOWLEDGED' ? <button className="sm" onClick={() => update.mutate({ id: a.id, status: 'ACKNOWLEDGED' })}>Acknowledge</button> : null}{a.status !== 'RESOLVED' ? <button className="sm" onClick={() => update.mutate({ id: a.id, status: 'RESOLVED' })}>Resolve</button> : null}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Registry() {
  const [q, setQ] = useState('');
  const r = useApi<RegistryRow[]>(`/canary/registry${qs({ q, limit: 100 })}`, { keepPrevious: true });
  return (
    <div className="stack">
      <input placeholder="Search a synthetic value, e.g. an email or phone number" aria-label="Search registry" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 480 }} />
      {r.isLoading ? <Loading /> : r.error ? <ErrorBox error={r.error} /> : !r.data!.length ? <Empty title="No values found" /> : (
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table>
            <thead><tr><th>Value</th><th>Type</th><th>Origin</th><th className="num">Exposures</th><th className="num">Alerts</th></tr></thead>
            <tbody>{r.data!.map((v) => <tr key={v.id}><td><Link to={`/canary/values/${v.id}`}>{v.value}</Link></td><td>{humanize(v.entityType)}</td><td className="small"><code>{v.tableName}.{v.columnName}</code></td><td className="num">{v._count.exposures}</td><td className="num">{v._count.alerts}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Sends() {
  const q = useApi<SendRow[]>('/canary/sends');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data!.length) return <Empty title="No sends yet">Sends are recorded when synthetic data goes to a labeling project or an export.</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Recipient</th><th>Type</th><th>Channel</th><th>Set</th><th className="num">Records</th><th className="num">Exposures</th><th>When</th></tr></thead>
        <tbody>{q.data!.map((s) => <tr key={s.id}><td>{s.recipient}</td><td>{humanize(s.recipientType)}</td><td>{s.channel}</td><td>{s.set.name} v{s.set.version}</td><td className="num">{num(s.recordCount)}</td><td className="num">{num(s._count.exposures)}</td><td className="small muted">{dateTime(s.createdAt)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

interface Trace {
  id: string; value: string; signature: string; entityType: string;
  origin: { set: { id: string; name: string; version: number; seed: number; algorithmVersion: string; source: { id: string; name: string } } | null; table: string; column: string; record: { syntheticKey: string; tableName: string; rowIndex: number } | null; generation: unknown; createdAt: string };
  exposures: { at: string; recipient: string; recipientType: string; channel: string; sendId: string }[];
  alerts: { id: string; status: string; at: string; input: string; context: string }[];
}

export function CanaryValue() {
  const { id } = useParams();
  const q = useApi<Trace>(`/canary/registry/${id}`);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const t = q.data!;
  return (
    <div className="stack lg">
      <PageHead crumbs={[{ to: '/canary', label: 'Canary' }, { to: '/canary?tab=registry', label: 'Registry' }, { label: t.value }]} title={t.value} description={`${humanize(t.entityType)} · synthetic value`} />
      <div className="grid cols-2">
        <Panel title="Origin">
          <dl className="dl">
            <dt>Synthetic set</dt><dd>{t.origin.set ? <Link to={`/synthetic/${t.origin.set.id}`}>{t.origin.set.name} v{t.origin.set.version}</Link> : '—'}</dd>
            <dt>Source</dt><dd>{t.origin.set ? <Link to={`/sources/${t.origin.set.source.id}`}>{t.origin.set.source.name}</Link> : '—'}</dd>
            <dt>Table / column</dt><dd><code>{t.origin.table}.{t.origin.column}</code></dd>
            <dt>Record</dt><dd className="mono">{t.origin.record?.syntheticKey ?? '—'}</dd>
            <dt>Seed / algorithm</dt><dd>{t.origin.set ? `${t.origin.set.seed} · ${t.origin.set.algorithmVersion}` : '—'}</dd>
            <dt>Registered</dt><dd>{dateTime(t.origin.createdAt)}</dd>
            <dt>Signature</dt><dd className="mono small" style={{ wordBreak: 'break-all' }}>{t.signature}</dd>
          </dl>
        </Panel>
        <Panel title="Generation metadata"><Json value={t.origin.generation} /></Panel>
      </div>
      <Panel title="Exposure history">
        {t.exposures.length === 0 ? <p className="muted">This value has not been sent anywhere.</p> : (
          <table><thead><tr><th>Recipient</th><th>Type</th><th>Channel</th><th>When</th></tr></thead>
            <tbody>{t.exposures.map((e, i) => <tr key={i}><td>{e.recipient}</td><td>{humanize(e.recipientType)}</td><td>{e.channel}</td><td className="small muted">{dateTime(e.at)}</td></tr>)}</tbody></table>
        )}
      </Panel>
      <Panel title="Alerts">
        {t.alerts.length === 0 ? <p className="muted">No scans have found this value.</p> : (
          <table><thead><tr><th>Found in</th><th>Context</th><th>Status</th><th>When</th></tr></thead>
            <tbody>{t.alerts.map((a) => <tr key={a.id}><td>{a.input}</td><td className="small">{a.context}</td><td><StatusBadge status={a.status} /></td><td className="small muted">{dateTime(a.at)}</td></tr>)}</tbody></table>
        )}
      </Panel>
      <p className="small muted"><Badge tone="dashed">Note</Badge> A scan that finds nothing does not prove a value was never leaked; it only shows it was not found in the scanned material.</p>
    </div>
  );
}
