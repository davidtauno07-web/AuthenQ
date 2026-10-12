import { prisma, Prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../modules/audit.js';
import type { RequestContext } from '../modules/context.js';
import { enqueue } from '../modules/jobs/queue.js';
import { isFeatureEnabled } from '../modules/platform/events.js';
import { assertTargets, cleanConfig, describeDriver, driverFor, DRIVERS, publicConfig, secretKeys, UNVERIFIED_FLAG } from '../connectors/registry.js';
import { redact, type ConnectorConfig, type RemoteObject } from '../connectors/types.js';
import { PURGED_SOURCE, type ParsedTable } from './firewall.js';

export const MAX_CONNECTOR_ROWS = 250_000;
const BATCH = 5000;

/**
 * Connector catalog. Verified connectors pass integration tests against real servers or the
 * vendors' official emulators. Unverified connectors are listed with their prerequisites but can
 * only be created after an administrator enables the "connectors.unverified" feature flag.
 */
export async function availableConnectorTypes(orgId: string) {
  const unverifiedEnabled = await isFeatureEnabled(orgId, UNVERIFIED_FLAG);
  return DRIVERS.map((d) => ({ ...describeDriver(d), flag: d.verification === 'VERIFIED' ? null : UNVERIFIED_FLAG, available: d.verification === 'VERIFIED' || unverifiedEnabled }));
}

export function decodeConfig(credentialsEnc: string): ConnectorConfig {
  const raw = decryptSecret(credentialsEnc);
  return raw.startsWith('{') ? (JSON.parse(raw) as ConnectorConfig) : { connectionString: raw };
}

const safeError = (type: string, cfg: ConnectorConfig, err: unknown) => redact((err as Error)?.message ?? String(err), cfg, secretKeys(driverFor(type)));

export async function listConnectors(ctx: RequestContext) {
  const rows = await prisma.connectorAccount.findMany({ where: { orgId: ctx.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' }, include: { syncs: { orderBy: { startedAt: 'desc' }, take: 5 } } });
  return rows.map(({ credentialsEnc, ...r }) => ({ ...r, hasCredentials: !!credentialsEnc, verification: DRIVERS.find((d) => d.type === r.type)?.verification ?? 'UNVERIFIED' }));
}

export async function createConnector(ctx: RequestContext, input: { type: string; name: string; config: Record<string, unknown> }) {
  const types = await availableConnectorTypes(ctx.orgId);
  const t = types.find((x) => x.type === input.type);
  if (!t) throw badRequest('Unknown connector type.');
  if (!t.available) throw badRequest(`${t.name} is not verified. An administrator must enable unverified connectors before it can be used.`);
  const driver = driverFor(input.type);
  const cfg = cleanConfig(driver, input.config);
  await assertTargets(driver, cfg);
  const c = await prisma.connectorAccount.create({
    data: { orgId: ctx.orgId, type: input.type, name: input.name, credentialsEnc: encryptSecret(JSON.stringify(cfg)), config: { settings: publicConfig(driver, cfg) } as Prisma.InputJsonValue, createdById: ctx.userId },
  });
  await audit(ctx, { action: 'connector.created', resourceType: 'connector', resourceId: c.id, summary: `Added ${driver.name} connector "${input.name}"` });
  return { id: c.id, name: c.name, type: c.type, status: c.status };
}

async function getConnector(ctx: RequestContext, id: string) {
  const c = await prisma.connectorAccount.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } });
  if (!c?.credentialsEnc) throw notFound('Connector');
  const driver = driverFor(c.type);
  const cfg = decodeConfig(c.credentialsEnc);
  await assertTargets(driver, cfg);
  return { c, driver, cfg };
}

export async function checkConnector(ctx: RequestContext, id: string) {
  const { c, driver, cfg } = await getConnector(ctx, id);
  const settings = (c.config as { settings?: unknown })?.settings ?? publicConfig(driver, cfg);
  try {
    const { objects } = await driver.test(cfg);
    await prisma.connectorAccount.update({ where: { id }, data: { status: 'HEALTHY', lastHealthAt: new Date(), lastError: null, config: { settings, objects } as unknown as Prisma.InputJsonValue } });
    await audit(ctx, { action: 'connector.tested', resourceType: 'connector', resourceId: id, summary: `Connection test for "${c.name}" succeeded (${objects.length} objects found)` });
    return { ok: true, objects, tables: objects.map((o) => o.name) };
  } catch (err) {
    const message = safeError(c.type, cfg, err);
    await prisma.connectorAccount.update({ where: { id }, data: { status: 'ERROR', lastHealthAt: new Date(), lastError: message } });
    await audit(ctx, { action: 'connector.test_failed', resourceType: 'connector', resourceId: id, summary: `Connection test for "${c.name}" failed` });
    return { ok: false, error: `Could not connect: ${message}`, objects: [] as RemoteObject[], tables: [] as string[] };
  }
}

export async function describeObject(ctx: RequestContext, id: string, object: string) {
  const { c, driver, cfg } = await getConnector(ctx, id);
  try {
    return { columns: await driver.describe(cfg, object) };
  } catch (err) {
    throw badRequest(`Could not read the schema: ${safeError(c.type, cfg, err)}`);
  }
}

/** Paged preview of raw source rows. Restricted to roles allowed to see real data; content is never logged. */
export async function previewObject(ctx: RequestContext, id: string, object: string, offset: number, limit: number) {
  const { c, driver, cfg } = await getConnector(ctx, id);
  try {
    const page = await driver.readPage(cfg, object, { limit: Math.min(Math.max(limit, 1), 100), offset: Math.max(offset, 0) });
    await audit(ctx, { action: 'connector.previewed', resourceType: 'connector', resourceId: id, summary: `Previewed ${page.rows.length} source rows of "${object}" from "${c.name}"` });
    return { ...page, offset };
  } catch (err) {
    throw badRequest(`Could not read rows: ${safeError(c.type, cfg, err)}`);
  }
}

/** Reads whole objects in pages for Firewall ingestion. Stops at MAX_CONNECTOR_ROWS per object and honours cancellation between pages. */
/** Gives each imported table a distinct name: sheets such as "Sales-2026" and "Sales 2026" both normalize to sales_2026. */
export function tableNamer() {
  const used = new Set<string>();
  return (n: string) => {
    let candidate = n;
    for (let i = 2; used.has(candidate); i++) candidate = `${n}_${i}`;
    used.add(candidate);
    return candidate;
  };
}

export async function readConnectorTables(
  connector: { type: string; credentialsEnc: string | null },
  objects: string[],
  opts: { onProgress?: (msg: string) => Promise<void>; shouldStop?: () => Promise<boolean> } = {},
): Promise<ParsedTable[]> {
  if (!connector.credentialsEnc) throw new Error('The connector has no stored credentials.');
  const driver = driverFor(connector.type);
  const cfg = decodeConfig(connector.credentialsEnc);
  await assertTargets(driver, cfg);
  const out: ParsedTable[] = [];
  const uniqueName = tableNamer();
  try {
    for (const object of objects) {
      const base = object.split('/').pop()!.split('.').filter(Boolean);
      const name = (driver.category === 'OBJECT_STORAGE' ? base.slice(0, -1).join('_') || base[0]! : base.pop()!).toLowerCase();
      if (driver.readTables) {
        if (opts.shouldStop && (await opts.shouldStop())) throw new Error('The import was cancelled.');
        const tables = await driver.readTables(cfg, object);
        for (const t of tables) {
          const rows = t.rows.slice(0, MAX_CONNECTOR_ROWS);
          const tableName = uniqueName(tables.length > 1 ? `${name}_${t.name}`.toLowerCase() : name);
          out.push({ name: tableName, rows });
          await opts.onProgress?.(`Read ${rows.length} rows from ${object}${tables.length > 1 ? ` (table ${t.name}, imported as ${tableName})` : ''}${t.rows.length > MAX_CONNECTOR_ROWS ? ` (stopped at the ${MAX_CONNECTOR_ROWS}-row limit)` : ''}`);
        }
        continue;
      }
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; offset < MAX_CONNECTOR_ROWS; offset += BATCH) {
        if (opts.shouldStop && (await opts.shouldStop())) throw new Error('The import was cancelled.');
        const page = await driver.readPage(cfg, object, { limit: Math.min(BATCH, MAX_CONNECTOR_ROWS - offset), offset });
        rows.push(...page.rows);
        if (!page.hasMore) break;
      }
      out.push({ name: uniqueName(name), rows });
      await opts.onProgress?.(`Read ${rows.length} rows from ${object}${rows.length >= MAX_CONNECTOR_ROWS ? ` (stopped at the ${MAX_CONNECTOR_ROWS}-row limit)` : ''}`);
    }
  } catch (err) {
    throw new Error(safeError(connector.type, cfg, err));
  }
  return out;
}

