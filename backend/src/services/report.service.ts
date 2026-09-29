import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { Prisma, ReportFormat, ReportType, TestRunStatus } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import { badRequest, notFound } from '../utils/errors.js';
import { getOrgSettings } from './settings.service.js';
import { flipIntervalFromSummary } from '../engines/fairness/metrics.js';

export interface GenerateReportInput {
  organizationId: string;
  userId?: string | null;
  reportType: ReportType;
  format: ReportFormat;
  testRunId?: string | null;
  modelId?: string | null;
  rangeStart?: Date | null;
  rangeEnd?: Date | null;
  title?: string;
}

const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  PRIVACY_ASSESSMENT: 'Privacy Assessment',
  FAIRNESS_ASSESSMENT: 'Fairness Assessment',
  MODEL_RISK_ASSESSMENT: 'Model Risk Assessment',
  CONTINUOUS_MONITORING: 'Continuous Monitoring Report',
  EXECUTIVE_SUMMARY: 'Executive Summary',
};

const DISCLAIMER =
  'This document is a Compliance Evidence Report produced by AuthenQ. It records the configuration, methodology, measurements and thresholds of automated privacy and fairness tests. It is not a legal filing, a certification, or a determination of compliance with any specific law or regulation. Findings indicate potential risk requiring human review; qualified reviewers remain responsible for any legal conclusion.';

export const generateReport = async (input: GenerateReportInput) => {
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
  });
  if (!organization) throw notFound('Organization not found');

  const rangeEnd = input.rangeEnd ?? new Date();
  const rangeStart =
    input.rangeStart ?? new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  const testRuns = await prisma.testRun.findMany({
    where: {
      organizationId: input.organizationId,
      status: TestRunStatus.COMPLETED,
      ...(input.testRunId ? { id: input.testRunId } : { createdAt: { gte: rangeStart, lte: rangeEnd } }),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...typeFilter(input.reportType),
    },
    orderBy: { createdAt: 'desc' },
    take: input.testRunId ? 1 : 50,
    include: {
      model: true,
      dataset: true,
      metrics: true,
      privacyTests: true,
      fairnessTests: {
        include: {
          counterfactualCases: { where: { outcomeChanged: true }, take: 5 },
        },
      },
      alerts: true,
    },
  });

  if (testRuns.length === 0) {
    throw badRequest('No completed test runs match the requested report scope');
  }

  const settings = await getOrgSettings(input.organizationId);
  const payload = {
    generatedAt: new Date().toISOString(),
    reportType: input.reportType,
    reportTypeLabel: REPORT_TYPE_LABEL[input.reportType],
    disclaimer: DISCLAIMER,
    organization: {
      id: organization.id,
      name: organization.name,
      industry: organization.industry,
    },
    period: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
    configuration: { thresholds: settings.thresholds, testing: settings.testing },
    methodology: {
      privacy:
        'Prototype Privacy Simulation — schema inspection, PII/sensitive-field detection, suppression and generalization, statistically matched synthetic generation, adversarial k-anonymity and linkage analysis. No differential privacy guarantee is claimed.',
      fairness:
        'Counterfactual red teaming — paired profiles differing in exactly one protected attribute are submitted to the model under test; selection rates, demographic parity, equal opportunity and counterfactual flip rate are compared against configured thresholds with Wilson confidence intervals.',
    },
    testRuns: testRuns.map((run) => ({
      id: run.id,
      reference: run.reference,
      testType: run.testType,
      model: run.model ? { name: run.model.name, version: run.model.version, environment: run.model.environment, isDemo: run.model.isDemo } : null,
      dataset: run.dataset ? { name: run.dataset.name, version: run.dataset.version, recordCount: run.dataset.recordCount } : null,
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      result: run.result,
      riskScore: run.riskScore,
      summary: run.summary,
      metrics: run.metrics.map((metric) => ({
        name: metric.metricName,
        value: metric.metricValue,
        threshold: metric.threshold,
        unit: metric.unit,
        breached: metric.breached,
      })),
      privacyTests: run.privacyTests.map((test) => ({
        recordsTested: test.recordsTested,
        adversarialCases: test.adversarialCases,
        highRiskCases: test.highRiskCases,
        reidentificationCases: test.reidentificationCases,
        privacyScore: test.privacyScore,
        threshold: test.threshold,
        result: test.result,
        breakdown: test.breakdown,
      })),
      fairnessTests: run.fairnessTests.map((test) => {
        const interval = flipIntervalFromSummary(test.metricsJson);
        return {
          protectedAttribute: test.protectedAttribute,
          sampleSize: test.sampleSize,
          baselineSelectionRate: test.baselineSelectionRate,
          variantSelectionRate: test.variantSelectionRate,
          selectionRateDifference: test.selectionRateDiff,
          demographicParityDifference: test.demographicParityDiff,
          equalOpportunityDifference: test.equalOpportunityDiff,
          counterfactualFlipRate: test.counterfactualFlipRate,
          threshold: test.threshold,
          confidenceInterval: [interval?.low ?? test.confidenceLow, interval?.high ?? test.confidenceHigh],
          result: test.result,
          evidence: test.counterfactualCases.map((c) => ({
            originalProfile: c.originalProfile,
            counterfactualProfile: c.counterfactualProfile,
            originalOutcome: c.originalOutcome,
            counterfactualOutcome: c.counterfactualOutcome,
            outcomeChanged: c.outcomeChanged,
          })),
        };
      }),
      alerts: run.alerts.map((alert) => ({
        severity: alert.severity,
        alertType: alert.alertType,
        title: alert.title,
        status: alert.status,
        createdAt: alert.createdAt.toISOString(),
      })),
      reviewStatus: run.result === 'PASS' ? 'NO_ACTION_REQUIRED' : 'PENDING_HUMAN_REVIEW',
    })),
  };

  const title =
    input.title ??
    `${REPORT_TYPE_LABEL[input.reportType]} — ${organization.name} — ${rangeEnd.toISOString().slice(0, 10)}`;

  const report = await prisma.report.create({
    data: {
      organizationId: input.organizationId,
      reportType: input.reportType,
      format: input.format,
      title,
      modelId: input.modelId ?? testRuns[0]?.modelId ?? null,
      testRunId: input.testRunId ?? testRuns[0]?.id ?? null,
      rangeStart,
      rangeEnd,
      generatedById: input.userId ?? null,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });

  const { fileLocation, fileSize } = await writeReportFile(report.id, input.format, title, payload);

  return prisma.report.update({
    where: { id: report.id },
    data: { fileLocation, fileSize },
  });
};

