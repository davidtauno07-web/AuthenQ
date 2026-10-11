import { GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import { badRequest } from '../lib/errors.js';
import { MAX_UPLOAD_BYTES, parseUpload } from '../services/firewall.js';
import { bool, hostOf, str, withRetry, type ConnectorConfig, type ConnectorDriver, type Page, type RemoteObject } from './types.js';

export const OBJECT_FILE_EXT = /\.(csv|tsv|json|jsonl|xlsx|sqlite|sqlite3|db)$/i;

interface ObjectStore {
  list(cfg: ConnectorConfig): Promise<{ key: string; size: number | null }[]>;
  get(cfg: ConnectorConfig, key: string): Promise<Buffer>;
  ping(cfg: ConnectorConfig): Promise<void>;
}

function checkKey(cfg: ConnectorConfig, key: string) {
  const prefix = str(cfg, 'prefix');
  if (key.includes('..') || (prefix && !key.startsWith(prefix)) || !OBJECT_FILE_EXT.test(key)) throw badRequest(`"${key}" is not a supported file inside the configured prefix.`);
}

/** Each supported file is one importable object; its parsed rows are paged in memory (files are capped at the upload limit). */
function objectDriver(meta: Omit<ConnectorDriver, 'list' | 'test' | 'describe' | 'readPage' | 'supportsIncremental' | 'category'>, store: ObjectStore): ConnectorDriver {
  const list = async (cfg: ConnectorConfig): Promise<RemoteObject[]> =>
    (await store.list(cfg)).filter((o) => OBJECT_FILE_EXT.test(o.key)).slice(0, 500).map((o) => ({ name: o.key, kind: 'file', rowEstimate: null, sizeBytes: o.size }));
  const load = async (cfg: ConnectorConfig, key: string) => {
    checkKey(cfg, key);
    const buf = await withRetry(() => store.get(cfg, key));
    if (buf.length > MAX_UPLOAD_BYTES) throw badRequest(`"${key}" is larger than 50 MB.`);
    const tables = await parseUpload(key.split('/').pop()!, buf);
    return tables[0] ?? { name: key, rows: [] };
  };
  const page = async (cfg: ConnectorConfig, key: string, limit: number, offset: number): Promise<Page> => {
    const t = await load(cfg, key);
    const rows = t.rows.slice(offset, offset + limit);
    return { rows, columns: Object.keys(t.rows[0] ?? {}).map((name) => ({ name, type: 'text' })), hasMore: offset + limit < t.rows.length };
  };
  return {
    ...meta,
    category: 'OBJECT_STORAGE',
    supportsIncremental: false,
    test: async (cfg) => {
      await withRetry(() => store.ping(cfg));
      return { objects: await list(cfg) };
    },
    list,
    describe: async (cfg, key) => (await page(cfg, key, 1, 0)).columns,
    readPage: (cfg, key, req) => {
      if (req.incremental) throw badRequest('Incremental reads are not supported for files. Re-import the file instead.');
      return page(cfg, key, req.limit, req.offset);
    },
  };
}

const prefixField = { key: 'prefix', label: 'Prefix (folder)', type: 'text' as const, placeholder: 'exports/crm/' };

// ── Amazon S3 and S3-compatible storage ─────────────────────────────────────────
const s3 = (cfg: ConnectorConfig) =>
  new S3Client({
    region: str(cfg, 'region', 'us-east-1'),
    endpoint: str(cfg, 'endpoint') || undefined,
    forcePathStyle: bool(cfg, 'forcePathStyle', !!str(cfg, 'endpoint')),
    credentials: { accessKeyId: str(cfg, 'accessKeyId'), secretAccessKey: str(cfg, 'secretAccessKey') },
    maxAttempts: 3,
  });

export const s3Driver = objectDriver(
  {
    type: 'S3',
    name: 'Amazon S3 / S3-compatible',
    description: 'Import CSV, TSV, JSON, JSONL, XLSX and SQLite files from an S3 bucket (AWS, MinIO, Ceph, R2 and other S3-compatible stores).',
    verification: 'VERIFIED',
    verifiedWith: 'S3 API emulator (LocalStack 3.8)',
    prerequisites: 'An access key with s3:ListBucket and s3:GetObject on the bucket. Custom endpoints are needed for non-AWS stores.',
    fields: [
      { key: 'bucket', label: 'Bucket', type: 'text', required: true },
      prefixField,
      { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1' },
      { key: 'endpoint', label: 'Custom endpoint', type: 'text', placeholder: 'https://minio.example.com', help: 'Leave blank for AWS S3.' },
      { key: 'forcePathStyle', label: 'Path-style addressing', type: 'boolean' },
      { key: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'password', secret: true, required: true },
    ],
    hosts: (cfg) => (str(cfg, 'endpoint') ? hostOf(str(cfg, 'endpoint')) : [`s3.${str(cfg, 'region', 'us-east-1')}.amazonaws.com`]),
  },
  {
    ping: async (cfg) => {
      await s3(cfg).send(new HeadBucketCommand({ Bucket: str(cfg, 'bucket') }));
    },
    list: async (cfg) => {
      const out: { key: string; size: number | null }[] = [];
      let token: string | undefined;
      do {
        const r = await s3(cfg).send(new ListObjectsV2Command({ Bucket: str(cfg, 'bucket'), Prefix: str(cfg, 'prefix') || undefined, ContinuationToken: token, MaxKeys: 1000 }));
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? null });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token && out.length < 5000);
      return out;
    },
    get: async (cfg, key) => {
      const r = await s3(cfg).send(new GetObjectCommand({ Bucket: str(cfg, 'bucket'), Key: key }));
      if ((r.ContentLength ?? 0) > MAX_UPLOAD_BYTES) throw badRequest(`"${key}" is larger than 50 MB.`);
      return Buffer.from(await r.Body!.transformToByteArray());
    },
  },
);

