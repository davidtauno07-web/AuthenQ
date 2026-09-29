import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import logoMark from '@/assets/authenq-mark.png';
import { useAuth } from '@/auth/AuthContext';
import { apiRequest } from '@/lib/api';
import { classNames } from '@/components/ui';

interface NavItem {
  label: string;
  to: string;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: (NavItem | NavGroup)[] = [
  { label: 'Overview', to: '/', end: true },
  {
    label: 'Testing',
    items: [
      { label: 'Privacy Shield', to: '/privacy-shield' },
      { label: 'Fairness Sword', to: '/fairness-sword' },
      { label: 'Test Runs', to: '/test-runs' },
    ],
  },
  { label: 'Models', to: '/models' },
  { label: 'Datasets', to: '/datasets' },
  { label: 'Data Sources', to: '/data-sources' },
  { label: 'Monitoring', to: '/monitoring' },
  { label: 'Alerts', to: '/alerts' },
  { label: 'Reports', to: '/reports' },
  { label: 'Integrations', to: '/integrations' },
  { label: 'Settings', to: '/settings' },
];

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  classNames(
    'block rounded px-3 py-2 text-sm transition',
    isActive ? 'bg-white text-ink-900 font-medium' : 'text-ink-300 hover:bg-ink-800 hover:text-white',
  );

export const AppShell = () => {
  const { user, organization, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const alertCounts = useQuery({
    queryKey: ['alerts', 'counts'],
    queryFn: () => apiRequest<{ open: number; bySeverity: Record<string, number> }>('/alerts/counts'),
    refetchInterval: 30_000,
  });

  const openAlerts = alertCounts.data?.open ?? 0;

  return (
    <div className="flex min-h-full bg-ink-50">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-ink-950 px-4 py-5 lg:flex">
        <div className="mb-8 flex items-center gap-3 px-1">
          <img src={logoMark} alt="AuthenQ" className="h-9 w-9 invert" />
          <div>
            <p className="text-sm font-semibold tracking-wide text-white">AuthenQ</p>
            <p className="text-[11px] leading-tight text-ink-400">
              Adversarial privacy &amp; bias testing
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto">
          {NAV.map((entry) =>
            'items' in entry ? (
              <div key={entry.label} className="pt-4">
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-widest text-ink-500">
                  {entry.label}
                </p>
                {entry.items.map((item) => (
                  <NavLink key={item.to} to={item.to} className={linkClass}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            ) : (
              <NavLink key={entry.to} to={entry.to} end={entry.end} className={linkClass}>
                <span className="flex items-center justify-between">
                  {entry.label}
                  {entry.label === 'Alerts' && openAlerts > 0 && (
                    <span className="rounded bg-state-fail px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      {openAlerts}
                    </span>
                  )}
                </span>
              </NavLink>
            ),
          )}
        </nav>

        <NavLink to="/docs" className={linkClass}>
          Documentation
        </NavLink>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-ink-200 bg-white px-6 py-3">
          <div className="flex items-center gap-3 lg:hidden">
            <img src={logoMark} alt="AuthenQ" className="h-7 w-7" />
            <span className="text-sm font-semibold">AuthenQ</span>
          </div>
          <div className="hidden min-w-0 flex-1 lg:block">
            <p className="truncate text-sm font-medium text-ink-800">{organization?.name}</p>
            <p className="text-xs text-ink-400">
              Continuous privacy and fairness testing · findings require human review
            </p>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded border border-ink-200 px-3 py-1.5 text-sm text-ink-800 hover:bg-ink-50"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
                {user?.name?.slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden sm:inline">{user?.name}</span>
              <span className="hidden text-xs text-ink-400 sm:inline">
                {user?.role.replace('_', ' ')}
              </span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-48 rounded border border-ink-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate('/settings');
                  }}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="block w-full px-4 py-2 text-left text-sm text-ink-700 hover:bg-ink-50"
                  onClick={async () => {
                    setMenuOpen(false);
                    await logout();
                    navigate('/login');
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-ink-200 bg-white px-4 py-2 lg:hidden">
          {NAV.flatMap((entry) => ('items' in entry ? entry.items : [entry])).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                classNames(
                  'whitespace-nowrap rounded px-3 py-1.5 text-sm',
                  isActive ? 'bg-ink-900 text-white' : 'text-ink-600',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
