import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { ApiError } from '../lib/api';
import { humanize } from '../lib/format';

export function PageHead({ title, description, crumbs, actions }: { title: ReactNode; description?: ReactNode; crumbs?: { to?: string; label: string }[]; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        {crumbs?.length ? (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : c.label}
                {i < crumbs.length - 1 ? ' / ' : ''}
              </span>
            ))}
          </nav>
        ) : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </header>
  );
}

export function Panel({ title, actions, children, flat, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flat?: boolean; className?: string }) {
  return (
    <section className={`panel ${flat ? 'flat' : ''} ${className ?? ''}`}>
      {title || actions ? (
        <div className="head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className="body">{children}</div>
    </section>
  );
}

export function Stat({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s ? <div className="s">{s}</div> : null}
    </div>
  );
}

type Tone = 'solid' | 'dark' | 'soft' | 'outline-strong' | 'dashed' | 'plain';
export function Badge({ tone = 'plain', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === 'plain' ? '' : tone}`} title={title}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  SIGNED_OFF: 'solid', READY: 'solid', COMPLETED: 'solid', DONE: 'solid', FINAL: 'solid', ACTIVE: 'solid', ACCEPTED: 'solid', RESOLVED: 'soft',
  NEEDS_REVIEW: 'outline-strong', NEEDS_DECISION: 'outline-strong', SAFETY_HOLD: 'outline-strong', BLOCKED: 'outline-strong', OPEN: 'outline-strong', FAILED: 'outline-strong', NEEDS_ADJUDICATION: 'outline-strong', PENDING: 'outline-strong', IN_REVIEW: 'outline-strong', FLAGGED: 'outline-strong', ERROR: 'outline-strong',
  RUNNING: 'dark', SCANNING: 'dark', GENERATING: 'dark', BUILDING: 'dark', INGESTING: 'dark', CHECKING: 'dark',
  QUEUED: 'dashed', DRAFT: 'dashed', PAUSED: 'dashed', OPEN_TASK: 'dashed', CANCELLED: 'soft', SKIPPED: 'soft', SUSPENDED: 'soft', LABELED: 'dark', CORRECTED: 'dark',
  SENSITIVE: 'solid', OUTCOME: 'soft', NON_SENSITIVE: 'plain', IDENTIFIER: 'dark', UNSCANNED: 'dashed', ACKNOWLEDGED: 'dark',
};
export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  if (!status) return <Badge tone="dashed">—</Badge>;
  return <Badge tone={STATUS_TONE[status] ?? 'plain'}>{label ?? humanize(status)}</Badge>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorBox({ error, title }: { error: ApiError | Error | null | undefined; title?: string }) {
  if (!error) return null;
  const api = error as ApiError;
  const reasons = typeof api.reasons !== 'undefined' ? api.reasons : [];
  const actions = api.body?.actions ?? [];
  return (
    <div className="callout" role="alert">
      <strong>{title ?? (api.code === 'GATE_BLOCKED' ? 'Blocked by a safety gate' : 'Something went wrong')}</strong>
      <p style={{ marginTop: 4 }}>{reasons.length ? 'Resolve the following before continuing:' : error.message}</p>
      {reasons.length ? (
        <ul>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {actions.length ? (
        <div className="row" style={{ marginTop: 8 }}>
          {actions.map((a) => (a.href ? <Link key={a.label} className="btn sm" to={a.href}>{a.label}</Link> : null))}
        </div>
      ) : null}
      {api.body?.requestId ? <p className="small muted" style={{ marginTop: 6 }}>Reference: {api.body.requestId}</p> : null}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function Bar({ value, max = 1, label }: { value: number; max?: number; label?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar" role="img" aria-label={label ?? `${Math.round(w)}%`}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  const w = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>
          <h2>{title}</h2>
          <button className="ghost sm" onClick={onClose} aria-label="Close" data-close>
            Close
          </button>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function Tabs({ tabs }: { tabs: { to: string; label: string; end?: boolean }[] }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= limit) return <p className="small muted">{total.toLocaleString()} total</p>;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  return (
    <div className="row small" role="navigation" aria-label="Pagination">
      <span className="muted">
        {(offset + 1).toLocaleString()}–{Math.min(total, offset + limit).toLocaleString()} of {total.toLocaleString()}
      </span>
      <span className="right" />
      <button className="sm" disabled={page <= 1} onClick={() => onChange(Math.max(0, offset - limit))}>
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button className="sm" disabled={page >= pages} onClick={() => onChange(offset + limit)}>
        Next
      </button>
    </div>
  );
}

export function Help({ children }: { children: ReactNode }) {
  return (
    <details className="small">
      <summary className="muted" style={{ cursor: 'pointer' }}>
        How this works
      </summary>
      <div style={{ marginTop: 6 }} className="muted">
        {children}
      </div>
    </details>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="mono small pre" style={{ margin: 0, background: 'var(--g50)', padding: 10, borderRadius: 4, overflow: 'auto', maxHeight: 360 }}>{JSON.stringify(value, null, 2)}</pre>;
}