export async function importFromConnector(ctx: RequestContext, id: string, sourceId: string, tables: string[]) {
  const { c } = await getConnector(ctx, id);
  const source = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: ctx.orgId, deletedAt: null } });
  if (!source) throw notFound('Data source');
  if (source.sourcePurgedAt) throw badRequest(PURGED_SOURCE);
  if (!tables.length || tables.length > 50) throw badRequest('Choose between 1 and 50 tables.');
  const sync = await prisma.connectorSync.create({ data: { orgId: ctx.orgId, connectorAccountId: c.id, status: 'RUNNING' } });
  await prisma.dataSource.update({ where: { id: sourceId }, data: { status: 'INGESTING', kind: 'CONNECTOR' } });
  const job = await enqueue({ orgId: ctx.orgId, type: 'FIREWALL_INGEST', payload: { sourceId, connectorId: c.id, syncId: sync.id, tables }, resourceType: 'data_source', resourceId: sourceId, createdById: ctx.userId });
  await audit(ctx, { action: 'connector.import', resourceType: 'connector', resourceId: c.id, summary: `Importing ${tables.length} object(s) from "${c.name}" into "${source.name}"`, jobId: job.id });
  return { job, syncId: sync.id };
}

export async function deleteConnector(ctx: RequestContext, id: string) {
  const c = await prisma.connectorAccount.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } });
  if (!c) throw notFound('Connector');
  await prisma.connectorAccount.update({ where: { id }, data: { deletedAt: new Date(), credentialsEnc: null } });
  await audit(ctx, { action: 'connector.deleted', resourceType: 'connector', resourceId: id, summary: `Removed connector "${c.name}" and its stored credentials` });
}
