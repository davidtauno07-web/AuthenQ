export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  actions?: { label: string; href?: string; action?: string }[];
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.message);
  }
  get code() {
    return this.body.code;
  }
  get reasons(): string[] {
    const d = this.body.details as { reasons?: string[] } | undefined;
    return Array.isArray(d?.reasons) ? d!.reasons : [];
  }
}

const BASE = '/api/v1';

function csrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)aq_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') headers['x-csrf-token'] = csrf();
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'AuthenQ could not reach the server. Check your connection and try again.' });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: ApiErrorBody } | null)?.error ?? { code: 'HTTP_' + res.status, message: `The server answered with status ${res.status}.` };
    if (res.status === 401) window.dispatchEvent(new CustomEvent('aq:unauthorized'));
    throw new ApiError(res.status, err);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  upload: <T>(path: string, form: FormData) => request<T>('POST', path, form),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
