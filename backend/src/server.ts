import { createApp } from './app.js';
import { env } from './config/env.js';
import { processDueSchedules } from './services/monitoring.service.js';

const SCHEDULER_INTERVAL_MS = 60_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.info(`AuthenQ API listening on port ${env.PORT}`);
});

/** In-process scheduler; a production deployment would use a dedicated worker. */
const scheduler = setInterval(() => {
  void processDueSchedules().catch((error: unknown) => {
    console.error('Scheduled monitoring sweep failed', error);
  });
}, SCHEDULER_INTERVAL_MS);
scheduler.unref();

const shutdown = (): void => {
  clearInterval(scheduler);
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
