import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber, formatPercent, humanize } from '@/lib/format';
import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  ResultBadge,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import type { Dataset, TestRun } from '@/lib/types';

interface AdversarialCase {
  id: string;
  scenarioType: string;
  riskScore: number;
  reidentification: boolean;
  metadata: Record<string, unknown>;
}

export const PrivacyShieldPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { hasRole } = useAuth();
  const canRun = hasRole('ANALYST');

  const [datasetId, setDatasetId] = useState('');
  const [sampleSize, setSampleSize] = useState(400);
  const [kAnonymityTarget, setKAnonymityTarget] = useState(5);
  const [noiseLevel, setNoiseLevel] = useState(0.15);

  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => apiRequest<Dataset[]>('/datasets'),
  });

  useEffect(() => {
    if (!datasetId && datasets.data && datasets.data.length > 0) {
      setDatasetId(datasets.data[0]?.id ?? '');
    }
  }, [datasets.data, datasetId]);

  const dataset = useQuery({
    queryKey: ['datasets', datasetId],
    queryFn: () => apiRequest<Dataset>(`/datasets/${datasetId}`),
    enabled: Boolean(datasetId),
  });

  const adversarialCases = useQuery({
    queryKey: ['datasets', datasetId, 'adversarial-cases'],
    queryFn: () => apiRequest<AdversarialCase[]>(`/datasets/${datasetId}/adversarial-cases`),
    enabled: Boolean(datasetId),
  });

  const privacyRuns = useQuery({
    queryKey: ['test-runs', { testType: 'PRIVACY', datasetId }],
    queryFn: () => apiRequest<TestRun[]>(`/test-runs?testType=PRIVACY&limit=10`),
  });

  const scan = useMutation({
    mutationFn: () => apiRequest(`/datasets/${datasetId}/scan`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      notify('Sensitive field scan complete', 'success');
    },
    onError: (error: unknown) =>
      notify(error instanceof Error ? error.message : 'Scan failed', 'error'),
  });

  const generate = useMutation({
    mutationFn: () =>
      apiRequest(`/datasets/${datasetId}/synthetic`, {
        method: 'POST',
        body: {
          recordCount: sampleSize,
          configuration: { kAnonymityTarget, noiseLevel },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      notify('Protected synthetic dataset generated', 'success');
    },
    onError: (error: unknown) =>
      notify(error instanceof Error ? error.message : 'Generation failed', 'error'),
  });

  const runPrivacyTest = useMutation({
    mutationFn: () =>
      apiRequest<TestRun>('/test-runs', {
        method: 'POST',
        body: {
          testType: 'PRIVACY',
          datasetId,
          configuration: {
            sampleSize,
            privacy: { kAnonymityTarget, noiseLevel },
          },
        },
      }),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['test-runs'] });
      notify(`Privacy test ${run.reference} started`, 'success');
      navigate(`/test-runs/${run.id}`);
    },
    onError: (error: unknown) =>
      notify(error instanceof Error ? error.message : 'Could not start privacy test', 'error'),
  });

  const latestSynthetic = useMemo(
    () => dataset.data?.syntheticDatasets?.[0] ?? null,
    [dataset.data],
  );

  return (
    <>
      <PageHeader
        title="Privacy Shield"
        description="Detect sensitive fields, generate a protected synthetic representation and attack it with adversarial re-identification cases. Prototype Privacy Simulation — not differential privacy, and no mathematical privacy guarantee."
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Configuration" className="xl:col-span-1">
          <div className="space-y-4">
            <Field label="Dataset">
              <Select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                <option value="">Select dataset…</option>
                {datasets.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} v{item.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Records tested" hint="50–50,000 records sampled from the source dataset.">
              <Input
                type="number"
                min={50}
                max={50_000}
                value={sampleSize}
                onChange={(event) => setSampleSize(Number(event.target.value))}
              />
            </Field>
            <Field label="k-anonymity target" hint="Smallest permitted quasi-identifier group.">
              <Input
                type="number"
                min={2}
                max={100}
                value={kAnonymityTarget}
                onChange={(event) => setKAnonymityTarget(Number(event.target.value))}
              />
            </Field>
            <Field label="Noise level" hint="Numeric noise as a fraction of column σ.">
              <Input
                type="number"
                step={0.05}
                min={0}
                max={1}
                value={noiseLevel}
                onChange={(event) => setNoiseLevel(Number(event.target.value))}
              />
            </Field>

            <div className="flex flex-wrap gap-2 border-t border-ink-100 pt-4">
              <Button
                variant="secondary"
                disabled={!datasetId || !canRun}
                loading={scan.isPending}
                onClick={() => scan.mutate()}
              >
                Scan sensitive fields
              </Button>
              <Button
                variant="secondary"
                disabled={!datasetId || !canRun}
                loading={generate.isPending}
                onClick={() => generate.mutate()}
              >
                Generate synthetic data
              </Button>
              <Button
                disabled={!datasetId || !canRun}
                loading={runPrivacyTest.isPending}
                onClick={() => runPrivacyTest.mutate()}
              >
                Run privacy test
              </Button>
            </div>
            {!canRun && (
              <p className="text-xs text-ink-400">
                Viewer role is read-only. Ask an analyst or admin to run tests.
              </p>
            )}
          </div>
        </Card>

        <Card title="Detected sensitive fields" className="xl:col-span-2">
          {!datasetId ? (
            <EmptyState title="Select a dataset" description="Choose a dataset to inspect its schema." />
          ) : dataset.isLoading ? (
            <LoadingState />
          ) : dataset.isError ? (
            <ErrorState error={dataset.error} onRetry={() => dataset.refetch()} />
          ) : (dataset.data?.sensitiveFields?.length ?? 0) === 0 ? (
            <EmptyState
              title="No scan results"
              description="Run a sensitive field scan to classify direct identifiers and quasi-identifiers."
            />
          ) : (
            <Table
              head={
                <>
                  <Th>Field</Th>
                  <Th>Category</Th>
                  <Th>Confidence</Th>
                  <Th>Sample match</Th>
                  <Th>Recommended action</Th>
                </>
              }
            >
              {dataset.data?.sensitiveFields?.map((field) => (
                <tr key={field.id} className="table-row">
                  <Td className="font-mono text-xs">{field.fieldName}</Td>
                  <Td>{humanize(field.category)}</Td>
                  <Td>{formatPercent(field.confidence, 0)}</Td>
                  <Td>{formatPercent(field.sampleMatchRate, 0)}</Td>
                  <Td className="text-ink-500">{humanize(field.recommendedAction)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card title="Protected synthetic representation">
          {!latestSynthetic ? (
            <EmptyState
              title="No synthetic dataset yet"
              description="Generate one to compare utility against privacy exposure."
            />
          ) : (
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Status</dt>
                <dd className="mt-1">
                  <StatusBadge status={latestSynthetic.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Records</dt>
                <dd className="mt-1">{formatNumber(latestSynthetic.recordCount)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Privacy score</dt>
                <dd className="mt-1">{formatNumber(latestSynthetic.privacyScore, 2)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-400">Statistical similarity</dt>
                <dd className="mt-1">{formatPercent(latestSynthetic.statisticalSimilarity, 1)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-ink-400">Method</dt>
                <dd className="mt-1 font-mono text-xs">{latestSynthetic.method}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs uppercase tracking-wide text-ink-400">Generated</dt>
                <dd className="mt-1">{formatDateTime(latestSynthetic.createdAt)}</dd>
              </div>
            </dl>
          )}
        </Card>

        <Card title="Recent privacy runs">
          {privacyRuns.isLoading ? (
            <LoadingState />
          ) : (privacyRuns.data?.length ?? 0) === 0 ? (
            <EmptyState title="No privacy runs yet" />
          ) : (
            <Table
              head={
                <>
                  <Th>Reference</Th>
                  <Th>Result</Th>
                  <Th>Risk</Th>
                  <Th>When</Th>
                </>
              }
            >
              {privacyRuns.data?.map((run) => (
                <tr key={run.id} className="table-row">
                  <Td>
                    <Link to={`/test-runs/${run.id}`} className="font-medium underline">
                      {run.reference}
                    </Link>
                  </Td>
                  <Td>
                    <ResultBadge result={run.result} />
                  </Td>
                  <Td>{formatNumber(run.riskScore, 1)}</Td>
                  <Td className="text-ink-500">{formatDateTime(run.createdAt)}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <Card title="Adversarial privacy cases" className="mt-6">
        {!datasetId ? (
          <EmptyState title="Select a dataset" />
        ) : adversarialCases.isLoading ? (
          <LoadingState />
        ) : (adversarialCases.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No adversarial cases recorded"
            description="Cases are produced when a privacy test attacks the protected representation."
          />
        ) : (
          <Table
            head={
              <>
                <Th>Scenario</Th>
                <Th>Risk</Th>
                <Th>Re-identified</Th>
                <Th>Evidence</Th>
              </>
            }
          >
            {adversarialCases.data?.slice(0, 25).map((item) => (
              <tr key={item.id} className="table-row">
                <Td>{humanize(item.scenarioType)}</Td>
                <Td>{item.riskScore.toFixed(2)}</Td>
                <Td>
                  {item.reidentification ? (
                    <span className="text-state-fail">Yes</span>
                  ) : (
                    <span className="text-ink-400">No</span>
                  )}
                </Td>
                <Td className="max-w-md truncate font-mono text-xs text-ink-500">
                  {JSON.stringify(item.metadata)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
};
