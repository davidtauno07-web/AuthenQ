import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, humanize, num, pct } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Help, Loading, Modal, PageHead, Panel, StatusBadge } from '../components/ui';

interface SourceRow {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  rowCount: number;
  createdAt: string;
  _count: { tables: number; columns: number; sets: number };
}

export function Sources() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = useApi<SourceRow[]>('/sources', { refetchInterval: 10_000 });
  const showNew = params.get('new') === '1';
  return (
    <div className="stack lg">
      <PageHead
        title="Data Sources"
        description="The Firewall inspects and classifies every column of your real data. Nothing moves downstream until the decisions are signed off."
        actions={can('sources.write') ? <button className="primary" onClick={() => setParams({ new: '1' })}>New data source</button> : null}
      />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <Empty title="No data sources yet" action={can('sources.write') ? <button className="primary" onClick={() => setParams({ new: '1' })}>New data source</button> : undefined}>
          Create a source, then upload files or import tables from a connector.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Status</th><th className="num">Tables</th><th className="num">Columns</th><th className="num">Rows</th><th className="num">Synthetic sets</th><th>Created</th></tr>
            </thead>
            <tbody>
              {q.data!.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/sources/${s.id}`}><strong>{s.name}</strong></Link><div className="small muted truncate">{s.description}</div></td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="num">{s._count.tables}</td>
                  <td className="num">{s._count.columns}</td>
                  <td className="num">{num(s.rowCount)}</td>
                  <td className="num">{s._count.sets}</td>
                  <td className="small muted">{dateTime(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showNew ? <NewSource onClose={() => setParams({})} /> : null}
    </div>
  );
}

function NewSource({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useAction((v: { name: string; description: string }) => api.post<{ id: string }>('/sources', v), {
    invalidate: ['/sources', '/dashboard'],
    onSuccess: (r) => nav(`/sources/${r.id}`),
  });
  return (
    <Modal
      title="New data source"
      onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate({ name, description })}>Create source</button></>}
    >
      <div className="stack">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM support tickets" /></Field>
        <Field label="Description" hint="What the data is and who owns it."><textarea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

interface Column {
  id: string;
  name: string;
  dataType: string;
  format: string | null;
  classification: string;
  entityType: string | null;
  explanation: string | null;
  confidence: number | null;
  decision: string | null;
  decisionSource: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
}
interface SourceDetailRes extends SourceRow {
  currentScanId: string | null;
  signedOffScanId: string | null;
  signedOffAt: string | null;
  lastError: string | null;
  tables: { id: string; name: string; rowCount: number; primaryKey: string | null; columns: Column[] }[];
  relations: { id: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; confidence: number; explanation: string; confirmed: boolean | null }[];
  scans: { id: string; version: number; status: string; summary: Record<string, number> | null; createdAt: string; completedAt: string | null }[];
  sets: { id: string; name: string; version: number; status: string; rowCount: number; createdAt: string }[];
  gate: { ready: boolean; reasons: string[] };
  decisions: { id: string; previous: string | null; decision: string; source: string; reason: string | null; createdAt: string; column: { name: string; table: { name: string } } }[];
}

const DECISIONS = ['REPLACE', 'GENERALIZE', 'SCRUB_TEXT', 'DROP', 'KEEP', 'KEY'] as const;
const DECISION_HELP: Record<string, string> = {
  REPLACE: 'Every value replaced with a format-preserving synthetic value.',
  GENERALIZE: 'Values coarsened (dates to month, codes to prefix, numbers to ranges).',
  SCRUB_TEXT: 'Free text rebuilt from sentence pools with every entity replaced.',
  DROP: 'Column removed from the synthetic copy.',
  KEEP: 'Values follow the real distribution. Not allowed for sensitive columns.',
  KEY: 'Keys remapped to synthetic keys while keeping relationships.',
};

export function SourceDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useApi<SourceDetailRes>(`/sources/${id}`, { refetchInterval: (d) => (d && ['INGESTING', 'SCANNING'].includes(d.status) ? 2000 : false) });
  const [tableFilter, setTableFilter] = useState<string>('');
  const [classFilter, setClassFilter] = useState<string>('');
  const [editing, setEditing] = useState<{ col: Column; table: string } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [twinOpen, setTwinOpen] = useState(false);
  const inv = [`/sources/${id}`, '/sources', '/dashboard'];
  const scan = useAction(() => api.post(`/sources/${id}/scan`), { success: 'Firewall scan started.', invalidate: inv });
  const signOff = useAction(() => api.post(`/sources/${id}/sign-off`), { success: 'Firewall decisions signed off.', invalidate: inv });
  const relation = useAction((v: { id: string; confirmed: boolean }) => api.patch(`/relations/${v.id}`, { confirmed: v.confirmed }), { invalidate: inv });
  const [uploadErr, setUploadErr] = useState<Error | null>(null);
  const [uploading, setUploading] = useState(false);
  const columns = useMemo(() => {
    const out: { table: string; col: Column }[] = [];
    for (const t of q.data?.tables ?? []) for (const c of t.columns) if ((!tableFilter || t.name === tableFilter) && (!classFilter || c.classification === classFilter)) out.push({ table: t.name, col: c });
    return out;
  }, [q.data, tableFilter, classFilter]);
  if (q.isLoading) return <Loading rows={8} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!;
  const busy = ['INGESTING', 'SCANNING'].includes(s.status);
  const upload = async (file: File, tableName: string) => {
    setUploadErr(null);
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    if (tableName) form.append('tableName', tableName);
    try {
      await api.upload(`/sources/${id}/upload`, form);
      await q.refetch();
    } catch (e) {
      setUploadErr(e as Error);
    } finally {
      setUploading(false);
    }
  };
  const latest = s.scans[0];
  return (
    <div className="stack lg">
      <PageHead
        crumbs={[{ to: '/sources', label: 'Data Sources' }, { label: s.name }]}
        title={<span className="row">{s.name} <StatusBadge status={s.status} /></span>}
        description={s.description || 'Real data. Values stay inside the Firewall boundary; only classifications and statistics are shown here.'}
        actions={
          <>
            {can('sources.write') ? <button disabled={busy || !s.tables.length || scan.isPending} onClick={() => scan.mutate(undefined)}>{s.currentScanId ? 'Rescan' : 'Run Firewall scan'}</button> : null}
            {can('firewall.signoff') ? <button className="primary" disabled={!s.gate.ready || s.status === 'SIGNED_OFF' || signOff.isPending} onClick={() => signOff.mutate(undefined)}>Sign off decisions</button> : null}
            {can('synthetic.write') ? <button className={s.status === 'SIGNED_OFF' ? 'primary' : ''} disabled={s.status !== 'SIGNED_OFF'} onClick={() => setTwinOpen(true)} title={s.status !== 'SIGNED_OFF' ? 'Sign off the Firewall decisions first' : undefined}>Generate synthetic twin</button> : null}
          </>
        }
      />
      {s.lastError ? <div className="callout"><strong>Last operation failed:</strong> {s.lastError}</div> : null}
      {busy ? <div className="callout">{s.status === 'INGESTING' ? 'Ingesting data…' : 'Firewall scan in progress…'} This page refreshes automatically.</div> : null}
      {!s.gate.ready && s.currentScanId ? (
        <div className="callout">
          <strong>Sign-off is blocked</strong>
          <ul>{s.gate.reasons.slice(0, 8).map((r) => <li key={r}>{r}</li>)}</ul>
          {s.gate.reasons.length > 8 ? <p className="small muted">and {s.gate.reasons.length - 8} more</p> : null}
        </div>
      ) : null}
      <ErrorBox error={scan.error ?? signOff.error} />
      <div className="grid cols-4">
        <div className="stat"><div className="k">Tables</div><div className="v">{s.tables.length}</div></div>
        <div className="stat"><div className="k">Rows</div><div className="v">{num(s.rowCount)}</div></div>
        <div className="stat"><div className="k">Scan</div><div className="v">{latest ? `v${latest.version}` : '—'}</div><div className="s">{latest ? <StatusBadge status={latest.status} /> : 'Not scanned'}</div></div>
        <div className="stat"><div className="k">Sensitive columns</div><div className="v">{latest?.summary?.SENSITIVE ?? '—'}</div><div className="s">{latest?.summary ? `${latest.summary.NEEDS_DECISION ?? 0} needed a decision` : ''}</div></div>
      </div>

      {can('sources.write') ? <UploadPanel onUpload={upload} uploading={uploading || s.status === 'INGESTING'} error={uploadErr} /> : null}

      {s.tables.length ? (
        <Panel
          flat
          title="Columns and Firewall decisions"
          actions={
            <>
              <select aria-label="Filter by table" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} style={{ width: 160 }}>
                <option value="">All tables</option>
                {s.tables.map((t) => <option key={t.id} value={t.name}>{t.name} ({num(t.rowCount)})</option>)}
              </select>
              <select aria-label="Filter by classification" value={classFilter} onChange={(e) => setClassFilter(e.target.value)} style={{ width: 180 }}>
                <option value="">All classifications</option>
                {['SENSITIVE', 'NEEDS_DECISION', 'IDENTIFIER', 'OUTCOME', 'NON_SENSITIVE', 'UNSCANNED'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
              </select>
            </>
          }
        >
          <div className="table-wrap" style={{ border: 'none' }}>
            <table>
              <thead><tr><th>Column</th><th>Type</th><th>Classification</th><th>Why</th><th>Decision</th><th /></tr></thead>
              <tbody>
                {columns.map(({ table, col }) => (
                  <tr key={col.id}>
                    <td><span className="muted small">{table}.</span><strong>{col.name}</strong>{col.isPrimaryKey ? <> <Badge tone="soft">PK</Badge></> : null}{col.isForeignKey ? <> <Badge tone="soft">FK</Badge></> : null}</td>
                    <td className="small">{col.dataType}{col.format ? <span className="muted"> · {col.format}</span> : null}</td>
                    <td><StatusBadge status={col.classification} />{col.entityType ? <div className="small muted">{humanize(col.entityType)}{col.confidence !== null ? ` · ${pct(col.confidence, 0)}` : ''}</div> : null}</td>
                    <td className="small" style={{ maxWidth: 420 }}>{col.explanation ?? '—'}</td>
                    <td>{col.decision ? <Badge tone={col.decisionSource === 'HUMAN' ? 'solid' : 'plain'} title={col.decisionSource === 'HUMAN' ? 'Human decision' : 'Firewall suggestion'}>{humanize(col.decision)}</Badge> : '—'}<div className="small muted">{col.decisionSource === 'HUMAN' ? 'Human' : col.decision ? 'Suggested' : ''}</div></td>
                    <td>{can('firewall.decide') && col.classification !== 'UNSCANNED' ? <button className="sm" onClick={() => setEditing({ col, table })}>Change</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <div className="grid cols-2">
        <Panel title="Relationships">
          {s.relations.length === 0 ? <p className="muted">No relationships detected yet.</p> : (
            <div className="stack">
              {s.relations.map((r) => (
                <div key={r.id} className="row between">
                  <div>
                    <code>{r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}</code>
                    <div className="small muted">{r.explanation} ({pct(r.confidence, 0)})</div>
                  </div>
                  {can('firewall.decide') ? (
                    <span className="row">
                      <button className={`sm ${r.confirmed === true ? 'primary' : ''}`} onClick={() => relation.mutate({ id: r.id, confirmed: true })}>Confirm</button>
                      <button className={`sm ${r.confirmed === false ? 'primary' : ''}`} onClick={() => relation.mutate({ id: r.id, confirmed: false })}>Reject</button>
                    </span>
                  ) : <Badge>{r.confirmed ? 'Confirmed' : 'Unconfirmed'}</Badge>}
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Real-value preview" actions={<Badge tone="outline-strong">Inside Firewall boundary</Badge>}>
          {can('sources.real.preview') ? (
            <div className="stack">
              <p className="small muted">Viewing real rows is restricted and every preview is recorded in the audit log.</p>
              <div className="row wrap">{s.tables.map((t) => <button key={t.id} className="sm" onClick={() => setPreview(t.id)}>Preview {t.name}</button>)}</div>
            </div>
          ) : <p className="muted small">Your role cannot view real values. Classifications and statistics are shown instead.</p>}
        </Panel>
      </div>

      <div className="grid cols-2">
        <Panel title="Scan history">
          {s.scans.length === 0 ? <p className="muted">No scans yet.</p> : (
            <table>
              <thead><tr><th>Version</th><th>Status</th><th>Sensitive</th><th>Needed decision</th><th>Completed</th></tr></thead>
              <tbody>{s.scans.map((sc) => <tr key={sc.id}><td>v{sc.version}{sc.id === s.signedOffScanId ? <> <Badge tone="solid">Signed off</Badge></> : null}</td><td><StatusBadge status={sc.status} /></td><td>{sc.summary?.SENSITIVE ?? '—'}</td><td>{sc.summary?.NEEDS_DECISION ?? '—'}</td><td className="small muted">{dateTime(sc.completedAt)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Decision log">
          {s.decisions.length === 0 ? <p className="muted">No human decisions recorded yet.</p> : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6, maxHeight: 300, overflow: 'auto' }}>
              {s.decisions.map((d) => (
                <li key={d.id} className="small">
                  <code>{d.column.table.name}.{d.column.name}</code>: {d.previous ? `${humanize(d.previous)} → ` : ''}<strong>{humanize(d.decision)}</strong>{d.reason ? <span className="muted"> — {d.reason}</span> : null}
                  <div className="muted">{dateTime(d.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {s.sets.length ? (
        <Panel title="Synthetic sets from this source">
          <table>
            <thead><tr><th>Name</th><th>Version</th><th>Status</th><th className="num">Rows</th><th>Created</th></tr></thead>
            <tbody>{s.sets.map((x) => <tr key={x.id} className="clickable" onClick={() => nav(`/synthetic/${x.id}`)}><td><Link to={`/synthetic/${x.id}`}>{x.name}</Link></td><td>v{x.version}</td><td><StatusBadge status={x.status} /></td><td className="num">{num(x.rowCount)}</td><td className="small muted">{dateTime(x.createdAt)}</td></tr>)}</tbody>
          </table>
        </Panel>
      ) : null}

      {can('deletion.manage') ? <DeleteSource name={s.name} id={s.id} /> : null}
      {editing ? <DecisionModal col={editing.col} table={editing.table} onClose={() => setEditing(null)} invalidate={inv} /> : null}
      {preview ? <PreviewModal sourceId={s.id} tableId={preview} onClose={() => setPreview(null)} /> : null}
      {twinOpen ? <TwinModal source={s} onClose={() => setTwinOpen(false)} /> : null}
    </div>
  );
}

function UploadPanel({ onUpload, uploading, error }: { onUpload: (f: File, table: string) => void; uploading: boolean; error: Error | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState('');
  return (
    <Panel title="Add data">
      <div className="stack">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="File" hint="CSV, TSV, XLSX, JSON or JSONL. Up to 50 MB and 200,000 rows per table.">
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,.json,.jsonl,.ndjson" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Table name (optional)"><input value={table} onChange={(e) => setTable(e.target.value)} placeholder="Derived from file name" style={{ width: 220 }} /></Field>
          <button className="primary" disabled={!file || uploading} onClick={() => file && onUpload(file, table)}>{uploading ? 'Uploading…' : 'Upload'}</button>
        </div>
        <ErrorBox error={error} title="Upload failed" />
        <Help>Uploading a table with an existing name replaces it. After uploading, run a Firewall scan. Database tables can be imported from Settings → Connectors.</Help>
      </div>
    </Panel>
  );
}

function DecisionModal({ col, table, onClose, invalidate }: { col: Column; table: string; onClose: () => void; invalidate: string[] }) {
  const [decision, setDecision] = useState(col.decision ?? 'REPLACE');
  const [reason, setReason] = useState('');
  const save = useAction(() => api.patch(`/columns/${col.id}/decision`, { decision, reason: reason || undefined }), { success: 'Decision saved.', invalidate, onSuccess: onClose, silentError: true });
  const options = DECISIONS.filter((d) => !(d === 'KEEP' && col.classification === 'SENSITIVE') && !(d === 'KEY' && !col.isPrimaryKey && !col.isForeignKey));
  const overriding = col.decisionSource === 'SYSTEM' && decision !== col.decision;
  return (
    <Modal title={`${table}.${col.name}`} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={save.isPending || (overriding && !reason.trim())} onClick={() => save.mutate(undefined)}>Save decision</button></>}>
      <div className="stack">
        <div className="callout small"><strong>{humanize(col.classification)}</strong>{col.entityType ? ` · ${humanize(col.entityType)}` : ''}<div>{col.explanation}</div></div>
        <fieldset>
          <legend>Action</legend>
          <div className="stack" style={{ gap: 6 }}>
            {options.map((d) => (
              <label key={d} className="check">
                <input type="radio" name="decision" checked={decision === d} onChange={() => setDecision(d)} />
                <span><strong>{humanize(d)}</strong> <span className="small muted">{DECISION_HELP[d]}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={overriding ? 'Reason for overriding the suggestion (required)' : 'Reason (optional)'}><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}

function PreviewModal({ sourceId, tableId, onClose }: { sourceId: string; tableId: string; onClose: () => void }) {
  const q = useApi<{ boundary: string; rows: Record<string, unknown>[] }>(`/sources/${sourceId}/tables/${tableId}/preview?limit=20`);
  const cols = q.data?.rows[0] ? Object.keys(q.data.rows[0]) : [];
  return (
    <Modal title="Real-value preview" onClose={onClose} wide>
      <div className="stack">
        <div className="callout strong small">Real data. This view is recorded in the audit log. Do not copy values outside AuthenQ.</div>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{q.data!.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} className="small truncate">{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TwinModal({ source, onClose }: { source: SourceDetailRes; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState(`${source.name} — synthetic v${source.sets.length + 1}`);
  const [seed, setSeed] = useState(42);
  const [multiplier, setMultiplier] = useState(1);
  const [amp, setAmp] = useState<{ table: string; column: string; value: string; factor: number }[]>([]);
  const outcomeCols = source.tables.flatMap((t) => t.columns.filter((c) => c.decision === 'KEEP' && ['OUTCOME', 'NON_SENSITIVE'].includes(c.classification) && c.dataType === 'string').map((c) => ({ table: t.name, column: c.name })));
  const gen = useAction(() => api.post<{ id: string }>(`/sources/${source.id}/synthetic-sets`, { name, seed, multiplier, amplify: amp.filter((a) => a.value) }), {
    success: 'Synthetic generation started.',
    invalidate: ['/synthetic-sets', `/sources/${source.id}`],
    onSuccess: (r) => nav(`/synthetic/${r.id}`),
    silentError: true,
  });
  return (
    <Modal title="Generate synthetic twin" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={gen.isPending} onClick={() => gen.mutate(undefined)}>Generate</button></>}>
      <div className="stack">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid cols-2">
          <Field label="Seed" hint="Same seed and decisions produce the same twin."><input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></Field>
          <Field label="Size multiplier" hint={`About ${num(Math.round(source.rowCount * multiplier))} rows.`}><input type="number" step="0.1" min={0.1} max={10} value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))} /></Field>
        </div>
        <fieldset>
          <legend>Rare-case amplification</legend>
          <div className="stack">
            {amp.map((a, i) => (
              <div key={i} className="row">
                <select value={`${a.table}.${a.column}`} onChange={(e) => { const [t, c] = e.target.value.split('.'); setAmp(amp.map((x, j) => (j === i ? { ...x, table: t!, column: c! } : x))); }}>
                  {outcomeCols.map((o) => <option key={`${o.table}.${o.column}`} value={`${o.table}.${o.column}`}>{o.table}.{o.column}</option>)}
                </select>
                <input placeholder="Value" value={a.value} onChange={(e) => setAmp(amp.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <input type="number" min={1} max={20} value={a.factor} style={{ width: 80 }} aria-label="Factor" onChange={(e) => setAmp(amp.map((x, j) => (j === i ? { ...x, factor: Number(e.target.value) } : x)))} />
                <button className="sm ghost" onClick={() => setAmp(amp.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            {outcomeCols.length ? <button className="sm" onClick={() => setAmp([...amp, { ...outcomeCols[0]!, value: '', factor: 3 }])}>Add amplification</button> : <p className="small muted">No kept categorical columns available.</p>}
          </div>
        </fieldset>
        <ErrorBox error={gen.error} />
      </div>
    </Modal>
  );
}

function DeleteSource({ id, name }: { id: string; name: string }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const del = useAction(() => api.del(`/sources/${id}`, { confirm }), { success: 'Data source deleted.', invalidate: ['/sources', '/dashboard'], onSuccess: () => nav('/sources'), silentError: true });
  return (
    <>
      <div><button className="danger sm" onClick={() => setOpen(true)}>Delete data source</button></div>
      {open ? (
        <Modal title="Delete data source" onClose={() => setOpen(false)} footer={<><button onClick={() => setOpen(false)}>Cancel</button><button className="primary" disabled={confirm !== name || del.isPending} onClick={() => del.mutate(undefined)}>Delete permanently</button></>}>
          <div className="stack">
            <p>This deletes the real rows held in the Firewall. Synthetic sets already generated are kept. Type <strong>{name}</strong> to confirm.</p>
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirm name" />
            <ErrorBox error={del.error} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
