import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
dotenv.config({ path: path.resolve(repoRoot, '.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(8).default('authenq-development-secret'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  REPORT_STORAGE_DIR: z.string().default('./storage/reports'),
  GITHUB_WEBHOOK_SECRET: z.string().default('authenq-development-webhook-secret'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
  throw new Error(`Invalid environment configuration:\n  ${issues}`);
}
if (
  parsed.data.NODE_ENV === 'production' &&
  ['authenq-development-secret', 'change-me-in-production'].includes(parsed.data.JWT_SECRET)
) {
  throw new Error('Set a unique JWT_SECRET before running in production');
}

export const env = {
  ...parsed.data,
  reportStorageDir: path.resolve(repoRoot, parsed.data.REPORT_STORAGE_DIR),
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
};

export type Env = typeof env;
