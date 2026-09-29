import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  ProgressBar,
  ResultBadge,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import type { TestRun } from '@/lib/types';

export const TestRunsPage = () => {
  const [status, setStatus] = useState('');
  const [testType, setTestType] = useState('');

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (testType) query.set('testType', testType);
  query.set('limit', '100');

  const runs = useQuery({
    queryKey: ['test-runs', { status, testType }],
    queryFn: () => apiRequest<TestRun[]>(`/test-runs?${query.toString()}`),
    refetchInterval: (data) =>
      (data.state.data ?? []).some((run) => run.status === 'RUNNING' || run.status === 'QUEUED')
        ? 3_000
        : false,
  });

  return (
    <>
      <PageHeader
        title="Test Runs"
        description="Every privacy, fairness and full assessment execution, with stage-level progress and stored evidence."
      />

      <Card
        title="Filters"
        className="mb-4"
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Status">
            <Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Test type">
            <Select value={testType} onChange={(event) => setTestType(event.target.value)}>
              <option value="">All types</option>
              {['PRIVACY', 'FAIRNESS', 'FULL_ASSESSMENT'].map((value) => (
                <option key={value} value={value}>
                  {value.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Runs">
        {runs.isLoading ? (
          <LoadingState />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : (runs.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No test runs match these filters"
            description="Start a run from Privacy Shield, Fairness Sword or the Overview."
          />
        ) : (
          <Table
            head={
              <>
                <Th>Reference</Th>
                <Th>Type</Th>
                <Th>Model / dataset</Th>
                <Th>Status</Th>
                <Th>Result</Th>
                <Th>Risk</Th>
                <Th>Started</Th>
              </>
            }
          >
            {runs.data?.map((run) => (
              <tr key={run.id} className="table-row">
                <Td>
                  <Link to={`/test-runs/${run.id}`} className="font-medium underline">
                    {run.reference}
                  </Link>
                  <span className="ml-2 text-xs text-ink-400">{run.triggeredBy}</span>
                </Td>
                <Td className="text-ink-500">{run.testType.replace('_', ' ')}</Td>
                <Td>
                  <span className="block">{run.model?.name ?? '—'}</span>
                  <span className="text-xs text-ink-400">{run.dataset?.name ?? '—'}</span>
                </Td>
                <Td>
                  <StatusBadge status={run.status} />
                  {(run.status === 'RUNNING' || run.status === 'QUEUED') && (
                    <div className="mt-2 w-28">
                      <ProgressBar value={run.progress} />
                    </div>
                  )}
                </Td>
                <Td>
                  <ResultBadge result={run.result} />
                </Td>
                <Td>{formatNumber(run.riskScore, 1)}</Td>
                <Td className="text-ink-500">{formatDateTime(run.startedAt ?? run.createdAt)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
};
