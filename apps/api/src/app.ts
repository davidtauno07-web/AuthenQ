import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isProduction } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { storage, verifyLocalSignature } from './lib/storage.js';
import { asyncHandler } from './lib/http.js';
import { badRequest, forbidden } from './lib/errors.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/errors.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { authRouter } from './modules/auth/routes.js';
import { dataRouter } from './routes/data.js';
import { labelingRouter } from './routes/labeling.js';
import { platformRouter } from './routes/platform.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: true, directives: { 'img-src': ["'self'", 'data:'], 'connect-src': ["'self'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  if (env.NODE_ENV !== 'test') app.use(pinoHttp({ logger, customProps: (req: express.Request) => ({ requestId: req.requestId }), autoLogging: { ignore: (req: express.Request) => req.url?.startsWith('/health') ?? false } }));
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin === new URL(env.APP_URL).origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('access-control-allow-headers', 'content-type, x-csrf-token, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      if (req.method === 'OPTIONS') return void res.status(204).end();
    }
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  app.use(cookieParser());

  // Health: liveness never touches dependencies; readiness checks DB.
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get(
    '/health/ready',
    asyncHandler(async (_req, res) => {
      const checks: Record<string, string> = {};
      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = 'ok';
      } catch {
        checks.database = 'unavailable';
      }
      const pendingMigrations = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM _prisma_migrations WHERE finished_at IS NULL`.catch(() => [{ n: 1n }]);
      checks.migrations = Number(pendingMigrations[0]?.n ?? 0) === 0 ? 'ok' : 'pending';
      const ok = Object.values(checks).every((v) => v === 'ok');
      res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
    }),
  );
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'authenq-api', version: process.env.APP_VERSION ?? 'dev' }));

  const api = express.Router();
  api.use(rateLimit('api', isProduction ? 600 : 5000, 60, (req) => `api:${req.get('authorization')?.slice(7, 17) ?? req.cookies?.aq_session?.slice(0, 16) ?? req.ip}`));
  api.use('/auth', authRouter);

  // Signed local-storage downloads (S3 uses native presigned URLs). The signature itself is the authorization.
  api.get(
    '/files/signed',
    asyncHandler(async (req, res) => {
      const key = String(req.query.key ?? '');
      const exp = Number(req.query.exp);
      if (!verifyLocalSignature(key, exp, String(req.query.sig ?? ''))) throw forbidden('This download link is invalid or has expired.');
      if (key.split('/')[1] !== 'exports') throw badRequest('Only export packages can be downloaded with a signed link.');
      const name = String(req.query.name ?? 'download').replace(/[^\w.-]/g, '_');
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', `attachment; filename="${name}"`);
      res.send(await storage.get(key));
    }),
  );

  api.use(requireAuth);
  api.use(platformRouter);
  api.use(dataRouter);
  api.use(labelingRouter);
  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
