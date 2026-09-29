import {
  ConnectionStatus,
  DataSourceType,
  Frequency,
  IntegrationStatus,
  IntegrationType,
  ModelEnvironment,
  ModelProvider,
  ModelStatus,
  ModelType,
  ReportFormat,
  ReportType,
  Role,
  TestType,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../services/auth.service.js';
import { DEFAULT_ORG_SETTINGS } from '../services/settings.service.js';
import { createDataset, scanDataset } from '../services/dataset.service.js';
import { createTestRun, registerTestRunWorker } from '../services/testRun.service.js';
import { jobRunner } from '../workers/jobRunner.js';
import { generateReport } from '../services/report.service.js';
import { nextRunFrom } from '../services/monitoring.service.js';
import { buildRecords, DEMO_DATASETS } from './demoData.js';

const DEMO_PASSWORD = 'AuthenQ!Demo2026';

const main = async (): Promise<void> => {
  registerTestRunWorker();

  // A seed is a reset of the demo tenant, not of unrelated organizations.
  const existing = await prisma.organization.findUnique({ where: { slug: 'northbank-financial' } });
  if (existing) {
    await prisma.organization.delete({ where: { id: existing.id } });
  }

  const organization = await prisma.organization.create({
    data: {
      name: 'Northbank Financial (Demo)',
      slug: 'northbank-financial',
      industry: 'Financial services',
      settings: DEFAULT_ORG_SETTINGS,
    },
  });

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [admin] = await Promise.all([
    prisma.user.create({
      data: {
        organizationId: organization.id,
        email: 'admin@authenq.demo',
        name: 'Ada Lindqvist',
        passwordHash,
        role: Role.ORG_ADMIN,
      },
    }),
    prisma.user.create({
      data: {
        organizationId: organization.id,
        email: 'analyst@authenq.demo',
        name: 'Rasmus Ilves',
        passwordHash,
        role: Role.ANALYST,
      },
    }),
    prisma.user.create({
      data: {
        organizationId: organization.id,
        email: 'viewer@authenq.demo',
        name: 'Nora Pärn',
        passwordHash,
        role: Role.VIEWER,
      },
    }),
  ]);

  const warehouse = await prisma.dataSource.create({
    data: {
      organizationId: organization.id,
      name: 'Core Banking Warehouse (Demo)',
      type: DataSourceType.WAREHOUSE,
      configuration: { host: 'warehouse.internal.demo', database: 'core', schema: 'analytics' },
      connectionStatus: ConnectionStatus.CONNECTED,
      lastCheckedAt: new Date(),
    },
  });
  await prisma.dataSource.create({
    data: {
      organizationId: organization.id,
      name: 'HR Applicant API (Demo)',
      type: DataSourceType.REST_API,
      configuration: { baseUrl: 'https://hr.internal.demo/api', authEnvVar: 'HR_API_TOKEN' },
      connectionStatus: ConnectionStatus.CONNECTED,
      lastCheckedAt: new Date(),
    },
  });

  const datasets = [];
  for (const definition of DEMO_DATASETS) {
    const dataset = await createDataset({
      organizationId: organization.id,
      dataSourceId: warehouse.id,
      name: definition.name,
      version: definition.version,
      domain: definition.domain,
      schema: definition.schema,
      records: buildRecords(definition, 'authenq-seed'),
    });
    await scanDataset(organization.id, dataset.id);
    datasets.push(dataset);
  }

  const lendingDataset = datasets[0]!;
  const hiringDataset = datasets[1]!;

  const creditModel = await prisma.model.create({
    data: {
      organizationId: organization.id,
      name: 'Credit Decision Engine',
      description: 'DEMO MODEL. Scores consumer lending applications.',
      version: '2.1',
      modelType: ModelType.CLASSIFICATION,
      provider: ModelProvider.MOCK,
      owner: 'Lending Risk',
      environment: ModelEnvironment.PRODUCTION,
      testFrequency: Frequency.WEEKLY,
      demoBehavior: 'GENDER_SENSITIVE',
      isDemo: true,
      status: ModelStatus.MONITORING,
    },
  });

  const hiringModel = await prisma.model.create({
    data: {
      organizationId: organization.id,
      name: 'Candidate Ranking Model',
      description: 'DEMO MODEL. Ranks graduate hiring candidates.',
      version: '1.4',
      modelType: ModelType.RANKING,
      provider: ModelProvider.MOCK,
      owner: 'People Analytics',
      environment: ModelEnvironment.STAGING,
      testFrequency: Frequency.MONTHLY,
      demoBehavior: 'AGE_SENSITIVE',
      isDemo: true,
      status: ModelStatus.MONITORING,
    },
  });

  await prisma.model.create({
    data: {
      organizationId: organization.id,
      name: 'Fraud Triage Classifier',
      description: 'DEMO MODEL. Baseline model used for regression comparisons.',
      version: '3.0',
      modelType: ModelType.CLASSIFICATION,
      provider: ModelProvider.MOCK,
      owner: 'Financial Crime',
      environment: ModelEnvironment.PRODUCTION,
      testFrequency: Frequency.WEEKLY,
      demoBehavior: 'STABLE',
      isDemo: true,
      status: ModelStatus.MONITORING,
    },
  });

  // Historical runs give the dashboard a trend and the regression detector a baseline.
  const history: { modelId: string; datasetId: string; testType: TestType }[] = [
    { modelId: creditModel.id, datasetId: lendingDataset.id, testType: TestType.PRIVACY },
    { modelId: creditModel.id, datasetId: lendingDataset.id, testType: TestType.FAIRNESS },
    { modelId: hiringModel.id, datasetId: hiringDataset.id, testType: TestType.FAIRNESS },
    { modelId: creditModel.id, datasetId: lendingDataset.id, testType: TestType.FULL_ASSESSMENT },
  ];

  for (const entry of history) {
    await createTestRun({
      organizationId: organization.id,
      userId: admin.id,
      testType: entry.testType,
      modelId: entry.modelId,
      datasetId: entry.datasetId,
      configuration: { sampleSize: 400, caseCount: 400, generateReport: false },
      triggeredBy: 'SEED',
    });
    // Seeded runs execute through the real job runner, so the demo tenant
    // contains completed runs with the same artefacts a live run produces.
    await jobRunner.idle();
  }

  await prisma.monitoringSchedule.create({
    data: {
      organizationId: organization.id,
      name: 'Weekly credit fairness sweep',
      modelId: creditModel.id,
      datasetId: lendingDataset.id,
      testType: TestType.FULL_ASSESSMENT,
      frequency: Frequency.WEEKLY,
      enabled: true,
      nextRun: nextRunFrom(new Date(), Frequency.WEEKLY),
      configuration: { sampleSize: 500 },
    },
  });
  await prisma.monitoringSchedule.create({
    data: {
      organizationId: organization.id,
      name: 'Monthly hiring model review',
      modelId: hiringModel.id,
      datasetId: hiringDataset.id,
      testType: TestType.FAIRNESS,
      frequency: Frequency.MONTHLY,
      enabled: true,
      nextRun: nextRunFrom(new Date(), Frequency.MONTHLY),
      configuration: { caseCount: 600 },
    },
  });

  await prisma.integration.create({
    data: {
      organizationId: organization.id,
      integrationType: IntegrationType.GITHUB,
      name: 'northbank/credit-models (simulated)',
      repository: 'northbank/credit-models',
      branch: 'main',
      status: IntegrationStatus.ACTIVE,
      configuration: { events: ['push', 'pull_request'], blockOnFailure: true },
    },
  });

  await generateReport({
    organizationId: organization.id,
    userId: admin.id,
    reportType: ReportType.EXECUTIVE_SUMMARY,
    format: ReportFormat.PDF,
    title: 'Q1 2026 AI Risk Assessment — Executive Summary',
  });

  console.info(
    [
      'AuthenQ demo data seeded.',
      `Organization: ${organization.name}`,
      'Users: admin@authenq.demo / analyst@authenq.demo / viewer@authenq.demo',
      `Password: ${DEMO_PASSWORD}`,
    ].join('\n'),
  );
};

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
