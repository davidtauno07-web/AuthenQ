import { ConnectionStatus, Prisma, type DataSourceType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { conflict, notFound } from '../utils/errors.js';

export interface UpsertDataSourceInput {
  organizationId: string;
  name: string;
  type: DataSourceType;
  configuration?: Record<string, unknown>;
}

export const listDataSources = (organizationId: string) =>
  prisma.dataSource.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { datasets: true } } },
  });

export const createDataSource = async (input: UpsertDataSourceInput) => {
  const existing = await prisma.dataSource.findFirst({
    where: { organizationId: input.organizationId, name: input.name },
  });
  if (existing) throw conflict('A data source with this name already exists');
  return prisma.dataSource.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      type: input.type,
      configuration: sanitizeConfiguration(input.configuration ?? {}),
    },
  });
};

export const updateDataSource = async (
  organizationId: string,
  dataSourceId: string,
  patch: Partial<UpsertDataSourceInput>,
) => {
  const source = await prisma.dataSource.findFirst({
    where: { id: dataSourceId, organizationId },
  });
  if (!source) throw notFound('Data source not found');
  return prisma.dataSource.update({
    where: { id: source.id },
    data: {
      name: patch.name,
      type: patch.type,
      configuration: patch.configuration
        ? sanitizeConfiguration(patch.configuration)
        : undefined,
    },
  });
};

export const deleteDataSource = async (organizationId: string, dataSourceId: string) => {
  const source = await prisma.dataSource.findFirst({
    where: { id: dataSourceId, organizationId },
  });
  if (!source) throw notFound('Data source not found');
  await prisma.dataSource.delete({ where: { id: source.id } });
};

/**
 * Connection test for the prototype: configuration completeness is validated and
 * credentials are resolved by environment-variable name, never stored inline.
 */
export const testConnection = async (organizationId: string, dataSourceId: string) => {
  const source = await prisma.dataSource.findFirst({
    where: { id: dataSourceId, organizationId },
  });
  if (!source) throw notFound('Data source not found');

  const configuration = source.configuration as Record<string, unknown>;
  const required = REQUIRED_KEYS[source.type] ?? [];
  const missing = required.filter((key) => !configuration[key]);
  const credentialEnvVar =
    typeof configuration.credentialEnvVar === 'string' ? configuration.credentialEnvVar : null;
  const credentialPresent = credentialEnvVar ? Boolean(process.env[credentialEnvVar]) : true;

  const healthy = missing.length === 0 && credentialPresent;
  const updated = await prisma.dataSource.update({
    where: { id: source.id },
    data: {
      connectionStatus: healthy ? ConnectionStatus.CONNECTED : ConnectionStatus.ERROR,
      lastCheckedAt: new Date(),
    },
  });

  return {
    dataSource: updated,
    healthy,
    missingConfiguration: missing,
    credentialEnvVar,
    credentialPresent,
    message: healthy
      ? 'Configuration is complete and credentials resolve from the environment.'
      : `Connection could not be validated: ${[
          ...missing.map((key) => `missing "${key}"`),
          ...(credentialPresent ? [] : [`environment variable ${credentialEnvVar} is not set`]),
        ].join(', ')}`,
  };
};

const REQUIRED_KEYS: Partial<Record<DataSourceType, string[]>> = {
  POSTGRES: ['host', 'database'],
  MYSQL: ['host', 'database'],
  SNOWFLAKE: ['account', 'warehouse', 'database'],
  WAREHOUSE: ['host', 'database'],
  REST_API: ['baseUrl'],
  CSV: [],
  DEMO: [],
};

/** Secrets are referenced by environment-variable name; raw values are dropped. */
const sanitizeConfiguration = (configuration: Record<string, unknown>): Prisma.InputJsonValue => {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(configuration)) {
    if (/password|secret|token|apikey|api_key/i.test(key)) continue;
    clean[key] = value;
  }
  return clean as Prisma.InputJsonValue;
};
