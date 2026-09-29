import { Frequency, Prisma, TestType } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound } from '../utils/errors.js';
import { createTestRun } from './testRun.service.js';

const HOURS: Record<Frequency, number> = {
  DAILY: 24,
  WEEKLY: 24 * 7,
  MONTHLY: 24 * 30,
  CUSTOM: 24,
};

export const intervalHoursFor = (frequency: Frequency, custom?: number | null): number =>
  frequency === Frequency.CUSTOM ? (custom ?? HOURS.CUSTOM) : HOURS[frequency];

export const nextRunFrom = (
  from: Date,
  frequency: Frequency,
  custom?: number | null,
): Date => new Date(from.getTime() + intervalHoursFor(frequency, custom) * 60 * 60 * 1000);

export interface UpsertScheduleInput {
  organizationId: string;
  name: string;
  modelId?: string | null;
  datasetId?: string | null;
  testType?: TestType;
  frequency?: Frequency;
  intervalHours?: number | null;
  enabled?: boolean;
  configuration?: Record<string, unknown>;
}

export const listSchedules = (organizationId: string) =>
  prisma.monitoringSchedule.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: { model: { select: { id: true, name: true, version: true } } },
  });

export const createSchedule = async (input: UpsertScheduleInput) => {
  if (input.modelId) {
    const model = await prisma.model.findFirst({
      where: { id: input.modelId, organizationId: input.organizationId },
    });
    if (!model) throw notFound('Model not found');
  }
  if (input.datasetId) {
    const dataset = await prisma.dataset.findFirst({
      where: { id: input.datasetId, organizationId: input.organizationId },
    });
    if (!dataset) throw notFound('Dataset not found');
  }
  const frequency = input.frequency ?? Frequency.WEEKLY;
  return prisma.monitoringSchedule.create({
    data: {
      organizationId: input.organizationId,
      name: input.name,
      modelId: input.modelId ?? null,
      datasetId: input.datasetId ?? null,
      testType: input.testType ?? TestType.FULL_ASSESSMENT,
      frequency,
      intervalHours: input.intervalHours ?? null,
      enabled: input.enabled ?? true,
      configuration: (input.configuration ?? {}) as Prisma.InputJsonValue,
      nextRun: nextRunFrom(new Date(), frequency, input.intervalHours),
    },
  });
};

export const updateSchedule = async (
  organizationId: string,
  scheduleId: string,
  patch: Partial<UpsertScheduleInput>,
) => {
  const schedule = await prisma.monitoringSchedule.findFirst({
    where: { id: scheduleId, organizationId },
  });
  if (!schedule) throw notFound('Monitoring schedule not found');
  if (patch.modelId) {
    const model = await prisma.model.findFirst({
      where: { id: patch.modelId, organizationId },
    });
    if (!model) throw notFound('Model not found');
  }
  if (patch.datasetId) {
    const dataset = await prisma.dataset.findFirst({
      where: { id: patch.datasetId, organizationId },
    });
    if (!dataset) throw notFound('Dataset not found');
  }
  const frequency = patch.frequency ?? schedule.frequency;
  return prisma.monitoringSchedule.update({
    where: { id: schedule.id },
    data: {
      name: patch.name,
      modelId: patch.modelId,
      datasetId: patch.datasetId,
      testType: patch.testType,
      frequency: patch.frequency,
      intervalHours: patch.intervalHours,
      enabled: patch.enabled,
      configuration: patch.configuration
        ? (patch.configuration as Prisma.InputJsonValue)
        : undefined,
      nextRun:
        patch.frequency || patch.intervalHours !== undefined
          ? nextRunFrom(new Date(), frequency, patch.intervalHours ?? schedule.intervalHours)
          : undefined,
    },
  });
};

export const deleteSchedule = async (organizationId: string, scheduleId: string) => {
  const schedule = await prisma.monitoringSchedule.findFirst({
    where: { id: scheduleId, organizationId },
  });
  if (!schedule) throw notFound('Monitoring schedule not found');
  await prisma.monitoringSchedule.delete({ where: { id: schedule.id } });
};

/** Triggers a schedule immediately and rolls its next run forward. */
export const runScheduleNow = async (organizationId: string, scheduleId: string) => {
  const schedule = await prisma.monitoringSchedule.findFirst({
    where: { id: scheduleId, organizationId },
  });
  if (!schedule) throw notFound('Monitoring schedule not found');
  if (!schedule.modelId && !schedule.datasetId) {
    throw badRequest('Schedule has neither a model nor a dataset to test');
  }

  const run = await createTestRun({
    organizationId,
    testType: schedule.testType,
    modelId: schedule.modelId,
    datasetId: schedule.datasetId,
    triggeredBy: 'SCHEDULE',
  });

  await prisma.monitoringSchedule.update({
    where: { id: schedule.id },
    data: {
      lastRun: new Date(),
      nextRun: nextRunFrom(new Date(), schedule.frequency, schedule.intervalHours),
    },
  });

  return run;
};

/**
 * Scheduler tick — invoked on an interval by the server. Kept separate from the
 * HTTP layer so a future external scheduler can call it directly.
 */
export const processDueSchedules = async (now = new Date()): Promise<string[]> => {
  const due = await prisma.monitoringSchedule.findMany({
    where: { enabled: true, nextRun: { lte: now } },
  });
  const started: string[] = [];
  for (const schedule of due) {
    if (!schedule.modelId && !schedule.datasetId) continue;
    const run = await createTestRun({
      organizationId: schedule.organizationId,
      testType: schedule.testType,
      modelId: schedule.modelId,
      datasetId: schedule.datasetId,
      triggeredBy: 'SCHEDULE',
    });
    await prisma.monitoringSchedule.update({
      where: { id: schedule.id },
      data: {
        lastRun: now,
        nextRun: nextRunFrom(now, schedule.frequency, schedule.intervalHours),
      },
    });
    started.push(run.id);
  }
  return started;
};
