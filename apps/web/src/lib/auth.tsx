import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; mfaEnabled: boolean };
  org: { id: string; name: string; slug: string; plan: string };
  role: { key: string; name: string };
  permissions: string[];
  organizations: { id: string; name: string; role: string }[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Me | null>({
    queryKey: ['auth/me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['auth/me'], null);
    window.addEventListener('aq:unauthorized', onUnauth);
    return () => window.removeEventListener('aq:unauthorized', onUnauth);
  }, [qc]);
  // qc.clear() would also drop the auth/me query this provider observes, so the new user never reaches it.
  const clearOtherQueries = () => qc.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth/me' });
  const me = q.data ?? null;
  const perms = new Set(me?.permissions ?? []);
  const value: AuthState = {
    me,
    loading: q.isLoading,
    can: (p) => perms.has(p),
    setMe: (m) => {
      clearOtherQueries();
      qc.setQueryData(['auth/me'], m);
    },
    refresh: () => q.refetch(),
    logout: async () => {
      await api.post('/auth/logout').catch(() => undefined);
      clearOtherQueries();
      qc.setQueryData(['auth/me'], null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
