import { MongoClient } from 'mongodb';
import { resolveSrv } from 'node:dns/promises';
import { badRequest } from '../lib/errors.js';
import { assertOutboundHost, blocksPrivateTargets } from '../lib/net.js';
import { IDENT, plainRow, str, withRetry, type ConnectorConfig, type ConnectorDriver, type RemoteObject } from './types.js';

/** mongodb+srv names resolve to other hosts; each SRV target is checked against the outbound policy too. */
async function assertSrvTargets(cs: string) {
  const m = /^mongodb\+srv:\/\/(?:[^@/]*@)?([^/?:,]+)/.exec(cs);
  if (!m || !blocksPrivateTargets()) return;
  let targets: { name: string }[];
  try {
    targets = await resolveSrv(`_mongodb._tcp.${m[1]}`);
  } catch {
    throw badRequest(`The SRV record for "${m[1]}" could not be resolved.`);
  }
  if (!targets.length) throw badRequest(`The SRV record for "${m[1]}" has no servers.`);
  for (const t of targets) await assertOutboundHost(t.name, 'Connector hosts');
}

async function withMongo<T>(cfg: ConnectorConfig, fn: (db: ReturnType<MongoClient['db']>) => Promise<T>): Promise<T> {
  await assertSrvTargets(str(cfg, 'connectionString'));
  const client = new MongoClient(str(cfg, 'connectionString'), { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, socketTimeoutMS: 60_000, readPreference: 'secondaryPreferred' });
  await withRetry(() => client.connect());
  try {
    return await fn(client.db(str(cfg, 'database')));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function collection(name: string) {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name) || name.startsWith('system.')) throw badRequest(`"${name}" is not a valid collection name.`);
  return name;
}

const list = (cfg: ConnectorConfig) =>
  withMongo(cfg, async (db) => {
    const cols = await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
    const out: RemoteObject[] = [];
    for (const c of cols.filter((x) => !x.name.startsWith('system.')).slice(0, 500)) {
      out.push({ name: c.name, kind: 'collection', rowEstimate: await db.collection(c.name).estimatedDocumentCount().catch(() => null) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });

export const mongoDriver: ConnectorDriver = {
  type: 'MONGODB',
  name: 'MongoDB',
  category: 'DATABASE',
  description: 'Read collections from MongoDB. Nested fields are kept as JSON text columns.',
  verification: 'VERIFIED',
  verifiedWith: 'MongoDB 7',
  prerequisites: 'A MongoDB 5+ deployment reachable from the AuthenQ server and a user with the read role on the database.',
  supportsIncremental: true,
  fields: [
    { key: 'connectionString', label: 'Connection string', type: 'password', secret: true, required: true, placeholder: 'mongodb://reader:pass@host:27017/?authSource=admin' },
    { key: 'database', label: 'Database', type: 'text', required: true },
  ],
  hosts: (cfg) => {
    const cs = str(cfg, 'connectionString');
    const m = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(cs);
    if (!m) throw badRequest('Use a mongodb:// or mongodb+srv:// connection string.');
    return m[2]!.split(',').map((h) => h.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
  },
  test: async (cfg) => ({ objects: await list(cfg) }),
  list,
  describe: (cfg, object) =>
    withMongo(cfg, async (db) => {
      const sample = await db.collection(collection(object)).find({}, { limit: 200 }).toArray();
      const types = new Map<string, string>();
      for (const d of sample) for (const [k, v] of Object.entries(d)) if (!types.has(k)) types.set(k, v === null ? 'null' : Array.isArray(v) ? 'array' : (v as { _bsontype?: string })?._bsontype ?? typeof v);
      return [...types].map(([name, type]) => ({ name, type }));
    }),
  readPage: (cfg, object, req) =>
    withMongo(cfg, async (db) => {
      const inc = req.incremental;
      if (inc && !IDENT.test(inc.column)) throw badRequest('The incremental field name is not valid.');
      const filter = inc ? { [inc.column]: { $gt: inc.after } } : {};
      const docs = await db.collection(collection(object)).find(filter, { sort: inc ? { [inc.column]: 1 } : { _id: 1 }, skip: req.offset, limit: req.limit + 1 }).toArray();
      const rows = docs.slice(0, req.limit).map((d) => plainRow(d as Record<string, unknown>));
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((name) => ({ name, type: 'mixed' }));
      return { rows, columns: cols, hasMore: docs.length > req.limit };
    }),
};
