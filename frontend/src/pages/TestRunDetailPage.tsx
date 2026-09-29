import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, downloadFile } from '@/lib/api';
import { formatDateTime, formatNumber, formatPercent, humanize } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import {
  Button, Card, EmptyState, ErrorState, LoadingState, Metric, PageHeader,
  ProgressBar, ResultBadge, SeverityBadge, StatusBadge, Table, Td, Th,
} from '@/components/ui';
import type { CounterfactualCase, TestRun } from '@/lib/types';

export const TestRunDetailPage = () => {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ['test-run', id],
    queryFn: () => apiRequest<TestRun>(`/test-runs/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) =>
      ['QUEUED', 'RUNNING'].includes(query.state.data?.status ?? '') ? 1500 : false,
  });
  const counterfactuals = useQuery({
    queryKey: ['counterfactuals', id],
    queryFn: () => apiRequest<CounterfactualCase[]>(`/test-runs/${id}/counterfactuals?limit=20`),
    enabled: run.data?.status === 'COMPLETED' && Boolean(run.data.fairnessTests?.length),
  });
  const cancel = useMutation({
    mutationFn: () => apiRequest<TestRun>(`/test-runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['test-run', id] }),
    onError: (error: Error) => notify(error.message, 'error'),
  });

  if (run.isLoading) return <LoadingState label="Loading test results" />;
  if (run.isError) return <ErrorState error={run.error} onRetry={() => run.refetch()} />;
  const data = run.data;
  if (!data) return <EmptyState title="Test run not found" />;
  const active = data.status === 'QUEUED' || data.status === 'RUNNING';

  return (
    <>
      <PageHeader
        title={data.reference}
        description={`${humanize(data.testType)} · ${data.model?.name ?? 'No model'} · ${data.dataset?.name ?? 'No dataset'} · created ${formatDateTime(data.createdAt)}`}
        actions={
          <>
            <Link to="/test-runs" className="text-sm underline">All runs</Link>
            {active && hasRole('ANALYST') && (
              <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel run
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Status" value={<StatusBadge status={data.status} />} />
        <Metric label="Result" value={<ResultBadge result={data.result} />} />
        <Metric label="Risk score" value={formatNumber(data.riskScore, 1)} />
        <Metric label="Completed" value={formatDateTime(data.completedAt)} />
      </div>
      {data.errorMessage && <p role="alert" className="mt-4 rounded border border-state-fail p-4 text-state-fail">{data.errorMessage}</p>}
      <Card title={`Workflow · ${data.progress}%`} className="mt-6">
        <ProgressBar value={data.progress} />
        <ol className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {data.stages.map((stage) => (
            <li key={stage.key} className="flex items-center justify-between rounded border border-ink-200 p-3 text-sm">
              {stage.label} <StatusBadge status={stage.status} />
            </li>
          ))}
        </ol>
      </Card>
      {data.privacyTests?.map((test) => (
        <Card key={test.id} title="Privacy Shield · Prototype Privacy Simulation" className="mt-6">
          <p className="mb-4 text-xs text-ink-500">No differential privacy guarantee. Potential risks require human review.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Metric label="Privacy risk" value={formatNumber(test.privacyScore, 1)} hint={`Threshold ${test.threshold}`} />
            <Metric label="Records tested" value={formatNumber(test.recordsTested)} />
            <Metric label="Re-identification cases" value={formatNumber(test.reidentificationCases)} />
            <Metric label="High-risk cases" value={formatNumber(test.highRiskCases)} />
            <Metric label="Adversarial cases" value={formatNumber(test.adversarialCases)} />
            <Metric label="Statistical similarity" value={formatPercent(typeof test.breakdown.statisticalSimilarity === 'number' ? test.breakdown.statisticalSimilarity : null)} />
          </div>
          <pre className="mt-4 overflow-x-auto rounded bg-ink-50 p-3 text-xs">{JSON.stringify(test.breakdown, null, 2)}</pre>
        </Card>
      ))}
      {(data.fairnessTests?.length ?? 0) > 0 && (
        <Card title="Fairness Sword · protected attributes" className="mt-6">
          <p className="mb-4 text-xs text-ink-500">Metric differences are signals for human review, not determinations of fairness.</p>
          <Table head={<><Th>Attribute</Th><Th>Samples</Th><Th>Selection (base / variant)</Th><Th>Parity Δ</Th><Th>Opportunity Δ</Th><Th>Flip rate (95% CI)</Th><Th>Result</Th></>}>
            {data.fairnessTests?.map((test) => (
              <tr key={test.id} className="table-row">
                <Td>{humanize(test.protectedAttribute)}</Td>
                <Td>{formatNumber(test.sampleSize)}{test.sampleWarning && <p className="text-xs text-state-warn">{test.sampleWarning}</p>}</Td>
                <Td>{formatPercent(test.baselineSelectionRate)} / {formatPercent(test.variantSelectionRate)}</Td>
                <Td>{formatPercent(test.demographicParityDiff)}</Td>
                <Td>{formatPercent(test.equalOpportunityDiff)}</Td>
                <Td>{formatPercent(test.counterfactualFlipRate)} ({formatPercent(test.confidenceLow)}–{formatPercent(test.confidenceHigh)})</Td>
                <Td><ResultBadge result={test.result} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {(data.metrics?.length ?? 0) > 0 && (
        <Card title="Recorded metrics" className="mt-6">
          <Table head={<><Th>Metric</Th><Th>Value</Th><Th>Threshold</Th><Th>Breach</Th></>}>
            {data.metrics?.map((metric) => (
              <tr key={metric.id} className="table-row">
                <Td>{humanize(metric.metricName)}</Td><Td>{formatNumber(metric.metricValue, 4)} {metric.unit}</Td>
                <Td>{formatNumber(metric.threshold, 4)}</Td><Td>{metric.breached ? 'Yes' : 'No'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {(counterfactuals.data?.length ?? 0) > 0 && (
        <Card title="Changed counterfactual outcomes (sample)" className="mt-6">
          <Table head={<><Th>Attribute</Th><Th>Original</Th><Th>Counterfactual</Th><Th>Outcome</Th></>}>
            {counterfactuals.data?.map((item) => (
              <tr key={item.id} className="table-row">
                <Td>{humanize(item.fairnessTest?.protectedAttribute)}</Td>
                <Td><pre className="max-w-xs overflow-x-auto text-xs">{JSON.stringify(item.originalProfile)}</pre></Td>
                <Td><pre className="max-w-xs overflow-x-auto text-xs">{JSON.stringify(item.counterfactualProfile)}</pre></Td>
                <Td>{item.originalOutcome} → {item.counterfactualOutcome}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Alerts">
          {data.alerts?.length ? data.alerts.map((alert) => (
            <div key={alert.id} className="border-b border-ink-100 py-2 text-sm">
              <SeverityBadge severity={alert.severity} /> <Link className="underline" to="/alerts">{alert.title}</Link>
              <p className="text-ink-500">{alert.description}</p>
            </div>
          )) : <EmptyState title={active ? 'Alerts pending' : 'No alerts raised'} />}
        </Card>
        <Card title="Reports">
          {data.reports?.length ? data.reports.map((report) => (
            <div key={report.id} className="flex justify-between gap-3 border-b border-ink-100 py-2 text-sm">
              <span>{report.title} ({report.format})</span>
              <Button variant="secondary" onClick={() => downloadFile(`/reports/${report.id}/download`, `authenq-${report.id}.${report.format.toLowerCase()}`).catch((error: Error) => notify(error.message, 'error'))}>Download</Button>
            </div>
          )) : <EmptyState title={active ? 'Report pending' : 'No report generated'} />}
        </Card>
      </div>
    </>
  );
};
