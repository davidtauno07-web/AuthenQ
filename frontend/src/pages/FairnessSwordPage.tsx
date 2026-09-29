import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber, formatRatio } from '@/lib/format';
import { useToast } from '@/components/ToastProvider';
import { useAuth } from '@/auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  ResultBadge,
  Select,
  Table,
  Td,
  Th,
} from '@/components/ui';
import type { Dataset, Model, OrgSettings, TestRun } from '@/lib/types';

export const FairnessSwordPage = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { hasRole } = useAuth();
  const canRun = hasRole('ANALYST');

  const [modelId, setModelId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [caseCount, setCaseCount] = useState(400);

  const models = useQuery({ queryKey: ['models'], queryFn: () => apiRequest<Model[]>('/models') });
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => apiRequest<Dataset[]>('/datasets'),
  });
  const settings = useQuery({
    queryKey: ['organization', 'settings'],
    queryFn: () => apiRequest<OrgSettings>('/organization/settings'),
  });
  const fairnessRuns = useQuery({
    queryKey: ['test-runs', { testType: 'FAIRNESS' }],
    queryFn: () => apiRequest<TestRun[]>('/test-runs?testType=FAIRNESS&limit=10'),
  });

  useEffect(() => {
    if (!modelId && models.data?.length) setModelId(models.data[0]?.id ?? '');
  }, [models.data, modelId]);
  useEffect(() => {
    if (!datasetId && datasets.data?.length) setDatasetId(datasets.data[0]?.id ?? '');
  }, [datasets.data, datasetId]);

  const runFairness = useMutation({
    mutationFn: () =>
      apiRequest<TestRun>('/test-runs', {
        method: 'POST',
        body: {
          testType: 'FAIRNESS',
          modelId,
          datasetId,
          configuration: { caseCount, sampleSize: caseCount },
        },
      }),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['test-runs'] });
      notify(`Fairness test ${run.reference} started`, 'success');
      navigate(`/test-runs/${run.id}`);
    },
    onError: (error: unknown) =>
      notify(error instanceof Error ? error.message : 'Could not start fairness test', 'error'),
  });

  const thresholds = settings.data?.thresholds;

  return (
    <>
      <PageHeader
        title="Fairness Sword"
        description="Counterfactual testing: identical profiles are re-scored with protected attributes changed, then compared against your configured disparity thresholds. Results indicate potential disparity requiring human review."
      />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Test configuration">
          <div className="space-y-4">
            <Field label="Model under test">
              <Select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                <option value="">Select model…</option>
                {models.data?.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} v{model.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Profile source dataset">
              <Select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                <option value="">Select dataset…</option>
                {datasets.data?.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} v{dataset.version}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Counterfactual pairs" hint="More pairs narrow the confidence interval.">
              <Input
                type="number"
                min={50}
                max={50_000}
                value={caseCount}
                onChange={(event) => setCaseCount(Number(event.target.value))}
              />
            </Field>
            <div>
              <span className="field-label">Protected attributes</span>
              <div className="flex flex-wrap gap-2">
                {(settings.data?.testing.defaultProtectedAttributes ?? []).map((attribute) => (
                  <span
                    key={attribute}
                    className="rounded border border-ink-300 px-2.5 py-1 text-xs text-ink-600"
                  >
                    {attribute}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-xs text-ink-400">
                Configured under Settings. Only attributes present in the dataset schema are tested.
              </p>
            </div>
            <Button
              className="w-full"
              disabled={!modelId || !datasetId || !canRun}
              loading={runFairness.isPending}
              onClick={() => runFairness.mutate()}
            >
              Run fairness test
            </Button>
            {!canRun && <p className="text-xs text-ink-400">Viewer role is read-only.</p>}
          </div>
        </Card>

        <Card title="Active thresholds" className="xl:col-span-2">
          {settings.isLoading ? (
            <LoadingState />
          ) : (
            <Table
              head={
                <>
                  <Th>Metric</Th>
                  <Th>Threshold</Th>
                  <Th>Meaning</Th>
                </>
              }
            >
              <tr className="table-row">
                <Td>Counterfactual flip rate</Td>
                <Td>{formatRatio(thresholds?.counterfactualFlipRate)}</Td>
                <Td className="text-ink-500">
                  Share of profiles whose decision changes when only a protected attribute changes
                </Td>
              </tr>
              <tr className="table-row">
                <Td>Demographic parity difference</Td>
                <Td>{formatRatio(thresholds?.demographicParityDifference)}</Td>
                <Td className="text-ink-500">Gap in selection rates between compared groups</Td>
              </tr>
              <tr className="table-row">
                <Td>Equal opportunity difference</Td>
                <Td>{formatRatio(thresholds?.equalOpportunityDifference)}</Td>
                <Td className="text-ink-500">
                  Gap in true-positive rates among profiles with a positive ground truth
                </Td>
              </tr>
              <tr className="table-row">
                <Td>Regression delta</Td>
                <Td>{formatRatio(thresholds?.regressionDelta)}</Td>
                <Td className="text-ink-500">Degradation against the previous baseline run</Td>
              </tr>
            </Table>
          )}
          <p className="mt-4 text-xs text-ink-400">
            Thresholds are organization settings and can be changed under Settings → Thresholds.
          </p>
        </Card>
      </div>

      <Card title="Recent fairness runs" className="mt-6">
        {fairnessRuns.isLoading ? (
          <LoadingState />
        ) : (fairnessRuns.data?.length ?? 0) === 0 ? (
          <EmptyState title="No fairness runs yet" description="Run your first counterfactual test." />
        ) : (
          <Table
            head={
              <>
                <Th>Reference</Th>
                <Th>Model</Th>
                <Th>Result</Th>
                <Th>Risk score</Th>
                <Th>When</Th>
              </>
            }
          >
            {fairnessRuns.data?.map((run) => (
              <tr key={run.id} className="table-row">
                <Td>
                  <Link to={`/test-runs/${run.id}`} className="font-medium underline">
                    {run.reference}
                  </Link>
                </Td>
                <Td>{run.model ? `${run.model.name} v${run.model.version}` : '—'}</Td>
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
    </>
  );
};
