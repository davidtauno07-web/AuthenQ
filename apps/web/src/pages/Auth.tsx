import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth, type Me } from '../lib/auth';
import { ErrorBox, Field } from '../components/ui';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="side">
        <img src="/authenq-logo-white.png" alt="AuthenQ" />
        <div className="stack">
          <h1 style={{ fontSize: 30, lineHeight: 1.15, maxWidth: 440 }}>From raw data to AI-ready data, safely.</h1>
          <p style={{ color: 'var(--g400)', maxWidth: 440 }}>
            Real data stays behind the Firewall. Synthetic twins become the working material, traceable through Canary, and labeled with measured quality.
          </p>
        </div>
        <div className="pipeline">FIREWALL → TWIN → CANARY → AUTONOMOUS LABELING → YOUR MODEL</div>
      </div>
      <div className="form">
        <div className="stack" style={{ width: 'min(380px, 100%)' }}>
          <img src="/authenq-logo.png" alt="" style={{ height: 28, width: 'auto', alignSelf: 'flex-start' }} />
          <div>
            <h1>{title}</h1>
            {subtitle ? <p className="muted" style={{ marginTop: 4 }}>{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const { me, setMe } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/';
  useEffect(() => {
    if (me) nav(next, { replace: true });
  }, [me, nav, next]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await api.post<Me>('/auth/login', { email, password, ...(mfaCode ? { mfaCode } : {}) });
      setMe(m);
      nav(next, { replace: true });
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === 'MFA_REQUIRED') setNeedMfa(true);
      else setError(ae);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Sign in" subtitle="Use your work email and password.">
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} title="Sign-in failed" />
        <Field label="Email">
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needMfa ? (
          <Field label="Authenticator code" hint="Enter the 6-digit code from your authenticator app.">
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
          </Field>
        ) : null}
        <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="row between small">
          <Link to="/forgot-password">Forgot password?</Link>
          <Link to="/register">Create an organization</Link>
        </div>
        <p className="small muted">Single sign-on: enter your email and your administrator&apos;s SSO settings are discovered automatically when configured.</p>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', email: '', password: '', orgName: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMe(await api.post<Me>('/auth/register', f));
      nav('/');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame title="Create your organization" subtitle="You become the administrator. Invite your team afterwards.">
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <Field label="Your name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Work email"><input type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Password" hint="At least 12 characters, with letters and numbers."><input type="password" autoComplete="new-password" required minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="Organization name"><input required value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value })} /></Field>
        <button className="primary" disabled={busy} type="submit">{busy ? 'Creating…' : 'Create organization'}</button>
        <p className="small">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </AuthFrame>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <AuthFrame title="Reset your password" subtitle="We will email you a link that is valid for one hour.">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setMsg((await api.post<{ message: string }>('/auth/forgot-password', { email })).message);
          } catch (err) {
            setError(err as ApiError);
          }
        }}
      >
        <ErrorBox error={error} />
        {msg ? <div className="callout">{msg}</div> : null}
        <Field label="Email"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="primary" type="submit">Send reset link</button>
        <Link className="small" to="/login">Back to sign in</Link>
      </form>
    </AuthFrame>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <AuthFrame title="Choose a new password">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setMsg((await api.post<{ message: string }>('/auth/reset-password', { token: params.get('token') ?? '', password })).message);
          } catch (err) {
            setError(err as ApiError);
          }
        }}
      >
        <ErrorBox error={error} />
        {msg ? <div className="callout">{msg} <Link to="/login">Sign in</Link></div> : null}
        <Field label="New password" hint="At least 12 characters, with letters and numbers."><input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="primary" type="submit">Change password</button>
      </form>
    </AuthFrame>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const [state, setState] = useState<'pending' | 'ok' | ApiError>('pending');
  useEffect(() => {
    api.post('/auth/verify-email', { token: params.get('token') ?? '' }).then(() => setState('ok'), (e) => setState(e as ApiError));
  }, [params]);
  return (
    <AuthFrame title="Email verification">
      {state === 'pending' ? <p>Verifying…</p> : state === 'ok' ? <div className="callout">Your email address is verified. <Link to="/">Continue to AuthenQ</Link></div> : <ErrorBox error={state} />}
    </AuthFrame>
  );
}

export function AcceptInvite() {
  const [params] = useSearchParams();
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <AuthFrame title="Join your team" subtitle="Set your name and a password to accept the invitation.">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            setMe(await api.post<Me>('/auth/accept-invite', { token: params.get('token') ?? '', name, password }));
            nav('/');
          } catch (err) {
            setError(err as ApiError);
          }
        }}
      >
        <ErrorBox error={error} />
        <Field label="Your name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Password" hint="At least 12 characters. If you already have an account, enter its password."><input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="primary" type="submit">Accept invitation</button>
      </form>
    </AuthFrame>
  );
}
