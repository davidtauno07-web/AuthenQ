import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, LoadingState, Metric, PageHeader, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { Dataset } from '@/lib/types';

export const DatasetDetailPage = () => {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const dataset = useQuery({ queryKey: ['dataset', id], queryFn: () => apiRequest<Dataset>(`/datasets/${id}`), enabled: Boolean(id) });
  const scan = useMutation({
    mutationFn: () => apiRequest(`/datasets/${id}/scan`, { method: 'POST' }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['dataset', id] }); notify('Sensitive field scan complete', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  if (dataset.isLoading) return <LoadingState />;
  if (dataset.isError) return <ErrorState error={dataset.error} onRetry={() => dataset.refetch()} />;
  const data = dataset.data;
  if (!data) return <EmptyState title="Dataset not found" />;
  return <>
    <PageHeader title={data.name} description={`v${data.version} · ${data.domain ?? 'Unclassified'} · created ${formatDateTime(data.createdAt)}`} actions={<><Link to="/datasets" className="text-sm underline">All datasets</Link>{hasRole('ANALYST') && <Button variant="secondary" loading={scan.isPending} onClick={() => scan.mutate()}>Scan sensitive fields</Button>}<Link className="rounded bg-ink-900 px-3 py-2 text-sm text-white" to="/privacy-shield">Open Privacy Shield</Link></>} />
    <div className="grid gap-4 sm:grid-cols-3">
      <Metric label="Source records" value={formatNumber(data.recordCount)} />
      <Metric label="Status" value={<StatusBadge status={data.status} />} />
      <Metric label="Sensitive fields" value={formatNumber(data.sensitiveFields?.length ?? data._count?.sensitiveFields)} />
    </div>
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <Card title="Schema">
        <Table head={<><Th>Field</Th><Th>Type</Th><Th>Description</Th></>}>
          {data.schemaJson.map((field) => <tr key={field.name} className="table-row"><Td>{field.name}</Td><Td>{field.type}</Td><Td>{field.description ?? '—'}</Td></tr>)}
        </Table>
      </Card>
      <Card title="Detected sensitive fields">
        {data.sensitiveFields?.length ? <Table head={<><Th>Field</Th><Th>Category</Th><Th>Confidence</Th></>}>
          {data.sensitiveFields.map((field) => <tr key={field.id} className="table-row"><Td>{field.fieldName}</Td><Td>{field.category}</Td><Td>{formatPercent(field.confidence)}</Td></tr>)}
        </Table> : <EmptyState title="No sensitive fields recorded" description="Run a scan to inspect the schema." />}
      </Card>
    </div>
    <Card title="Protected synthetic representations" className="mt-6">
      {data.syntheticDatasets?.length ? <Table head={<><Th>Method</Th><Th>Records</Th><Th>Similarity</Th><Th>Status</Th><Th>Created</Th></>}>
        {data.syntheticDatasets.map((item) => <tr key={item.id} className="table-row"><Td>{item.method}</Td><Td>{formatNumber(item.recordCount)}</Td><Td>{formatPercent(item.statisticalSimilarity)}</Td><Td><StatusBadge status={item.status} /></Td><Td>{formatDateTime(item.createdAt)}</Td></tr>)}
      </Table> : <EmptyState title="No protected representations yet" />}
      <p className="mt-4 text-xs text-ink-500">Prototype Privacy Simulation: synthetic records are separate from source records; no differential privacy guarantee is claimed.</p>
    </Card>
  </>;
};
