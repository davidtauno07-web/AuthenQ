import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  API_PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  CANARY_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  SESSION_ROTATE_MINUTES: z.coerce.number().positive().default(15),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('authenq'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(750),
  EMAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('AuthenQ <no-reply@authenq.local>'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEMO_PASSWORD: z.string().default('AuthenQ!Demo2026'),
  OUTBOUND_BLOCK_PRIVATE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  OUTBOUND_PRIVATE_ALLOWLIST: z.string().default(''),
  LOG_LEVEL: z.string().default(isTest ? 'silent' : 'info'),
});

const testDefaults: Record<string, string> = {
  DATABASE_URL: 'postgresql://authenq:authenq@localhost:5432/authenq_test?schema=public',
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
  ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef0123456789',
  CANARY_SECRET: 'test-canary-secret-0123456789abcdef0123456789',
  STORAGE_LOCAL_DIR: '.storage-test',
};

const source = isTest ? { ...testDefaults, ...process.env, ...(process.env.TEST_DATABASE_URL ? { DATABASE_URL: process.env.TEST_DATABASE_URL } : {}) } : process.env;
const parsed = schema.safeParse(source);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid AuthenQ configuration. Check your .env file:\n${issues}`);
}
if (isTest) process.env.DATABASE_URL = parsed.data.DATABASE_URL;

if (parsed.data.NODE_ENV === 'production') {
  for (const key of ['SESSION_SECRET', 'ENCRYPTION_KEY', 'CANARY_SECRET'] as const) {
    if (parsed.data[key].startsWith('change-me')) throw new Error(`${key} must be replaced before running in production`);
  }
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
