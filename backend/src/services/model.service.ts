import {
  ConnectionStatus,
  ModelStatus,
  Prisma,
  type Frequency,
  type ModelEnvironment,
  type ModelProvider,
  type ModelType,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { conflict, notFound } from '../utils/errors.js';
import { resolveProvider } from '../engines/models/index.js';

export interface UpsertModelInput {
  organizationId: string;
  name: string;
  description?: string | null;
  version?: string;
  modelType?: ModelType;
  provider?: ModelProvider;
  endpoint?: string | null;
  authConfig?: Record<string, unknown>;
  owner?: string | null;
  environment?: ModelEnvironment;
  testFrequency?: Frequency;
  demoBehavior?: string | null;
  isDemo?: boolean;
}

export const listModels = (organizationId: string) =>
  prisma.model.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { testRuns: true } },
      testRuns: {
        where: { status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        take: 1,
        select: { id: true, reference: true, result: true, riskScore: true, completedAt: true },
      },
    },
  });

export const getModel = async (organizationId: string, modelId: string) => {
  const model = await prisma.model.findFirst({
    where: { id: modelId, organizationId },
    include: {
      versions: { orderBy: { createdAt: 'desc' } },
      testRuns: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          reference: true,
          testType: true,
          status: true,
          result: true,
          riskScore: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });
  if (!model) throw notFound('Model not found');
  return model;
};

export const createModel = async (input: UpsertModelInput) => {
  const existing = await prisma.model.findFirst({
    where: {
      organizationId: input.organizationId,
      name: input.name,
      version: input.version ?? '1.0',
    },
  });
  if (existing) throw conflict('A model with this name and version already exists');

  return prisma.model.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      version: input.version ?? '1.0',
      modelType: input.modelType,
      provider: input.provider,
      endpoint: input.endpoint ?? null,
      authConfig: (input.authConfig ?? {}) as Prisma.InputJsonValue,
      owner: input.owner ?? null,
      environment: input.environment,
      testFrequency: input.testFrequency,
      demoBehavior: input.demoBehavior ?? null,
      isDemo: input.isDemo ?? input.provider === 'MOCK',
      status: ModelStatus.REGISTERED,
    },
  });
};

export const updateModel = async (
  organizationId: string,
  modelId: string,
  patch: Partial<UpsertModelInput>,
) => {
  const model = await prisma.model.findFirst({ where: { id: modelId, organizationId } });
  if (!model) throw notFound('Model not found');

  // A version change is a new system under test; history makes regressions explainable.
  if (patch.version && patch.version !== model.version) {
    await prisma.modelVersionHistory.create({
      data: { modelId: model.id, version: model.version, note: 'Superseded' },
    });
  }

  return prisma.model.update({
    where: { id: model.id },
    data: {
      name: patch.name,
      description: patch.description,
      version: patch.version,
      modelType: patch.modelType,
      provider: patch.provider,
      endpoint: patch.endpoint,
      authConfig: patch.authConfig
        ? (patch.authConfig as Prisma.InputJsonValue)
        : undefined,
      owner: patch.owner,
      environment: patch.environment,
      testFrequency: patch.testFrequency,
      demoBehavior: patch.demoBehavior,
      isDemo: patch.isDemo,
    },
  });
};

export const deleteModel = async (organizationId: string, modelId: string) => {
  const model = await prisma.model.findFirst({ where: { id: modelId, organizationId } });
  if (!model) throw notFound('Model not found');
  await prisma.model.delete({ where: { id: model.id } });
};

export const checkModelHealth = async (organizationId: string, modelId: string) => {
  const model = await prisma.model.findFirst({ where: { id: modelId, organizationId } });
  if (!model) throw notFound('Model not found');
  const adapter = resolveProvider(model.provider);
  const health = await adapter.healthCheck({
    id: model.id,
    name: model.name,
    version: model.version,
    endpoint: model.endpoint,
    authConfig: model.authConfig as Record<string, unknown>,
    demoBehavior: model.demoBehavior,
    isDemo: model.isDemo,
  });
  await prisma.model.update({
    where: { id: model.id },
    data: { status: health.healthy ? ModelStatus.MONITORING : ModelStatus.PAUSED },
  });
  return { ...health, provider: adapter.kind, connectionStatus: health.healthy ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR };
};
