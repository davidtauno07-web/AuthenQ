import { SignJWT, importPKCS8 } from 'jose';
import { badRequest } from '../lib/errors.js';
import { IDENT, plainRow, splitName, str, withRetry, type ConnectorConfig, type ConnectorDriver, type Page, type RemoteObject } from './types.js';

// These drivers call the vendors' official REST SQL APIs. They are UNVERIFIED: no live
// Snowflake, BigQuery or Databricks account was available, so they are hidden unless an
// administrator enables the "connectors.unverified" feature flag.

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  return withRetry(async () => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  });
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  return withRetry(async () => {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  });
}

const zip = (cols: string[], arr: unknown[]) => plainRow(Object.fromEntries(cols.map((c, i) => [c, arr[i] ?? null])));

function sqlPage(run: (sql: string) => Promise<{ columns: { name: string; type: string }[]; data: unknown[][] }>, quote: (s: string, t: string) => string, defaultSchema: (cfg: ConnectorConfig) => string) {
  return async (cfg: ConnectorConfig, object: string, req: { limit: number; offset: number; incremental?: { column: string; after: string | number } }): Promise<Page> => {
    const [s, t] = splitName(object, defaultSchema(cfg));
    if (req.incremental && !IDENT.test(req.incremental.column)) throw badRequest('The incremental column name is not valid.');
    const after = req.incremental ? (typeof req.incremental.after === 'number' ? String(req.incremental.after) : `'${String(req.incremental.after).replace(/'/g, "''")}'`) : '';
    const where = req.incremental ? `WHERE ${req.incremental.column} > ${after}` : '';
    const shape = await run(`SELECT * FROM ${quote(s, t)} LIMIT 0`);
    const positions = shape.columns.map((c, i) => (/^(VARIANT|OBJECT|ARRAY|MAP|STRUCT|GEOGRAPHY|GEOMETRY|BINARY)/i.test(c.type) ? null : String(i + 1))).filter((x): x is string => !!x);
    if (!positions.length) throw badRequest('This table has no column that can be used to read it in a stable order.');
    const order = [...(req.incremental ? [req.incremental.column] : []), ...positions].join(', ');
    const r = await run(`SELECT * FROM ${quote(s, t)} ${where} ORDER BY ${order} LIMIT ${req.limit + 1} OFFSET ${req.offset}`);
    const names = r.columns.map((c) => c.name);
    return { rows: r.data.slice(0, req.limit).map((d) => zip(names, d)), columns: r.columns, hasMore: r.data.length > req.limit };
  };
}

// ── Snowflake (SQL API v2) ───────────────────────────────────────────────────────
function snowflakeRun(cfg: ConnectorConfig) {
  return async (statement: string) => {
    const account = str(cfg, 'account');
    const r = await postJson<{ resultSetMetaData?: { rowType: { name: string; type: string }[] }; data?: unknown[][] }>(
      `https://${account}.snowflakecomputing.com/api/v2/statements`,
      { statement, timeout: 60, warehouse: str(cfg, 'warehouse') || undefined, database: str(cfg, 'database') || undefined, schema: str(cfg, 'schema') || undefined, role: str(cfg, 'role') || undefined },
      { authorization: `Bearer ${str(cfg, 'token')}`, 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' },
    );
    return { columns: (r.resultSetMetaData?.rowType ?? []).map((c) => ({ name: c.name, type: c.type })), data: r.data ?? [] };
  };
}
const snowList = async (cfg: ConnectorConfig): Promise<RemoteObject[]> => {
  const r = await snowflakeRun(cfg)("SELECT table_schema, table_name, row_count FROM information_schema.tables WHERE table_type = 'BASE TABLE' ORDER BY 1,2 LIMIT 500");
  return r.data.map((d) => ({ name: `${d[0]}.${d[1]}`, kind: 'table', rowEstimate: d[2] === null ? null : Number(d[2]) }));
};
export const snowflakeDriver: ConnectorDriver = {
  type: 'SNOWFLAKE',
  name: 'Snowflake',
  category: 'WAREHOUSE',
  description: 'Read tables through the Snowflake SQL API.',
  verification: 'UNVERIFIED',
  prerequisites: 'Requires a Snowflake account, a warehouse, and a programmatic access token for a role with SELECT on the tables. Not tested against a live account.',
  supportsIncremental: true,
  fields: [
    { key: 'account', label: 'Account identifier', type: 'text', required: true, placeholder: 'orgname-accountname' },
    { key: 'warehouse', label: 'Warehouse', type: 'text', required: true },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'schema', label: 'Schema', type: 'text', placeholder: 'PUBLIC' },
    { key: 'role', label: 'Role', type: 'text' },
    { key: 'token', label: 'Programmatic access token', type: 'password', secret: true, required: true },
  ],
  hosts: (cfg) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(str(cfg, 'account'))) throw badRequest('The Snowflake account identifier is not valid.');
    return [`${str(cfg, 'account')}.snowflakecomputing.com`];
  },
  test: async (cfg) => ({ objects: await snowList(cfg) }),
  list: snowList,
  describe: async (cfg, object) => {
    const [s, t] = splitName(object, str(cfg, 'schema', 'PUBLIC'));
    const r = await snowflakeRun(cfg)(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${s}' AND table_name = '${t}' ORDER BY ordinal_position`);
    return r.data.map((d) => ({ name: String(d[0]), type: String(d[1]) }));
  },
  readPage: (cfg, object, req) => sqlPage(snowflakeRun(cfg), (s, t) => `"${s}"."${t}"`, (c) => str(c, 'schema', 'PUBLIC'))(cfg, object, req),
};

