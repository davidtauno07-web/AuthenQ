export const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
};

export const formatRelative = (value: string | null | undefined): string => {
  if (!value) return '—';
  const deltaMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const formatNumber = (value: number | null | undefined, digits = 0): string =>
  value === null || value === undefined || Number.isNaN(value)
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });

export const formatRatio = (value: number | null | undefined, digits = 4): string =>
  value === null || value === undefined ? '—' : value.toFixed(digits);

export const formatPercent = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}%`;

export const formatBytes = (value: number | null | undefined): string => {
  if (!value) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const TITLE_EXCEPTIONS: Record<string, string> = {
  k_anonymity: 'k-Anonymity',
  privacy_risk_score: 'Privacy Risk Score',
  reidentification_rate: 'Re-identification Rate',
};

export const humanize = (value: string | null | undefined): string => {
  if (!value) return '—';
  const exception = TITLE_EXCEPTIONS[value];
  if (exception) return exception;
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};
