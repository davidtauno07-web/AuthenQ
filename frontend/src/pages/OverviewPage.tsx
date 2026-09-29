import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber, formatRatio, formatRelative } from '@/lib/format';
import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Metric,
  Modal,
  ResultBadge,
  Select,
  SeverityBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import type {
  ActivityFeed,
  DashboardSummary,
  Dataset,
  Model,
  ModelCoverage,
  TestRun,
  TrendPoint,
} from '@/lib/types';

const riskTone = (score: number | null, threshold: number): 'pass' | 'warn' | 'fail' | undefined => {
  if (score === null) return undefined;
  if (score <= threshold) return 'pass';
  if (score <= threshold * 1.5) return 'warn';
  return 'fail';
};

export const OverviewPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { hasRole } = useAuth();
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [datasetId, setDatasetId] = useState('');

  const summary = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => apiRequest<DashboardSummary>('/dashboard/summary'),
  });
  const trend = useQuery({
    queryKey: ['dashboard', 'trend'],
    queryFn: () => apiRequest<TrendPoint[]>('/dashboard/trend'),
  });
  const activity = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: () => apiRequest<ActivityFeed>('/dashboard/activity'),
  });
  const coverage = useQuery({
    queryKey: ['dashboard', 'coverage'],
    queryFn: () => apiRequest<ModelCoverage[]>('/dashboard/coverage'),
  });
  const models = useQuery({ queryKey: ['models'], queryFn: () => apiRequest<Model[]>('/models') });
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => apiRequest<Dataset[]>('/datasets'),
  });

  const runAssessment = useMutation({
    mutationFn: () =>
      apiRequest<TestRun>('/test-runs', {
        method: 'POST',
        body: {
          testType: 'FULL_ASSESSMENT',
          modelId,
          datasetId,
          triggeredBy: 'MANUAL',
          configuration: { generateReport: true },
        },
      }),
    onSuccess: (run) => {
      setAssessmentOpen(false);
      queryClient.invalidateQueries({ queryKey: ['test-runs'] });
      notify(`Full AuthenQ assessment ${run.reference} queued`, 'success');
      navigate(`/test-runs/${run.id}`);
    },
    onError: (error: unknown) =>
      notify(error instanceof Error ? error.message : 'Could not start assessment', 'error'),
  });

  const chartData = useMemo(
    () =>
      (trend.data ?? []).map((point) => ({
        label: new Date(point.timestamp).toLocaleDateString(undefined, {
          month: 'short',
          day: '2-digit',
        }),
        privacy: point.privacy_risk_score ?? null,
        flipRate: point.counterfactual_flip_rate ?? null,
        parity: point.demographic_parity_difference ?? null,
      })),
    [trend.data],
  );

  if (summary.isLoading) return <LoadingState label="Loading overview" />;
  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;

  const data = summary.data;
  const thresholds = data?.thresholds;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Overview</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-500">
            Continuous privacy and fairness posture across monitored models and datasets. All
            findings indicate potential risk requiring human review.
          </p>
        </div>
        {hasRole('ANALYST') && (
          <Button onClick={() => setAssessmentOpen(true)}>Run full AuthenQ assessment</Button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Privacy risk score"
          value={formatNumber(data?.privacyRiskScore, 1)}
          hint={`Threshold ${thresholds?.privacyRiskScore ?? '—'} · lower is better`}
          tone={
            data && thresholds ? riskTone(data.privacyRiskScore, thresholds.privacyRiskScore) : undefined
          }
        />
        <Metric
          label="Fairness risk score"
          value={formatNumber(data?.fairnessRiskScore, 1)}
          hint="Composite of threshold breaches across protected attributes"
          tone={data ? riskTone(data.fairnessRiskScore, 25) : undefined}
        />
        <Metric
          label="Open alerts"
          value={formatNumber(data?.openAlerts)}
          hint={`${formatNumber(data?.criticalAlerts)} critical`}
          tone={data && data.openAlerts > 0 ? 'warn' : 'pass'}
        />
        <Metric
          label="Pass rate (30d)"
          value={`${formatNumber(data?.passRate, 0)}%`}
          hint={`${formatNumber(data?.testsLast30Days)} runs · ${formatNumber(
            data?.modelsMonitored,
          )} models monitored`}
        />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card title="Risk trend" className="xl:col-span-2">
          {trend.isLoading ? (
            <LoadingState label="Loading trend" />
          ) : chartData.length === 0 ? (
            <EmptyState title="No completed runs yet" description="Run an assessment to build history." />
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="#e6e6e9" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#6c6c75' }} stroke="#c7c7cc" />
                  <YAxis tick={{ fontSize: 11, fill: '#6c6c75' }} stroke="#c7c7cc" />
                  <Tooltip
                    contentStyle={{ border: '1px solid #c7c7cc', borderRadius: 4, fontSize: 12 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="privacy"
                    name="Privacy risk score"
                    stroke="#0b0b0c"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="flipRate"
                    name="Counterfactual flip rate"
                    stroke="#6c6c75"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="parity"
                    name="Demographic parity difference"
                    stroke="#9a9aa2"
                    strokeWidth={2}
                    strokeDasharray="2 2"
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Testing workflow">
          <ol className="space-y-3 text-sm text-ink-600">
            {[
              ['Select dataset', 'Register source data and detect sensitive fields'],
              ['Privacy Shield', 'Generate protected synthetic data and adversarial cases'],
              ['Fairness Sword', 'Run counterfactual tests against the model'],
              ['Results', 'Compare metrics to thresholds and prior baselines'],
              ['Alert', 'Raise findings for human review'],
              ['Report', 'Produce compliance evidence'],
            ].map(([title, detail], index) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-ink-300 text-xs font-semibold text-ink-700">
                  {index + 1}
                </span>
                <span>
                  <span className="block font-medium text-ink-900">{title}</span>
                  <span className="text-xs text-ink-500">{detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">
            Last assessment {formatRelative(data?.lastAssessmentAt)} ·{' '}
            {formatDateTime(data?.lastAssessmentAt)}
          </p>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card title="Recent test runs" action={<Link className="text-sm underline" to="/test-runs">View all</Link>}>
          {activity.isLoading ? (
            <LoadingState />
          ) : (activity.data?.runs.length ?? 0) === 0 ? (
            <EmptyState title="No test runs yet" />
          ) : (
            <Table
              head={
                <>
                  <Th>Reference</Th>
                  <Th>Type</Th>
                  <Th>Model</Th>
                  <Th>Result</Th>
                  <Th>When</Th>
                </>
              }
            >
              {activity.data?.runs.map((run) => (
                <tr key={run.id} className="table-row">
                  <Td>
                    <Link to={`/test-runs/${run.id}`} className="font-medium underline">
                      {run.reference}
                    </Link>
                  </Td>
                  <Td className="text-ink-500">{run.testType.replace('_', ' ')}</Td>
                  <Td>{run.model ? `${run.model.name} v${run.model.version}` : '—'}</Td>
                  <Td>
                    <ResultBadge result={run.result} />
                  </Td>
                  <Td className="text-ink-500">{formatRelative(run.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="Open alerts" action={<Link className="text-sm underline" to="/alerts">View all</Link>}>
          {activity.isLoading ? (
            <LoadingState />
          ) : (activity.data?.alerts.length ?? 0) === 0 ? (
            <EmptyState title="No open alerts" description="Nothing currently exceeds your thresholds." />
          ) : (
            <ul className="divide-y divide-ink-100">
              {activity.data?.alerts.slice(0, 6).map((alert) => (
                <li key={alert.id} className="flex items-start gap-3 py-3">
                  <SeverityBadge severity={alert.severity} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{alert.title}</p>
                    <p className="text-xs text-ink-500">
                      {alert.metricName ? `${alert.metricName} ` : ''}
                      {alert.currentValue !== null && `= ${formatRatio(alert.currentValue)} `}
                      {alert.threshold !== null && `(threshold ${formatRatio(alert.threshold)})`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Model coverage" className="mt-6">
        {coverage.isLoading ? (
          <LoadingState />
        ) : (coverage.data?.length ?? 0) === 0 ? (
          <EmptyState title="No models registered" />
        ) : (
          <Table
            head={
              <>
                <Th>Model</Th>
                <Th>Environment</Th>
                <Th>Last result</Th>
                <Th>Risk score</Th>
                <Th>Last tested</Th>
              </>
            }
          >
            {coverage.data?.map((model) => (
              <tr key={model.id} className="table-row">
                <Td>
                  <Link to="/models" className="font-medium underline">
                    {model.name}
                  </Link>{' '}
                  <span className="text-ink-400">v{model.version}</span>
                </Td>
                <Td className="text-ink-500">{model.environment}</Td>
                <Td>
                  <ResultBadge result={model.lastResult} />
                </Td>
                <Td>{formatNumber(model.lastRiskScore, 1)}</Td>
                <Td className="text-ink-500">{formatDateTime(model.lastTestedAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal
        open={assessmentOpen}
        title="Run full AuthenQ assessment"
        onClose={() => setAssessmentOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAssessmentOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={runAssessment.isPending}
              disabled={!modelId || !datasetId}
              onClick={() => runAssessment.mutate()}
            >
              Start assessment
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-ink-600">
          Runs Privacy Shield and Fairness Sword end to end, evaluates thresholds, compares against
          previous baselines, raises alerts and produces a Compliance Evidence Report.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Dataset">
            <Select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              <option value="">Select dataset…</option>
              {datasets.data?.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} v{dataset.version}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <Select value={modelId} onChange={(event) => setModelId(event.target.value)}>
              <option value="">Select model…</option>
              {models.data?.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} v{model.version}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  );
};
