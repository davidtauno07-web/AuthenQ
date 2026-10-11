import { badRequest } from '../lib/errors.js';

export type FieldType = 'text' | 'password' | 'number' | 'boolean' | 'textarea';
export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

/** VERIFIED = integration tests pass against a real server/emulator. UNVERIFIED = built against the official API but never run against a live account here. */
export type Verification = 'VERIFIED' | 'UNVERIFIED';
export type Category = 'DATABASE' | 'WAREHOUSE' | 'OBJECT_STORAGE';
export type ConnectorConfig = Record<string, string | number | boolean | undefined>;

export interface RemoteObject { name: string; kind: 'table' | 'collection' | 'file'; rowEstimate: number | null; sizeBytes?: number | null }
export interface RemoteColumn { name: string; type: string }
export interface PageRequest { limit: number; offset: number; incremental?: { column: string; after: string | number } }
export interface Page { rows: Record<string, unknown>[]; columns: RemoteColumn[]; hasMore: boolean }

export interface ConnectorDriver {
  type: string;
  name: string;
  category: Category;
  description: string;
  verification: Verification;
  verifiedWith?: string;
  prerequisites: string;
  supportsIncremental: boolean;
  fields: FieldSpec[];
  /** Hostnames this config will contact, checked against the outbound policy before every connection. */
  hosts(cfg: ConnectorConfig): string[];
  test(cfg: ConnectorConfig): Promise<{ objects: RemoteObject[] }>;
  list(cfg: ConnectorConfig): Promise<RemoteObject[]>;
  describe(cfg: ConnectorConfig, object: string): Promise<RemoteColumn[]>;
  readPage(cfg: ConnectorConfig, object: string, req: PageRequest): Promise<Page>;
}

export const IDENT = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/;

export function splitName(full: string, defaultSchema: string): [string, string] {
  const parts = full.split('.');
  const [schema, name] = parts.length === 2 ? parts : [defaultSchema, parts[0]!];
  if (parts.length > 2 || !IDENT.test(schema!) || !IDENT.test(name!)) throw badRequest(`"${full}" is not a valid table name.`);
  return [schema!, name!];
}

export function str(cfg: ConnectorConfig, key: string, fallback = ''): string {
  const v = cfg[key];
  return v === undefined || v === null || v === '' ? fallback : String(v);
}
export function num(cfg: ConnectorConfig, key: string, fallback: number): number {
  const n = Number(cfg[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export function bool(cfg: ConnectorConfig, key: string, fallback = false): boolean {
  const v = cfg[key];
  return v === undefined || v === '' ? fallback : v === true || v === 'true';
}

/** Converts driver-specific values (dates, bigints, buffers, BSON ids, nested documents) to plain JSON-safe values. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
  if (typeof v === 'object') {
    const o = v as { _bsontype?: string; toHexString?: () => string; toString: () => string };
    if (o._bsontype === 'ObjectId' && o.toHexString) return o.toHexString();
    if (o._bsontype === 'Decimal128' || o._bsontype === 'Long') return o.toString();
    try {
      return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    } catch {
      return String(v);
    }
  }
  return v;
}
export const plainRow = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)]));

const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|ESOCKET|Connection lost|server selection|timed out|429|503/i;

export async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseMs = 400): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !TRANSIENT.test((err as Error).message ?? '')) throw err;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
    }
  }
}

export function hostOf(url: string): string[] {
  try {
    return [new URL(url).hostname];
  } catch {
    return [];
  }
}

/** Removes credentials from driver error messages before they are stored or shown. */
export function redact(message: string, cfg: ConnectorConfig, secretKeys: string[]): string {
  let m = message;
  for (const k of secretKeys) {
    const v = cfg[k];
    if (typeof v === 'string' && v.length >= 4) m = m.split(v).join('[redacted]');
  }
  return m
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '[connection string]')
    .replace(/(AccountKey|SharedAccessSignature|password|pwd|token)=([^;\s]+)/gi, '$1=[redacted]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[key]')
    .slice(0, 400);
}
