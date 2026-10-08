import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { ago } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  perm?: string;
  end?: boolean;
}
const NAV: { section: string; items: NavItem[] }[] = [
  { section: 'Overview', items: [{ to: '/', label: 'Dashboard', glyph: '◼', end: true }] },
  {
    section: 'Pipeline',
    items: [
      { to: '/sources', label: 'Data Sources', glyph: '01', perm: 'sources.read' },
      { to: '/synthetic', label: 'Synthetic Sets', glyph: '02', perm: 'synthetic.read' },
      { to: '/canary', label: 'Canary', glyph: '03', perm: 'canary.read' },
      { to: '/projects', label: 'Labeling Projects', glyph: '04', perm: 'labeling.read' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/activity', label: 'Activity', glyph: '≡', perm: 'activity.read' },
      { to: '/jobs', label: 'Jobs', glyph: '⟳' },
      { to: '/notifications', label: 'Notifications', glyph: '•' },
    ],
  },
  {
    section: 'Platform',
    items: [
      { to: '/settings', label: 'Settings', glyph: '⚙' },
      { to: '/help', label: 'Help & docs', glyph: '?' },
    ],
  },
];

interface Command {
  label: string;
  hint: string;
  to: string;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<Command[]>([]);
  const statics = useMemo<Command[]>(
    () => [
      ...NAV.flatMap((s) => s.items.filter((i) => !i.perm || can(i.perm)).map((i) => ({ label: i.label, hint: 'Go to', to: i.to }))),
      ...(can('sources.write') ? [{ label: 'New data source', hint: 'Action', to: '/sources?new=1' }] : []),
      ...(can('labeling.manage') ? [{ label: 'Send synthetic data to labeling', hint: 'Action', to: '/projects/new' }] : []),
      ...(can('canary.scan') ? [{ label: 'Scan text for Canary values', hint: 'Action', to: '/canary?tab=scan' }] : []),
      { label: 'Account & security', hint: 'Settings', to: '/settings/account' },
    ],
    [can],
  );
  useEffect(() => {
    if (q.trim().length < 2) return setRemote([]);
    const t = setTimeout(() => {
      api
        .get<{ type: string; label: string; href: string }[]>(`/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setRemote(r.map((x) => ({ label: x.label, hint: x.type, to: x.href }))))
        .catch(() => setRemote([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const items = [...statics.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())), ...remote].slice(0, 14);
  const go = (c: Command | undefined) => {
    if (!c) return;
    nav(c.to);
    onClose();
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Search pages, sources, sets, projects…"
          value={q}
          aria-label="Search"
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(items.length - 1, s + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            if (e.key === 'Enter') go(items[sel]);
          }}
        />
        <ul role="listbox">
          {items.length === 0 ? <li className="muted small" style={{ padding: 12 }}>No matches.</li> : null}
          {items.map((c, i) => (
            <li key={c.hint + c.to + c.label}>
              <button className="ghost" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(c)}>
                <span>{c.label}</span>
                <span className="small" style={{ opacity: 0.6 }}>{c.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface NotificationsRes {
  items: { id: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }[];
  unread: number;
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const q = useApi<NotificationsRes>('/notifications', { refetchInterval: 30_000 });
  const nav = useNavigate();
  return (
    <div className="relative">
      <button className="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Notifications, ${q.data?.unread ?? 0} unread`}>
        Notifications{q.data?.unread ? <span className="badge solid">{q.data.unread}</span> : null}
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="row between" style={{ padding: '8px 10px', borderBottom: 'var(--line)' }}>
            <strong className="small">Recent</strong>
            <Link className="small" to="/notifications" onClick={() => setOpen(false)}>View all</Link>
          </div>
          {(q.data?.items ?? []).slice(0, 6).map((n) => (
            <button
              key={n.id}
              className="ghost"
              style={{ width: '100%', height: 'auto', padding: '8px 10px', justifyContent: 'flex-start', textAlign: 'left', display: 'block', fontWeight: n.readAt ? 400 : 600 }}
              onClick={() => {
                setOpen(false);
                api.post('/notifications/read', { ids: [n.id] }).then(() => q.refetch());
                if (n.link) nav(n.link);
              }}
            >
              <div>{n.title}</div>
              <div className="small muted">{n.body}</div>
              <div className="small muted">{ago(n.createdAt)}</div>
            </button>
          ))}
          {!q.data?.items.length ? <p className="small muted" style={{ padding: 10 }}>No notifications yet.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Layout() {
  const { me, can, logout, setMe } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('aq.sidebar') === 'collapsed');
  const [mobile, setMobile] = useState(false);
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMobile(false), [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem('aq.sidebar', c ? 'expanded' : 'collapsed');
      return !c;
    });
  };
  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobile ? 'mobile-open' : ''}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <img src="/authenq-logo-white.png" alt="AuthenQ" />
        </div>
        <nav>
          {NAV.map((s) => {
            const items = s.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={s.section}>
                <div className="section">{s.section}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`} title={collapsed ? i.label : undefined}>
                    <span className="glyph" aria-hidden>{i.glyph}</span>
                    <span className="label">{i.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="foot">
          <button className="sm" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? '»' : '« Collapse'}
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost sm mobile-only" onClick={() => setMobile((m) => !m)} aria-label="Open navigation" style={{ display: 'none' }}>
            Menu
          </button>
          <button className="ghost" onClick={() => setPalette(true)} style={{ color: 'var(--g500)', minWidth: 260, justifyContent: 'space-between', border: '1px solid var(--g200)' }} aria-label="Open command palette">
            <span>Search or jump to…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <span className="right" />
          <NotificationBell />
          <div className="relative">
            <button className="ghost" onClick={() => setUserMenu((o) => !o)} aria-expanded={userMenu}>
              <span>{me?.user.name}</span>
              <span className="badge soft">{me?.role.name}</span>
            </button>
            {userMenu ? (
              <div className="menu" role="menu" style={{ padding: 6 }}>
                <div style={{ padding: '6px 8px' }}>
                  <div><strong>{me?.org.name}</strong></div>
                  <div className="small muted">{me?.user.email}</div>
                </div>
                {me && me.organizations.length > 1 ? (
                  <div style={{ padding: '6px 8px' }}>
                    <label className="field">
                      <span>Switch organization</span>
                      <select
                        value={me.org.id}
                        onChange={async (e) => {
                          const m = await api.post<typeof me>('/auth/switch-org', { orgId: e.target.value });
                          setMe(m);
                          nav('/');
                        }}
                      >
                        {me.organizations.map((o) => (
                          <option key={o.id} value={o.id}>{o.name} ({o.role})</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
                <hr className="sep" />
                <button className="ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => { setUserMenu(false); nav('/settings/account'); }}>
                  Account & security
                </button>
                <button className="ghost" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={async () => { await logout(); nav('/login'); }}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </header>
        {me && !me.user.emailVerified ? (
          <div className="callout" style={{ margin: '12px 28px 0' }}>
            Your email address is not verified yet. <button className="sm" onClick={() => api.post('/auth/resend-verification')}>Resend verification email</button>
          </div>
        ) : null}
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
    </div>
  );
}
