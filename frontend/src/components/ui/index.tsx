import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useEffect } from 'react';
import type { AlertStatus, Severity, TestResult } from '@/lib/types';

export const classNames = (...values: (string | false | null | undefined)[]): string =>
  values.filter(Boolean).join(' ');

export const Card = ({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={classNames('card', className)}>
    {(title || action) && (
      <header className="card-header">
        <h2 className="card-title">{title}</h2>
        {action}
      </header>
    )}
    <div className="px-5 py-4">{children}</div>
  </section>
);

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-ink-900 text-white hover:bg-ink-800 disabled:bg-ink-400',
  secondary: 'border border-ink-300 bg-white text-ink-900 hover:bg-ink-50 disabled:text-ink-400',
  ghost: 'text-ink-600 hover:bg-ink-100 disabled:text-ink-300',
  danger: 'bg-state-fail text-white hover:opacity-90 disabled:opacity-60',
};

export const Button = ({
  variant = 'primary',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }) => (
  <button
    {...props}
    disabled={props.disabled || loading}
    className={classNames(
      'inline-flex items-center justify-center gap-2 rounded px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed',
      BUTTON_STYLES[variant],
      className,
    )}
  >
    {loading && <Spinner className="h-3.5 w-3.5" />}
    {children}
  </button>
);

export const Spinner = ({ className }: { className?: string }) => (
  <span
    role="status"
    aria-label="Loading"
    className={classNames(
      'inline-block animate-spin rounded-full border-2 border-current border-r-transparent',
      className ?? 'h-4 w-4',
    )}
  />
);

const RESULT_STYLES: Record<TestResult, string> = {
  PASS: 'bg-state-pass/10 text-state-pass border-state-pass/30',
  WARNING: 'bg-state-warn/10 text-state-warn border-state-warn/30',
  FAIL: 'bg-state-fail/10 text-state-fail border-state-fail/30',
  INCONCLUSIVE: 'bg-ink-100 text-ink-500 border-ink-300',
};

export const ResultBadge = ({ result }: { result: TestResult | null | undefined }) => (
  <span
    className={classNames(
      'inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
      result ? RESULT_STYLES[result] : 'border-ink-300 bg-ink-100 text-ink-500',
    )}
  >
    {result ?? 'Pending'}
  </span>
);

export const StatusBadge = ({ status }: { status: string }) => {
  const tone =
    status === 'COMPLETED' || status === 'CONNECTED' || status === 'ACTIVE' || status === 'MONITORING'
      ? 'border-ink-900 bg-ink-900 text-white'
      : status === 'RUNNING' || status === 'QUEUED' || status === 'GENERATING'
        ? 'border-ink-400 bg-white text-ink-700'
        : status === 'FAILED'
          ? 'border-state-fail/30 bg-state-fail/10 text-state-fail'
          : 'border-ink-200 bg-ink-100 text-ink-500';
  return (
    <span
      className={classNames(
        'inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
        tone,
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
};

const SEVERITY_STYLES: Record<Severity, string> = {
  LOW: 'border-ink-300 bg-ink-100 text-ink-600',
  MEDIUM: 'border-state-warn/30 bg-state-warn/10 text-state-warn',
  HIGH: 'border-state-fail/30 bg-state-fail/10 text-state-fail',
  CRITICAL: 'border-state-fail bg-state-fail text-white',
};

export const SeverityBadge = ({ severity }: { severity: Severity }) => (
  <span
    className={classNames(
      'inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
      SEVERITY_STYLES[severity],
    )}
  >
    {severity}
  </span>
);

const ALERT_STATUS_STYLES: Record<AlertStatus, string> = {
  NEW: 'border-ink-900 bg-ink-900 text-white',
  INVESTIGATING: 'border-state-warn/40 bg-state-warn/10 text-state-warn',
  RESOLVED: 'border-state-pass/30 bg-state-pass/10 text-state-pass',
  DISMISSED: 'border-ink-200 bg-ink-100 text-ink-500',
};

export const AlertStatusBadge = ({ status }: { status: AlertStatus }) => (
  <span
    className={classNames(
      'inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide',
      ALERT_STATUS_STYLES[status],
    )}
  >
    {status}
  </span>
);

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{title}</h1>
      {description && <p className="mt-1 max-w-3xl text-sm text-ink-500">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>
);

export const LoadingState = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex items-center gap-3 rounded-md border border-dashed border-ink-200 bg-white px-5 py-10 text-sm text-ink-500">
    <Spinner />
    {label}…
  </div>
);

export const ErrorState = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => (
  <div className="rounded-md border border-state-fail/30 bg-state-fail/5 px-5 py-6">
    <p className="text-sm font-semibold text-state-fail">Something went wrong</p>
    <p className="mt-1 text-sm text-ink-600">
      {error instanceof Error ? error.message : 'Unexpected error'}
    </p>
    {onRetry && (
      <Button variant="secondary" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    )}
  </div>
);

export const EmptyState = ({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <div className="rounded-md border border-dashed border-ink-200 bg-white px-5 py-10 text-center">
    <p className="text-sm font-semibold text-ink-700">{title}</p>
    {description && <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">{description}</p>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

export const Metric = ({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'pass' | 'warn' | 'fail' | 'neutral';
}) => (
  <div className="card px-5 py-4">
    <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">{label}</p>
    <p
      className={classNames(
        'mt-2 font-semibold tracking-tight text-metric',
        tone === 'pass' && 'text-state-pass',
        tone === 'warn' && 'text-state-warn',
        tone === 'fail' && 'text-state-fail',
        (!tone || tone === 'neutral') && 'text-ink-900',
      )}
    >
      {value}
    </p>
    {hint && <p className="mt-1 text-xs text-ink-500">{hint}</p>}
  </div>
);

export const ProgressBar = ({ value }: { value: number }) => (
  <div className="h-1.5 w-full overflow-hidden rounded bg-ink-100">
    <div
      className="h-full bg-ink-900 transition-all"
      style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
    />
  </div>
);

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <label className="block">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
  </label>
);

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={classNames('input', props.className)} />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...props} className={classNames('input', props.className)} />
);

export const Modal = ({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/50 p-6">
      <div role="dialog" aria-label={title} className="w-full max-w-2xl rounded-md bg-white shadow-lg">
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-4">
          <h2 className="text-base font-semibold text-ink-900">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close dialog">
            ✕
          </Button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex justify-end gap-2 border-t border-ink-100 px-5 py-4">{footer}</footer>
        )}
      </div>
    </div>
  );
};

export const Table = ({ head, children }: { head: ReactNode; children: ReactNode }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse">
      <thead>
        <tr className="bg-ink-50">{head}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={classNames('px-4 py-2', className)}>{children}</th>
);

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={classNames('px-4 py-3 align-middle', className)}>{children}</td>
);
