import crypto from 'node:crypto';
import { IntegrationStatus, IntegrationType, Prisma, TestType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { badRequest, notFound, unauthorized } from '../utils/errors.js';
import { hashToken, generateOpaqueToken } from './token.service.js';
import { createTestRun } from './testRun.service.js';

export interface UpsertIntegrationInput {
  organizationId: string;
  integrationType: IntegrationType;
  name: string;
  repository?: string | null;
  branch?: string | null;
  configuration?: Record<string, unknown>;
  status?: IntegrationStatus;
}

export const listIntegrations = (organizationId: string) =>
  prisma.integration.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' } });

export const createIntegration = (input: UpsertIntegrationInput) =>
  prisma.integration.create({
    data: {
      organizationId: input.organizationId,
      integrationType: input.integrationType,
      name: input.name,
      repository: input.repository ?? null,
      branch: input.branch ?? null,
      configuration: (input.configuration ?? {}) as Prisma.InputJsonValue,
      status: input.status ?? IntegrationStatus.INACTIVE,
    },
  });

export const updateIntegration = async (
  organizationId: string,
  integrationId: string,
  patch: Partial<UpsertIntegrationInput>,
) => {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, organizationId },
  });
  if (!integration) throw notFound('Integration not found');
  return prisma.integration.update({
    where: { id: integration.id },
    data: {
      name: patch.name,
      repository: patch.repository,
      branch: patch.branch,
      status: patch.status,
      configuration: patch.configuration
        ? (patch.configuration as Prisma.InputJsonValue)
        : undefined,
    },
  });
};

export const deleteIntegration = async (organizationId: string, integrationId: string) => {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, organizationId },
  });
  if (!integration) throw notFound('Integration not found');
  await prisma.integration.delete({ where: { id: integration.id } });
};

export interface SimulatedPipelineEvent {
  commit?: string;
  branch?: string;
  modelId?: string | null;
  datasetId?: string | null;
  testType?: TestType;
}

/**
 * Simulated CI/CD trigger: a pipeline event starts a test run and the run
 * result becomes the gate status a real pipeline would read back.
 */
export const handlePipelineEvent = async (
  organizationId: string,
  integrationId: string,
  event: SimulatedPipelineEvent,
) => {
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, organizationId },
  });
  if (!integration) throw notFound('Integration not found');
  if (integration.status !== IntegrationStatus.ACTIVE) {
    throw badRequest('Integration is not active');
  }

  const configuration = integration.configuration as Record<string, unknown>;
  const modelId =
    event.modelId ?? (typeof configuration.modelId === 'string' ? configuration.modelId : null);
  const datasetId =
    event.datasetId ??
    (typeof configuration.datasetId === 'string' ? configuration.datasetId : null);

  const run = await createTestRun({
    organizationId,
    testType: event.testType ?? TestType.FULL_ASSESSMENT,
    modelId,
    datasetId,
    triggeredBy: `CI:${integration.integrationType}`,
  });

  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      lastCommit: event.commit ?? null,
      lastEventAt: new Date(),
      lastTestRunId: run.id,
      branch: event.branch ?? integration.branch,
    },
  });

  return { integrationId: integration.id, testRunId: run.id, reference: run.reference };
};

/** Records the outcome of a pipeline-triggered run so the gate status is queryable. */
export const recordPipelineResult = async (testRunId: string): Promise<void> => {
  const run = await prisma.testRun.findUnique({ where: { id: testRunId } });
  if (!run) return;
  await prisma.integration.updateMany({
    where: { lastTestRunId: testRunId },
    data: { lastResult: run.result },
  });
};

export const verifyWebhookSignature = (rawBody: string, signature: string | undefined): void => {
  if (!env.GITHUB_WEBHOOK_SECRET) return;
  if (!signature) throw unauthorized('Missing webhook signature');
  const expected = `sha256=${crypto
    .createHmac('sha256', env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw unauthorized('Invalid webhook signature');
  }
};

export const listApiKeys = (organizationId: string) =>
  prisma.apiKey.findMany({
    where: { organizationId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
  });

/** The plaintext key is returned exactly once; only its hash is persisted. */
export const createApiKey = async (organizationId: string, name: string) => {
  const { token } = generateOpaqueToken();
  const prefix = `aq_${token.slice(0, 6)}`;
  const plaintext = `${prefix}_${token}`;
  const record = await prisma.apiKey.create({
    data: { organizationId, name, prefix, keyHash: hashToken(plaintext) },
  });
  return { id: record.id, name: record.name, prefix, apiKey: plaintext };
};

export const revokeApiKey = async (organizationId: string, apiKeyId: string) => {
  const key = await prisma.apiKey.findFirst({ where: { id: apiKeyId, organizationId } });
  if (!key) throw notFound('API key not found');
  return prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
};

export const resolveApiKey = async (plaintext: string) => {
  const key = await prisma.apiKey.findFirst({
    where: { keyHash: hashToken(plaintext), revokedAt: null },
  });
  if (!key) return null;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return key;
};
