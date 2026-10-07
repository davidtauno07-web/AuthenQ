import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

import { ensureSystemData } from './modules/bootstrap.js';

await ensureSystemData();
const app = createApp();
const server = app.listen(env.API_PORT, () => logger.info({ port: env.API_PORT }, 'AuthenQ API listening'));

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down API');
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
