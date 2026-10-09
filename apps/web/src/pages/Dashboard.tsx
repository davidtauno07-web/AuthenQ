import { Link } from 'react-router-dom';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ago, humanize, num } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHead, Panel, Progress, StatusBadge } from '../components/ui';

interface DashboardRes {
  pipeline: {
    firewall: { total: number; byStatus: Record<string, number> };
    twin: { total: number; byStatus: Record<string, number> };
    canary: { registered: number; openAlerts: number };
    labeling: { projects: number; tasks: Record<string, number>; pendingReview: number };
    exports: { completed: number };
  };
  projects: { id: string; name: string; status: string; goldLockedAt: string | null }[];
  jobs: { id: string; type: string; status: string; progress: number; createdAt: string; error: string | null }[];
  activity: { id: string; summary: string; actorLabel: string | null; createdAt: string }[];
}

export function Dashboard() {
  const { me, can } = useAuth();
  const q = useApi<DashboardRes>('/dashboard', { refetchInterval: 15_000 });
  if (q.isLoading) return <Loading rows={6} />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data!;
  const p = d.pipeline;
  const tasksTotal = Object.values(p.labeling.tasks).reduce((a, b) => a + b, 0);
  const tasksDone = (p.labeling.tasks.DONE ?? 0) + (p.labeling.tasks.LABELED ?? 0);
  const empty = p.firewall.total === 0;
  return (
    <div className="stack lg">
      <PageHead title={`${me?.org.name}`} description="Status of every stage in the pipeline, computed from your organization's data." />
      <div className="steps" aria-label="Pipeline">
        <Link to="/sources">
          <span className="n">FIREWALL</span>
          <span className="v">{num(p.firewall.total)}</span>
          <span className="small muted">{num(p.firewall.byStatus.SIGNED_OFF ?? 0)} signed off · {num(p.firewall.byStatus.NEEDS_REVIEW ?? 0)} need review</span>
        </Link>
        <Link to="/synthetic">
          <span className="n">TWIN</span>
          <span className="v">{num(p.twin.total)}</span>
          <span className="small muted">{num(p.twin.byStatus.READY ?? 0)} ready · {num(p.twin.byStatus.SAFETY_HOLD ?? 0)} on safety hold</span>
        </Link>
        <Link to="/canary">
          <span className="n">CANARY</span>
          <span className="v">{num(p.canary.registered)}</span>
          <span className="small muted">values traced · {num(p.canary.openAlerts)} open alerts</span>
        </Link>
        <Link to="/projects">
          <span className="n">LABELING</span>
          <span className="v">{num(tasksDone)}<span className="small muted"> / {num(tasksTotal)}</span></span>
          <span className="small muted">{num(p.labeling.pendingReview)} awaiting review</span>
        </Link>
        <Link to="/projects">
          <span className="n">EXPORT</span>
          <span className="v">{num(p.exports.completed)}</span>
          <span className="small muted">completed packages</span>
        </Link>
      </div>
      {empty ? (
        <Empty title="Start with the Firewall" action={can('sources.write') ? <Link className="btn primary" to="/sources?new=1">Add a data source</Link> : undefined}>
          Upload a CSV, TSV, XLSX, JSON or JSONL file, or connect a PostgreSQL database. The Firewall classifies every column before anything leaves its boundary.
        </Empty>
      ) : null}
      {p.canary.openAlerts > 0 ? (
        <div className="callout strong">
          <strong>{p.canary.openAlerts} open Canary alert{p.canary.openAlerts === 1 ? '' : 's'}.</strong> Synthetic values from your sets were found in scanned material. <Link to="/canary?tab=alerts" style={{ color: 'inherit' }}>Review alerts</Link>
        </div>
      ) : null}
      <div className="grid cols-2">
        <Panel title="Labeling projects" actions={<Link className="small" to="/projects">All projects</Link>}>
          {d.projects.length === 0 ? (
            <p className="muted">No projects yet. Send a ready synthetic set to labeling to create one.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {d.projects.map((pr) => (
                <li key={pr.id} className="row between">
                  <Link to={`/projects/${pr.id}`}>{pr.name}</Link>
                  <span className="row">
                    {pr.goldLockedAt ? <span className="badge soft">Gold locked</span> : <span className="badge dashed">Gold open</span>}
                    <StatusBadge status={pr.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Active jobs" actions={<Link className="small" to="/jobs">All jobs</Link>}>
          {d.jobs.length === 0 ? (
            <p className="muted">No queued, running or failed jobs.</p>
          ) : (
            <div className="stack">
              {d.jobs.map((j) => (
                <div key={j.id} className="stack" style={{ gap: 4 }}>
                  <div className="row between">
                    <span>{humanize(j.type)}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <Progress value={j.progress} />
                  {j.error ? <span className="small muted">{j.error}</span> : null}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      {can('activity.read') ? (
        <Panel title="Recent activity" actions={<Link className="small" to="/activity">Full audit log</Link>}>
          {d.activity.length === 0 ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 8 }}>
              {d.activity.map((a) => (
                <li key={a.id} className="row between">
                  <span>
                    <strong>{a.actorLabel ?? 'System'}</strong> {a.summary}
                  </span>
                  <span className="small muted nowrap">{ago(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
