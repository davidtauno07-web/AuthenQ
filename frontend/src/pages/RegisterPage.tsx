import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import logo from '@/assets/authenq-logo.png';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input } from '@/components/ui';

export const RegisterPage = () => {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    organizationName: '',
    industry: '',
    name: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const update = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({ ...form, industry: form.industry || undefined });
      navigate('/', { replace: true });
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-50 px-6 py-14">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-md border border-ink-200 bg-white p-8">
        <img src={logo} alt="AuthenQ" className="mb-5 h-14 w-14 object-contain" />
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Register organization</h1>
        <p className="mt-1 text-sm text-ink-500">
          The first account becomes the Organization Admin for this workspace.
        </p>

        <div className="mt-6 space-y-4">
          <Field label="Organization name">
            <Input
              required
              minLength={2}
              value={form.organizationName}
              onChange={(event) => update('organizationName')(event.target.value)}
            />
          </Field>
          <Field label="Industry" hint="Optional — used for reporting context.">
            <Input
              value={form.industry}
              onChange={(event) => update('industry')(event.target.value)}
              placeholder="Financial services"
            />
          </Field>
          <Field label="Your name">
            <Input
              required
              value={form.name}
              onChange={(event) => update('name')(event.target.value)}
            />
          </Field>
          <Field label="Work email">
            <Input
              type="email"
              required
              value={form.email}
              onChange={(event) => update('email')(event.target.value)}
            />
          </Field>
          <Field label="Password" hint="Minimum 8 characters.">
            <Input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={(event) => update('password')(event.target.value)}
            />
          </Field>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded border border-state-fail/30 bg-state-fail/5 px-3 py-2 text-sm text-state-fail">
            {error}
          </p>
        )}

        <Button type="submit" loading={submitting} className="mt-6 w-full">
          Create workspace
        </Button>
        <p className="mt-4 text-sm text-ink-500">
          Already registered?{' '}
          <Link to="/login" className="font-medium text-ink-900 underline">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
};
