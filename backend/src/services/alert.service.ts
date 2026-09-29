import { AlertSeverity, AlertStatus, AlertType, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';
import { getOrgSettings } from './settings.service.js';

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export interface CreateAlertInput {
  organizationId: string;
  severity: AlertSeverity;
  alertType: AlertType;
  title: string;
  description: string;
  testRunId?: string | null;
  metricName?: string | null;
  currentValue?: number | null;
  threshold?: number | null;
  recommendedAction?: string | null;
}

/** Respects the organization's minimum-severity notification preference. */
export const createAlert = async (input: CreateAlertInput) => {
  const settings = await getOrgSettings(input.organizationId);
  if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[settings.notifications.minimumSeverity]) {
    return null;
  }
  if (
    (input.alertType === AlertType.PRIVACY_THRESHOLD_EXCEEDED &&
      !settings.notifications.alertOnPrivacyBreach) ||
    (input.alertType === AlertType.FAIRNESS_THRESHOLD_EXCEEDED &&
      !settings.notifications.alertOnFairnessBreach) ||
    (input.alertType === AlertType.MODEL_REGRESSION_DETECTED &&
      !settings.notifications.alertOnRegression)
  ) {
    return null;
  }

  return prisma.alert.create({
    data: {
      organizationId: input.organizationId,
      severity: input.severity,
      alertType: input.alertType,
      title: input.title,
      description: input.description,
      testRunId: input.testRunId ?? null,
      metricName: input.metricName ?? null,
      currentValue: input.currentValue ?? null,
      threshold: input.threshold ?? null,
      recommendedAction: input.recommendedAction ?? null,
    },
  });
};

export const listAlerts = async (
  organizationId: string,
  options: {
    status?: AlertStatus;
    severity?: AlertSeverity;
    alertType?: AlertType;
    page: number;
    pageSize: number;
  },
) => {
  const where: Prisma.AlertWhereInput = {
    organizationId,
    ...(options.status ? { status: options.status } : {}),
    ...(options.severity ? { severity: options.severity } : {}),
    ...(options.alertType ? { alertType: options.alertType } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.alert.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
      include: {
        testRun: { select: { id: true, reference: true, testType: true } },
      },
    }),
    prisma.alert.count({ where }),
  ]);
  return { items, total, page: options.page, pageSize: options.pageSize };
};

export const updateAlertStatus = async (
  organizationId: string,
  alertId: string,
  status: AlertStatus,
) => {
  const alert = await prisma.alert.findFirst({ where: { id: alertId, organizationId } });
  if (!alert) throw notFound('Alert not found');
  return prisma.alert.update({
    where: { id: alertId },
    data: {
      status,
      resolvedAt: status === AlertStatus.RESOLVED ? new Date() : null,
    },
  });
};

export const alertCounts = async (organizationId: string) => {
  const grouped = await prisma.alert.groupBy({
    by: ['severity'],
    where: { organizationId, status: { in: [AlertStatus.NEW, AlertStatus.INVESTIGATING] } },
    _count: { _all: true },
  });
  const bySeverity = Object.fromEntries(
    grouped.map((row) => [row.severity, row._count._all]),
  ) as Record<AlertSeverity, number>;
  return {
    open: grouped.reduce((sum, row) => sum + row._count._all, 0),
    bySeverity,
  };
};
