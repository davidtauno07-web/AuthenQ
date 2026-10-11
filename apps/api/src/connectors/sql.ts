import pg from 'pg';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import oracledb from 'oracledb';
import { badRequest } from '../lib/errors.js';
import { bool, IDENT, num, plainRow, splitName, str, withRetry, type ConnectorConfig, type ConnectorDriver, type PageRequest, type RemoteColumn, type RemoteObject } from './types.js';

const TIMEOUT = 60_000;

function incrementalColumn(req: PageRequest) {
  if (!req.incremental) return null;
  if (!IDENT.test(req.incremental.column)) throw badRequest('The incremental column name is not valid.');
  return req.incremental.column;
}

// ── PostgreSQL (and Redshift, which speaks the PostgreSQL wire protocol) ──────────
async function withPg<T>(cfg: ConnectorConfig, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: str(cfg, 'connectionString'), statement_timeout: TIMEOUT, query_timeout: TIMEOUT, connectionTimeoutMillis: 10_000 });
  await withRetry(() => client.connect());
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY').catch(() => undefined);
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function pgDriver(type: 'POSTGRES' | 'REDSHIFT'): ConnectorDriver {
  const redshift = type === 'REDSHIFT';
  const list = (cfg: ConnectorConfig) =>
    withPg(cfg, async (c) => {
      const r = await c.query<{ s: string; t: string; n: string | null }>(
        `SELECT t.table_schema AS s, t.table_name AS t, ${redshift ? 'NULL' : 'c.reltuples::bigint'}::text AS n
         FROM information_schema.tables t ${redshift ? '' : "LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)"}
         WHERE t.table_type = 'BASE TABLE' AND t.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2 LIMIT 500`,
      );
      return r.rows.map<RemoteObject>((x) => ({ name: `${x.s}.${x.t}`, kind: 'table', rowEstimate: x.n !== null && Number(x.n) >= 0 ? Number(x.n) : null }));
    });
  return {
    type,
    name: redshift ? 'Amazon Redshift' : 'PostgreSQL',
    category: redshift ? 'WAREHOUSE' : 'DATABASE',
    description: redshift ? 'Read tables from Amazon Redshift over its PostgreSQL-compatible protocol.' : 'Read tables from a PostgreSQL database using a read-only connection string.',
    verification: redshift ? 'UNVERIFIED' : 'VERIFIED',
    verifiedWith: redshift ? undefined : 'PostgreSQL 16',
    prerequisites: redshift
      ? 'Requires an Amazon Redshift cluster or Serverless workgroup reachable from the AuthenQ server and a read-only database user. Uses the PostgreSQL driver; not yet tested against a live Redshift cluster.'
      : 'A PostgreSQL 12+ server reachable from the AuthenQ server and a user with SELECT-only grants.',
    supportsIncremental: true,
    fields: [{ key: 'connectionString', label: 'Connection string', type: 'password', secret: true, required: true, placeholder: redshift ? 'postgresql://user:pass@cluster.region.redshift.amazonaws.com:5439/dev' : 'postgresql://readonly:pass@host:5432/db' }],
    hosts: (cfg) => {
      const cs = str(cfg, 'connectionString');
      if (!/^postgres(ql)?:\/\//.test(cs)) throw badRequest('Use a postgresql:// connection string.');
      const u = new URL(cs);
      if (u.searchParams.has('host') || u.searchParams.has('hostaddr')) throw badRequest('Set the host in the connection string itself, not with a host parameter.');
      return [u.hostname];
    },
    test: async (cfg) => ({ objects: await list(cfg) }),
    list,
    describe: (cfg, object) =>
      withPg(cfg, async (c) => {
        const [s, t] = splitName(object, 'public');
        const r = await c.query<{ name: string; type: string }>('SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position', [s, t]);
        return r.rows;
      }),
    readPage: (cfg, object, req) =>
      withPg(cfg, async (c) => {
        const [s, t] = splitName(object, 'public');
        const inc = incrementalColumn(req);
        const where = inc ? `WHERE "${inc}" > $3` : '';
        const order = inc ? `"${inc}"` : '1';
        const params: unknown[] = [req.limit + 1, req.offset];
        if (inc) params.push(req.incremental!.after);
        const r = await c.query(`SELECT * FROM "${s}"."${t}" ${where} ORDER BY ${order} LIMIT $1 OFFSET $2`, params);
        const rows = r.rows.slice(0, req.limit).map(plainRow);
        return { rows, columns: r.fields.map((f) => ({ name: f.name, type: String(f.dataTypeID) })), hasMore: r.rows.length > req.limit };
      }),
  };
}

export const postgresDriver = pgDriver('POSTGRES');
export const redshiftDriver = pgDriver('REDSHIFT');

// ── MySQL / MariaDB ─────────────────────────────────────────────────────────────
async function withMysql<T>(cfg: ConnectorConfig, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await withRetry(() =>
    mysql.createConnection({ host: str(cfg, 'host'), port: num(cfg, 'port', 3306), user: str(cfg, 'user'), password: str(cfg, 'password'), database: str(cfg, 'database'), ssl: bool(cfg, 'ssl') ? {} : undefined, connectTimeout: 10_000, dateStrings: false, supportBigNumbers: true, bigNumberStrings: true }),
  );
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY').catch(() => undefined);
    await conn.query(`SET SESSION MAX_EXECUTION_TIME=${TIMEOUT}`).catch(() => undefined);
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

const mysqlList = (cfg: ConnectorConfig) =>
  withMysql(cfg, async (c) => {
    const [rows] = await c.query("SELECT table_name AS t, table_rows AS n FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema = DATABASE() ORDER BY 1 LIMIT 500");
    return (rows as { t: string; n: string | number | null }[]).map<RemoteObject>((x) => ({ name: x.t, kind: 'table', rowEstimate: x.n === null ? null : Number(x.n) }));
  });

export const mysqlDriver: ConnectorDriver = {
  type: 'MYSQL',
  name: 'MySQL',
  category: 'DATABASE',
  description: 'Read tables from MySQL 8 (or compatible MariaDB) with a read-only user.',
  verification: 'VERIFIED',
  verifiedWith: 'MySQL 8.4',
  prerequisites: 'A MySQL 8+ server reachable from the AuthenQ server and a user with SELECT-only grants on the database.',
  supportsIncremental: true,
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'db.example.com' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '3306' },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
    { key: 'ssl', label: 'Require TLS', type: 'boolean' },
  ],
  hosts: (cfg) => [str(cfg, 'host')],
  test: async (cfg) => ({ objects: await mysqlList(cfg) }),
  list: mysqlList,
  describe: (cfg, object) =>
    withMysql(cfg, async (c) => {
      const [, t] = splitName(object, '_');
      const [rows] = await c.query('SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [t]);
      return rows as RemoteColumn[];
    }),
  readPage: (cfg, object, req) =>
    withMysql(cfg, async (c) => {
      const [, t] = splitName(object, '_');
      const inc = incrementalColumn(req);
      const sql = `SELECT * FROM \`${t}\` ${inc ? `WHERE \`${inc}\` > ?` : ''} ORDER BY ${inc ? `\`${inc}\`` : '1'} LIMIT ? OFFSET ?`;
      const params = inc ? [req.incremental!.after, req.limit + 1, req.offset] : [req.limit + 1, req.offset];
      const [rows, fields] = await c.query(sql, params);
      const list = rows as Record<string, unknown>[];
      return { rows: list.slice(0, req.limit).map(plainRow), columns: (fields ?? []).map((f) => ({ name: f.name, type: String(f.type) })), hasMore: list.length > req.limit };
    }),
};

// ── Microsoft SQL Server / Azure SQL ────────────────────────────────────────────
async function withMssql<T>(cfg: ConnectorConfig, fn: (p: mssql.ConnectionPool) => Promise<T>): Promise<T> {
  const pool = new mssql.ConnectionPool({
    server: str(cfg, 'host'),
    port: num(cfg, 'port', 1433),
    database: str(cfg, 'database'),
    user: str(cfg, 'user'),
    password: str(cfg, 'password'),
    options: { encrypt: bool(cfg, 'encrypt', true), trustServerCertificate: bool(cfg, 'trustServerCertificate'), readOnlyIntent: true },
    connectionTimeout: 10_000,
    requestTimeout: TIMEOUT,
    pool: { max: 1, min: 0 },
  });
  await withRetry(() => pool.connect());
  try {
    return await fn(pool);
  } finally {
    await pool.close().catch(() => undefined);
  }
}

const mssqlList = (cfg: ConnectorConfig) =>
  withMssql(cfg, async (p) => {
    const r = await p.request().query<{ s: string; t: string; n: number | null }>(
      `SELECT TOP 500 s.name AS s, t.name AS t, SUM(pt.rows) AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions pt ON pt.object_id = t.object_id AND pt.index_id IN (0,1) GROUP BY s.name, t.name ORDER BY s.name, t.name`,
    );
    return r.recordset.map<RemoteObject>((x) => ({ name: `${x.s}.${x.t}`, kind: 'table', rowEstimate: x.n === null ? null : Number(x.n) }));
  });

export const mssqlDriver: ConnectorDriver = {
  type: 'MSSQL',
  name: 'Microsoft SQL Server',
  category: 'DATABASE',
  description: 'Read tables from SQL Server 2017+ or Azure SQL Database.',
  verification: 'VERIFIED',
  verifiedWith: 'SQL Server 2022',
  prerequisites: 'A SQL Server login with db_datareader (SELECT-only) on the database. Use TLS (encrypt) for remote servers.',
  supportsIncremental: true,
  fields: [
    { key: 'host', label: 'Server', type: 'text', required: true, placeholder: 'sql.example.com' },
    { key: 'port', label: 'Port', type: 'number', placeholder: '1433' },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
    { key: 'encrypt', label: 'Encrypt connection (TLS)', type: 'boolean' },
    { key: 'trustServerCertificate', label: 'Trust self-signed server certificate', type: 'boolean', help: 'Only for development servers.' },
  ],
  hosts: (cfg) => [str(cfg, 'host')],
  test: async (cfg) => ({ objects: await mssqlList(cfg) }),
  list: mssqlList,
  describe: (cfg, object) =>
    withMssql(cfg, async (p) => {
      const [s, t] = splitName(object, 'dbo');
      const r = await p.request().input('s', s).input('t', t).query<RemoteColumn>('SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = @s AND table_name = @t ORDER BY ordinal_position');
      return r.recordset;
    }),
  readPage: (cfg, object, req) =>
    withMssql(cfg, async (p) => {
      const [s, t] = splitName(object, 'dbo');
      const inc = incrementalColumn(req);
      const rq = p.request().input('o', mssql.Int, req.offset).input('n', mssql.Int, req.limit + 1);
      if (inc) rq.input('after', req.incremental!.after);
      const r = await rq.query(`SELECT * FROM [${s}].[${t}] ${inc ? `WHERE [${inc}] > @after` : ''} ORDER BY ${inc ? `[${inc}]` : '1'} OFFSET @o ROWS FETCH NEXT @n ROWS ONLY`);
      const cols = Object.entries(r.recordset.columns ?? {}).map(([name, c]) => ({ name, type: String((c as { type?: { name?: string } }).type?.name ?? '') }));
      return { rows: r.recordset.slice(0, req.limit).map(plainRow), columns: cols, hasMore: r.recordset.length > req.limit };
    }),
};

// ── Oracle Database (node-oracledb thin mode, no Instant Client needed) ─────────
oracledb.fetchAsString = [oracledb.CLOB];

async function withOracle<T>(cfg: ConnectorConfig, fn: (c: oracledb.Connection) => Promise<T>): Promise<T> {
  const conn = await withRetry(() => oracledb.getConnection({ user: str(cfg, 'user'), password: str(cfg, 'password'), connectString: `${str(cfg, 'host')}:${num(cfg, 'port', 1521)}/${str(cfg, 'serviceName')}`, connectTimeout: 10 }));
  conn.callTimeout = TIMEOUT;
  try {
    await conn.execute('SET TRANSACTION READ ONLY').catch(() => undefined);
    return await fn(conn);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

const OBJ = { outFormat: oracledb.OUT_FORMAT_OBJECT };
const oracleList = (cfg: ConnectorConfig) =>
  withOracle(cfg, async (c) => {
    const r = await c.execute<{ O: string; T: string; N: number | null }>('SELECT USER AS O, table_name AS T, num_rows AS N FROM user_tables ORDER BY table_name FETCH FIRST 500 ROWS ONLY', [], OBJ);
    return (r.rows ?? []).map<RemoteObject>((x) => ({ name: `${x.O}.${x.T}`, kind: 'table', rowEstimate: x.N ?? null }));
  });

export const oracleDriver: ConnectorDriver = {
  type: 'ORACLE',
  name: 'Oracle Database',
  category: 'DATABASE',
  description: 'Read tables from Oracle Database 19c+ (thin driver, no client install).',
  verification: 'VERIFIED',
  verifiedWith: 'Oracle Database 23ai Free',
  prerequisites: 'An Oracle user with SELECT privileges on the tables to import and a reachable listener/service name.',
  supportsIncremental: true,
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', placeholder: '1521' },
    { key: 'serviceName', label: 'Service name', type: 'text', required: true, placeholder: 'FREEPDB1' },
    { key: 'user', label: 'User', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', secret: true, required: true },
  ],
  hosts: (cfg) => [str(cfg, 'host')],
  test: async (cfg) => ({ objects: await oracleList(cfg) }),
  list: oracleList,
  describe: (cfg, object) =>
    withOracle(cfg, async (c) => {
      const [s, t] = splitName(object, str(cfg, 'user').toUpperCase());
      const r = await c.execute<{ NAME: string; TYPE: string }>('SELECT column_name AS NAME, data_type AS TYPE FROM all_tab_columns WHERE owner = :s AND table_name = :t ORDER BY column_id', { s, t }, OBJ);
      return (r.rows ?? []).map((x) => ({ name: x.NAME, type: x.TYPE }));
    }),
  readPage: (cfg, object, req) =>
    withOracle(cfg, async (c) => {
      const [s, t] = splitName(object, str(cfg, 'user').toUpperCase());
      const inc = incrementalColumn(req);
      const binds: Record<string, string | number> = { o: req.offset, n: req.limit + 1 };
      if (inc) binds.after = req.incremental!.after;
      const r = await c.execute<Record<string, unknown>>(`SELECT * FROM "${s}"."${t}" ${inc ? `WHERE "${inc}" > :after` : ''} ORDER BY ${inc ? `"${inc}"` : '1'} OFFSET :o ROWS FETCH NEXT :n ROWS ONLY`, binds, OBJ);
      const rows = r.rows ?? [];
      return { rows: rows.slice(0, req.limit).map(plainRow), columns: (r.metaData ?? []).map((m) => ({ name: m.name, type: String(m.dbTypeName ?? '') })), hasMore: rows.length > req.limit };
    }),
};
