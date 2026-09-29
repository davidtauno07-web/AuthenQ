import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.routes.js';
import { organizationRouter } from './routes/organization.routes.js';
import { dataSourceRouter } from './routes/dataSource.routes.js';
import { datasetRouter } from './routes/dataset.routes.js';
import { modelRouter } from './routes/model.routes.js';
import { testRunRouter } from './routes/testRun.routes.js';
import { alertRouter } from './routes/alert.routes.js';
import { monitoringRouter } from './routes/monitoring.routes.js';
import { reportRouter } from './routes/report.routes.js';
import { integrationRouter } from './routes/integration.routes.js';
import { dashboardRouter } from './routes/dashboard.routes.js';
import { jobRunner } from './workers/jobRunner.js';
import { registerTestRunWorker } from './services/testRun.service.js';

export const createApp = (): Express => {
  registerTestRunWorker();

  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', jobs: jobRunner.stats, timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/organization', organizationRouter);
  app.use('/api/data-sources', dataSourceRouter);
  app.use('/api/datasets', datasetRouter);
  app.use('/api/models', modelRouter);
  app.use('/api/test-runs', testRunRouter);
  app.use('/api/alerts', alertRouter);
  app.use('/api/monitoring', monitoringRouter);
  app.use('/api/reports', reportRouter);
  app.use('/api/integrations', integrationRouter);
  app.use('/api/dashboard', dashboardRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
