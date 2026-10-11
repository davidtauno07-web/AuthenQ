import { badRequest } from '../lib/errors.js';
import { assertOutboundHost, blocksPrivateTargets } from '../lib/net.js';
import { mongoDriver } from './mongo.js';
import { azureBlobDriver, gcsDriver, s3Driver } from './objects.js';
import { mssqlDriver, mysqlDriver, oracleDriver, postgresDriver, redshiftDriver } from './sql.js';
import type { ConnectorConfig, ConnectorDriver } from './types.js';
import { bigqueryDriver, databricksDriver, snowflakeDriver } from './warehouses.js';

export const UNVERIFIED_FLAG = 'connectors.unverified';

export const DRIVERS: ConnectorDriver[] = [postgresDriver, mysqlDriver, mssqlDriver, oracleDriver, mongoDriver, s3Driver, azureBlobDriver, gcsDriver, redshiftDriver, snowflakeDriver, bigqueryDriver, databricksDriver];

export function driverFor(type: string): ConnectorDriver {
  const d = DRIVERS.find((x) => x.type === type);
  if (!d) throw badRequest(`Unknown connector type "${type}".`);
  return d;
}

export const secretKeys = (d: ConnectorDriver) => d.fields.filter((f) => f.secret).map((f) => f.key);

/** Public metadata for the catalog. Secrets are never part of it. */
export function describeDriver(d: ConnectorDriver) {
  return { type: d.type, name: d.name, category: d.category, description: d.description, verification: d.verification, verifiedWith: d.verifiedWith ?? null, prerequisites: d.prerequisites, supportsIncremental: d.supportsIncremental, fields: d.fields };
}

/** Validates required fields and keeps only declared keys. */
export function cleanConfig(d: ConnectorDriver, input: Record<string, unknown>): ConnectorConfig {
  const out: ConnectorConfig = {};
  for (const f of d.fields) {
    const v = input[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw badRequest(`${f.label} is required.`);
      continue;
    }
    if (f.type === 'boolean') out[f.key] = v === true || v === 'true';
    else if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) throw badRequest(`${f.label} must be a valid number.`);
      out[f.key] = n;
    } else {
      const s = String(v);
      if (s.length > (f.type === 'textarea' ? 20_000 : 2000)) throw badRequest(`${f.label} is too long.`);
      out[f.key] = s.trim();
    }
  }
  return out;
}

export function publicConfig(d: ConnectorDriver, cfg: ConnectorConfig) {
  const secrets = new Set(secretKeys(d));
  return Object.fromEntries(Object.entries(cfg).filter(([k]) => !secrets.has(k)));
}

/** Every host is checked against the outbound policy (private ranges blocked in production) before connecting. */
export async function assertTargets(d: ConnectorDriver, cfg: ConnectorConfig) {
  const hosts = d.hosts(cfg).filter(Boolean);
  if (!hosts.length) throw badRequest('The connector configuration does not include a host.');
  if (!blocksPrivateTargets()) return;
  for (const h of hosts) await assertOutboundHost(h, 'Connector hosts');
}
