import { AlertStatus, TestResult, TestRunStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { round } from '../utils/stats.js';
import { getOrgSettings } from './settings.service.js';

export interface DashboardSummary {
  privacyRiskScore: number | null;
  fairnessRiskScore: number | null;
  openAlerts: number;
  criticalAlerts: number;
  modelsMonitored: number;
  datasetsProtected: number;
  testsLast30Days: number;
  passRate: number | null;
  lastAssessmentAt: string | null;
  thresholds: Awaited<ReturnType<typeof getOrgSettings>>['thresholds'];
}

export const dashboardSummary = async (organizationId: string): Promise<DashboardSummary> => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const settings = await getOrgSettings(organizationId);

  const [
    latestPrivacy,
    latestFairness,
    openAlerts,
    criticalAlerts,
    modelsMonitored,
    datasetsProtected,
    recentRuns,
    lastRun,
  ] = await Promise.all([
    prisma.metric.findFirst({
      where: { metricName: 'privacy_risk_score', testRun: { organizationId } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.metric.findFirst({
      where: { metricName: 'counterfactual_flip_rate', testRun: { organizationId } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.alert.count({
      where: { organizationId, status: { in: [AlertStatus.NEW, AlertStatus.INVESTIGATING] } },
    }),
    prisma.alert.count({
      where: { organizationId, severity: 'CRITICAL', status: { in: [AlertStatus.NEW, AlertStatus.INVESTIGATING] } },
    }),
    prisma.model.count({ where: { organizationId } }),
    prisma.dataset.count({ where: { organizationId, status: 'PROTECTED' } }),
    prisma.testRun.findMany({
      where: { organizationId, createdAt: { gte: since }, status: TestRunStatus.COMPLETED },
      select: { result: true },
    }),
    prisma.testRun.findFirst({
      where: { organizationId, status: TestRunStatus.COMPLETED },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    }),
  ]);

  const passed = recentRuns.filter((run) => run.result === TestResult.PASS).length;

  return {
    privacyRiskScore: latestPrivacy?.metricValue ?? null,
    fairnessRiskScore: latestFairness ? round(latestFairness.metricValue * 100, 2) : null,
    openAlerts,
    criticalAlerts,
    modelsMonitored,
    datasetsProtected,
    testsLast30Days: recentRuns.length,
    passRate: recentRuns.length === 0 ? null : round((passed / recentRuns.length) * 100, 1),
    lastAssessmentAt: lastRun?.completedAt?.toISOString() ?? null,
    thresholds: settings.thresholds,
  };
};

export const riskTrend = async (organizationId: string, days = 60) => {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const metrics = await prisma.metric.findMany({
    where: {
      createdAt: { gte: since },
      testRun: { organizationId, status: TestRunStatus.COMPLETED },
      metricName: {
        in: [
          'privacy_risk_score',
          'counterfactual_flip_rate',
          'demographic_parity_difference',
          'equal_opportunity_difference',
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    include: { testRun: { select: { reference: true, completedAt: true, modelId: true } } },
  });

  const byTimestamp = new Map<string, Record<string, number | string>>();
  for (const metric of metrics) {
    const key = (metric.testRun.completedAt ?? metric.createdAt).toISOString();
    const bucket = byTimestamp.get(key) ?? { timestamp: key, reference: metric.testRun.reference };
    bucket[metric.metricName] = metric.metricValue;
    byTimestamp.set(key, bucket);
  }
  return [...byTimestamp.values()];
};

export const recentActivity = async (organizationId: string, limit = 10) => {
  const [runs, alerts] = await Promise.all([
    prisma.testRun.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        reference: true,
        testType: true,
        status: true,
        result: true,
        createdAt: true,
        model: { select: { name: true, version: true } },
      },
    }),
    prisma.alert.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        alertType: true,
        metricName: true,
        currentValue: true,
        threshold: true,
        createdAt: true,
      },
    }),
  ]);
  return { runs, alerts };
};

export const coverage = async (organizationId: string) => {
  const models = await prisma.model.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      version: true,
      environment: true,
      status: true,
      testRuns: {
        where: { status: TestRunStatus.COMPLETED },
        orderBy: { completedAt: 'desc' },
        take: 1,
        select: { completedAt: true, result: true, riskScore: true, reference: true },
      },
    },
  });
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    version: model.version,
    environment: model.environment,
    status: model.status,
    lastResult: model.testRuns[0]?.result ?? null,
    lastRiskScore: model.testRuns[0]?.riskScore ?? null,
    lastTestedAt: model.testRuns[0]?.completedAt?.toISOString() ?? null,
    lastReference: model.testRuns[0]?.reference ?? null,
  }));
};
