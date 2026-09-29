import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/auth/AuthContext';
import { LoginPage } from './LoginPage';

describe('login workflow', () => {
  afterEach(() => vi.unstubAllGlobals());

  const renderLogin = () => render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<h1>Workspace loaded</h1>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  it('submits credentials, stores the token and enters the workspace', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        token: 'signed-session',
        user: { id: 'u1', name: 'Admin', role: 'ORG_ADMIN' },
        organization: { id: 'o1', name: 'Example', slug: 'example' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();
    await userEvent.type(screen.getByPlaceholderText('you@company.com'), 'admin@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'test-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Workspace loaded' });
    expect(window.localStorage.getItem('authenq.token')).toBe('signed-session');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/login'), expect.objectContaining({ method: 'POST' }));
  });

  it('keeps invalid credentials on the login screen and shows the API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
      json: async () => ({ message: 'Invalid credentials' }),
    }));
    renderLogin();
    await userEvent.type(screen.getByPlaceholderText('you@company.com'), 'viewer@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'incorrect');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials'));
    expect(window.localStorage.getItem('authenq.token')).toBeNull();
  });
});
