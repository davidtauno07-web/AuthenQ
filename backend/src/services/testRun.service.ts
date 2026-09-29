import {
  AlertSeverity,
  AlertType,
  Prisma,
  ReportFormat,
  ReportType,
  TestResult,
  TestRunStatus,
  TestType,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { badRequest, notFound } from '../utils/errors.js';
import { percentile, round } from '../utils/stats.js';
import { jobRunner } from '../workers/jobRunner.js';
import { generateAdversarialCases } from '../engines/privacy/adversarial.js';
import { scorePrivacy, summarizeScenarios } from '../engines/privacy/privacyEngine.js';
import {
  DEFAULT_PRIVACY_CONFIGURATION,
  type PrivacyConfiguration,
} from '../engines/privacy/syntheticGenerator.js';
import {
  runFairnessTest,
  type FairnessRunOutput,
} from '../engines/fairness/fairnessEngine.js';
import { flipIntervalFromSummary } from '../engines/fairness/metrics.js';
import type { ProtectedAttributeConfig } from '../engines/fairness/counterfactual.js';
import { getOrgSettings } from './settings.service.js';
import {
  loadDetections,
  loadSourceRecords,
  loadSyntheticRecords,
  loadTestProfiles,
  parseSchema,
} from './dataset.service.js';
import { generateSyntheticDataset } from './synthetic.service.js';
import { createAlert } from './alert.service.js';
import { detectRegressions } from './regression.service.js';
import { generateReport } from './report.service.js';

export const TEST_RUN_JOB = 'test-run';

/** Maximum adversarial/counterfactual rows persisted per run. */
const MAX_PERSISTED_CASES = 250;

export interface TestRunStage {
  key: string;
  label: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'SKIPPED' | 'FAILED';
}

const PRIVACY_STAGES: TestRunStage[] = [
  { key: 'LOAD_DATASET', label: 'Load dataset', status: 'PENDING' },
  { key: 'DETECT_SENSITIVE_FIELDS', label: 'Detect sensitive fields', status: 'PENDING' },
  { key: 'GENERATE_SYNTHETIC', label: 'Generate protected synthetic data', status: 'PENDING' },
  { key: 'GENERATE_ADVERSARIAL', label: 'Generate adversarial privacy cases', status: 'PENDING' },
  { key: 'SCORE_PRIVACY', label: 'Score privacy risk', status: 'PENDING' },
];

const FAIRNESS_STAGES: TestRunStage[] = [
  { key: 'LOAD_PROFILES', label: 'Load test profiles', status: 'PENDING' },
  { key: 'GENERATE_COUNTERFACTUALS', label: 'Generate counterfactual pairs', status: 'PENDING' },
  { key: 'INVOKE_MODEL', label: 'Invoke model under test', status: 'PENDING' },
  { key: 'CALCULATE_METRICS', label: 'Calculate fairness metrics', status: 'PENDING' },
  { key: 'EVALUATE_THRESHOLDS', label: 'Evaluate thresholds', status: 'PENDING' },
];

const CLOSING_STAGES: TestRunStage[] = [
  { key: 'DETECT_REGRESSIONS', label: 'Compare against baseline', status: 'PENDING' },
  { key: 'RAISE_ALERTS', label: 'Raise alerts', status: 'PENDING' },
];

const stagesFor = (testType: TestType): TestRunStage[] => {
  const stages: TestRunStage[] = [];
  if (testType === TestType.PRIVACY || testType === TestType.FULL_ASSESSMENT) {
    stages.push(...PRIVACY_STAGES.map((stage) => ({ ...stage })));
  }
  if (testType === TestType.FAIRNESS || testType === TestType.FULL_ASSESSMENT) {
    stages.push(...FAIRNESS_STAGES.map((stage) => ({ ...stage })));
  }
  stages.push(...CLOSING_STAGES.map((stage) => ({ ...stage })));
  if (testType === TestType.FULL_ASSESSMENT) {
    stages.push({ key: 'GENERATE_REPORT', label: 'Generate compliance evidence', status: 'PENDING' });
  }
  return stages;
};

export interface TestRunConfiguration {
  sampleSize?: number;
  caseCount?: number;
  protectedAttributes?: ProtectedAttributeConfig[];
  privacy?: Partial<PrivacyConfiguration>;
  generateReport?: boolean;
}

export interface CreateTestRunInput {
  organizationId: string;
  userId?: string | null;
  testType: TestType;
  modelId?: string | null;
  datasetId?: string | null;
  triggeredBy?: string;
  configuration?: TestRunConfiguration;
}

const nextReference = async (organizationId: string): Promise<string> => {
  const count = await prisma.testRun.count({ where: { organizationId } });
  return `TR-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
};

export const createTestRun = async (input: CreateTestRunInput) => {
  const needsDataset =
    input.testType === TestType.PRIVACY || input.testType === TestType.FULL_ASSESSMENT;
  const needsModel =
    input.testType === TestType.FAIRNESS || input.testType === TestType.FULL_ASSESSMENT;

  const dataset = input.datasetId
    ? await prisma.dataset.findFirst({
        where: { id: input.datasetId, organizationId: input.organizationId },
      })
    : null;
  if (needsDataset && !dataset) throw badRequest('A dataset is required for this test type');

  const model = input.modelId
    ? await prisma.model.findFirst({
        where: { id: input.modelId, organizationId: input.organizationId },
      })
    : null;
  if (needsModel && !model) throw badRequest('A model is required for this test type');

  const stages = stagesFor(input.testType);
  const run = await prisma.testRun.create({
    data: {
      organizationId: input.organizationId,
      reference: await nextReference(input.organizationId),
      testType: input.testType,
      modelId: model?.id ?? null,
      datasetId: dataset?.id ?? null,
      status: TestRunStatus.QUEUED,
      stage: stages[0]?.key ?? null,
      stages: stages as unknown as Prisma.InputJsonValue,
      configuration: (input.configuration ?? {}) as unknown as Prisma.InputJsonValue,
      triggeredBy: input.triggeredBy ?? 'MANUAL',
      modelVersion: model?.version ?? null,
      datasetVersion: dataset?.version ?? null,
    },
  });

  jobRunner.enqueue(TEST_RUN_JOB, run.id, {
    testRunId: run.id,
    organizationId: input.organizationId,
    userId: input.userId ?? null,
  });

  return run;
};

interface StageTracker {
  stages: TestRunStage[];
  total: number;
}

const beginStage = async (
  testRunId: string,
  tracker: StageTracker,
  key: string,
): Promise<void> => {
  const stage = tracker.stages.find((entry) => entry.key === key);
  if (stage) stage.status = 'RUNNING';
  await persistStages(testRunId, tracker, key);
};

const completeStage = async (
  testRunId: string,
  tracker: StageTracker,
  key: string,
  status: TestRunStage['status'] = 'COMPLETE',
): Promise<void> => {
  const stage = tracker.stages.find((entry) => entry.key === key);
  if (stage) stage.status = status;
  await persistStages(testRunId, tracker, key);
};

const persistStages = async (
  testRunId: string,
  tracker: StageTracker,
  currentKey: string,
): Promise<void> => {
  const done = tracker.stages.filter(
    (stage) => stage.status === 'COMPLETE' || stage.status === 'SKIPPED',
  ).length;
  await prisma.testRun.update({
    where: { id: testRunId },
    data: {
      stage: currentKey,
      progress: Math.round((done / tracker.total) * 100),
      stages: tracker.stages as unknown as Prisma.InputJsonValue,
    },
  });
};

export interface TestRunJobPayload {
  testRunId: string;
  organizationId: string;
  userId?: string | null;
}

/** Executes a queued test run; registered with the job runner at bootstrap. */
export const executeTestRun = async (payload: TestRunJobPayload): Promise<void> => {
  const run = await prisma.testRun.findFirst({
    where: { id: payload.testRunId, organizationId: payload.organizationId },
    include: { dataset: true, model: true },
  });
  if (!run) throw notFound('Test run not found');

  const settings = await getOrgSettings(run.organizationId);
  const configuration = (run.configuration ?? {}) as TestRunConfiguration;
  const tracker: StageTracker = {
    stages: stagesFor(run.testType),
    total: stagesFor(run.testType).length,
  };

  await prisma.testRun.update({
    where: { id: run.id },
    data: { status: TestRunStatus.RUNNING, startedAt: new Date(), progress: 0 },
  });

  const metrics: Prisma.MetricCreateManyInput[] = [];
  const summary: Record<string, unknown> = {};
  const results: TestResult[] = [];

  try {
    let syntheticDatasetId: string | null = null;
    const profiles: Record<string, unknown>[] = [];

    if (run.testType === TestType.PRIVACY || run.testType === TestType.FULL_ASSESSMENT) {
      const privacyOutcome = await runPrivacyPhase({
        run,
        tracker,
        threshold: settings.thresholds.privacyRiskScore,
        privacyConfig: configuration.privacy,
        sampleSize: configuration.sampleSize ?? settings.testing.defaultTestSize,
      });
      syntheticDatasetId = privacyOutcome.syntheticDatasetId;
      metrics.push(...privacyOutcome.metrics(run.id));
      summary.privacy = privacyOutcome.summary;
      results.push(privacyOutcome.result);
    }

    if (run.testType === TestType.FAIRNESS || run.testType === TestType.FULL_ASSESSMENT) {
      const fairnessOutcome = await runFairnessPhase({
        run,
        tracker,
        profiles,
        settings,
        configuration,
        syntheticDatasetId,
      });
      metrics.push(...fairnessOutcome.metrics(run.id));
      summary.fairness = fairnessOutcome.summary;
      results.push(fairnessOutcome.result);
    }

    if (metrics.length > 0) {
      await prisma.metric.createMany({ data: metrics });
    }

    await beginStage(run.id, tracker, 'DETECT_REGRESSIONS');
    const regressions = await detectRegressions({
      organizationId: run.organizationId,
      testRunId: run.id,
      modelId: run.modelId,
      testType: run.testType,
      regressionDelta: settings.thresholds.regressionDelta,
    });
    summary.regressions = regressions;
    await completeStage(run.id, tracker, 'DETECT_REGRESSIONS');

    const overall = worstResult(results);
    const riskScore = computeRiskScore(metrics, settings.thresholds.privacyRiskScore);

    await prisma.testRun.update({
      where: { id: run.id },
      data: {
        status: TestRunStatus.COMPLETED,
        result: overall,
        riskScore,
        summary: summary as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });

    await beginStage(run.id, tracker, 'RAISE_ALERTS');
    await raiseAlerts({ run, metrics, overall, regressions });
    await completeStage(run.id, tracker, 'RAISE_ALERTS');

    if (run.testType === TestType.FULL_ASSESSMENT && configuration.generateReport !== false) {
      await beginStage(run.id, tracker, 'GENERATE_REPORT');
      await generateReport({
        organizationId: run.organizationId,
        userId: payload.userId ?? null,
        reportType: ReportType.MODEL_RISK_ASSESSMENT,
        format: ReportFormat.PDF,
        testRunId: run.id,
        modelId: run.modelId,
      });
      await completeStage(run.id, tracker, 'GENERATE_REPORT');
    }

    await prisma.testRun.update({ where: { id: run.id }, data: { progress: 100 } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown execution error';
    await prisma.testRun.update({
      where: { id: run.id },
      data: {
        status: TestRunStatus.FAILED,
        errorMessage: message,
        completedAt: new Date(),
        stages: tracker.stages.map((stage) =>
          stage.status === 'RUNNING' ? { ...stage, status: 'FAILED' as const } : stage,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    throw error;
  }
};

type RunWithRelations = Prisma.TestRunGetPayload<{ include: { dataset: true; model: true } }>;

interface PrivacyPhaseInput {
  run: RunWithRelations;
  tracker: StageTracker;
  threshold: number;
  privacyConfig?: Partial<PrivacyConfiguration>;
  sampleSize: number;
}

const runPrivacyPhase = async (input: PrivacyPhaseInput) => {
  const { run, tracker } = input;
  const dataset = run.dataset;
  if (!dataset) throw badRequest('Privacy testing requires a dataset');

  await beginStage(run.id, tracker, 'LOAD_DATASET');
  const schema = parseSchema(dataset.schemaJson);
  const sourceRecords = await loadSourceRecords(dataset.id, input.sampleSize);
  if (sourceRecords.length === 0) throw badRequest('Dataset contains no records');
  await completeStage(run.id, tracker, 'LOAD_DATASET');

  await beginStage(run.id, tracker, 'DETECT_SENSITIVE_FIELDS');
  const detections = await loadDetections(dataset.id);
  await completeStage(run.id, tracker, 'DETECT_SENSITIVE_FIELDS');

  await beginStage(run.id, tracker, 'GENERATE_SYNTHETIC');
  const configuration: PrivacyConfiguration = {
    ...DEFAULT_PRIVACY_CONFIGURATION,
    seed: `${run.id}`,
    ...input.privacyConfig,
  };
  const synthetic = await generateSyntheticDataset({
    organizationId: run.organizationId,
    datasetId: dataset.id,
    recordCount: Math.min(sourceRecords.length, input.sampleSize),
    configuration,
  });
  await completeStage(run.id, tracker, 'GENERATE_SYNTHETIC');

  await beginStage(run.id, tracker, 'GENERATE_ADVERSARIAL');
  const analysis = generateAdversarialCases(
    schema,
    synthetic.records,
    detections,
    configuration,
    MAX_PERSISTED_CASES,
  );
  await prisma.adversarialCase.createMany({
    data: analysis.cases.slice(0, MAX_PERSISTED_CASES).map((item) => ({
      syntheticDatasetId: synthetic.syntheticDatasetId,
      scenarioType: item.scenarioType,
      riskScore: item.riskScore,
      reidentification: item.reidentification,
      metadata: item.metadata as Prisma.InputJsonValue,
    })),
  });
  await completeStage(run.id, tracker, 'GENERATE_ADVERSARIAL');

  await beginStage(run.id, tracker, 'SCORE_PRIVACY');
  const unsuppressed = detections.filter(
    (detection) => !synthetic.suppressedFields.includes(detection.fieldName),
  );
  const score = scorePrivacy({
    recordsTested: synthetic.records.length,
    analysis,
    statisticalSimilarity: synthetic.statisticalSimilarity,
    suppressedDirectIdentifiers: synthetic.suppressedFields.length,
    unsuppressedDirectIdentifiers: unsuppressed.filter((d) =>
      ['EMAIL', 'PHONE', 'NATIONAL_ID', 'MEDICAL_RECORD_NUMBER', 'NAME', 'CUSTOMER_ID'].includes(
        d.category,
      ),
    ).length,
    threshold: input.threshold,
  });

  await prisma.privacyTest.create({
    data: {
      testRunId: run.id,
      syntheticDatasetId: synthetic.syntheticDatasetId,
      recordsTested: synthetic.records.length,
      adversarialCases: score.adversarialCaseCount,
      highRiskCases: score.highRiskCases,
      reidentificationCases: score.reidentificationCases,
      privacyScore: score.privacyScore,
      threshold: input.threshold,
      result: score.result,
      breakdown: {
        ...score.breakdown,
        kAnonymity: analysis.kAnonymity,
        equivalenceClasses: analysis.equivalenceClasses,
        smallestClassSize: analysis.smallestClassSize,
        quasiIdentifiers: analysis.quasiIdentifiers,
        scenarios: summarizeScenarios(analysis.cases),
        statisticalSimilarity: synthetic.statisticalSimilarity,
        suppressedFields: synthetic.suppressedFields,
      } as unknown as Prisma.InputJsonValue,
    },
  });
  await completeStage(run.id, tracker, 'SCORE_PRIVACY');

  return {
    syntheticDatasetId: synthetic.syntheticDatasetId,
    syntheticRecords: synthetic.records,
    result: score.result,
    summary: {
      privacyScore: score.privacyScore,
      threshold: input.threshold,
      result: score.result,
      highRiskCases: score.highRiskCases,
      reidentificationCases: score.reidentificationCases,
      kAnonymity: analysis.kAnonymity,
      statisticalSimilarity: synthetic.statisticalSimilarity,
      interpretation: score.breakdown.interpretation,
      methodology: score.breakdown.methodology,
    },
    metrics: (testRunId: string): Prisma.MetricCreateManyInput[] => [
      {
        testRunId,
        metricName: 'privacy_risk_score',
        metricValue: score.privacyScore,
        threshold: input.threshold,
        unit: 'score',
        breached: score.privacyScore > input.threshold,
      },
      {
        testRunId,
        metricName: 'reidentification_rate',
        metricValue: round(
          score.reidentificationCases / Math.max(1, score.adversarialCaseCount),
          4,
        ),
        unit: 'ratio',
        breached: score.reidentificationCases > 0,
      },
      {
        testRunId,
        metricName: 'k_anonymity',
        metricValue: analysis.kAnonymity,
        threshold: DEFAULT_PRIVACY_CONFIGURATION.kAnonymityTarget,
        unit: 'count',
        breached: analysis.kAnonymity < DEFAULT_PRIVACY_CONFIGURATION.kAnonymityTarget,
      },
      {
        testRunId,
        metricName: 'statistical_similarity',
        metricValue: synthetic.statisticalSimilarity,
        unit: 'ratio',
        breached: false,
      },
    ],
  };
};

interface FairnessPhaseInput {
  run: RunWithRelations;
  tracker: StageTracker;
  profiles: Record<string, unknown>[];
  settings: Awaited<ReturnType<typeof getOrgSettings>>;
  configuration: TestRunConfiguration;
  syntheticDatasetId: string | null;
}

const runFairnessPhase = async (input: FairnessPhaseInput) => {
  const { run, tracker } = input;
  const model = run.model;
  if (!model) throw badRequest('Fairness testing requires a model');

  await beginStage(run.id, tracker, 'LOAD_PROFILES');
  let profiles = input.profiles;
  if (profiles.length === 0 && run.datasetId) {
    profiles = await loadTestProfiles(run.datasetId, input.settings.testing.defaultTestSize);
  }
  if (profiles.length === 0 && input.syntheticDatasetId) {
    profiles = await loadSyntheticRecords(input.syntheticDatasetId);
  }
  if (profiles.length === 0) throw badRequest('No profiles available for fairness testing');
  await completeStage(run.id, tracker, 'LOAD_PROFILES');

  const attributes =
    input.configuration.protectedAttributes ??
    deriveProtectedAttributes(profiles, input.settings.testing.defaultProtectedAttributes);
  if (attributes.length === 0) {
    throw badRequest('No protected attributes are present in the test profiles');
  }

  const caseCount =
    input.configuration.caseCount ??
    Math.min(input.settings.testing.defaultTestSize, Math.max(200, profiles.length));

  await beginStage(run.id, tracker, 'GENERATE_COUNTERFACTUALS');
  await completeStage(run.id, tracker, 'GENERATE_COUNTERFACTUALS');

  await beginStage(run.id, tracker, 'INVOKE_MODEL');
  const outputs: FairnessRunOutput[] = [];
  for (const attribute of attributes) {
    const output = await runFairnessTest({
      descriptor: {
        id: model.id,
        name: model.name,
        version: model.version,
        endpoint: model.endpoint,
        authConfig: model.authConfig as Record<string, unknown>,
        demoBehavior: model.demoBehavior,
        isDemo: model.isDemo,
      },
      provider: model.provider,
      profiles,
      attribute,
      caseCount,
      thresholds: {
        counterfactualFlipRate: input.settings.thresholds.counterfactualFlipRate,
        demographicParityDifference: input.settings.thresholds.demographicParityDifference,
        equalOpportunityDifference: input.settings.thresholds.equalOpportunityDifference,
      },
      seed: `${run.id}:${attribute.name}`,
    });
    outputs.push(output);
  }
  await completeStage(run.id, tracker, 'INVOKE_MODEL');

  await beginStage(run.id, tracker, 'CALCULATE_METRICS');
  for (const output of outputs) {
    const fairnessTest = await prisma.fairnessTest.create({
      data: {
        testRunId: run.id,
        protectedAttribute: output.attribute,
        sampleSize: output.metrics.totalPairs,
        baselineSelectionRate: output.metrics.baseline.selectionRate,
        variantSelectionRate: output.metrics.comparison.selectionRate,
        selectionRateDiff: output.metrics.selectionRateDifference,
        demographicParityDiff: output.metrics.demographicParityDifference,
        equalOpportunityDiff: output.metrics.equalOpportunityDifference,
        counterfactualFlipRate: output.metrics.counterfactualFlipRate,
        threshold: input.settings.thresholds.counterfactualFlipRate,
        confidenceLow: output.metrics.flipConfidenceLow,
        confidenceHigh: output.metrics.flipConfidenceHigh,
        result: output.result,
        metricsJson: {
          ...output.metrics,
          breaches: output.breaches,
          interpretation: output.interpretation,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    const evidence = [
      ...output.cases.filter((item) => item.outcomeChanged),
      ...output.cases.filter((item) => !item.outcomeChanged),
    ].slice(0, MAX_PERSISTED_CASES);

    await prisma.counterfactualCase.createMany({
      data: evidence.map((item) => ({
        fairnessTestId: fairnessTest.id,
        originalProfile: item.originalProfile as Prisma.InputJsonValue,
        counterfactualProfile: item.counterfactualProfile as Prisma.InputJsonValue,
        originalOutcome: item.originalOutcome,
        counterfactualOutcome: item.counterfactualOutcome,
        originalScore: item.originalScore,
        counterfactualScore: item.counterfactualScore,
        outcomeChanged: item.outcomeChanged,
      })),
    });
  }
  await completeStage(run.id, tracker, 'CALCULATE_METRICS');

  await beginStage(run.id, tracker, 'EVALUATE_THRESHOLDS');
  const worst = outputs.reduce((acc, output) =>
    output.metrics.counterfactualFlipRate > acc.metrics.counterfactualFlipRate ? output : acc,
  );
  await completeStage(run.id, tracker, 'EVALUATE_THRESHOLDS');

  return {
    result: worstResult(outputs.map((output) => output.result)),
    summary: {
      attributes: outputs.map((output) => ({
        attribute: output.attribute,
        result: output.result,
        counterfactualFlipRate: output.metrics.counterfactualFlipRate,
        demographicParityDifference: output.metrics.demographicParityDifference,
        equalOpportunityDifference: output.metrics.equalOpportunityDifference,
        sampleAdequacy: output.metrics.sampleAdequacy,
        interpretation: output.interpretation,
        breaches: output.breaches,
      })),
      worstAttribute: worst.attribute,
    },
    metrics: (testRunId: string): Prisma.MetricCreateManyInput[] => {
      const rows: Prisma.MetricCreateManyInput[] = [];
      for (const output of outputs) {
        const suffix = `:${output.attribute}`;
        rows.push(
          {
            testRunId,
            metricName: `counterfactual_flip_rate${suffix}`,
            metricValue: output.metrics.counterfactualFlipRate,
            threshold: input.settings.thresholds.counterfactualFlipRate,
            unit: 'ratio',
            breached:
              output.metrics.counterfactualFlipRate >
              input.settings.thresholds.counterfactualFlipRate,
          },
          {
            testRunId,
            metricName: `demographic_parity_difference${suffix}`,
            metricValue: output.metrics.demographicParityDifference,
            threshold: input.settings.thresholds.demographicParityDifference,
            unit: 'ratio',
            breached:
              output.metrics.demographicParityDifference >
              input.settings.thresholds.demographicParityDifference,
          },
          {
            testRunId,
            metricName: `equal_opportunity_difference${suffix}`,
            metricValue: output.metrics.equalOpportunityDifference,
            threshold: input.settings.thresholds.equalOpportunityDifference,
            unit: 'ratio',
            breached:
              output.metrics.equalOpportunityDifference >
              input.settings.thresholds.equalOpportunityDifference,
          },
        );
      }
      // Headline metrics (unsuffixed) are what regression detection compares.
      rows.push(
        {
          testRunId,
          metricName: 'counterfactual_flip_rate',
          metricValue: worst.metrics.counterfactualFlipRate,
          threshold: input.settings.thresholds.counterfactualFlipRate,
          unit: 'ratio',
          breached:
            worst.metrics.counterfactualFlipRate >
            input.settings.thresholds.counterfactualFlipRate,
        },
        {
          testRunId,
          metricName: 'demographic_parity_difference',
          metricValue: worst.metrics.demographicParityDifference,
          threshold: input.settings.thresholds.demographicParityDifference,
          unit: 'ratio',
          breached:
            worst.metrics.demographicParityDifference >
            input.settings.thresholds.demographicParityDifference,
        },
        {
          testRunId,
          metricName: 'equal_opportunity_difference',
          metricValue: worst.metrics.equalOpportunityDifference,
          threshold: input.settings.thresholds.equalOpportunityDifference,
          unit: 'ratio',
          breached:
            worst.metrics.equalOpportunityDifference >
            input.settings.thresholds.equalOpportunityDifference,
        },
        {
          testRunId,
          metricName: 'selection_rate_difference',
          metricValue: worst.metrics.selectionRateDifference,
          unit: 'ratio',
          breached: false,
        },
      );
      return rows;
    },
  };
};

/** Protected attribute values are derived from the profiles actually tested. */
export const deriveProtectedAttributes = (
  profiles: Record<string, unknown>[],
  candidates: string[],
): ProtectedAttributeConfig[] => {
  const configs: ProtectedAttributeConfig[] = [];
  for (const candidate of candidates) {
    const counts = new Map<string, number>();
    const numbers: number[] = [];
    let numericOnly = true;
    for (const profile of profiles) {
      const raw = profile[candidate];
      if (raw === null || raw === undefined) continue;
      const value = String(raw);
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (typeof raw === 'number' && Number.isFinite(raw)) numbers.push(raw);
      else numericOnly = false;
    }
    if (counts.size < 2) continue;

    // Continuous attributes such as age are compared at representative points;
    // splitting them per distinct value would shrink every group below the
    // sample size needed for a defensible comparison.
    const values =
      numericOnly && counts.size > 3
        ? [percentile(numbers, 20), percentile(numbers, 85)].map((value) =>
            String(Math.round(value)),
          )
        : [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([value]) => value)
            .slice(0, 3);

    if (new Set(values).size >= 2) {
      configs.push({ name: candidate, values, label: candidate });
    }
  }
  return configs;
};

const RESULT_RANK: Record<TestResult, number> = {
  PASS: 0,
  INCONCLUSIVE: 1,
  WARNING: 2,
  FAIL: 3,
};

export const worstResult = (results: TestResult[]): TestResult =>
  results.reduce<TestResult>(
    (acc, result) => (RESULT_RANK[result] > RESULT_RANK[acc] ? result : acc),
    TestResult.PASS,
  );

/** 0–100 composite: privacy score plus normalised fairness breach magnitude. */
export const computeRiskScore = (
  metrics: Prisma.MetricCreateManyInput[],
  privacyThreshold: number,
): number => {
  const privacy = metrics.find((metric) => metric.metricName === 'privacy_risk_score');
  const flip = metrics.find((metric) => metric.metricName === 'counterfactual_flip_rate');
  const parity = metrics.find((metric) => metric.metricName === 'demographic_parity_difference');

  const parts: number[] = [];
  if (privacy) parts.push(Math.min(100, privacy.metricValue));
  if (flip) parts.push(Math.min(100, (flip.metricValue / Math.max(0.01, flip.threshold ?? 0.05)) * 25));
  if (parity)
    parts.push(Math.min(100, (parity.metricValue / Math.max(0.01, parity.threshold ?? 0.05)) * 25));
  if (parts.length === 0) return 0;
  const score = parts.reduce((sum, part) => sum + part, 0) / parts.length;
  return round(Math.min(100, score * (privacy && privacy.metricValue > privacyThreshold ? 1.1 : 1)), 2);
};

interface RaiseAlertsInput {
  run: RunWithRelations;
  metrics: Prisma.MetricCreateManyInput[];
  overall: TestResult;
  regressions: Awaited<ReturnType<typeof detectRegressions>>;
}

const raiseAlerts = async (input: RaiseAlertsInput): Promise<void> => {
  const { run } = input;
  const label = run.model ? `${run.model.name} v${run.model.version}` : run.dataset?.name ?? 'system';

  for (const metric of input.metrics) {
    if (!metric.breached || metric.metricName.includes(':')) continue;
    const isPrivacy = metric.metricName.startsWith('privacy') || metric.metricName === 'k_anonymity' || metric.metricName === 'reidentification_rate';
    await createAlert({
      organizationId: run.organizationId,
      severity: input.overall === TestResult.FAIL ? AlertSeverity.HIGH : AlertSeverity.MEDIUM,
      alertType: isPrivacy
        ? AlertType.PRIVACY_THRESHOLD_EXCEEDED
        : AlertType.FAIRNESS_THRESHOLD_EXCEEDED,
      title: `${humanizeMetric(metric.metricName)} exceeded threshold on ${label}`,
      description: `Test run ${run.reference} measured ${humanizeMetric(metric.metricName)} at ${metric.metricValue} against a configured threshold of ${metric.threshold ?? 'n/a'}. This indicates potential risk and requires human review.`,
      testRunId: run.id,
      metricName: metric.metricName,
      currentValue: metric.metricValue,
      threshold: metric.threshold ?? null,
      recommendedAction: isPrivacy
        ? 'Review the flagged adversarial cases, increase suppression or generalization for the affected quasi-identifiers, and re-run the Privacy Shield test.'
        : 'Review the counterfactual evidence for the affected protected attribute with a qualified reviewer before the model is promoted.',
    });
  }

  for (const regression of input.regressions.filter((item) => item.regressed)) {
    await createAlert({
      organizationId: run.organizationId,
      severity: AlertSeverity.HIGH,
      alertType: AlertType.MODEL_REGRESSION_DETECTED,
      title: `Regression in ${humanizeMetric(regression.metricName)} on ${label}`,
      description: `${humanizeMetric(regression.metricName)} moved from ${regression.previousValue} (${regression.baselineReference}) to ${regression.currentValue} in ${run.reference}, a change of ${regression.delta}.`,
      testRunId: run.id,
      metricName: regression.metricName,
      currentValue: regression.currentValue,
      threshold: regression.previousValue,
      recommendedAction:
        'Compare the current model version against the baseline version and investigate the change that introduced the regression.',
    });
  }
};

export const humanizeMetric = (metricName: string): string =>
  metricName
    .split(':')[0]
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

export const listTestRuns = (
  organizationId: string,
  filters: { status?: TestRunStatus; testType?: TestType; modelId?: string; datasetId?: string; limit?: number } = {},
) =>
  prisma.testRun.findMany({
    where: {
      organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.testType ? { testType: filters.testType } : {}),
      ...(filters.modelId ? { modelId: filters.modelId } : {}),
      ...(filters.datasetId ? { datasetId: filters.datasetId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: filters.limit ?? 50,
    include: {
      model: { select: { id: true, name: true, version: true } },
      dataset: { select: { id: true, name: true, version: true } },
      _count: { select: { alerts: true } },
    },
  });

export const getTestRun = async (organizationId: string, testRunId: string) => {
  const run = await prisma.testRun.findFirst({
    where: { id: testRunId, organizationId },
    include: {
      model: true,
      dataset: { select: { id: true, name: true, version: true, recordCount: true } },
      metrics: { orderBy: { metricName: 'asc' } },
      privacyTests: true,
      fairnessTests: {
        include: {
          counterfactualCases: {
            where: { outcomeChanged: true },
            take: 20,
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      alerts: { orderBy: { createdAt: 'desc' } },
      reports: { select: { id: true, title: true, format: true, createdAt: true } },
    },
  });
  if (!run) throw notFound('Test run not found');
  return {
    ...run,
    fairnessTests: run.fairnessTests.map((test) => {
      const interval = flipIntervalFromSummary(test.metricsJson);
      return {
        ...test,
        confidenceLow: interval?.low ?? test.confidenceLow,
        confidenceHigh: interval?.high ?? test.confidenceHigh,
      };
    }),
  };
};

export const cancelTestRun = async (organizationId: string, testRunId: string) => {
  const run = await prisma.testRun.findFirst({ where: { id: testRunId, organizationId } });
  if (!run) throw notFound('Test run not found');
  if (run.status === TestRunStatus.COMPLETED || run.status === TestRunStatus.FAILED) {
    throw badRequest('Test run has already finished');
  }
  jobRunner.cancel(run.id);
  return prisma.testRun.update({
    where: { id: run.id },
    data: { status: TestRunStatus.CANCELLED, completedAt: new Date() },
  });
};

export const markRunFailed = async (testRunId: string, message: string): Promise<void> => {
  await prisma.testRun
    .update({
      where: { id: testRunId },
      data: { status: TestRunStatus.FAILED, errorMessage: message, completedAt: new Date() },
    })
    .catch(() => undefined);
};

export const registerTestRunWorker = (): void => {
  jobRunner.register<TestRunJobPayload>(TEST_RUN_JOB, executeTestRun);
  jobRunner.setErrorHandler(async (jobId, name, error) => {
    if (name !== TEST_RUN_JOB) return;
    await markRunFailed(jobId, error instanceof Error ? error.message : 'Job failed');
  });
};
