import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, humanize, num, pct } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Help, Loading, Modal, PageHead, Panel, Progress, StatusBadge, Tabs } from '../components/ui';

export interface LabelDef { value: string; description: string; shortcut?: string }
export interface DecisionNode { question?: string; yes?: DecisionNode; no?: DecisionNode; label?: string }
export interface ProjectConfig {
  autoAcceptThreshold: number; passes: number; dropout: number; seed: number;
  rules: { id: string; label: string; keywords: string[]; description: string }[];
  carryOver: { enabled: boolean };
  quality: { minAccuracy: number; minLockedTest: number; maxReviewRate: number; minAuditAccuracy: number };
  auditRate: number;
  shortcuts: Record<string, string>;
}
export interface Project {
  id: string; name: string; description: string; purpose: string; status: string; setId: string; tableName: string;
  textFields: string[]; contextFields: string[]; sliceField: string | null; carryOverField: string | null;
  goldVersion: number; goldLockedAt: string | null; activeGuidelineVersionId: string | null; createdAt: string;
  labels: LabelDef[]; configResolved: ProjectConfig; counts: Record<string, number>;
  guideline: { id: string; version: number; content: string; decisionTree: DecisionNode | null; changeNote: string; publishedAt: string | null } | null;
  members: { id: string; userId: string; role: string; user?: { id: string; name: string; email: string } }[];
  exampleCount: number;
  gold: { split: string; status: string; count: number }[];
  runs: { id: string; runNumber: number; status: string; engineType: string; createdAt: string }[];
  set: { id: string; name: string; version: number } | null;
}
export interface ProjectCtx { project: Project; refetch: () => void }
export const useProject = () => useOutletContext<ProjectCtx>();

interface ProjectRow { id: string; name: string; description: string; status: string; createdAt: string; labels: LabelDef[]; counts: Record<string, number>; total: number; done: number; goldLockedAt: string | null }

