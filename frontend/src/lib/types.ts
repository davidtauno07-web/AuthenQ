export type Role = 'ORG_ADMIN' | 'ANALYST' | 'VIEWER';
export type TestResult = 'PASS' | 'WARNING' | 'FAIL' | 'INCONCLUSIVE';
export type TestType = 'PRIVACY' | 'FAIRNESS' | 'FULL_ASSESSMENT';
export type TestRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type AlertStatus = 'NEW' | 'INVESTIGATING' | 'RESOLVED' | 'DISMISSED';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  organizationId: string;
  status?: string;
  lastLoginAt?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  industry?: string | null;
  settings?: OrgSettings;
}

export interface AuthResponse {
  token: string;
  user: User;
  organization: Organization;
}

export interface Thresholds {
  privacyRiskScore: number;
  counterfactualFlipRate: number;
  demographicParityDifference: number;
  equalOpportunityDifference: number;
  regressionDelta: number;
}

export interface OrgSettings {
  thresholds: Thresholds;
  testing: {
    defaultTestSize: number;
    defaultFrequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
    defaultProtectedAttributes: string[];
    syntheticRecordMultiplier: number;
  };
  notifications: {
    alertOnPrivacyBreach: boolean;
    alertOnFairnessBreach: boolean;
    alertOnRegression: boolean;
    minimumSeverity: string;
  };
}

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
  thresholds: Thresholds;
}

export interface TrendPoint {
  timestamp: string;
  reference: string;
  privacy_risk_score?: number;
  counterfactual_flip_rate?: number;
  demographic_parity_difference?: number;
  equal_opportunity_difference?: number;
}

export interface ActivityRun {
  id: string;
  reference: string;
  testType: TestType;
  status: TestRunStatus;
  result: TestResult | null;
  createdAt: string;
  model: { name: string; version: string } | null;
}

export interface ActivityFeed {
  runs: ActivityRun[];
  alerts: Alert[];
}

export interface ModelCoverage {
  id: string;
  name: string;
  version: string;
  environment: string;
  status: string;
  lastResult: TestResult | null;
  lastRiskScore: number | null;
  lastTestedAt: string | null;
  lastReference: string | null;
}

export interface SchemaField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'categorical';
  nullable?: boolean;
  description?: string;
  protectedAttribute?: boolean;
}

export interface SensitiveField {
  id: string;
  fieldName: string;
  category: string;
  confidence: number;
  sampleMatchRate: number;
  recommendedAction: string;
}

export interface Dataset {
  id: string;
  name: string;
  version: string;
  domain: string | null;
  recordCount: number;
  status: 'REGISTERED' | 'SCANNED' | 'PROTECTED' | 'ARCHIVED';
  dataSourceId: string | null;
  schemaJson: SchemaField[];
  createdAt: string;
  sensitiveFields?: SensitiveField[];
  syntheticDatasets?: SyntheticDataset[];
  dataSource?: { id: string; name: string; type: string } | null;
  _count?: { records: number; sensitiveFields: number };
}

export interface SyntheticDataset {
  id: string;
  datasetId: string;
  recordCount: number;
  method: string;
  status: 'GENERATING' | 'READY' | 'FAILED';
  privacyScore: number | null;
  statisticalSimilarity: number | null;
  configuration: Record<string, unknown>;
  createdAt: string;
}

export interface DataSource {
  id: string;
  name: string;
  type: string;
  connectionStatus: 'PENDING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  configuration: Record<string, unknown>;
  lastCheckedAt: string | null;
  createdAt: string;
  _count?: { datasets: number };
}

export interface Model {
  id: string;
  name: string;
  description: string | null;
  version: string;
  modelType: string;
  provider: string;
  endpoint: string | null;
  owner: string | null;
  environment: string;
  testFrequency: string;
  status: string;
  demoBehavior: string | null;
  isDemo: boolean;
  createdAt: string;
  _count?: { testRuns: number };
  testRuns?: TestRun[];
  versionHistory?: { id: string; version: string; note: string | null; createdAt: string }[];
}

export interface RunStage {
  key: string;
  label: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETE' | 'SKIPPED' | 'FAILED';
}

export interface Metric {
  id: string;
  metricName: string;
  metricValue: number;
  unit: string | null;
  threshold: number | null;
  breached: boolean;
}

export interface PrivacyTest {
  id: string;
  recordsTested: number;
  adversarialCases: number;
  reidentificationCases: number;
  highRiskCases: number;
  kAnonymity: number;
  privacyScore: number;
  threshold: number;
  result: TestResult;
  breakdown: Record<string, unknown>;
}

export interface CounterfactualCase {
  id: string;
  originalProfile: Record<string, unknown>;
  counterfactualProfile: Record<string, unknown>;
  originalOutcome: string;
  counterfactualOutcome: string;
  originalScore: number;
  counterfactualScore: number;
  outcomeChanged: boolean;
  fairnessTest?: { protectedAttribute: string };
}

export interface FairnessTest {
  id: string;
  protectedAttribute: string;
  sampleSize: number;
  baselineSelectionRate: number;
  variantSelectionRate: number;
  selectionRateDiff: number;
  demographicParityDiff: number;
  equalOpportunityDiff: number;
  counterfactualFlipRate: number;
  threshold: number;
  confidenceLow: number;
  confidenceHigh: number;
  result: TestResult;
  metricsJson: Record<string, unknown>;
  sampleWarning?: string | null;
  counterfactualCases?: CounterfactualCase[];
}

export interface TestRun {
  id: string;
  reference: string;
  testType: TestType;
  status: TestRunStatus;
  progress: number;
  stage: string | null;
  stages: RunStage[];
  result: TestResult | null;
  riskScore: number | null;
  errorMessage: string | null;
  triggeredBy: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  modelId: string | null;
  datasetId: string | null;
  summary?: Record<string, unknown>;
  model?: Model | null;
  dataset?: { id: string; name: string; version: string; recordCount: number } | null;
  metrics?: Metric[];
  privacyTests?: PrivacyTest[];
  fairnessTests?: FairnessTest[];
  alerts?: Alert[];
  reports?: { id: string; title: string; format: string; createdAt: string }[];
}

export interface Alert {
  id: string;
  severity: Severity;
  alertType: string;
  title: string;
  description: string;
  testRunId: string | null;
  metricName: string | null;
  currentValue: number | null;
  threshold: number | null;
  recommendedAction: string | null;
  status: AlertStatus;
  createdAt: string;
  testRun?: { id: string; reference: string; testType: TestType } | null;
}

export interface Report {
  id: string;
  reportType: string;
  format: string;
  title: string;
  modelId: string | null;
  testRunId: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  fileSize: number | null;
  createdAt: string;
  model?: { name: string; version: string } | null;
}

export interface MonitoringSchedule {
  id: string;
  name: string;
  testType: TestType;
  frequency: string;
  intervalHours: number | null;
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: TestResult | null;
  modelId: string | null;
  datasetId: string | null;
  model?: { id: string; name: string; version: string } | null;
  dataset?: { id: string; name: string } | null;
}

export interface Integration {
  id: string;
  integrationType: string;
  name: string;
  configuration: Record<string, unknown>;
  status: string;
  repository: string | null;
  branch: string | null;
  lastCommit: string | null;
  lastEventAt: string | null;
  lastResult: TestResult | null;
  lastTestRunId: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  user?: { name: string; email: string } | null;
}
