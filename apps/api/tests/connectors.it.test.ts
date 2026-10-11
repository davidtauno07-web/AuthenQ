import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';
import mysql from 'mysql2/promise';
import mssql from 'mssql';
import oracledb from 'oracledb';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { driverFor } from '../src/connectors/registry.js';
import type { ConnectorConfig } from '../src/connectors/types.js';

// Real integration tests against local servers/emulators (see docker-compose.connectors.yml).
// Run with: npm run test:connectors --workspace apps/api
const enabled = !!process.env.CONNECTOR_IT || (import.meta as { env?: { MODE?: string } }).env?.MODE === 'connectors';
const N = 12;
const people = Array.from({ length: N }, (_, i) => ({ id: i + 1, name: `Person ${i + 1}`, email: `p${i + 1}@example.com` }));
const csv = `id,name,email\n${people.map((p) => `${p.id},${p.name},${p.email}`).join('\n')}\n`;
const H = process.env.CONNECTOR_IT_HOST ?? '127.0.0.1';
const AZURITE = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://${H}:10000/devstoreaccount1;`;
const pgUrl = process.env.CONNECTOR_IT_PG ?? process.env.DATABASE_URL!.replace(/\?.*$/, '');

const configs: Record<string, { cfg: ConnectorConfig; object: string; idCol: string; bad: ConnectorConfig }> = {
  POSTGRES: { cfg: { connectionString: pgUrl }, object: 'it_conn.customers', idCol: 'id', bad: { connectionString: pgUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:WrongPw-123@') } },
  MYSQL: { cfg: { host: H, port: 13306, database: 'crm', user: 'root', password: 'rootpw' }, object: 'customers', idCol: 'id', bad: { host: H, port: 13306, database: 'crm', user: 'root', password: 'WrongPw-123' } },
  MSSQL: { cfg: { host: H, port: 11433, database: 'crm', user: 'sa', password: 'Str0ng!Passw0rd', encrypt: true, trustServerCertificate: true }, object: 'dbo.customers', idCol: 'id', bad: { host: H, port: 11433, database: 'crm', user: 'sa', password: 'WrongPw-123', encrypt: true, trustServerCertificate: true } },
  ORACLE: { cfg: { host: H, port: 11521, serviceName: 'FREEPDB1', user: 'crm', password: 'CrmPw123' }, object: 'CRM.CUSTOMERS', idCol: 'ID', bad: { host: H, port: 11521, serviceName: 'FREEPDB1', user: 'crm', password: 'WrongPw-123' } },
  MONGODB: { cfg: { connectionString: `mongodb://${H}:27018`, database: 'crm' }, object: 'customers', idCol: 'id', bad: { connectionString: `mongodb://${H}:27999`, database: 'crm' } },
  S3: { cfg: { bucket: 'aq-it', prefix: 'crm/', region: 'us-east-1', endpoint: `http://${H}:14566`, forcePathStyle: true, accessKeyId: 'test', secretAccessKey: 'test' }, object: 'crm/customers.csv', idCol: 'id', bad: { bucket: 'missing-bucket-x', endpoint: `http://${H}:14566`, forcePathStyle: true, accessKeyId: 'test', secretAccessKey: 'WrongPw-123' } },
  AZURE_BLOB: { cfg: { connectionString: AZURITE, container: 'aq-it', prefix: 'crm/' }, object: 'crm/customers.csv', idCol: 'id', bad: { connectionString: AZURITE.replace(/AccountKey=[^;]+/, 'AccountKey=V3JvbmdQdy0xMjM='), container: 'aq-it' } },
  GCS: { cfg: { bucket: 'aq-it', prefix: 'crm/', projectId: 'test', apiEndpoint: `http://${H}:4443` }, object: 'crm/customers.csv', idCol: 'id', bad: { bucket: 'missing-bucket-x', projectId: 'test', apiEndpoint: `http://${H}:4443` } },
};

async function seed() {
  const p = new pg.Client({ connectionString: pgUrl });
  await p.connect();
  await p.query('DROP SCHEMA IF EXISTS it_conn CASCADE; CREATE SCHEMA it_conn; CREATE TABLE it_conn.customers (id int primary key, name text, email text)');
  for (const r of people) await p.query('INSERT INTO it_conn.customers VALUES ($1,$2,$3)', [r.id, r.name, r.email]);
  await p.end();

  const my = await mysql.createConnection({ host: H, port: 13306, user: 'root', password: 'rootpw', database: 'crm' });
  await my.query('DROP TABLE IF EXISTS customers');
  await my.query('CREATE TABLE customers (id int primary key, name varchar(80), email varchar(120))');
  await my.query('INSERT INTO customers VALUES ?', [people.map((r) => [r.id, r.name, r.email])]);
  await my.end();

  const master = await new mssql.ConnectionPool({ server: H, port: 11433, user: 'sa', password: 'Str0ng!Passw0rd', database: 'master', options: { encrypt: true, trustServerCertificate: true } }).connect();
  await master.request().query("IF DB_ID('crm') IS NULL CREATE DATABASE crm");
  await master.close();
  const ms = await new mssql.ConnectionPool({ server: H, port: 11433, user: 'sa', password: 'Str0ng!Passw0rd', database: 'crm', options: { encrypt: true, trustServerCertificate: true } }).connect();
  await ms.request().query("IF OBJECT_ID('dbo.customers') IS NOT NULL DROP TABLE dbo.customers; CREATE TABLE dbo.customers (id int primary key, name nvarchar(80), email nvarchar(120))");
  for (const r of people) await ms.request().input('i', r.id).input('n', r.name).input('e', r.email).query('INSERT INTO dbo.customers VALUES (@i,@n,@e)');
  await ms.close();

  const ora = await oracledb.getConnection({ user: 'crm', password: 'CrmPw123', connectString: `${H}:11521/FREEPDB1` });
  await ora.execute('BEGIN EXECUTE IMMEDIATE \'DROP TABLE customers\'; EXCEPTION WHEN OTHERS THEN NULL; END;');
  await ora.execute('CREATE TABLE customers (id NUMBER PRIMARY KEY, name VARCHAR2(80), email VARCHAR2(120))');
  await ora.executeMany('INSERT INTO customers VALUES (:1, :2, :3)', people.map((r) => [r.id, r.name, r.email]), { autoCommit: true });
  await ora.close();

  const mc = await new MongoClient(`mongodb://${H}:27018`).connect();
  await mc.db('crm').collection('customers').deleteMany({});
  await mc.db('crm').collection('customers').insertMany(people.map((r) => ({ ...r, profile: { tier: r.id % 2 ? 'gold' : 'basic' } })));
  await mc.close();

  const s3 = new S3Client({ region: 'us-east-1', endpoint: `http://${H}:14566`, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  await s3.send(new CreateBucketCommand({ Bucket: 'aq-it' })).catch(() => undefined);
  await s3.send(new PutObjectCommand({ Bucket: 'aq-it', Key: 'crm/customers.csv', Body: csv }));
  await s3.send(new PutObjectCommand({ Bucket: 'aq-it', Key: 'other/ignored.csv', Body: csv }));

  const az = BlobServiceClient.fromConnectionString(AZURITE).getContainerClient('aq-it');
  await az.createIfNotExists();
  await az.getBlockBlobClient('crm/customers.csv').upload(csv, csv.length);

  const gs = new Storage({ projectId: 'test', apiEndpoint: `http://${H}:4443` });
  await gs.createBucket('aq-it').catch(() => undefined);
  await gs.bucket('aq-it').file('crm/customers.csv').save(csv);
}

describe.skipIf(!enabled)('connector integration (live servers and emulators)', () => {
  beforeAll(seed, 180_000);

  for (const [type, t] of Object.entries(configs)) {
    describe(type, () => {
      const d = driverFor(type);
      it('is marked verified', () => expect(d.verification).toBe('VERIFIED'));

      it('tests the connection and discovers the object and its schema', async () => {
        const { objects } = await d.test(t.cfg);
        expect(objects.map((o) => o.name)).toContain(t.object);
        if (d.category === 'OBJECT_STORAGE') expect(objects.map((o) => o.name)).not.toContain('other/ignored.csv');
        const cols = (await d.describe(t.cfg, t.object)).map((c) => c.name.toLowerCase());
        expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'email']));
      }, 60_000);

      it('paginates deterministically', async () => {
        const first = await d.readPage(t.cfg, t.object, { limit: 5, offset: 0 });
        expect(first.rows).toHaveLength(5);
        expect(first.hasMore).toBe(true);
        const last = await d.readPage(t.cfg, t.object, { limit: 5, offset: 10 });
        expect(last.rows).toHaveLength(2);
        expect(last.hasMore).toBe(false);
        const ids = [...first.rows, ...last.rows].map((r) => Number(r[t.idCol] ?? r.id));
        expect(new Set(ids).size).toBe(7);
        const emails = first.rows.map((r) => String(r.email ?? r.EMAIL));
        expect(emails.every((e) => /^p\d+@example\.com$/.test(e))).toBe(true);
      }, 60_000);

      if (d.supportsIncremental) {
        it('reads incrementally after a cursor value', async () => {
          const r = await d.readPage(t.cfg, t.object, { limit: 100, offset: 0, incremental: { column: t.idCol, after: 8 } });
          expect(r.rows.map((x) => Number(x[t.idCol]))).toEqual([9, 10, 11, 12]);
        }, 60_000);
      }

      it('fails with a clear error that does not leak credentials', async () => {
        const err = await d.test(t.bad).then(() => null, (e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        const { redact } = await import('../src/connectors/types.js');
        const msg = redact(err!.message, t.bad, d.fields.filter((f) => f.secret).map((f) => f.key));
        expect(msg).not.toContain('WrongPw-123');
        expect(msg.length).toBeGreaterThan(0);
      }, 90_000);
    });
  }
});