const typeFilter = (reportType: ReportType): Prisma.TestRunWhereInput => {
  switch (reportType) {
    case ReportType.PRIVACY_ASSESSMENT:
      return { testType: { in: ['PRIVACY', 'FULL_ASSESSMENT'] } };
    case ReportType.FAIRNESS_ASSESSMENT:
      return { testType: { in: ['FAIRNESS', 'FULL_ASSESSMENT'] } };
    default:
      return {};
  }
};

type ReportPayload = Record<string, unknown>;

const writeReportFile = async (
  reportId: string,
  format: ReportFormat,
  title: string,
  payload: unknown,
): Promise<{ fileLocation: string; fileSize: number }> => {
  await fsp.mkdir(env.reportStorageDir, { recursive: true });
  const extension = format.toLowerCase();
  const fileLocation = path.join(env.reportStorageDir, `${reportId}.${extension}`);

  if (format === ReportFormat.JSON) {
    await fsp.writeFile(fileLocation, JSON.stringify(payload, null, 2), 'utf8');
  } else if (format === ReportFormat.CSV) {
    await fsp.writeFile(fileLocation, toCsv(payload as ReportPayload), 'utf8');
  } else {
    await writePdf(fileLocation, title, payload as ReportPayload);
  }

  const stat = await fsp.stat(fileLocation);
  return { fileLocation, fileSize: stat.size };
};

interface PayloadRun {
  reference: string;
  testType: string;
  result: string | null;
  riskScore: number | null;
  completedAt: string | null;
  model: { name: string; version: string } | null;
  dataset: { name: string; version: string } | null;
  metrics: { name: string; value: number; threshold: number | null; breached: boolean }[];
}

const toCsv = (payload: ReportPayload): string => {
  const runs = (payload as unknown as { testRuns: PayloadRun[] }).testRuns;
  const header = [
    'test_reference',
    'test_type',
    'model',
    'model_version',
    'dataset',
    'completed_at',
    'result',
    'risk_score',
    'metric',
    'value',
    'threshold',
    'breached',
  ];
  const lines = [header.join(',')];
  for (const run of runs) {
    if (run.metrics.length === 0) {
      lines.push(
        csvRow([
          run.reference,
          run.testType,
          run.model?.name ?? '',
          run.model?.version ?? '',
          run.dataset?.name ?? '',
          run.completedAt ?? '',
          run.result ?? '',
          run.riskScore ?? '',
          '',
          '',
          '',
          '',
        ]),
      );
      continue;
    }
    for (const metric of run.metrics) {
      lines.push(
        csvRow([
          run.reference,
          run.testType,
          run.model?.name ?? '',
          run.model?.version ?? '',
          run.dataset?.name ?? '',
          run.completedAt ?? '',
          run.result ?? '',
          run.riskScore ?? '',
          metric.name,
          metric.value,
          metric.threshold ?? '',
          metric.breached,
        ]),
      );
    }
  }
  return lines.join('\n');
};

const csvRow = (values: (string | number | boolean)[]): string =>
  values
    .map((value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    })
    .join(',');

