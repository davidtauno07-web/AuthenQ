-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ORG_ADMIN', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('POSTGRES', 'MYSQL', 'SNOWFLAKE', 'REST_API', 'CSV', 'WAREHOUSE', 'DEMO');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'ERROR', 'PENDING');

-- CreateEnum
CREATE TYPE "DatasetStatus" AS ENUM ('REGISTERED', 'SCANNED', 'PROTECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SensitivityLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SyntheticStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AdversarialStatus" AS ENUM ('GENERATED', 'TESTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ModelType" AS ENUM ('CLASSIFICATION', 'SCORING', 'RANKING', 'GENERATIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "ModelEnvironment" AS ENUM ('DEVELOPMENT', 'STAGING', 'PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "ModelStatus" AS ENUM ('REGISTERED', 'MONITORING', 'PAUSED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ModelProvider" AS ENUM ('MOCK', 'REST', 'INTERNAL', 'SANDBOX');

-- CreateEnum
CREATE TYPE "TestType" AS ENUM ('PRIVACY', 'FAIRNESS', 'FULL_ASSESSMENT');

-- CreateEnum
CREATE TYPE "TestRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TestResult" AS ENUM ('PASS', 'WARNING', 'FAIL', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "Frequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('PRIVACY_THRESHOLD_EXCEEDED', 'FAIRNESS_THRESHOLD_EXCEEDED', 'MODEL_REGRESSION_DETECTED', 'SCHEMA_CHANGED', 'NEW_SENSITIVE_FIELD', 'TEST_FAILED', 'SCHEDULED_TEST_FAILED', 'MODEL_VERSION_CHANGED', 'DATASET_CHANGED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('NEW', 'INVESTIGATING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('PRIVACY_ASSESSMENT', 'FAIRNESS_ASSESSMENT', 'MODEL_RISK_ASSESSMENT', 'CONTINUOUS_MONITORING', 'EXECUTIVE_SUMMARY');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'JSON', 'CSV');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('GITHUB', 'GITLAB', 'MODEL_API', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ERROR');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DataSourceType" NOT NULL,
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dataSourceId" TEXT,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "schemaVersion" TEXT NOT NULL DEFAULT '1',
    "schemaJson" JSONB NOT NULL DEFAULT '[]',
    "status" "DatasetStatus" NOT NULL DEFAULT 'REGISTERED',
    "domain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetRecord" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensitiveField" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "sensitivityLevel" "SensitivityLevel" NOT NULL,
    "detectionMethod" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleMasked" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensitiveField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticDataset" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "generationMethod" TEXT NOT NULL,
    "privacyConfiguration" JSONB NOT NULL DEFAULT '{}',
    "statisticalSimilarity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "SyntheticStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyntheticDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyntheticRecord" (
    "id" TEXT NOT NULL,
    "syntheticDatasetId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyntheticRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdversarialCase" (
    "id" TEXT NOT NULL,
    "syntheticDatasetId" TEXT NOT NULL,
    "scenarioType" TEXT NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "reidentification" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "AdversarialStatus" NOT NULL DEFAULT 'GENERATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdversarialCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Model" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "modelType" "ModelType" NOT NULL DEFAULT 'CLASSIFICATION',
    "provider" "ModelProvider" NOT NULL DEFAULT 'MOCK',
    "endpoint" TEXT,
    "authConfig" JSONB NOT NULL DEFAULT '{}',
    "owner" TEXT,
    "environment" "ModelEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "testFrequency" "Frequency" NOT NULL DEFAULT 'WEEKLY',
    "status" "ModelStatus" NOT NULL DEFAULT 'REGISTERED',
    "demoBehavior" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelVersionHistory" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelVersionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "testType" "TestType" NOT NULL,
    "modelId" TEXT,
    "datasetId" TEXT,
    "status" "TestRunStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "stage" TEXT,
    "stages" JSONB NOT NULL DEFAULT '[]',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "riskScore" DOUBLE PRECISION,
    "result" "TestResult",
    "summary" JSONB NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'MANUAL',
    "modelVersion" TEXT,
    "datasetVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyTest" (
    "id" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "syntheticDatasetId" TEXT,
    "recordsTested" INTEGER NOT NULL,
    "adversarialCases" INTEGER NOT NULL DEFAULT 0,
    "highRiskCases" INTEGER NOT NULL DEFAULT 0,
    "reidentificationCases" INTEGER NOT NULL DEFAULT 0,
    "privacyScore" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "result" "TestResult" NOT NULL,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FairnessTest" (
    "id" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "protectedAttribute" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "baselineSelectionRate" DOUBLE PRECISION NOT NULL,
    "variantSelectionRate" DOUBLE PRECISION NOT NULL,
    "selectionRateDiff" DOUBLE PRECISION NOT NULL,
    "demographicParityDiff" DOUBLE PRECISION NOT NULL,
    "equalOpportunityDiff" DOUBLE PRECISION NOT NULL,
    "counterfactualFlipRate" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "confidenceLow" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidenceHigh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "result" "TestResult" NOT NULL,
    "metricsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FairnessTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CounterfactualCase" (
    "id" TEXT NOT NULL,
    "fairnessTestId" TEXT NOT NULL,
    "originalProfile" JSONB NOT NULL,
    "counterfactualProfile" JSONB NOT NULL,
    "originalOutcome" TEXT NOT NULL,
    "counterfactualOutcome" TEXT NOT NULL,
    "originalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "counterfactualScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outcomeChanged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounterfactualCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "metricName" TEXT NOT NULL,
    "metricValue" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'ratio',
    "breached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringSchedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "modelId" TEXT,
    "datasetId" TEXT,
    "name" TEXT NOT NULL,
    "testType" "TestType" NOT NULL DEFAULT 'FULL_ASSESSMENT',
    "frequency" "Frequency" NOT NULL DEFAULT 'WEEKLY',
    "intervalHours" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "nextRun" TIMESTAMP(3),
    "lastRun" TIMESTAMP(3),
    "lastResult" "TestResult",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "testRunId" TEXT,
    "metricName" TEXT,
    "currentValue" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "recommendedAction" TEXT,
    "status" "AlertStatus" NOT NULL DEFAULT 'NEW',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "format" "ReportFormat" NOT NULL DEFAULT 'PDF',
    "title" TEXT NOT NULL,
    "modelId" TEXT,
    "testRunId" TEXT,
    "rangeStart" TIMESTAMP(3),
    "rangeEnd" TIMESTAMP(3),
    "generatedById" TEXT,
    "fileLocation" TEXT,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationType" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "status" "IntegrationStatus" NOT NULL DEFAULT 'INACTIVE',
    "repository" TEXT,
    "branch" TEXT,
    "lastCommit" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastTestRunId" TEXT,
    "lastResult" "TestResult",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE INDEX "DataSource_organizationId_idx" ON "DataSource"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_organizationId_name_key" ON "DataSource"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Dataset_organizationId_idx" ON "Dataset"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_organizationId_name_version_key" ON "Dataset"("organizationId", "name", "version");

-- CreateIndex
CREATE INDEX "DatasetRecord_datasetId_idx" ON "DatasetRecord"("datasetId");

-- CreateIndex
CREATE INDEX "SensitiveField_datasetId_idx" ON "SensitiveField"("datasetId");

-- CreateIndex
CREATE UNIQUE INDEX "SensitiveField_datasetId_fieldName_key" ON "SensitiveField"("datasetId", "fieldName");

-- CreateIndex
CREATE INDEX "SyntheticDataset_datasetId_idx" ON "SyntheticDataset"("datasetId");

-- CreateIndex
CREATE INDEX "SyntheticRecord_syntheticDatasetId_idx" ON "SyntheticRecord"("syntheticDatasetId");

-- CreateIndex
CREATE INDEX "AdversarialCase_syntheticDatasetId_idx" ON "AdversarialCase"("syntheticDatasetId");

-- CreateIndex
CREATE INDEX "AdversarialCase_scenarioType_idx" ON "AdversarialCase"("scenarioType");

-- CreateIndex
CREATE INDEX "Model_organizationId_idx" ON "Model"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Model_organizationId_name_version_key" ON "Model"("organizationId", "name", "version");

-- CreateIndex
CREATE INDEX "ModelVersionHistory_modelId_idx" ON "ModelVersionHistory"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "TestRun_reference_key" ON "TestRun"("reference");

-- CreateIndex
CREATE INDEX "TestRun_organizationId_createdAt_idx" ON "TestRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "TestRun_modelId_idx" ON "TestRun"("modelId");

-- CreateIndex
CREATE INDEX "TestRun_datasetId_idx" ON "TestRun"("datasetId");

-- CreateIndex
CREATE INDEX "PrivacyTest_testRunId_idx" ON "PrivacyTest"("testRunId");

-- CreateIndex
CREATE INDEX "FairnessTest_testRunId_idx" ON "FairnessTest"("testRunId");

-- CreateIndex
CREATE INDEX "CounterfactualCase_fairnessTestId_idx" ON "CounterfactualCase"("fairnessTestId");

-- CreateIndex
CREATE INDEX "CounterfactualCase_fairnessTestId_outcomeChanged_idx" ON "CounterfactualCase"("fairnessTestId", "outcomeChanged");

-- CreateIndex
CREATE INDEX "Metric_testRunId_idx" ON "Metric"("testRunId");

-- CreateIndex
CREATE INDEX "Metric_metricName_idx" ON "Metric"("metricName");

-- CreateIndex
CREATE INDEX "MonitoringSchedule_organizationId_idx" ON "MonitoringSchedule"("organizationId");

-- CreateIndex
CREATE INDEX "Alert_organizationId_status_idx" ON "Alert"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Alert_testRunId_idx" ON "Alert"("testRunId");

-- CreateIndex
CREATE INDEX "Report_organizationId_createdAt_idx" ON "Report"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSource" ADD CONSTRAINT "DataSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetRecord" ADD CONSTRAINT "DatasetRecord_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensitiveField" ADD CONSTRAINT "SensitiveField_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticDataset" ADD CONSTRAINT "SyntheticDataset_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyntheticRecord" ADD CONSTRAINT "SyntheticRecord_syntheticDatasetId_fkey" FOREIGN KEY ("syntheticDatasetId") REFERENCES "SyntheticDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdversarialCase" ADD CONSTRAINT "AdversarialCase_syntheticDatasetId_fkey" FOREIGN KEY ("syntheticDatasetId") REFERENCES "SyntheticDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelVersionHistory" ADD CONSTRAINT "ModelVersionHistory_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyTest" ADD CONSTRAINT "PrivacyTest_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FairnessTest" ADD CONSTRAINT "FairnessTest_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CounterfactualCase" ADD CONSTRAINT "CounterfactualCase_fairnessTestId_fkey" FOREIGN KEY ("fairnessTestId") REFERENCES "FairnessTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringSchedule" ADD CONSTRAINT "MonitoringSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringSchedule" ADD CONSTRAINT "MonitoringSchedule_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
