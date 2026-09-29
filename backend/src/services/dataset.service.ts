import { DatasetStatus, Prisma, SyntheticStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';
import {
  isDirectIdentifier,
  scanSchemaForPii,
  type PiiDetection,
  type SchemaField,
} from '../engines/privacy/piiDetector.js';

export const parseSchema = (schemaJson: Prisma.JsonValue): SchemaField[] => {
  if (!Array.isArray(schemaJson)) return [];
  return schemaJson
    .filter((entry) => Boolean(entry && typeof entry === 'object' && 'name' in entry && 'type' in entry))
    .map((entry) => entry as unknown as SchemaField);
};

export const listDatasets = (organizationId: string) =>
  prisma.dataset.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: {
      dataSource: { select: { id: true, name: true, type: true } },
      sensitiveFields: true,
      _count: { select: { syntheticDatasets: true, records: true } },
    },
  });

export const getDataset = async (organizationId: string, datasetId: string) => {
  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, organizationId },
    include: {
      dataSource: true,
      sensitiveFields: { orderBy: { fieldName: 'asc' } },
      syntheticDatasets: {
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { adversarialCases: true, records: true } } },
      },
      _count: { select: { records: true } },
    },
  });
  if (!dataset) throw notFound('Dataset not found');
  return dataset;
};

export interface CreateDatasetInput {
  organizationId: string;
  dataSourceId?: string | null;
  name: string;
  version?: string;
  domain?: string | null;
  schema: SchemaField[];
  records?: Record<string, unknown>[];
}

export const createDataset = async (input: CreateDatasetInput) => {
  if (input.dataSourceId) {
    const source = await prisma.dataSource.findFirst({
      where: { id: input.dataSourceId, organizationId: input.organizationId },
    });
    if (!source) throw notFound('Data source not found');
  }
  const records = input.records ?? [];
  return prisma.dataset.create({
    data: {
      organizationId: input.organizationId,
      dataSourceId: input.dataSourceId ?? null,
      name: input.name,
      version: input.version ?? '1.0',
      domain: input.domain ?? null,
      schemaJson: input.schema as unknown as Prisma.InputJsonValue,
      recordCount: records.length,
      status: DatasetStatus.REGISTERED,
      records: {
        create: records.map((payload) => ({ payload: payload as Prisma.InputJsonValue })),
      },
    },
  });
};

/**
 * Raw source rows never leave the backend: callers receive them only inside
 * engine execution, and API responses expose masked or synthetic data instead.
 */
export const loadSourceRecords = async (
  datasetId: string,
  limit = 10_000,
): Promise<Record<string, unknown>[]> => {
  const rows = await prisma.datasetRecord.findMany({
    where: { datasetId },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.payload as Record<string, unknown>);
};

/**
 * Adversarial test profiles for fairness testing.
 *
 * Counterfactual testing needs the protected attributes intact, so profiles are
 * derived from source records with direct identifiers removed rather than from
 * the generalized protected representation used for privacy testing.
 */
export const loadTestProfiles = async (
  datasetId: string,
  limit = 10_000,
): Promise<Record<string, unknown>[]> => {
  const [records, dataset] = await Promise.all([
    loadSourceRecords(datasetId, limit),
    prisma.dataset.findUnique({ where: { id: datasetId } }),
  ]);
  if (!dataset) throw notFound('Dataset not found');
  const identifierFields = scanSchemaForPii(parseSchema(dataset.schemaJson), { sampleRecords: records })
    .filter((field) => isDirectIdentifier(field.category))
    .map((field) => field.fieldName);

  return records.map((record) => {
    const profile: Record<string, unknown> = { ...record };
    for (const field of identifierFields) delete profile[field];
    return profile;
  });
};

export const loadSyntheticRecords = async (
  syntheticDatasetId: string,
  limit = 10_000,
): Promise<Record<string, unknown>[]> => {
  const rows = await prisma.syntheticRecord.findMany({
    where: { syntheticDatasetId },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.payload as Record<string, unknown>);
};

export interface ScanResult {
  datasetId: string;
  detections: PiiDetection[];
  newFields: string[];
  schemaFieldCount: number;
}

/** Schema inspection + PII/sensitive-field detection. */
export const scanDataset = async (
  organizationId: string,
  datasetId: string,
): Promise<ScanResult> => {
  const dataset = await prisma.dataset.findFirst({
    where: { id: datasetId, organizationId },
    include: { sensitiveFields: true },
  });
  if (!dataset) throw notFound('Dataset not found');

  const schema = parseSchema(dataset.schemaJson);
  const sample = await loadSourceRecords(datasetId, 200);
  const detections = scanSchemaForPii(schema, { sampleRecords: sample });
  const known = new Set(dataset.sensitiveFields.map((field) => field.fieldName));

  await prisma.$transaction([
    prisma.sensitiveField.deleteMany({ where: { datasetId } }),
    prisma.sensitiveField.createMany({
      data: detections.map((detection) => ({
        datasetId,
        fieldName: detection.fieldName,
        category: detection.category,
        sensitivityLevel: detection.sensitivityLevel,
        detectionMethod: detection.detectionMethod,
        confidence: detection.confidence,
        sampleMasked: detection.sampleMasked,
      })),
    }),
    prisma.dataset.update({
      where: { id: datasetId },
      data: { status: DatasetStatus.SCANNED },
    }),
  ]);

  return {
    datasetId,
    detections,
    newFields: detections.map((d) => d.fieldName).filter((name) => !known.has(name)),
    schemaFieldCount: schema.length,
  };
};

export const loadDetections = async (datasetId: string): Promise<PiiDetection[]> => {
  const fields = await prisma.sensitiveField.findMany({ where: { datasetId } });
  return fields.map((field) => ({
    fieldName: field.fieldName,
    category: field.category as PiiDetection['category'],
    sensitivityLevel: field.sensitivityLevel,
    detectionMethod: field.detectionMethod as PiiDetection['detectionMethod'],
    confidence: field.confidence,
    sampleMasked: field.sampleMasked,
  }));
};

export const latestReadySyntheticDataset = (datasetId: string) =>
  prisma.syntheticDataset.findFirst({
    where: { datasetId, status: SyntheticStatus.READY },
    orderBy: { createdAt: 'desc' },
  });

export const deleteDataset = async (organizationId: string, datasetId: string) => {
  const dataset = await prisma.dataset.findFirst({ where: { id: datasetId, organizationId } });
  if (!dataset) throw notFound('Dataset not found');
  await prisma.dataset.delete({ where: { id: datasetId } });
};