const writePdf = (filePath: string, title: string, payload: ReportPayload): Promise<void> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 54 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    stream.on('finish', () => resolve());
    stream.on('error', reject);

    const data = payload as unknown as {
      organization: { name: string; industry: string | null };
      reportTypeLabel: string;
      period: { start: string; end: string };
      generatedAt: string;
      disclaimer: string;
      methodology: { privacy: string; fairness: string };
      configuration: { thresholds: Record<string, number> };
      testRuns: (PayloadRun & {
        privacyTests: { privacyScore: number; threshold: number; recordsTested: number; highRiskCases: number; reidentificationCases: number; result: string }[];
        fairnessTests: {
          protectedAttribute: string;
          counterfactualFlipRate: number;
          threshold: number;
          demographicParityDifference: number;
          sampleSize: number;
          result: string;
        }[];
        alerts: { severity: string; title: string }[];
        reviewStatus: string;
      })[];
    };

    doc.font('Helvetica-Bold').fontSize(22).text('AuthenQ', { characterSpacing: 2 });
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    doc.text('Autonomous Adversarial Privacy & Bias-Testing Infrastructure');
    doc.moveDown(1.5);

    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(16).text(data.reportTypeLabel);
    doc.font('Helvetica').fontSize(10).fillColor('#333333').text(title);
    doc.moveDown(0.8);

    line(doc);
    keyValue(doc, 'Organization', data.organization.name);
    keyValue(doc, 'Industry', data.organization.industry ?? 'Not specified');
    keyValue(doc, 'Testing period', `${data.period.start.slice(0, 10)} → ${data.period.end.slice(0, 10)}`);
    keyValue(doc, 'Generated at', data.generatedAt);
    keyValue(doc, 'Test runs included', String(data.testRuns.length));
    line(doc);

    heading(doc, 'Methodology');
    paragraph(doc, `Privacy — ${data.methodology.privacy}`);
    paragraph(doc, `Fairness — ${data.methodology.fairness}`);

    heading(doc, 'Configured thresholds');
    for (const [key, value] of Object.entries(data.configuration.thresholds)) {
      keyValue(doc, key, String(value));
    }

    for (const run of data.testRuns) {
      if (doc.y > 660) doc.addPage();
      heading(doc, `Test run ${run.reference}`);
      keyValue(doc, 'Type', run.testType);
      keyValue(doc, 'Model', run.model ? `${run.model.name} v${run.model.version}` : 'n/a');
      keyValue(doc, 'Dataset', run.dataset ? `${run.dataset.name} v${run.dataset.version}` : 'n/a');
      keyValue(doc, 'Completed', run.completedAt ?? 'n/a');
      keyValue(doc, 'Result', run.result ?? 'n/a');
      keyValue(doc, 'Review status', run.reviewStatus);

      for (const test of run.privacyTests) {
        paragraph(
          doc,
          `Privacy Shield — records tested ${test.recordsTested}, high-risk cases ${test.highRiskCases}, potential re-identification cases ${test.reidentificationCases}, privacy risk score ${test.privacyScore}/100 against threshold ${test.threshold} → ${test.result}.`,
        );
      }
      for (const test of run.fairnessTests) {
        paragraph(
          doc,
          `Fairness Sword — protected attribute "${test.protectedAttribute}", sample ${test.sampleSize}, counterfactual flip rate ${(test.counterfactualFlipRate * 100).toFixed(2)}% against threshold ${(test.threshold * 100).toFixed(2)}%, demographic parity difference ${(test.demographicParityDifference * 100).toFixed(2)} pp → ${test.result}.`,
        );
      }
      if (run.metrics.length > 0) {
        paragraph(
          doc,
          `Metrics: ${run.metrics
            .map((m) => `${m.name}=${m.value}${m.breached ? ' (threshold exceeded)' : ''}`)
            .join(', ')}`,
        );
      }
      if (run.alerts.length > 0) {
        paragraph(doc, `Alerts: ${run.alerts.map((a) => `[${a.severity}] ${a.title}`).join('; ')}`);
      }
    }

    if (doc.y > 620) doc.addPage();
    heading(doc, 'Limitations and interpretation');
    paragraph(doc, data.disclaimer);

    doc.end();
  });

type Doc = InstanceType<typeof PDFDocument>;

const heading = (doc: Doc, text: string): void => {
  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000000').text(text.toUpperCase(), {
    characterSpacing: 1,
  });
  doc.moveDown(0.3);
};

const keyValue = (doc: Doc, key: string, value: string): void => {
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`${key}`, { continued: true });
  doc.fillColor('#000000').text(`   ${value}`);
};

const paragraph = (doc: Doc, text: string): void => {
  doc.font('Helvetica').fontSize(9.5).fillColor('#111111').text(text, { align: 'left' });
  doc.moveDown(0.4);
};

const line = (doc: Doc): void => {
  doc.moveDown(0.5);
  doc
    .strokeColor('#cccccc')
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.5);
};

export const listReports = (organizationId: string) =>
  prisma.report.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    include: {
      model: { select: { id: true, name: true, version: true } },
      generatedBy: { select: { id: true, name: true } },
      testRun: { select: { id: true, reference: true } },
    },
  });

export const getReport = async (organizationId: string, reportId: string) => {
  const report = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    include: {
      model: true,
      testRun: { select: { id: true, reference: true } },
      generatedBy: { select: { id: true, name: true } },
    },
  });
  if (!report) throw notFound('Report not found');
  return report;
};