// ── Google BigQuery (REST v2, service-account JWT) ──────────────────────────────
async function bigqueryToken(cfg: ConnectorConfig) {
  let key: { client_email: string; private_key: string; token_uri?: string };
  try {
    key = JSON.parse(str(cfg, 'credentialsJson'));
  } catch {
    throw badRequest('The service-account key must be valid JSON.');
  }
  const aud = 'https://oauth2.googleapis.com/token';
  if (key.token_uri && key.token_uri.replace(/\/$/, '') !== aud) throw badRequest(`The service-account key must use Google's token endpoint (${aud}).`);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/bigquery.readonly' })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(key.client_email).setAudience(aud).setIssuedAt().setExpirationTime('10m')
    .sign(await importPKCS8(key.private_key, 'RS256'));
  const r = await fetch(aud, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Google token endpoint returned HTTP ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}
const bqBase = (cfg: ConnectorConfig) => `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(str(cfg, 'projectId'))}`;
const bqList = async (cfg: ConnectorConfig): Promise<RemoteObject[]> => {
  const auth = { authorization: `Bearer ${await bigqueryToken(cfg)}` };
  const r = await getJson<{ tables?: { tableReference: { tableId: string }; type: string }[] }>(`${bqBase(cfg)}/datasets/${encodeURIComponent(str(cfg, 'dataset'))}/tables?maxResults=500`, auth);
  return (r.tables ?? []).filter((t) => t.type === 'TABLE').map((t) => ({ name: `${str(cfg, 'dataset')}.${t.tableReference.tableId}`, kind: 'table', rowEstimate: null }));
};
export const bigqueryDriver: ConnectorDriver = {
  type: 'BIGQUERY',
  name: 'Google BigQuery',
  category: 'WAREHOUSE',
  description: 'Read tables from a BigQuery dataset with the BigQuery REST API.',
  verification: 'UNVERIFIED',
  prerequisites: 'Requires a Google Cloud project with BigQuery enabled and a service-account key with roles/bigquery.dataViewer and roles/bigquery.jobUser. Not tested against a live project.',
  supportsIncremental: false,
  fields: [
    { key: 'projectId', label: 'Project ID', type: 'text', required: true },
    { key: 'dataset', label: 'Dataset', type: 'text', required: true },
    { key: 'credentialsJson', label: 'Service-account key (JSON)', type: 'textarea', secret: true, required: true },
  ],
  hosts: () => ['bigquery.googleapis.com', 'oauth2.googleapis.com'],
  test: async (cfg) => ({ objects: await bqList(cfg) }),
  list: bqList,
  describe: async (cfg, object) => {
    const [d, t] = splitName(object, str(cfg, 'dataset'));
    const r = await getJson<{ schema?: { fields: { name: string; type: string }[] } }>(`${bqBase(cfg)}/datasets/${d}/tables/${t}`, { authorization: `Bearer ${await bigqueryToken(cfg)}` });
    return (r.schema?.fields ?? []).map((f) => ({ name: f.name, type: f.type }));
  },
  readPage: async (cfg, object, req) => {
    if (req.incremental) throw badRequest('Incremental reads are not available for BigQuery yet.');
    const [d, t] = splitName(object, str(cfg, 'dataset'));
    const auth = { authorization: `Bearer ${await bigqueryToken(cfg)}` };
    const meta = await getJson<{ schema?: { fields: { name: string; type: string }[] }; numRows?: string }>(`${bqBase(cfg)}/datasets/${d}/tables/${t}`, auth);
    const r = await getJson<{ rows?: { f: { v: unknown }[] }[] }>(`${bqBase(cfg)}/datasets/${d}/tables/${t}/data?maxResults=${req.limit}&startIndex=${req.offset}`, auth);
    const cols = (meta.schema?.fields ?? []).map((f) => ({ name: f.name, type: f.type }));
    const rows = (r.rows ?? []).map((row) => zip(cols.map((c) => c.name), row.f.map((x) => x.v)));
    return { rows, columns: cols, hasMore: req.offset + rows.length < Number(meta.numRows ?? 0) };
  },
};

// ── Databricks SQL (Statement Execution API 2.0) ────────────────────────────────
function databricksRun(cfg: ConnectorConfig) {
  return async (statement: string) => {
    const r = await postJson<{ status: { state: string; error?: { message: string } }; manifest?: { schema: { columns: { name: string; type_name: string }[] } }; result?: { data_array?: unknown[][] } }>(
      `https://${str(cfg, 'host')}/api/2.0/sql/statements`,
      { statement, warehouse_id: str(cfg, 'warehouseId'), catalog: str(cfg, 'catalog') || undefined, schema: str(cfg, 'schema') || undefined, wait_timeout: '50s', on_wait_timeout: 'CANCEL', disposition: 'INLINE', format: 'JSON_ARRAY' },
      { authorization: `Bearer ${str(cfg, 'token')}` },
    );
    if (r.status.state !== 'SUCCEEDED') throw new Error(`Databricks statement ${r.status.state}: ${r.status.error?.message ?? ''}`.trim());
    return { columns: (r.manifest?.schema.columns ?? []).map((c) => ({ name: c.name, type: c.type_name })), data: r.result?.data_array ?? [] };
  };
}
const dbxList = async (cfg: ConnectorConfig): Promise<RemoteObject[]> => {
  const r = await databricksRun(cfg)(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_type IN ('MANAGED','EXTERNAL','BASE TABLE') ORDER BY 1,2 LIMIT 500`);
  return r.data.map((d) => ({ name: `${d[0]}.${d[1]}`, kind: 'table', rowEstimate: null }));
};
export const databricksDriver: ConnectorDriver = {
  type: 'DATABRICKS',
  name: 'Databricks SQL',
  category: 'WAREHOUSE',
  description: 'Read Unity Catalog tables through a Databricks SQL warehouse.',
  verification: 'UNVERIFIED',
  prerequisites: 'Requires a Databricks workspace, a running SQL warehouse, and a personal access token or service-principal token with SELECT on the catalog. Not tested against a live workspace.',
  supportsIncremental: true,
  fields: [
    { key: 'host', label: 'Workspace host', type: 'text', required: true, placeholder: 'dbc-1234.cloud.databricks.com' },
    { key: 'warehouseId', label: 'SQL warehouse ID', type: 'text', required: true },
    { key: 'catalog', label: 'Catalog', type: 'text', required: true },
    { key: 'schema', label: 'Schema', type: 'text', placeholder: 'default' },
    { key: 'token', label: 'Access token', type: 'password', secret: true, required: true },
  ],
  hosts: (cfg) => {
    if (!/^[A-Za-z0-9.-]+$/.test(str(cfg, 'host'))) throw badRequest('Enter the workspace host name only, without https://.');
    return [str(cfg, 'host')];
  },
  test: async (cfg) => ({ objects: await dbxList(cfg) }),
  list: dbxList,
  describe: async (cfg, object) => {
    const [s, t] = splitName(object, str(cfg, 'schema', 'default'));
    const r = await databricksRun(cfg)(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${s}' AND table_name = '${t}' ORDER BY ordinal_position`);
    return r.data.map((d) => ({ name: String(d[0]), type: String(d[1]) }));
  },
  readPage: (cfg, object, req) => sqlPage(databricksRun(cfg), (s, t) => `\`${s}\`.\`${t}\``, (c) => str(c, 'schema', 'default'))(cfg, object, req),
};
