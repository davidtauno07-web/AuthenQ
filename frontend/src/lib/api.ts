const TOKEN_KEY = 'authenq.token';

export const getToken = (): string | null => window.localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => window.localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => window.localStorage.removeItem(TOKEN_KEY);

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const token = getToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    signal: options.signal,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('authenq:unauthorized'));
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      details?: unknown;
    };
    throw new ApiError(response.status, payload.message ?? response.statusText, payload.details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

/** Absolute URL for links the browser must fetch itself (report downloads). */
export const apiUrl = (path: string): string => `${BASE_URL}${path}`;

export const downloadFile = async (path: string, filename: string): Promise<void> => {
  const token = getToken();
  const response = await fetch(apiUrl(path), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ApiError(response.status, 'Download failed');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
