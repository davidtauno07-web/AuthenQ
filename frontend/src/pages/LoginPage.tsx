import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import logo from '@/assets/authenq-logo.png';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input } from '@/components/ui';

export const LoginPage = () => {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-ink-950 px-12 py-14 text-white lg:flex">
        <img src={logo} alt="AuthenQ" className="h-40 w-40 object-contain invert" />
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            Autonomous adversarial privacy &amp; bias-testing infrastructure
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-ink-300">
            AuthenQ continuously tests AI systems and data pipelines for privacy leakage,
            re-identification exposure and potential fairness disparities — then records the
            evidence. Findings indicate potential risk requiring human review; they are not legal
            conclusions.
          </p>
        </div>
        <p className="text-xs text-ink-500">Prototype environment · fictional demo data only</p>
      </div>

      <div className="flex items-center justify-center px-6 py-14">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <img src={logo} alt="AuthenQ" className="mb-6 h-16 w-16 object-contain lg:hidden" />
          <h2 className="text-xl font-semibold tracking-tight text-ink-900">Sign in</h2>
          <p className="mt-1 text-sm text-ink-500">Access your organization&apos;s testing workspace.</p>

          <div className="mt-6 space-y-4">
            <Field label="Work email">
              <Input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded border border-state-fail/30 bg-state-fail/5 px-3 py-2 text-sm text-state-fail">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="mt-6 w-full">
            Sign in
          </Button>

          <p className="mt-4 text-sm text-ink-500">
            No workspace yet?{' '}
            <Link to="/register" className="font-medium text-ink-900 underline">
              Register an organization
            </Link>
          </p>

          <div className="mt-8 rounded border border-ink-200 bg-white px-4 py-3 text-xs text-ink-500">
            <p className="font-semibold text-ink-700">Demo credentials</p>
            <p className="mt-1">admin@authenq.demo · analyst@authenq.demo · viewer@authenq.demo</p>
            <p>Password: AuthenQ!Demo2026</p>
            <button
              type="button"
              className="mt-2 font-medium text-ink-900 underline"
              onClick={() => {
                setEmail('admin@authenq.demo');
                setPassword('AuthenQ!Demo2026');
              }}
            >
              Fill demo admin
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
