import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { dateTime, humanize } from '../lib/format';
import { Badge, Empty, ErrorBox, Json, Loading, Modal, PageHead, Pagination, Progress, StatusBadge } from '../components/ui';

interface ActivityRow { id: string; actorType: string; actorLabel: string | null; action: string; resourceType: string; resourceId: string | null; summary: string; before: unknown; after: unknown; details: unknown; ip: string | null; requestId: string | null; createdAt: string }

export function Activity() {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [open, setOpen] = useState<ActivityRow | null>(null);
  const q = useApi<{ items: ActivityRow[]; total: number }>(`/activity${qs({ limit: 50, offset, q: search, resourceType })}`, { keepPrevious: true });
  return (
    <div className="stack lg">
      <PageHead title="Activity" description="Append-only audit log. Entries cannot be edited or deleted, and never contain real source values." />
      <div className="row wrap">
        <input placeholder="Search summaries" aria-label="Search activity" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} style={{ maxWidth: 320 }} />
        <select aria-label="Resource type" value={resourceType} onChange={(e) => { setResourceType(e.target.value); setOffset(0); }} style={{ width: 220 }}>
          <option value="">All resources</option>
          {['data_source', 'source_column', 'synthetic_set', 'label_project', 'task', 'gold_record', 'engine_run', 'engine_item', 'export', 'canary_scan', 'member', 'api_key', 'webhook', 'session', 'user'].map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
        </select>
      </div>
      {q.isLoading ? <Loading rows={8} /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.items.length ? <Empty title="No activity" /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Summary</th><th /></tr></thead>
              <tbody>
                {q.data!.items.map((a) => (
                  <tr key={a.id}>
                    <td className="small muted nowrap">{dateTime(a.createdAt)}</td>
                    <td className="nowrap">{a.actorLabel ?? 'System'} <Badge tone="soft">{humanize(a.actorType)}</Badge></td>
                    <td className="mono small">{a.action}</td>
                    <td>{a.summary}</td>
                    <td><button className="sm" onClick={() => setOpen(a)}>Details</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={q.data!.total} limit={50} offset={offset} onChange={setOffset} />
        </>
      )}
      {open ? (
        <Modal title={open.action} onClose={() => setOpen(null)} wide>
          <div className="stack">
            <dl className="dl">
              <dt>When</dt><dd>{dateTime(open.createdAt)}</dd>
              <dt>Actor</dt><dd>{open.actorLabel ?? 'System'} ({humanize(open.actorType)})</dd>
              <dt>Resource</dt><dd>{humanize(open.resourceType)} <span className="mono small">{open.resourceId}</span></dd>
              <dt>IP</dt><dd>{open.ip ?? '—'}</dd>
              <dt>Request</dt><dd className="mono small">{open.requestId ?? '—'}</dd>
            </dl>
            {open.before ? <><h3>Before</h3><Json value={open.before} /></> : null}
            {open.after ? <><h3>After</h3><Json value={open.after} /></> : null}
            {open.details ? <><h3>Details</h3><Json value={open.details} /></> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

interface JobRow { id: string; type: string; status: string; progress: number; processed: number; total: number; error: string | null; attempts: number; maxAttempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null; resourceType: string | null; resourceId: string | null }

const RESOURCE_LINK: Record<string, (id: string) => string> = {
  data_source: (id) => `/sources/${id}`,
  synthetic_set: (id) => `/synthetic/${id}`,
  label_project: (id) => `/projects/${id}`,
};

export function Jobs() {
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useApi<{ items: JobRow[]; total: number }>(`/jobs${qs({ status, limit: 50, offset })}`, { refetchInterval: 4000, keepPrevious: true });
  const control = useAction((v: { id: string; action: string }) => api.post(`/jobs/${v.id}/${v.action}`), { success: 'Job updated.', invalidate: ['/jobs'] });
  return (
    <div className="stack lg">
      <PageHead title="Jobs" description="Background work: ingestion, Firewall scans, Twin generation, engine runs and exports. Jobs survive restarts and can be paused, resumed, cancelled or retried." />
      <select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} style={{ width: 200 }}>
        <option value="">All statuses</option>
        {['QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
      </select>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.items.length ? <Empty title="No jobs" /> : (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Status</th><th style={{ width: 200 }}>Progress</th><th>Attempts</th><th>Created</th><th>Resource</th><th /></tr></thead>
              <tbody>
                {q.data!.items.map((j) => (
                  <tr key={j.id}>
                    <td>{humanize(j.type)}{j.error ? <div className="small muted">{j.error}</div> : null}</td>
                    <td><StatusBadge status={j.status} /></td>
                    <td><Progress value={j.progress} /><div className="small muted">{j.total ? `${j.processed.toLocaleString()} / ${j.total.toLocaleString()}` : ''}</div></td>
                    <td>{j.attempts}/{j.maxAttempts}</td>
                    <td className="small muted">{dateTime(j.createdAt)}</td>
                    <td>{j.resourceType && j.resourceId && RESOURCE_LINK[j.resourceType] ? <Link to={RESOURCE_LINK[j.resourceType]!(j.resourceId)}>Open</Link> : '—'}</td>
                    <td>
                      {me && (me.role.key === 'ADMIN' || (j as JobRow & { createdById?: string }).createdById === me.user.id) ? (
                        <div className="row">
                          {j.status === 'RUNNING' || j.status === 'QUEUED' ? <button className="sm" onClick={() => control.mutate({ id: j.id, action: 'pause' })}>Pause</button> : null}
                          {j.status === 'PAUSED' ? <button className="sm" onClick={() => control.mutate({ id: j.id, action: 'resume' })}>Resume</button> : null}
                          {['RUNNING', 'QUEUED', 'PAUSED'].includes(j.status) ? <button className="sm" onClick={() => control.mutate({ id: j.id, action: 'cancel' })}>Cancel</button> : null}
                          {['FAILED', 'CANCELLED'].includes(j.status) ? <button className="sm" onClick={() => control.mutate({ id: j.id, action: 'retry' })}>Retry</button> : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination total={q.data!.total} limit={50} offset={offset} onChange={setOffset} />
        </>
      )}
    </div>
  );
}

export function Notifications() {
  const q = useApi<{ items: { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }[]; unread: number }>('/notifications');
  const readAll = useAction(() => api.post('/notifications/read', {}), { invalidate: ['/notifications'] });
  return (
    <div className="stack lg">
      <PageHead title="Notifications" actions={<button disabled={!q.data?.unread} onClick={() => readAll.mutate(undefined)}>Mark all as read</button>} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.items.length ? <Empty title="No notifications" /> : (
        <div className="table-wrap">
          <table>
            <tbody>
              {q.data!.items.map((n) => (
                <tr key={n.id}>
                  <td style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.link ? <Link to={n.link}>{n.title}</Link> : n.title}<div className="small muted">{n.body}</div></td>
                  <td className="small muted nowrap">{dateTime(n.createdAt)}</td>
                  <td>{n.readAt ? <Badge tone="soft">Read</Badge> : <Badge tone="solid">New</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
