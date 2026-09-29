import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiRequest, clearToken, getToken, setToken } from '@/lib/api';
import type { AuthResponse, Organization, Role, User } from '@/lib/types';

interface AuthState {
  user: User | null;
  organization: Organization | null;
  loading: boolean;
}

interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  organizationName: string;
  industry?: string;
  name: string;
  email: string;
  password: string;
}

interface AuthContextValue extends AuthState {
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (role: Role) => boolean;
}

const ROLE_RANK: Record<Role, number> = { VIEWER: 1, ANALYST: 2, ORG_ADMIN: 3 };

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({
    user: null,
    organization: null,
    loading: Boolean(getToken()),
  });

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    apiRequest<{ user: User; organization: Organization }>('/auth/me')
      .then((data) => {
        if (!cancelled) {
          setState({ user: data.user, organization: data.organization, loading: false });
        }
      })
      .catch(() => {
        clearToken();
        if (!cancelled) setState({ user: null, organization: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setState({ user: null, organization: null, loading: false });
    window.addEventListener('authenq:unauthorized', onUnauthorized);
    return () => window.removeEventListener('authenq:unauthorized', onUnauthorized);
  }, []);

  const applySession = useCallback((data: AuthResponse) => {
    setToken(data.token);
    setState({ user: data.user, organization: data.organization, loading: false });
  }, []);

  const login = useCallback(
    async (input: LoginInput) => {
      applySession(await apiRequest<AuthResponse>('/auth/login', { method: 'POST', body: input }));
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      applySession(
        await apiRequest<AuthResponse>('/auth/register', { method: 'POST', body: input }),
      );
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    await apiRequest('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearToken();
    setState({ user: null, organization: null, loading: false });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      register,
      logout,
      hasRole: (role: Role) =>
        state.user ? ROLE_RANK[state.user.role] >= ROLE_RANK[role] : false,
    }),
    [state, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
};
