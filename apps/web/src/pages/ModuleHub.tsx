import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { num } from '../lib/format';
import { Empty, ErrorBox, Loading, PageHead, Progress, StatusBadge } from '../components/ui';

interface ProjectRow { id: string; name: string; description: string; status: string; total: number; done: number; goldLockedAt: string | null }

const MODULES = {
  workspace: { title: 'Labeling Workspace', description: 'Label synthetic records with versioned guidelines. Choose a project to open its workspace.', action: 'Open workspace' },
  gold: { title: 'Gold Set', description: 'Curate reference labels and the locked test split used to measure quality. Choose a project.', action: 'Open Gold Set' },
  quality: { title: 'Review and Quality', description: 'Review routed items, adjudicate disagreements and inspect quality metrics. Choose a project.', action: 'Open quality' },
  exports: { title: 'Export', description: 'Build training-ready export packages with manifests, data cards and safety checks. Choose a project.', action: 'Open exports' },
} as const;

export function ModuleHub({ module }: { module: keyof typeof MODULES }) {
  const m = MODULES[module];
  const { can } = useAuth();
  const q = useApi<ProjectRow[]>('/projects');
  return (
    <div className="stack lg">
      <PageHead title={m.title} description={m.description} />
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : !q.data!.length ? (
        <Empty title="No labeling projects yet" action={can('labeling.manage') ? <Link className="btn primary" to="/projects/new">Send synthetic data to labeling</Link> : undefined}>
          Labeling projects are created by explicitly sending an approved synthetic set to labeling.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Project</th><th>Status</th><th style={{ width: 240 }}>Progress</th><th /></tr></thead>
            <tbody>
              {q.data!.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><div className="small muted truncate">{p.description}</div></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td><Progress value={p.total ? p.done / p.total : 0} /><div className="small muted">{num(p.done)} / {num(p.total)} labeled</div></td>
                  <td className="num"><Link className="btn sm" to={`/projects/${p.id}/${module}`}>{m.action}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