export function Projects() {
  const { can } = useAuth();
  const q = useApi<ProjectRow[]>('/projects');
  return (
    <div className="stack lg">
      <PageHead title="Labeling Projects" description="Labelers work only on synthetic data. Projects are created by explicitly sending a ready synthetic set to labeling." actions={can('labeling.manage') ? <Link className="btn primary" to="/projects/new">Send synthetic data to labeling</Link> : null} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <Empty title="No labeling projects" action={can('labeling.manage') ? <Link className="btn primary" to="/projects/new">Create a project</Link> : undefined}>Generate a synthetic set first, then send one of its tables to labeling.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Project</th><th>Status</th><th>Labels</th><th style={{ width: 220 }}>Progress</th><th>Gold</th><th>Created</th></tr></thead>
            <tbody>
              {q.data!.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/projects/${p.id}`}><strong>{p.name}</strong></Link><div className="small muted truncate">{p.description}</div></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="small">{p.labels.length}</td>
                  <td><Progress value={p.total ? p.done / p.total : 0} /><div className="small muted">{num(p.done)} / {num(p.total)} labeled</div></td>
                  <td>{p.goldLockedAt ? <Badge tone="soft">Locked</Badge> : <Badge tone="dashed">Open</Badge>}</td>
                  <td className="small muted">{dateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface SetLite { id: string; name: string; version: number; status: string }

export function NewProject() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const sets = useApi<SetLite[]>('/synthetic-sets');
  const [setId, setSetId] = useState(params.get('setId') ?? '');
  const detail = useApi<{ tables: { name: string; rows: number }[]; status: string; name: string }>(setId ? `/synthetic-sets/${setId}` : null);
  const [tableName, setTableName] = useState('');
  const sample = useApi<{ rows: { data: Record<string, unknown> }[] }>(setId && tableName ? `/synthetic-sets/${setId}/rows${qs({ table: tableName, limit: 5 })}` : null);
  const fields = sample.data?.rows[0] ? Object.keys(sample.data.rows[0].data) : [];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [labels, setLabels] = useState<LabelDef[]>([{ value: '', description: '' }, { value: '', description: '' }]);
  const [textFields, setTextFields] = useState<string[]>([]);
  const [contextFields, setContextFields] = useState<string[]>([]);
  const [sliceField, setSliceField] = useState('');
  const [carryOverField, setCarryOverField] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!tableName && detail.data?.tables[0]) setTableName(detail.data.tables[detail.data.tables.length - 1]!.name);
  }, [detail.data, tableName]);
  const send = useAction(
    () => api.post<{ id: string }>('/send-to-labeling', { setId, tableName, name, description, purpose, labels: labels.filter((l) => l.value.trim()), textFields, contextFields, sliceField: sliceField || null, carryOverField: carryOverField || null, confirm: true }),
    { success: 'Project created. Synthetic tasks are ready.', invalidate: ['/projects', '/canary', '/synthetic-sets', '/dashboard'], onSuccess: (r) => nav(`/projects/${r.id}`), silentError: true },
  );
  const ready = (sets.data ?? []).filter((s) => s.status === 'READY');
  const valid = setId && tableName && name.trim().length >= 2 && labels.filter((l) => l.value.trim()).length >= 2 && textFields.length > 0;
  const toggle = (list: string[], set: (v: string[]) => void, f: string) => set(list.includes(f) ? list.filter((x) => x !== f) : [...list, f]);
  const tableRows = detail.data?.tables.find((t) => t.name === tableName)?.rows ?? 0;
  return (
    <div className="stack lg">
      <PageHead crumbs={[{ to: '/projects', label: 'Labeling Projects' }, { label: 'New' }]} title="Send synthetic data to labeling" description="This is an explicit transfer. Only synthetic rows are sent; the send is recorded and every Canary value in it gets an exposure record." />
      <div className="grid cols-2">
        <Panel title="1. Synthetic data">
          <div className="stack">
            <Field label="Synthetic set">
              <select value={setId} onChange={(e) => { setSetId(e.target.value); setTableName(''); setTextFields([]); setContextFields([]); }}>
                <option value="">Choose a ready set…</option>
                {ready.map((s) => <option key={s.id} value={s.id}>{s.name} (v{s.version})</option>)}
              </select>
            </Field>
            {sets.data && !ready.length ? <p className="small muted">No synthetic sets are ready. <Link to="/synthetic">Open Synthetic Sets</Link></p> : null}
            {detail.data ? (
              <Field label="Table">
                <select value={tableName} onChange={(e) => { setTableName(e.target.value); setTextFields([]); setContextFields([]); }}>
                  {detail.data.tables.map((t) => <option key={t.name} value={t.name}>{t.name} ({num(t.rows)} rows)</option>)}
                </select>
              </Field>
            ) : null}
            {fields.length ? (
              <>
                <fieldset><legend>Text shown to labelers</legend><div className="row wrap">{fields.map((f) => <label key={f} className="check"><input type="checkbox" checked={textFields.includes(f)} onChange={() => toggle(textFields, setTextFields, f)} />{f}</label>)}</div></fieldset>
                <fieldset><legend>Context fields</legend><div className="row wrap">{fields.filter((f) => !textFields.includes(f)).map((f) => <label key={f} className="check"><input type="checkbox" checked={contextFields.includes(f)} onChange={() => toggle(contextFields, setContextFields, f)} />{f}</label>)}</div></fieldset>
                <div className="grid cols-2">
                  <Field label="Slice field" hint="Used for per-slice quality."><select value={sliceField} onChange={(e) => setSliceField(e.target.value)}><option value="">None</option>{fields.map((f) => <option key={f}>{f}</option>)}</select></Field>
                  <Field label="Carry-over field" hint="An existing outcome column. Only used if you enable carry-over later."><select value={carryOverField} onChange={(e) => setCarryOverField(e.target.value)}><option value="">None</option>{fields.map((f) => <option key={f}>{f}</option>)}</select></Field>
                </div>
              </>
            ) : null}
          </div>
        </Panel>
        <Panel title="2. Project and labels">
          <div className="stack">
            <Field label="Project name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Description"><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="Purpose" hint="What the resulting model will be used for. Appears in the data card."><textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
            <fieldset>
              <legend>Labels</legend>
              <div className="stack" style={{ gap: 6 }}>
                {labels.map((l, i) => (
                  <div key={i} className="row">
                    <input aria-label={`Label ${i + 1}`} placeholder="Label" value={l.value} onChange={(e) => setLabels(labels.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} style={{ width: 180 }} />
                    <input aria-label={`Label ${i + 1} description`} placeholder="When to use it" value={l.description} onChange={(e) => setLabels(labels.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <button className="ghost sm" disabled={labels.length <= 2} onClick={() => setLabels(labels.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                ))}
                <div><button className="sm" onClick={() => setLabels([...labels, { value: '', description: '' }])}>Add label</button></div>
              </div>
            </fieldset>
          </div>
        </Panel>
      </div>
      <ErrorBox error={send.error} />
      <div className="row"><span className="right" /><Link className="btn" to="/projects">Cancel</Link><button className="primary" disabled={!valid} onClick={() => setConfirming(true)}>Review and send</button></div>
      {confirming ? (
        <Modal title="Confirm send to labeling" onClose={() => setConfirming(false)} footer={<><button onClick={() => setConfirming(false)}>Back</button><button className="primary" disabled={send.isPending} onClick={() => send.mutate(undefined)}>{send.isPending ? 'Sending…' : 'Send to labeling'}</button></>}>
          <div className="stack">
            <p>You are sending <strong>{num(tableRows)} synthetic rows</strong> from <strong>{detail.data?.name}</strong> / <code>{tableName}</code> to a new project <strong>{name}</strong>.</p>
            <ul className="small">
              <li>Only synthetic values are sent. Real source data never reaches labelers.</li>
              <li>A send record and Canary exposure records are created for traceability.</li>
              <li>Labelers see: {textFields.join(', ')}{contextFields.length ? `; context: ${contextFields.join(', ')}` : ''}.</li>
            </ul>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

export function ProjectLayout() {
  const { projectId } = useParams();
  const { can } = useAuth();
  const q = useApi<Project>(`/projects/${projectId}`);
  if (q.isLoading) return <Loading rows={6} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const p = q.data!;
  const base = `/projects/${p.id}`;
  const tabs = [
    { to: base, label: 'Overview', end: true },
    { to: `${base}/guidelines`, label: 'Guidelines' },
    ...(can('labeling.label') ? [{ to: `${base}/workspace`, label: 'Workspace' }] : []),
    { to: `${base}/gold`, label: 'Gold Set' },
    { to: `${base}/engine`, label: 'Engine' },
    ...(can('labeling.review') ? [{ to: `${base}/review`, label: 'Review' }] : []),
    ...(can('quality.read') ? [{ to: `${base}/quality`, label: 'Quality' }] : []),
    ...(can('exports.read') ? [{ to: `${base}/exports`, label: 'Export' }] : []),
  ];
  return (
    <div>
      <PageHead
        crumbs={[{ to: '/projects', label: 'Labeling Projects' }, { label: p.name }]}
        title={<span className="row">{p.name} <StatusBadge status={p.status} /></span>}
        description={<>{p.description || 'Synthetic labeling project.'} {p.set ? <span className="muted">Data: <Link to={`/synthetic/${p.set.id}`}>{p.set.name} v{p.set.version}</Link> / <code>{p.tableName}</code></span> : null}</>}
      />
      <Tabs tabs={tabs} />
      <Outlet context={{ project: p, refetch: () => q.refetch() } satisfies ProjectCtx} />
    </div>
  );
}

export function ProjectOverview() {
  const { project: p } = useProject();
  const { can } = useAuth();
  const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
  const done = (p.counts.DONE ?? 0) + (p.counts.LABELED ?? 0);
  const goldBy = (split: string) => p.gold.filter((g) => g.split === split).reduce((a, g) => a + g.count, 0);
  const [settings, setSettings] = useState(false);
  return (
    <div className="stack lg">
      <div className="grid cols-4">
        <div className="stat"><div className="k">Tasks</div><div className="v">{num(total)}</div><div className="s">{num(done)} labeled ({pct(total ? done / total : 0, 0)})</div></div>
        <div className="stat"><div className="k">In review</div><div className="v">{num(p.counts.IN_REVIEW ?? 0)}</div></div>
        <div className="stat"><div className="k">Gold records</div><div className="v">{num(goldBy('LOCKED_TEST') + goldBy('TUNING') + goldBy('EXAMPLE'))}</div><div className="s">{goldBy('LOCKED_TEST')} locked test · {goldBy('TUNING')} tuning</div></div>
        <div className="stat"><div className="k">Examples</div><div className="v">{p.exampleCount}</div><div className="s">Guideline v{p.guideline?.version ?? '—'}</div></div>
      </div>
      <div className="grid cols-2">
        <Panel title="Labels">
          <table>
            <thead><tr><th>Key</th><th>Label</th><th>Description</th></tr></thead>
            <tbody>{p.labels.map((l) => <tr key={l.value}><td><kbd>{l.shortcut}</kbd></td><td><strong>{l.value}</strong></td><td className="small">{l.description}</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="Task status">
          <div className="stack">
            {Object.entries(p.counts).map(([s, n]) => (
              <div key={s} className="hbar"><span>{humanize(s)}</span><div className="bar"><span style={{ width: `${total ? (n / total) * 100 : 0}%` }} /></div><span className="num">{num(n)}</span></div>
            ))}
          </div>
        </Panel>
      </div>
      <div className="grid cols-2">
        <Panel title="Members">
          <table>
            <tbody>{p.members.map((m) => <tr key={m.id}><td>{m.user?.name ?? m.userId}<div className="small muted">{m.user?.email}</div></td><td><Badge>{humanize(m.role)}</Badge></td></tr>)}</tbody>
          </table>
          {can('labeling.manage') ? <AddMember projectId={p.id} existing={p.members.map((m) => m.userId)} /> : null}
        </Panel>
        <Panel title="Engine configuration" actions={can('labeling.manage') ? <button className="sm" onClick={() => setSettings(true)}>Edit</button> : null}>
          <dl className="dl">
            <dt>Auto-accept threshold</dt><dd>{p.configResolved.autoAcceptThreshold}</dd>
            <dt>Self-consistency passes</dt><dd>{p.configResolved.passes} (dropout {p.configResolved.dropout})</dd>
            <dt>Deterministic rules</dt><dd>{p.configResolved.rules.length}</dd>
            <dt>Carried-over outcomes</dt><dd>{p.carryOverField ? (p.configResolved.carryOver.enabled ? `Enabled (${p.carryOverField})` : `Disabled (${p.carryOverField} available)`) : 'No field selected'}</dd>
            <dt>Audit rate</dt><dd>{pct(p.configResolved.auditRate, 0)} of auto-accepted items</dd>
            <dt>Quality gate</dt><dd className="small">Accuracy ≥ {pct(p.configResolved.quality.minAccuracy, 0)}, locked test ≥ {p.configResolved.quality.minLockedTest}, review rate ≤ {pct(p.configResolved.quality.maxReviewRate, 0)}, audit accuracy ≥ {pct(p.configResolved.quality.minAuditAccuracy, 0)}</dd>
          </dl>
        </Panel>
      </div>
      {p.purpose ? <Panel title="Purpose"><p>{p.purpose}</p></Panel> : null}
      {settings ? <ConfigModal project={p} onClose={() => setSettings(false)} /> : null}
    </div>
  );
}

function AddMember({ projectId, existing }: { projectId: string; existing: string[] }) {
  const members = useApi<{ id: string; user: { id: string; name: string } }[]>('/members');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('LABELER');
  const add = useAction(() => api.post(`/projects/${projectId}/members`, { userId, role }), { success: 'Member added.', invalidate: [`/projects/${projectId}`] });
  const options = (members.data ?? []).filter((m) => !existing.includes(m.user.id));
  if (!options.length) return null;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <select aria-label="User" value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Add a member…</option>{options.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}</select>
      <select aria-label="Project role" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 170 }}><option value="LABELER">Labeler</option><option value="REVIEWER">Reviewer</option><option value="PROJECT_MANAGER">Project manager</option></select>
      <button className="sm" disabled={!userId} onClick={() => add.mutate(undefined)}>Add</button>
    </div>
  );
}

function ConfigModal({ project: p, onClose }: { project: Project; onClose: () => void }) {
  const { refetch } = useProject();
  const [c, setC] = useState<ProjectConfig>(p.configResolved);
  const [rulesText, setRulesText] = useState(p.configResolved.rules.map((r) => `${r.label}: ${r.keywords.join(', ')}`).join('\n'));
  const save = useAction(
    () => {
      const rules = rulesText.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => {
        const [label, kw] = l.split(':');
        return { id: `rule-${i + 1}`, label: (label ?? '').trim(), keywords: (kw ?? '').split(',').map((k) => k.trim()).filter(Boolean), description: `Keyword rule for ${(label ?? '').trim()}` };
      });
      return api.patch(`/projects/${p.id}`, { config: { ...c, rules } });
    },
    { success: 'Configuration saved.', invalidate: [`/projects/${p.id}`], onSuccess: () => { refetch(); onClose(); }, silentError: true },
  );
  const set = (patch: Partial<ProjectConfig>) => setC({ ...c, ...patch });
  return (
    <Modal title="Engine and quality configuration" onClose={onClose} wide footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="stack">
        <div className="grid cols-3">
          <Field label="Auto-accept threshold"><input type="number" step="0.01" min={0.5} max={1} value={c.autoAcceptThreshold} onChange={(e) => set({ autoAcceptThreshold: Number(e.target.value) })} /></Field>
          <Field label="Passes"><input type="number" min={1} max={7} value={c.passes} onChange={(e) => set({ passes: Number(e.target.value) })} /></Field>
          <Field label="Token dropout"><input type="number" step="0.01" min={0} max={0.5} value={c.dropout} onChange={(e) => set({ dropout: Number(e.target.value) })} /></Field>
          <Field label="Seed"><input type="number" value={c.seed} onChange={(e) => set({ seed: Number(e.target.value) })} /></Field>
          <Field label="Audit rate"><input type="number" step="0.01" min={0} max={1} value={c.auditRate} onChange={(e) => set({ auditRate: Number(e.target.value) })} /></Field>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" disabled={!p.carryOverField} checked={c.carryOver.enabled} onChange={(e) => set({ carryOver: { enabled: e.target.checked } })} /> Use carried-over outcomes{p.carryOverField ? ` (${p.carryOverField})` : ''}</label>
        </div>
        <fieldset>
          <legend>Quality gate</legend>
          <div className="grid cols-4">
            <Field label="Min. accuracy"><input type="number" step="0.01" value={c.quality.minAccuracy} onChange={(e) => set({ quality: { ...c.quality, minAccuracy: Number(e.target.value) } })} /></Field>
            <Field label="Min. locked test"><input type="number" value={c.quality.minLockedTest} onChange={(e) => set({ quality: { ...c.quality, minLockedTest: Number(e.target.value) } })} /></Field>
            <Field label="Max. review rate"><input type="number" step="0.01" value={c.quality.maxReviewRate} onChange={(e) => set({ quality: { ...c.quality, maxReviewRate: Number(e.target.value) } })} /></Field>
            <Field label="Min. audit accuracy"><input type="number" step="0.01" value={c.quality.minAuditAccuracy} onChange={(e) => set({ quality: { ...c.quality, minAuditAccuracy: Number(e.target.value) } })} /></Field>
          </div>
        </fieldset>
        <Field label="Deterministic rules" hint="One rule per line: Label: keyword, keyword phrase, …"><textarea rows={6} className="mono" value={rulesText} onChange={(e) => setRulesText(e.target.value)} /></Field>
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}

interface GuidelineVersion { id: string; version: number; content: string; changeNote: string; decisionTree: DecisionNode | null; publishedAt: string | null; createdAt: string }
interface Example { id: string; text: string; label: string; explanation: string | null; createdAt: string }

export function DecisionTree({ node, depth = 0 }: { node: DecisionNode | null | undefined; depth?: number }) {
  if (!node) return null;
  if (node.label) return <div><Badge tone="solid">{node.label}</Badge></div>;
  return (
    <div className={depth ? 'tree' : ''}>
      <div style={{ fontWeight: 500 }}>{node.question}</div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 4 }}><span className="small muted" style={{ width: 28 }}>Yes</span><DecisionTree node={node.yes} depth={depth + 1} /></div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 4 }}><span className="small muted" style={{ width: 28 }}>No</span><DecisionTree node={node.no} depth={depth + 1} /></div>
    </div>
  );
}

export function ProjectGuidelines() {
  const { project: p, refetch } = useProject();
  const { can } = useAuth();
  const versions = useApi<GuidelineVersion[]>(`/projects/${p.id}/guidelines`);
  const examples = useApi<Example[]>(`/projects/${p.id}/examples`);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [ex, setEx] = useState({ text: '', label: p.labels[0]?.value ?? '', explanation: '' });
  const inv = [`/projects/${p.id}`];
  const saveVersion = useAction((publish: boolean) => api.post(`/projects/${p.id}/guidelines`, { content, changeNote, publish, decisionTree: p.guideline?.decisionTree ?? undefined }), { success: 'Guideline version saved.', invalidate: inv, onSuccess: () => { setEditing(false); refetch(); } });
  const publish = useAction((id: string) => api.post(`/projects/${p.id}/guidelines/${id}/publish`), { success: 'Version published.', invalidate: inv, onSuccess: () => refetch() });
  const addEx = useAction(() => api.post(`/projects/${p.id}/examples`, ex), { success: 'Example added.', invalidate: inv, onSuccess: () => setEx({ ...ex, text: '', explanation: '' }) });
  const delEx = useAction((id: string) => api.del(`/projects/${p.id}/examples/${id}`), { invalidate: inv });
  return (
    <div className="stack lg">
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <Panel title={`Guideline v${p.guideline?.version ?? '—'}`} actions={can('labeling.manage') && !editing ? <button className="sm" onClick={() => { setContent(p.guideline?.content ?? ''); setChangeNote(''); setEditing(true); }}>New version</button> : null}>
          {editing ? (
            <div className="stack">
              <textarea rows={18} className="mono" value={content} onChange={(e) => setContent(e.target.value)} aria-label="Guideline content" />
              <Field label="Change note"><input value={changeNote} onChange={(e) => setChangeNote(e.target.value)} placeholder="What changed and why" /></Field>
              <div className="row"><button onClick={() => setEditing(false)}>Cancel</button><button disabled={changeNote.trim().length < 3} onClick={() => saveVersion.mutate(false)}>Save draft</button><button className="primary" disabled={changeNote.trim().length < 3} onClick={() => saveVersion.mutate(true)}>Save and publish</button></div>
              <p className="small muted">Publishing marks tasks labeled under older versions as affected, so they can be re-run with the &ldquo;guideline affected&rdquo; engine scope.</p>
            </div>
          ) : <div className="pre">{p.guideline?.content ?? 'No guideline yet.'}</div>}
        </Panel>
        <div className="stack lg">
          <Panel title="Decision tree"><DecisionTree node={p.guideline?.decisionTree} />{!p.guideline?.decisionTree ? <p className="muted">No decision tree.</p> : null}</Panel>
          <Panel title="Version history">
            {versions.isLoading ? <Loading /> : (
              <table>
                <tbody>{(versions.data ?? []).map((v) => <tr key={v.id}><td>v{v.version}</td><td className="small">{v.changeNote}</td><td>{v.id === p.activeGuidelineVersionId ? <Badge tone="solid">Active</Badge> : v.publishedAt ? <Badge>Published</Badge> : <Badge tone="dashed">Draft</Badge>}</td><td>{can('labeling.manage') && v.id !== p.activeGuidelineVersionId ? <button className="sm" onClick={() => publish.mutate(v.id)}>Publish</button> : null}</td></tr>)}</tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
      <Panel title={`Example bank (${examples.data?.length ?? 0})`}>
        <div className="stack">
          {can('labeling.review') ? (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Example text (synthetic)"><textarea rows={2} value={ex.text} onChange={(e) => setEx({ ...ex, text: e.target.value })} /></Field>
              <Field label="Label"><select value={ex.label} onChange={(e) => setEx({ ...ex, label: e.target.value })} style={{ width: 170 }}>{p.labels.map((l) => <option key={l.value}>{l.value}</option>)}</select></Field>
              <Field label="Why"><input value={ex.explanation} onChange={(e) => setEx({ ...ex, explanation: e.target.value })} /></Field>
              <button disabled={!ex.text.trim()} onClick={() => addEx.mutate(undefined)}>Add</button>
            </div>
          ) : null}
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead><tr><th>Text</th><th>Label</th><th>Explanation</th><th /></tr></thead>
              <tbody>{(examples.data ?? []).map((e) => <tr key={e.id}><td className="small" style={{ maxWidth: 560 }}>{e.text}</td><td><Badge>{e.label}</Badge></td><td className="small muted">{e.explanation}</td><td>{can('labeling.manage') ? <button className="sm ghost" onClick={() => delEx.mutate(e.id)}>Remove</button> : null}</td></tr>)}</tbody>
            </table>
          </div>
          <Help>Examples teach the engine and appear as reference cases in the workspace. They never include locked-test gold records.</Help>
        </div>
      </Panel>
    </div>
  );
}
