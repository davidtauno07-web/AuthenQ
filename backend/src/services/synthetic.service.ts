import { DatasetStatus, Prisma, SyntheticStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound } from '../utils/errors.js';
import {
  DEFAULT_PRIVACY_CONFIGURATION,
  generateSyntheticRecords,
  type PrivacyConfiguration,
} from '../engines/privacy/syntheticGenerator.js';
import { loadDetections, loadSourceRecords, parseSchema } from './dataset.service.js';

/** Cap on persisted synthetic rows — the metrics matter, not bulk storage. */
export const MAX_PERSISTED_SYNTHETIC_RECORDS = 1_000;

export interface GenerateSyntheticInput {
  organizationId: string;
  datasetId: string;
  recordCount?: number;
  configuration?: Partial<PrivacyConfiguration>;
}

export const generateSyntheticDataset = async (input: GenerateSyntheticInput) => {
  const dataset = await prisma.dataset.findFirst({
    where: { id: input.datasetId, organizationId: input.organizationId },
    include: { syntheticDatasets: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!dataset) throw notFound('Dataset not found');

  const schema = parseSchema(dataset.schemaJson);
  if (schema.length === 0) throw badRequest('Dataset has no schema to generate from');

  const detections = await loadDetections(dataset.id);
  const sourceRecords = await loadSourceRecords(dataset.id);
  if (sourceRecords.length === 0) {
    throw badRequest('Dataset has no records; import records before generating synthetic data');
  }

  const configuration: PrivacyConfiguration = {
    ...DEFAULT_PRIVACY_CONFIGURATION,
    seed: `${dataset.id}:${dataset.version}`,
    ...input.configuration,
  };
  const targetCount = input.recordCount ?? sourceRecords.length;

  const previousVersion = dataset.syntheticDatasets[0]?.version ?? '0.0';
  const version = `${Number(previousVersion.split('.')[0] ?? 0) + 1}.0`;

  const record = await prisma.syntheticDataset.create({
    data: {
      datasetId: dataset.id,
      version,
      recordCount: 0,
      generationMethod: 'PROTOTYPE_PRIVACY_SIMULATION_V1',
      privacyConfiguration: configuration as unknown as Prisma.InputJsonValue,
      status: SyntheticStatus.GENERATING,
    },
  });

  try {
    const generated = generateSyntheticRecords(
      schema,
      sourceRecords,
      detections,
      targetCount,
      configuration,
    );

    await prisma.$transaction([
      prisma.syntheticRecord.createMany({
        data: generated.records
          .slice(0, MAX_PERSISTED_SYNTHETIC_RECORDS)
          .map((payload) => ({
            syntheticDatasetId: record.id,
            payload: payload as Prisma.InputJsonValue,
          })),
      }),
      prisma.syntheticDataset.update({
        where: { id: record.id },
        data: {
          recordCount: generated.records.length,
          statisticalSimilarity: generated.statisticalSimilarity,
          status: SyntheticStatus.READY,
        },
      }),
      prisma.dataset.update({
        where: { id: dataset.id },
        data: { status: DatasetStatus.PROTECTED },
      }),
    ]);

    return {
      syntheticDatasetId: record.id,
      version,
      recordCount: generated.records.length,
      persistedRecords: Math.min(generated.records.length, MAX_PERSISTED_SYNTHETIC_RECORDS),
      statisticalSimilarity: generated.statisticalSimilarity,
      suppressedFields: generated.suppressedFields,
      method: generated.method,
      configuration,
      records: generated.records,
    };
  } catch (error) {
    await prisma.syntheticDataset.update({
      where: { id: record.id },
      data: { status: SyntheticStatus.FAILED },
    });
    throw error;
  }
};
