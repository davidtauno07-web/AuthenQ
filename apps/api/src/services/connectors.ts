import pg from 'pg';
import { prisma, Prisma } from '../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../modules/audit.js';
import type { RequestContext } from '../modules/context.js';
import { enqueue } from '../modules/jobs/queue.js';
import { assertOutboundHost, blocksPrivateTargets } from '../lib/net.js';
import { isFeatureEnabled } from '../modules/platform/events.js';
import type { ParsedTable } from './firewall.js';

/**
 * Connector registry. Only connectors with a working implementation are
 * exposed; others stay behind feature flags until they are built.
 */
export const CONNECTOR_TYPES = [
  { type: 'POSTGRES', name: 'PostgreSQL', flag: null, description: 'Read tables from a PostgreSQL database using a read-only connection string.' },
] as const;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_CONNECTOR_ROWS = 250_000;

export async function availableConnectorTypes(orgId: string) {
  const out = [];
  for (const c of CONNECTOR_TYPES) if (!c.flag || (await isFeatureEnabled(orgId, c.flag))) out.push(c);
  void orgId;
  return out;
}

/** Connector hosts are checked against the outbound policy before every connection. */
export async function assertConnectorTarget(connectionString: string) {
  if (!blocksPrivateTargets()) return;
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    throw badRequest('Use a single-host postgresql:// connection string.');
  }
  if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) throw badRequest('Set the host in the connection string itself, not with a host parameter.');
  await assertOutboundHost(u.hostname, 'Connector hosts');
}

function pgClient(connectionString: string) {
  return new pg.Client({ connectionString, statement_timeout: 60_000, query_timeout: 60_000, connectionTimeoutMillis: 10_000 });
}

export async function testPostgres(connectionString: string) {
  await assertConnectorTarget(connectionString);
  const client = pgClient(connectionString);
  try {
    await client.connect();
    const r = await client.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT 500`,
    );
    return r.rows.map((x) => `${x.table_schema}.${x.table_name}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function readPostgresTables(connectionString: string, tables: string[]): Promise<ParsedTable[]> {
  await assertConnectorTarget(connectionString);
  const client = pgClient(connectionString);
  await client.connect();
  try {
    await client.query('SET TRANSACTION READ ONLY').catch(() => undefined);
    const out: ParsedTable[] = [];
    for (const full of tables) {
      const [schema, name] = full.includes('.') ? full.split('.') : ['public', full];
      if (!IDENT.test(schema!) || !IDENT.test(name!)) throw badRequest(`"${full}" is not a valid table name.`);
      const r = await client.query(`SELECT * FROM "${schema}"."${name}" LIMIT ${MAX_CONNECTOR_ROWS}`);
      out.push({ name: name!.toLowerCase(), rows: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))) });
    }
    return out;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function listConnectors(ctx: RequestContext) {
  const rows = await prisma.connectorAccount.findMany({ where: { orgId: ctx.orgId, deletedAt: null }, orderBy: { createdAt: 'desc' }, include: { syncs: { orderBy: { startedAt: 'desc' }, take: 5 } } });
  return rows.map(({ credentialsEnc, ...r }) => ({ ...r, hasCredentials: !!credentialsEnc }));
}

export async function createConnector(ctx: RequestContext, input: { type: string; name: string; connectionString: string }) {
  const types = await availableConnectorTypes(ctx.orgId);
  if (!types.some((t) => t.type === input.type)) throw badRequest('This connector type is not available for your organization.');
  if (!/^postgres(ql)?:\/\//.test(input.connectionString)) throw badRequest('Use a postgresql:// connection string.');
  await assertConnectorTarget(input.connectionString);
  const c = await prisma.connectorAccount.create({ data: { orgId: ctx.orgId, type: input.type, name: input.name, credentialsEnc: encryptSecret(input.connectionString), createdById: ctx.userId } });
  await audit(ctx, { action: 'connector.created', resourceType: 'connector', resourceId: c.id, summary: `Added ${input.type} connector "${input.name}"` });
  return { id: c.id, name: c.name, type: c.type, status: c.status };
}

async function getConnector(ctx: RequestContext, id: string) {
  const c = await prisma.connectorAccount.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } });
  if (!c?.credentialsEnc) throw notFound('Connector');
  return c;
}

export async function checkConnector(ctx: RequestContext, id: string) {
  const c = await getConnector(ctx, id);
  try {
    const tables = await testPostgres(decryptSecret(c.credentialsEnc!));
    await prisma.connectorAccount.update({ where: { id }, data: { status: 'HEALTHY', lastHealthAt: new Date(), lastError: null, config: { tables } as Prisma.InputJsonValue } });
    return { ok: true, tables };
  } catch (err) {
    const message = (err as Error).message.replace(/postgres(ql)?:\/\/[^\s]+/g, '[connection string]').slice(0, 300);
    await prisma.connectorAccount.update({ where: { id }, data: { status: 'ERROR', lastHealthAt: new Date(), lastError: message } });
    return { ok: false, error: `Could not connect: ${message}` };
  }
}

export async function importFromConnector(ctx: RequestContext, id: string, sourceId: string, tables: string[]) {
  const c = await getConnector(ctx, id);
  await assertConnectorTarget(decryptSecret(c.credentialsEnc!));
  const source = await prisma.dataSource.findFirst({ where: { id: sourceId, orgId: ctx.orgId, deletedAt: null } });
  if (!source) throw notFound('Data source');
  if (!tables.length || tables.length > 50) throw badRequest('Choose between 1 and 50 tables.');
  const sync = await prisma.connectorSync.create({ data: { orgId: ctx.orgId, connectorAccountId: c.id, status: 'RUNNING' } });
  await prisma.dataSource.update({ where: { id: sourceId }, data: { status: 'INGESTING', kind: 'CONNECTOR' } });
  const job = await enqueue({ orgId: ctx.orgId, type: 'FIREWALL_INGEST', payload: { sourceId, connectorId: c.id, syncId: sync.id, tables }, resourceType: 'data_source', resourceId: sourceId, createdById: ctx.userId });
  await audit(ctx, { action: 'connector.import', resourceType: 'connector', resourceId: c.id, summary: `Importing ${tables.length} table(s) from "${c.name}" into "${source.name}"`, jobId: job.id });
  return { job, syncId: sync.id };
}

export async function deleteConnector(ctx: RequestContext, id: string) {
  const c = await getConnector(ctx, id);
  await prisma.connectorAccount.update({ where: { id }, data: { deletedAt: new Date(), credentialsEnc: null } });
  await audit(ctx, { action: 'connector.deleted', resourceType: 'connector', resourceId: id, summary: `Removed connector "${c.name}" and its stored credentials` });
}