// ── Azure Blob Storage ──────────────────────────────────────────────────────────
const azure = (cfg: ConnectorConfig) => BlobServiceClient.fromConnectionString(str(cfg, 'connectionString')).getContainerClient(str(cfg, 'container'));

export const azureBlobDriver = objectDriver(
  {
    type: 'AZURE_BLOB',
    name: 'Azure Blob Storage',
    description: 'Import supported files from an Azure Blob Storage container.',
    verification: 'VERIFIED',
    verifiedWith: 'Azurite (official Azure Storage emulator)',
    prerequisites: 'A storage-account connection string or SAS connection string with read and list permissions on the container.',
    fields: [
      { key: 'connectionString', label: 'Connection string', type: 'password', secret: true, required: true, placeholder: 'DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…' },
      { key: 'container', label: 'Container', type: 'text', required: true },
      prefixField,
    ],
    hosts: (cfg) => {
      const cs = str(cfg, 'connectionString');
      const ep = /BlobEndpoint=([^;]+)/i.exec(cs)?.[1];
      if (ep) return hostOf(ep);
      const acct = /AccountName=([^;]+)/i.exec(cs)?.[1];
      if (!acct) throw badRequest('The connection string must include AccountName or BlobEndpoint.');
      return [`${acct}.blob.${/EndpointSuffix=([^;]+)/i.exec(cs)?.[1] ?? 'core.windows.net'}`];
    },
  },
  {
    ping: async (cfg) => {
      if (!(await azure(cfg).exists())) throw new Error(`Container "${str(cfg, 'container')}" does not exist or is not accessible.`);
    },
    list: async (cfg) => {
      const out: { key: string; size: number | null }[] = [];
      for await (const b of azure(cfg).listBlobsFlat({ prefix: str(cfg, 'prefix') || undefined })) {
        out.push({ key: b.name, size: b.properties.contentLength ?? null });
        if (out.length >= 5000) break;
      }
      return out;
    },
    get: (cfg, key) => azure(cfg).getBlobClient(key).downloadToBuffer(),
  },
);

// ── Google Cloud Storage ────────────────────────────────────────────────────────
const gcs = (cfg: ConnectorConfig) => {
  const json = str(cfg, 'credentialsJson');
  let credentials: { client_email: string; private_key: string } | undefined;
  if (json) {
    try {
      credentials = JSON.parse(json);
    } catch {
      throw badRequest('The service-account key must be valid JSON.');
    }
  }
  return new Storage({ projectId: str(cfg, 'projectId') || undefined, apiEndpoint: str(cfg, 'apiEndpoint') || undefined, credentials, retryOptions: { maxRetries: 2 } }).bucket(str(cfg, 'bucket'));
};

export const gcsDriver = objectDriver(
  {
    type: 'GCS',
    name: 'Google Cloud Storage',
    description: 'Import supported files from a Google Cloud Storage bucket.',
    verification: 'VERIFIED',
    verifiedWith: 'fake-gcs-server emulator (JSON API)',
    prerequisites: 'A service-account JSON key with storage.objects.list and storage.objects.get (roles/storage.objectViewer) on the bucket. Not yet run against a live Google Cloud project.',
    fields: [
      { key: 'bucket', label: 'Bucket', type: 'text', required: true },
      prefixField,
      { key: 'projectId', label: 'Project ID', type: 'text' },
      { key: 'credentialsJson', label: 'Service-account key (JSON)', type: 'textarea', secret: true },
      { key: 'apiEndpoint', label: 'Custom API endpoint', type: 'text', help: 'Only for emulators or private endpoints.' },
    ],
    hosts: (cfg) => (str(cfg, 'apiEndpoint') ? hostOf(str(cfg, 'apiEndpoint')) : ['storage.googleapis.com']),
  },
  {
    ping: async (cfg) => {
      const [exists] = await gcs(cfg).exists();
      if (!exists) throw new Error(`Bucket "${str(cfg, 'bucket')}" does not exist or is not accessible.`);
    },
    list: async (cfg) => {
      const [files] = await gcs(cfg).getFiles({ prefix: str(cfg, 'prefix') || undefined, maxResults: 5000 });
      return files.map((f) => ({ key: f.name, size: f.metadata.size === undefined ? null : Number(f.metadata.size) }));
    },
    get: async (cfg, key) => (await gcs(cfg).file(key).download())[0],
  },
);
