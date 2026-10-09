import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { ago } from '../lib/format';
import {
  Activity, Award, Bell, Database, FolderKanban, Layers, LayoutDashboard, ListChecks, Menu, PackageOpen, PanelLeftClose, PanelLeftOpen, PenLine, Radar, Search, Settings, ShieldCheck, type LucideIcon,
} from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: string;
  end?: boolean;
}
export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Workspace',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/sources', label: 'Data Sources', icon: Database, perm: 'sources.read' },
      { to: '/synthetic', label: 'Synthetic Sets', icon: Layers, perm: 'synthetic.read' },
      { to: '/canary', label: 'Canary', icon: Radar, perm: 'canary.read' },
      { to: '/projects', label: 'Labeling Projects', icon: FolderKanban, perm: 'labeling.read' },
      { to: '/workspace', label: 'Labeling Workspace', icon: PenLine, perm: 'labeling.label' },
      { to: '/gold', label: 'Gold Set', icon: Award, perm: 'quality.read' },
      { to: '/quality', label: 'Review and Quality', icon: ShieldCheck, perm: 'quality.read' },
      { to: '/exports', label: 'Export', icon: PackageOpen, perm: 'exports.read' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { to: '/activity', label: 'Activity', icon: Activity, perm: 'activity.read' },
      { to: '/settings', label: 'Settings', icon: Settings },
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
        <Bell size={18} aria-hidden />{q.data?.unread ? <span className="badge solid">{q.data.unread}</span> : null}
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

function pageTitle(pathname: string) {
  for (const s of NAV) for (const i of s.items) if (i.to !== '/' && pathname.startsWith(i.to)) return i.label;
  if (pathname.startsWith('/jobs')) return 'Jobs';
  if (pathname.startsWith('/notifications')) return 'Notifications';
  if (pathname.startsWith('/help')) return 'Help';
  return pathname === '/' ? 'Dashboard' : '';
}

export function Layout() {
  const { me, can, logout, setMe } = useAuth();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('aq.sidebar') === 'collapsed');
  const [mobile, setMobile] = useState(false);
  const [palette, setPalette] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    setMobile(false);
    setUserMenu(false);
  }, [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        toggle();
      }
      if (e.key === 'Escape') setMobile(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem('aq.sidebar', c ? 'expanded' : 'collapsed');
      return !c;
    });
  };
  const initials = (me?.user.name ?? '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobile ? 'mobile-open' : ''}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      {mobile ? <div className="scrim" onClick={() => setMobile(false)} aria-hidden /> : null}
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <Link to="/" aria-label="AuthenQ home">
            {collapsed ? <img src="/favicon.png" alt="AuthenQ" className="mark-img" /> : <img src="/authenq-logo.png" alt="AuthenQ" />}
          </Link>
          <button className="ghost icon collapse-btn" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar (Ctrl+\\)' : 'Collapse sidebar (Ctrl+\\)'}>
            {collapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
          </button>
        </div>
        <nav>
          {NAV.map((s) => {
            const items = s.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={s.section} className="nav-group">
                <div className="section">{s.section}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `nav ${isActive ? 'active' : ''}`} aria-label={collapsed ? i.label : undefined} data-tip={collapsed ? i.label : undefined}>
                    <i.icon size={18} strokeWidth={1.75} aria-hidden className="nav-icon" />
                    <span className="label">{i.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="foot">
          <NavLink to="/jobs" className={({ isActive }) => `nav ${isActive ? 'active' : ''}`} aria-label={collapsed ? 'Jobs' : undefined} data-tip={collapsed ? 'Jobs' : undefined}>
            <ListChecks size={18} strokeWidth={1.75} aria-hidden className="nav-icon" />
            <span className="label">Jobs</span>
          </NavLink>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost icon mobile-only" onClick={() => setMobile((m) => !m)} aria-label="Open navigation" aria-expanded={mobile}>
            <Menu size={18} aria-hidden />
          </button>
          <div className="topbar-title">{pageTitle(loc.pathname)}</div>
          <span className="right" />
          <button className="ghost search-trigger" onClick={() => setPalette(true)} aria-label="Open command palette">
            <Search size={16} aria-hidden />
            <span className="label">Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <NotificationBell />
          <div className="relative">
            <button className="ghost account-btn" onClick={() => setUserMenu((o) => !o)} aria-expanded={userMenu} aria-haspopup="menu" aria-label="Account menu">
              <span className="avatar" aria-hidden>{initials}</span>
              <span className="label">{me?.user.name}</span>
            </button>
            {userMenu ? (
              <div className="menu" role="menu" style={{ padding: 6 }}>
                <div style={{ padding: '6px 8px' }}>
                  <div><strong>{me?.user.name}</strong></div>
                  <div className="small muted">{me?.user.email}</div>
                  <div className="small muted">{me?.org.name} · {me?.role.name}</div>
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
                <button role="menuitem" className="ghost menu-item" onClick={() => nav('/settings/account')}>Account and security</button>
                <button role="menuitem" className="ghost menu-item" onClick={() => nav('/notifications')}>Notifications</button>
                <button role="menuitem" className="ghost menu-item" onClick={() => nav('/help')}>Help and documentation</button>
                <hr className="sep" />
                <button role="menuitem" className="ghost menu-item" onClick={async () => { await logout(); nav('/login'); }}>Sign out</button>
              </div>
            ) : null}
          </div>
        </header>
        {me && !me.user.emailVerified ? (
          <div className="callout" style={{ margin: '12px 32px 0' }}>
            Your email address is not verified yet. <button className="sm" onClick={() => api.post('/auth/resend-verification')}>Resend verification email</button>
          </div>
        ) : null}
        <main id="main" className="content" tabIndex={-1}>
          <div className="content-inner">
            <Outlet />
          </div>
        </main>
      </div>
      {palette ? <CommandPalette onClose={() => setPalette(false)} /> : null}
    </div>
  );
}
