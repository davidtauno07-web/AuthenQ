import { useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { dateTime, humanize, num } from '../lib/format';
import { Badge, Empty, ErrorBox, Field, Help, Loading, Modal, PageHead, Panel, StatusBadge } from '../components/ui';

const SECTIONS: { to: string; label: string; perm?: string }[] = [
  { to: 'account', label: 'Account & security' },
  { to: 'organization', label: 'Organization' },
  { to: 'members', label: 'Members & roles' },
  { to: 'connectors', label: 'Connectors', perm: 'sources.read' },
  { to: 'api-keys', label: 'API keys', perm: 'apikeys.manage' },
  { to: 'webhooks', label: 'Webhooks', perm: 'webhooks.manage' },
  { to: 'ai', label: 'AI providers', perm: 'ai.manage' },
  { to: 'features', label: 'Feature flags & policies' },
  { to: 'usage', label: 'Usage' },
  { to: 'security', label: 'Security events', perm: 'security.read' },
];

export function Settings() {
  const { can } = useAuth();
  const sections = SECTIONS.filter((s) => !s.perm || can(s.perm));
  return (
    <div className="stack lg">
      <PageHead title="Settings" />
      <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 24 }} className="settings-grid">
        <nav aria-label="Settings sections" className="stack" style={{ gap: 2 }}>
          {sections.map((s) => <NavLink key={s.to} to={`/settings/${s.to}`} className={({ isActive }) => `subnav ${isActive ? 'active' : ''}`}>{s.label}</NavLink>)}
        </nav>
        <div>
          <Routes>
            <Route index element={<Navigate to="account" replace />} />
            <Route path="account" element={<Account />} />
            <Route path="organization" element={<Organization />} />
            <Route path="members" element={<Members />} />
            <Route path="connectors" element={<Connectors />} />
            <Route path="api-keys" element={<ApiKeys />} />
            <Route path="webhooks" element={<Webhooks />} />
            <Route path="ai" element={<AiProviders />} />
            <Route path="features" element={<Features />} />
            <Route path="usage" element={<Usage />} />
            <Route path="security" element={<SecurityEvents />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function SecretOnce({ title, value, note, onClose }: { title: string; value: string; note: string; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal title={title} onClose={onClose} footer={<button className="primary" onClick={onClose}>I have stored it</button>}>
      <div className="stack">
        <div className="callout strong small">{note}</div>
        <code className="pre" style={{ wordBreak: 'break-all' }}>{value}</code>
        <div><button className="sm" onClick={() => navigator.clipboard.writeText(value).then(() => toast.show('Copied.'))}>Copy</button></div>
      </div>
    </Modal>
  );
}

function Account() {
  const { me, refresh } = useAuth();
  const sessions = useApi<{ id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean }[]>('/auth/sessions');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const changePw = useAction(() => api.post('/auth/change-password', pw), { success: 'Password changed. Other sessions were signed out.', onSuccess: () => setPw({ currentPassword: '', newPassword: '' }) });
  const revoke = useAction((id: string) => api.del(`/auth/sessions/${id}`), { success: 'Session revoked.', invalidate: ['/auth/sessions'] });
  const start = useAction(() => api.post<{ secret: string; uri: string }>('/auth/mfa/enroll'), { onSuccess: setEnroll });
  const verify = useAction(() => api.post('/auth/mfa/verify', { code }), { success: 'Two-factor authentication enabled.', onSuccess: () => { setEnroll(null); setCode(''); refresh(); } });
  const [disableCode, setDisableCode] = useState('');
  const disable = useAction(() => api.del('/auth/mfa', { password: disableCode }), { success: 'Two-factor authentication removed.', onSuccess: () => { setDisableCode(''); refresh(); } });
  return (
    <div className="stack lg">
      <Panel title="Profile">
        <dl className="dl"><dt>Name</dt><dd>{me?.user.name}</dd><dt>Email</dt><dd>{me?.user.email} {me?.user.emailVerified ? <Badge tone="soft">Verified</Badge> : <Badge tone="dashed">Not verified</Badge>}</dd><dt>Role</dt><dd>{me?.role.name}</dd></dl>
      </Panel>
      <Panel title="Password">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Current password"><input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 12 characters."><input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <button disabled={!pw.currentPassword || pw.newPassword.length < 12} onClick={() => changePw.mutate(undefined)}>Change password</button>
        </div>
      </Panel>
      <Panel title="Two-factor authentication">
        {me?.user.mfaEnabled ? (
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Badge tone="solid">Enabled</Badge>
            <Field label="Password to disable"><input type="password" autoComplete="current-password" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} style={{ width: 200 }} /></Field>
            <button disabled={!disableCode} onClick={() => disable.mutate(undefined)}>Disable</button>
          </div>
        ) : enroll ? (
          <div className="stack">
            <p>Add this key to your authenticator app (TOTP, 6 digits, 30 seconds), then enter the current code.</p>
            <code className="pre" style={{ wordBreak: 'break-all' }}>{enroll.secret}</code>
            <p className="small muted" style={{ wordBreak: 'break-all' }}>{enroll.uri}</p>
            <div className="row"><input inputMode="numeric" aria-label="Code" value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 140 }} /><button className="primary" disabled={code.length < 6} onClick={() => verify.mutate(undefined)}>Verify and enable</button></div>
          </div>
        ) : <button onClick={() => start.mutate(undefined)}>Set up authenticator app</button>}
      </Panel>
      <Panel title="Active sessions">
        {sessions.isLoading ? <Loading /> : (
          <table>
            <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last seen</th><th /></tr></thead>
            <tbody>{(sessions.data ?? []).map((s) => <tr key={s.id}><td className="small truncate">{s.userAgent ?? 'Unknown'} {s.current ? <Badge tone="solid">This session</Badge> : null}</td><td className="small">{s.ip ?? '—'}</td><td className="small muted">{dateTime(s.createdAt)}</td><td className="small muted">{dateTime(s.lastSeenAt)}</td><td>{!s.current ? <button className="sm" onClick={() => revoke.mutate(s.id)}>Revoke</button> : null}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Organization() {
  const { can, refresh } = useAuth();
  const q = useApi<{ id: string; name: string; slug: string; createdAt: string; billing: { plan: string; status: string } | null }>('/org');
  const [name, setName] = useState('');
  const save = useAction(() => api.patch('/org', { name }), { success: 'Organization renamed.', invalidate: ['/org'], onSuccess: () => refresh() });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <Panel title="Organization">
      <div className="stack">
        <dl className="dl"><dt>Name</dt><dd>{q.data!.name}</dd><dt>Slug</dt><dd className="mono">{q.data!.slug}</dd><dt>Created</dt><dd>{dateTime(q.data!.createdAt)}</dd><dt>Plan</dt><dd>{q.data!.billing ? `${humanize(q.data!.billing.plan)} (${humanize(q.data!.billing.status)})` : '—'}</dd></dl>
        {can('org.manage') ? <div className="row"><input aria-label="New name" placeholder="New name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} /><button disabled={name.trim().length < 2} onClick={() => save.mutate(undefined)}>Rename</button></div> : null}
      </div>
    </Panel>
  );
}

interface Member { id: string; status: string; role: { key: string; name: string }; user: { id: string; name: string; email?: string }; createdAt: string }
interface RolesRes { roles: { key: string; name: string; description: string; permissions: string[] }[]; permissions: Record<string, string> }

function Members() {
  const { can, me } = useAuth();
  const q = useApi<Member[]>('/members');
  const roles = useApi<RolesRes>('/roles');
  const [invite, setInvite] = useState({ email: '', role: 'LABELER', name: '' });
  const inv = useAction(() => api.post('/members/invite', invite), { success: 'Invitation sent.', invalidate: ['/members'], onSuccess: () => setInvite({ email: '', role: 'LABELER', name: '' }) });
  const update = useAction((v: { id: string; role?: string; status?: string }) => api.patch(`/members/${v.id}`, { role: v.role, status: v.status }), { success: 'Member updated.', invalidate: ['/members'] });
  const remove = useAction((id: string) => api.del(`/members/${id}`), { success: 'Member removed.', invalidate: ['/members'] });
  const manage = can('members.manage');
  return (
    <div className="stack lg">
      {manage ? (
        <Panel title="Invite a member">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Email"><input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Name (optional)"><input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} /></Field>
            <Field label="Role"><select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} style={{ width: 180 }}>{roles.data?.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
            <button className="primary" disabled={!invite.email.includes('@')} onClick={() => inv.mutate(undefined)}>Send invitation</button>
          </div>
        </Panel>
      ) : null}
      <Panel title="Members" flat>
        {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : (
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th><th /></tr></thead>
            <tbody>
              {q.data!.map((m) => (
                <tr key={m.id}>
                  <td>{m.user.name}<div className="small muted">{m.user.email}</div></td>
                  <td>{manage && m.user.id !== me?.user.id ? <select aria-label={`Role of ${m.user.name}`} value={m.role.key} onChange={(e) => update.mutate({ id: m.id, role: e.target.value })} style={{ width: 170 }}>{roles.data?.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select> : m.role.name}</td>
                  <td><StatusBadge status={m.status} /></td>
                  <td className="small muted">{dateTime(m.createdAt)}</td>
                  <td>{manage && m.user.id !== me?.user.id ? <div className="row">{m.status === 'ACTIVE' ? <button className="sm" onClick={() => update.mutate({ id: m.id, status: 'SUSPENDED' })}>Suspend</button> : m.status === 'SUSPENDED' ? <button className="sm" onClick={() => update.mutate({ id: m.id, status: 'ACTIVE' })}>Reactivate</button> : null}<button className="sm ghost" onClick={() => remove.mutate(m.id)}>Remove</button></div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {roles.data ? (
        <Panel title="Roles and permissions">
          <div className="table-wrap" style={{ maxHeight: 480 }}>
            <table>
              <thead><tr><th>Permission</th>{roles.data.roles.map((r) => <th key={r.key} className="num">{r.name}</th>)}</tr></thead>
              <tbody>{Object.entries(roles.data.permissions).map(([k, d]) => <tr key={k}><td><code>{k}</code><div className="small muted">{d}</div></td>{roles.data!.roles.map((r) => <td key={r.key} className="num">{r.permissions.includes(k) ? '●' : <span className="muted">·</span>}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

interface FieldSpec { key: string; label: string; type: 'text' | 'password' | 'number' | 'boolean' | 'textarea'; secret?: boolean; required?: boolean; placeholder?: string; help?: string }
interface ConnectorType { type: string; name: string; category: 'DATABASE' | 'WAREHOUSE' | 'OBJECT_STORAGE'; description: string; verification: 'VERIFIED' | 'UNVERIFIED'; verifiedWith: string | null; prerequisites: string; supportsIncremental: boolean; fields: FieldSpec[]; flag: string | null; available: boolean }
interface RemoteObject { name: string; kind: string; rowEstimate: number | null; sizeBytes?: number | null }
interface ConnectorRes { types: ConnectorType[]; connectors: { id: string; type: string; name: string; status: string; lastHealthAt: string | null; lastError: string | null; hasCredentials: boolean; verification: string; createdAt: string }[] }
interface PreviewRes { rows: Record<string, unknown>[]; columns: { name: string; type: string }[]; hasMore: boolean; offset: number }

const CATEGORY: Record<ConnectorType['category'], string> = { DATABASE: 'Databases', WAREHOUSE: 'Data warehouses', OBJECT_STORAGE: 'Object storage and files' };

function VerificationBadge({ t }: { t: Pick<ConnectorType, 'verification' | 'verifiedWith'> }) {
  return t.verification === 'VERIFIED' ? <Badge tone="soft">Verified{t.verifiedWith ? ` · ${t.verifiedWith}` : ''}</Badge> : <Badge tone="dashed">Not verified · requires configuration</Badge>;
}

function Connectors() {
  const { can } = useAuth();
  const q = useApi<ConnectorRes>('/connectors');
  const sources = useApi<{ id: string; name: string }[]>('/sources');
  const [type, setType] = useState('POSTGRES');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [objects, setObjects] = useState<{ id: string; list: RemoteObject[] } | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [schema, setSchema] = useState<{ object: string; columns: { name: string; type: string }[] } | null>(null);
  const [preview, setPreview] = useState<{ object: string; page: PreviewRes } | null>(null);
  const create = useAction(() => api.post('/connectors', { type, name, config: values }), { success: 'Connector saved. Credentials are encrypted at rest.', invalidate: ['/connectors'], onSuccess: () => { setName(''); setValues({}); } });
  const test = useAction((id: string) => api.post<{ ok: boolean; error?: string; objects: RemoteObject[] }>(`/connectors/${id}/test`), { invalidate: ['/connectors'], onSuccess: (r, id) => { if (r.ok) { setObjects({ id, list: r.objects }); setPick([]); } } });
  const describe = useAction((object: string) => api.post<{ columns: { name: string; type: string }[] }>(`/connectors/${objects!.id}/describe`, { object }), { onSuccess: (r, object) => setSchema({ object, columns: r.columns }) });
  const peek = useAction(({ object, offset }: { object: string; offset: number }) => api.post<PreviewRes>(`/connectors/${objects!.id}/preview`, { object, offset, limit: 25 }), { onSuccess: (page, v) => setPreview({ object: v.object, page }) });
  const imp = useAction(() => api.post(`/connectors/${objects!.id}/import`, { sourceId, tables: pick }), { success: 'Import started. The source page shows progress.', onSuccess: () => setObjects(null) });
  const del = useAction((id: string) => api.del(`/connectors/${id}`), { success: 'Connector removed and its credentials deleted.', invalidate: ['/connectors'] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const types = q.data!.types;
  const avail = types.filter((t) => t.available);
  const current = types.find((t) => t.type === type) ?? avail[0];
  const missing = current ? current.fields.some((f) => f.required && !values[f.key]) : true;
  const lastResult = test.data && !test.data.ok ? test.data.error : null;
  return (
    <div className="stack lg">
      <Panel title="Connector catalog">
        <p className="small muted">Verified connectors pass integration tests against a real server or the vendor's official emulator. Unverified connectors are built on the vendor's official API but have not been run against a live account; they stay disabled until an administrator enables the <code>connectors.unverified</code> feature flag.</p>
        {(Object.keys(CATEGORY) as ConnectorType['category'][]).map((cat) => (
          <div key={cat} className="stack sm" style={{ marginTop: 16 }}>
            <h4>{CATEGORY[cat]}</h4>
            <table>
              <tbody>{types.filter((t) => t.category === cat).map((t) => <tr key={t.type}><td style={{ width: '32%' }}><strong>{t.name}</strong><div className="small muted">{t.description}</div></td><td className="small muted">{t.prerequisites}</td><td style={{ textAlign: 'right' }}><VerificationBadge t={t} />{!t.available ? <div className="small muted">Disabled</div> : null}</td></tr>)}</tbody>
            </table>
          </div>
        ))}
        <p className="small muted" style={{ marginTop: 12 }}>CSV, TSV, JSON, JSONL, XLSX and SQLite files can also be uploaded directly on a data source.</p>
      </Panel>
      {can('connectors.manage') && current ? (
        <Panel title="Add a connector">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!missing && name.length >= 2) create.mutate(undefined); }}>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="Type"><select value={current.type} onChange={(e) => { setType(e.target.value); setValues({}); }} style={{ width: 240 }}>{avail.map((t) => <option key={t.type} value={t.type}>{t.name}{t.verification === 'UNVERIFIED' ? ' (not verified)' : ''}</option>)}</select></Field>
              <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM replica" /></Field>
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              {current.fields.map((f) => f.type === 'boolean' ? (
                <label key={f.key} className="check"><input type="checkbox" checked={values[f.key] === true} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />{f.label}</label>
              ) : (
                <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.help}>
                  {f.type === 'textarea'
                    ? <textarea rows={4} autoComplete="off" spellCheck={false} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} style={{ width: 340 }} />
                    : <input type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete="off" placeholder={f.placeholder} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} style={{ width: f.secret ? 340 : 220 }} />}
                </Field>
              ))}
            </div>
            <p className="small muted">Use a read-only account. Secret fields are encrypted at rest and never shown again. {current.verification === 'UNVERIFIED' ? 'This connector has not been verified against a live service.' : ''}</p>
            <div><button className="primary" type="submit" disabled={name.length < 2 || missing || create.isPending}>Save connector</button></div>
            <ErrorBox error={create.error} />
          </form>
        </Panel>
      ) : null}
      <Panel title="Connectors" flat>
        {!q.data!.connectors.length ? <p className="muted" style={{ padding: 12 }}>No connectors configured.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Last checked</th><th /></tr></thead>
            <tbody>{q.data!.connectors.map((c) => <tr key={c.id}><td>{c.name}{c.lastError ? <div className="small muted">{c.lastError}</div> : null}</td><td>{types.find((t) => t.type === c.type)?.name ?? c.type}{c.verification !== 'VERIFIED' ? <div><Badge tone="dashed">Not verified</Badge></div> : null}</td><td><StatusBadge status={c.status} /></td><td className="small muted">{dateTime(c.lastHealthAt)}</td><td>{can('connectors.manage') ? <div className="row"><button className="sm" disabled={test.isPending} onClick={() => test.mutate(c.id)}>{test.isPending && test.variables === c.id ? 'Testing…' : 'Test & browse'}</button><button className="sm ghost" onClick={() => { if (confirm(`Remove "${c.name}" and delete its stored credentials?`)) del.mutate(c.id); }}>Remove</button></div> : null}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
      <ErrorBox error={test.error} title="Connection test failed" />
      {lastResult ? <div className="error-box" role="alert"><strong>Connection test failed</strong><p>{lastResult}</p></div> : null}
      {objects ? (
        <Modal title="Browse and import" onClose={() => { setObjects(null); setSchema(null); setPreview(null); }} footer={<><button onClick={() => setObjects(null)}>Cancel</button><button className="primary" disabled={!sourceId || !pick.length || imp.isPending} onClick={() => imp.mutate(undefined)}>Import {pick.length || ''}</button></>}>
          <div className="stack">
            <Field label="Into data source"><select value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value="">Choose…</option>{sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <fieldset><legend>Objects ({objects.list.length})</legend>
              {!objects.list.length ? <p className="small muted">The connection works but no importable tables or supported files were found.</p> : null}
              <div className="stack" style={{ gap: 4, maxHeight: 260, overflow: 'auto' }}>{objects.list.map((o) => (
                <div key={o.name} className="row" style={{ justifyContent: 'space-between' }}>
                  <label className="check"><input type="checkbox" checked={pick.includes(o.name)} disabled={!pick.includes(o.name) && pick.length >= 50} onChange={() => setPick(pick.includes(o.name) ? pick.filter((x) => x !== o.name) : [...pick, o.name])} /><code>{o.name}</code><span className="small muted">{o.rowEstimate !== null ? ` ~${num(o.rowEstimate)} rows` : o.sizeBytes ? ` ${num(Math.ceil(o.sizeBytes / 1024))} KB` : ''}</span></label>
                  <div className="row"><button className="sm ghost" onClick={() => describe.mutate(o.name)}>Schema</button>{can('sources.real.preview') ? <button className="sm ghost" onClick={() => peek.mutate({ object: o.name, offset: 0 })}>Preview</button> : null}</div>
                </div>
              ))}</div>
            </fieldset>
            <ErrorBox error={describe.error ?? peek.error ?? imp.error} />
            {schema ? <div><h4>Schema of <code>{schema.object}</code></h4><table><tbody>{schema.columns.map((c) => <tr key={c.name}><td><code>{c.name}</code></td><td className="small muted">{c.type}</td></tr>)}</tbody></table></div> : null}
            {preview ? (
              <div className="stack sm">
                <h4>Source preview of <code>{preview.object}</code> <span className="small muted">rows {preview.page.offset + 1}–{preview.page.offset + preview.page.rows.length} · real data, visible to your role only, access is logged</span></h4>
                <div style={{ overflow: 'auto', maxHeight: 260 }}><table><thead><tr>{Object.keys(preview.page.rows[0] ?? {}).map((k) => <th key={k}>{k}</th>)}</tr></thead><tbody>{preview.page.rows.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j} className="small">{v === null ? '' : String(v)}</td>)}</tr>)}</tbody></table></div>
                <div className="row"><button className="sm" disabled={preview.page.offset === 0} onClick={() => peek.mutate({ object: preview.object, offset: Math.max(0, preview.page.offset - 25) })}>Previous</button><button className="sm" disabled={!preview.page.hasMore} onClick={() => peek.mutate({ object: preview.object, offset: preview.page.offset + 25 })}>Next</button></div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function ApiKeys() {
  const q = useApi<{ keys: { id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }[]; scopes: string[] }>('/api-keys');
  const [form, setForm] = useState({ name: '', role: 'VIEWER', scopes: [] as string[], expiresInDays: 90 });
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction(() => api.post<{ key: string }>('/api-keys', form), { invalidate: ['/api-keys'], onSuccess: (r) => { setSecret(r.key); setForm({ ...form, name: '', scopes: [] }); } });
  const revoke = useAction((id: string) => api.del(`/api-keys/${id}`), { success: 'Key revoked.', invalidate: ['/api-keys'] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="stack lg">
      <Panel title="Create an API key">
        <div className="stack">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Service account role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={{ width: 180 }}>{['VIEWER', 'LABELER', 'REVIEWER', 'DATA_ENGINEER', 'PROJECT_MANAGER'].map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</select></Field>
            <Field label="Expires in (days)"><input type="number" min={1} max={730} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: Number(e.target.value) })} style={{ width: 120 }} /></Field>
          </div>
          <fieldset><legend>Scopes</legend><div className="row wrap">{q.data!.scopes.map((s) => <label key={s} className="check"><input type="checkbox" checked={form.scopes.includes(s)} onChange={() => setForm({ ...form, scopes: form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] })} /><code>{s}</code></label>)}</div></fieldset>
          <div><button className="primary" disabled={form.name.length < 2 || !form.scopes.length} onClick={() => create.mutate(undefined)}>Create key</button></div>
          <Help>Keys are shown once and stored as a hash. A key can only do what both its scopes and its service-account role allow.</Help>
        </div>
      </Panel>
      <Panel title="Keys" flat>
        {!q.data!.keys.length ? <p className="muted" style={{ padding: 12 }}>No API keys.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>{q.data!.keys.map((k) => <tr key={k.id}><td>{k.name}</td><td className="mono small">{k.prefix}…</td><td className="small">{k.scopes.join(', ')}</td><td className="small muted">{dateTime(k.lastUsedAt)}</td><td className="small muted">{dateTime(k.expiresAt)}</td><td>{k.revokedAt ? <Badge tone="dashed">Revoked</Badge> : <button className="sm" onClick={() => revoke.mutate(k.id)}>Revoke</button>}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
      {secret ? <SecretOnce title="New API key" value={secret} note="Copy this key now. It will not be shown again." onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

interface WebhookRes { endpoints: { id: string; url: string; events: string[]; active: boolean; createdAt: string; deliveries: { id: string; event: string; status: string; attempts: number; responseStatus: number | null; createdAt: string }[] }[]; events: string[] }

function Webhooks() {
  const q = useApi<WebhookRes>('/webhooks');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction(() => api.post<{ secret: string }>('/webhooks', { url, events }), { invalidate: ['/webhooks'], onSuccess: (r) => { setSecret(r.secret); setUrl(''); setEvents([]); } });
  const toggle = useAction((v: { id: string; active: boolean }) => api.patch(`/webhooks/${v.id}`, { active: v.active }), { invalidate: ['/webhooks'] });
  const del = useAction((id: string) => api.del(`/webhooks/${id}`), { success: 'Endpoint removed.', invalidate: ['/webhooks'] });
  const redeliver = useAction((v: { id: string; d: string }) => api.post(`/webhooks/${v.id}/redeliver/${v.d}`), { success: 'Redelivery queued.', invalidate: ['/webhooks'] });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="stack lg">
      <Panel title="Add an endpoint">
        <div className="stack">
          <Field label="HTTPS URL"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/authenq-webhook" /></Field>
          <fieldset><legend>Events</legend><div className="row wrap">{q.data!.events.map((ev) => <label key={ev} className="check"><input type="checkbox" checked={events.includes(ev)} onChange={() => setEvents(events.includes(ev) ? events.filter((x) => x !== ev) : [...events, ev])} /><code>{ev}</code></label>)}</div></fieldset>
          <div><button className="primary" disabled={!url || !events.length} onClick={() => create.mutate(undefined)}>Add endpoint</button></div>
          <Help>Each delivery carries <code>x-authenq-signature: t=&lt;timestamp&gt;,v1=&lt;HMAC-SHA256&gt;</code>. Failed deliveries retry with exponential backoff. Private network addresses are rejected.</Help>
        </div>
      </Panel>
      {!q.data!.endpoints.length ? <Empty title="No webhook endpoints" /> : q.data!.endpoints.map((ep) => (
        <Panel key={ep.id} title={<span className="mono small">{ep.url}</span>} actions={<><label className="check small"><input type="checkbox" checked={ep.active} onChange={(e) => toggle.mutate({ id: ep.id, active: e.target.checked })} /> Active</label><button className="sm ghost" onClick={() => del.mutate(ep.id)}>Remove</button></>}>
          <p className="small muted">{ep.events.join(', ')}</p>
          {ep.deliveries.length ? (
            <table>
              <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>When</th><th /></tr></thead>
              <tbody>{ep.deliveries.map((d) => <tr key={d.id}><td className="mono small">{d.event}</td><td><StatusBadge status={d.status} /></td><td>{d.attempts}</td><td>{d.responseStatus ?? '—'}</td><td className="small muted">{dateTime(d.createdAt)}</td><td><button className="sm" onClick={() => redeliver.mutate({ id: ep.id, d: d.id })}>Redeliver</button></td></tr>)}</tbody>
            </table>
          ) : <p className="small muted">No deliveries yet.</p>}
        </Panel>
      ))}
      {secret ? <SecretOnce title="Signing secret" value={secret} note="Copy this signing secret now. It will not be shown again." onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

function AiProviders() {
  const q = useApi<{ id: string; provider: string; name: string; model: string; baseUrl: string | null; enabled: boolean; apiKey: string | null; createdAt: string }[]>('/ai-providers');
  const [form, setForm] = useState({ provider: 'OPENAI_COMPATIBLE', name: '', model: '', baseUrl: '', apiKey: '' });
  const create = useAction(() => api.post('/ai-providers', { ...form, baseUrl: form.baseUrl || undefined, apiKey: form.apiKey || undefined }), { success: 'Provider saved. The key is encrypted at rest.', invalidate: ['/ai-providers'], onSuccess: () => setForm({ ...form, name: '', model: '', apiKey: '' }) });
  const toggle = useAction((v: { id: string; enabled: boolean }) => api.patch(`/ai-providers/${v.id}`, { enabled: v.enabled }), { invalidate: ['/ai-providers'] });
  const del = useAction((id: string) => api.del(`/ai-providers/${id}`), { invalidate: ['/ai-providers'] });
  return (
    <div className="stack lg">
      <div className="callout small">External AI only ever receives synthetic records, guideline text and aggregates. The gateway rejects real source data before any request is made. Engine runs through external AI also require the <code>engine.external_ai</code> feature flag.</div>
      <Panel title="Add a provider">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <Field label="Provider"><select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} style={{ width: 200 }}><option value="OPENAI_COMPATIBLE">OpenAI-compatible</option><option value="ANTHROPIC">Anthropic</option><option value="SELF_HOSTED">Self-hosted</option></select></Field>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Model"><input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
          <Field label="Base URL"><input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Optional" /></Field>
          <Field label="API key"><input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>
          <button className="primary" disabled={form.name.length < 2 || !form.model} onClick={() => create.mutate(undefined)}>Save</button>
        </div>
      </Panel>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? <Empty title="No AI providers">The built-in demo engine works without any provider.</Empty> : (
        <table>
          <thead><tr><th>Name</th><th>Provider</th><th>Model</th><th>Key</th><th>Enabled</th><th /></tr></thead>
          <tbody>{q.data!.map((p) => <tr key={p.id}><td>{p.name}</td><td>{humanize(p.provider)}</td><td className="mono small">{p.model}</td><td className="mono small">{p.apiKey ?? '—'}</td><td><input type="checkbox" aria-label={`Enable ${p.name}`} checked={p.enabled} onChange={(e) => toggle.mutate({ id: p.id, enabled: e.target.checked })} /></td><td><button className="sm ghost" onClick={() => del.mutate(p.id)}>Remove</button></td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function Features() {
  const { can } = useAuth();
  const q = useApi<{ settings: Record<string, unknown>; keys: string[]; flags: { key: string; description: string; stage: string; enabled: boolean }[]; retention: { id: string; resourceType: string; days: number }[] }>('/settings');
  const flag = useAction((v: { key: string; enabled: boolean }) => api.put(`/feature-flags/${v.key}`, { enabled: v.enabled }), { success: 'Feature flag updated.', invalidate: ['/settings'] });
  const setting = useAction((v: { key: string; value: string | number | boolean }) => api.put(`/settings/${v.key}`, { value: v.value }), { success: 'Setting saved.', invalidate: ['/settings'] });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const manage = can('settings.manage');
  const SETTING_HELP: Record<string, string> = {
    'retention.days': 'Days to keep completed jobs, scans and expired sessions (number).',
    'export.requireOverrideApproval': 'Require the exports.override permission for gate overrides (true/false).',
    'workspace.shortcuts': 'Default workspace shortcuts as JSON, e.g. {"submit":"Enter"}.',
    'security.sessionHours': 'Session lifetime in hours (number).',
    'security.requireMfa': 'Require two-factor authentication for all members (true/false).',
  };
  const parse = (raw: string): string | number | boolean => (raw === 'true' ? true : raw === 'false' ? false : raw.trim() !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
  return (
    <div className="stack lg">
      <Panel title="Feature flags">
        <table>
          <thead><tr><th>Flag</th><th>Stage</th><th>Enabled</th></tr></thead>
          <tbody>{d.flags.map((f) => <tr key={f.key}><td><code>{f.key}</code><div className="small muted">{f.description}</div></td><td><Badge>{humanize(f.stage)}</Badge></td><td><input type="checkbox" aria-label={`Toggle ${f.key}`} disabled={!manage} checked={f.enabled} onChange={(e) => flag.mutate({ key: f.key, enabled: e.target.checked })} /></td></tr>)}</tbody>
        </table>
      </Panel>
      <Panel title="Organization policies">
        <table>
          <tbody>
            {d.keys.map((k) => (
              <tr key={k}>
                <td><code>{k}</code><div className="small muted">{SETTING_HELP[k]}</div></td>
                <td style={{ width: 280 }}><input aria-label={k} disabled={!manage} value={drafts[k] ?? (d.settings[k] === undefined ? '' : typeof d.settings[k] === 'object' ? JSON.stringify(d.settings[k]) : String(d.settings[k]))} placeholder="Default" onChange={(e) => setDrafts({ ...drafts, [k]: e.target.value })} /></td>
                <td>{manage ? <button className="sm" disabled={drafts[k] === undefined} onClick={() => setting.mutate({ key: k, value: parse(drafts[k]!) })}>Save</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      {d.retention.length ? <Panel title="Retention policies"><table><tbody>{d.retention.map((r) => <tr key={r.id}><td>{humanize(r.resourceType)}</td><td>{r.days} days</td></tr>)}</tbody></table></Panel> : null}
    </div>
  );
}

function Usage() {
  const q = useApi<{ since: string; metrics: { metric: string; quantity: number; limit: number | null }[] }>('/usage');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <Panel title={`Usage since ${dateTime(q.data!.since)}`}>
      {!q.data!.metrics.length ? <p className="muted">No metered usage in this period.</p> : (
        <table>
          <thead><tr><th>Metric</th><th className="num">Quantity</th><th className="num">Limit</th></tr></thead>
          <tbody>{q.data!.metrics.map((m) => <tr key={m.metric}><td>{humanize(m.metric)}</td><td className="num">{num(m.quantity)}</td><td className="num">{m.limit === null ? 'No limit' : num(m.limit)}</td></tr>)}</tbody>
        </table>
      )}
    </Panel>
  );
}

function SecurityEvents() {
  const q = useApi<{ events: { id: string; type: string; severity: string; details: unknown; ip: string | null; createdAt: string }[]; logins: { id: string; email: string; success: boolean; reason: string | null; ip: string | null; createdAt: string }[] }>('/security/events');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <div className="stack lg">
      <Panel title="Security events">
        {!q.data!.events.length ? <p className="muted">No security events.</p> : (
          <table><thead><tr><th>Type</th><th>Severity</th><th>IP</th><th>When</th></tr></thead>
            <tbody>{q.data!.events.map((e) => <tr key={e.id}><td className="mono small">{e.type}</td><td><Badge>{humanize(e.severity)}</Badge></td><td className="small">{e.ip ?? '—'}</td><td className="small muted">{dateTime(e.createdAt)}</td></tr>)}</tbody></table>
        )}
      </Panel>
      <Panel title="Sign-in attempts">
        {!q.data!.logins.length ? <p className="muted">No sign-in attempts recorded.</p> : (
          <table><thead><tr><th>Email</th><th>Result</th><th>Reason</th><th>IP</th><th>When</th></tr></thead>
            <tbody>{q.data!.logins.map((l) => <tr key={l.id}><td>{l.email}</td><td>{l.success ? <Badge tone="soft">Success</Badge> : <Badge tone="outline-strong">Failed</Badge>}</td><td className="small">{l.reason ?? '—'}</td><td className="small">{l.ip ?? '—'}</td><td className="small muted">{dateTime(l.createdAt)}</td></tr>)}</tbody></table>
        )}
      </Panel>
    </div>
  );
}
