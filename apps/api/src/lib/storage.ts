import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { hmac, safeEqual } from './crypto.js';

/**
 * Object storage abstraction. Metadata lives in PostgreSQL (`files`), bytes
 * live here. Keys are always server-generated from opaque ids.
 */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Returns a short-lived URL. Callers must authorize before requesting one. */
  signedUrl(key: string, fileName: string, expiresInSeconds: number): Promise<string>;
}

class LocalDriver implements StorageDriver {
  private root = resolve(process.cwd(), env.STORAGE_LOCAL_DIR);
  private pathFor(key: string) {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }
  async put(key: string, body: Buffer) {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.pathFor(key));
  }
  async delete(key: string) {
    await rm(this.pathFor(key), { force: true });
  }
  async signedUrl(key: string, fileName: string, expiresInSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = signLocal(key, exp);
    const q = new URLSearchParams({ key, exp: String(exp), sig, name: fileName });
    return `/api/v1/files/signed?${q.toString()}`;
  }
}

export function signLocal(key: string, exp: number): string {
  return hmac(env.SESSION_SECRET, `storage:${key}:${exp}`);
}

export function verifyLocalSignature(key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signLocal(key, exp), sig);
}

class S3Driver implements StorageDriver {
  private client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }),
    );
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    return Buffer.from(bytes ?? []);
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
  async signedUrl(key: string, fileName: string, expiresInSeconds: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`,
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

export const storage: StorageDriver = env.STORAGE_DRIVER === 's3' ? new S3Driver() : new LocalDriver();

export function storageKey(orgId: string, kind: string, id: string, ext: string) {
  return `${orgId}/${kind}/${id}.${ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'}`;
}
