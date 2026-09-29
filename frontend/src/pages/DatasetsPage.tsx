import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { DataSource, Dataset, SchemaField } from '@/lib/types';

export const DatasetsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [dataSourceId, setDataSourceId] = useState('');
  const [recordsText, setRecordsText] = useState('[{"email":"demo@example.test","age":34,"gender":"woman","approved":true}]');
  const [error, setError] = useState('');
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => apiRequest<Dataset[]>('/datasets') });
  const sources = useQuery({ queryKey: ['data-sources'], queryFn: () => apiRequest<DataSource[]>('/data-sources') });
  const create = useMutation({
    mutationFn: (input: { schema: SchemaField[]; records: Record<string, unknown>[] }) =>
      apiRequest<Dataset>('/datasets', { method: 'POST', body: { name, domain: domain || null, dataSourceId: dataSourceId || null, ...input } }),
    onSuccess: (dataset) => { cache.invalidateQueries({ queryKey: ['datasets'] }); setOpen(false); setError(''); notify('Dataset registered', 'success'); navigate(`/datasets/${dataset.id}`); },
    onError: (reason: Error) => setError(reason.message),
  });
  const submit = () => {
    try {
      const parsed: unknown = JSON.parse(recordsText);
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
        throw new Error('Provide a nonempty JSON array of record objects.');
      }
      const records = parsed as Record<string, unknown>[];
      const first = records[0];
      if (!first) throw new Error('At least one record is required.');
      const schema: SchemaField[] = Object.entries(first).map(([field, value]) => ({
        name: field, type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
      }));
      if (records.some((row) => Object.keys(row).some((key) => !schema.some((field) => field.name === key)))) {
        throw new Error('All records must use fields declared in the first record.');
      }
      setError('');
      create.mutate({ schema, records });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Invalid JSON');
    }
  };
  return <>
    <PageHeader title="Datasets" description="Register schema and fictional test records, inspect sensitive fields, and create protected synthetic representations." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>Register dataset</Button>} />
    <Card title="Registered datasets">
      {datasets.isLoading ? <LoadingState /> : datasets.isError ? <ErrorState error={datasets.error} onRetry={() => datasets.refetch()} /> : !datasets.data?.length ? <EmptyState title="No datasets registered" /> :
        <Table head={<><Th>Name</Th><Th>Source</Th><Th>Records</Th><Th>Sensitive fields</Th><Th>Status</Th><Th>Created</Th></>}>
          {datasets.data.map((dataset) => <tr key={dataset.id} className="table-row">
            <Td><Link className="font-medium underline" to={`/datasets/${dataset.id}`}>{dataset.name}</Link><p className="text-xs text-ink-400">v{dataset.version} · {dataset.domain ?? 'Unclassified'}</p></Td>
            <Td>{dataset.dataSource?.name ?? 'Manual'}</Td><Td>{formatNumber(dataset.recordCount)}</Td>
            <Td>{dataset._count?.sensitiveFields ?? dataset.sensitiveFields?.length ?? '—'}</Td><Td><StatusBadge status={dataset.status} /></Td><Td>{formatDateTime(dataset.createdAt)}</Td>
          </tr>)}
        </Table>}
    </Card>
    <Modal open={open} onClose={() => setOpen(false)} title="Register dataset" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim() || !recordsText.trim()} loading={create.isPending} onClick={submit}>Register dataset</Button></>}>
      <div className="space-y-4">
        <Field label="Dataset name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Domain"><Input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="e.g. lending" /></Field>
        <Field label="Data source"><Select value={dataSourceId} onChange={(event) => setDataSourceId(event.target.value)}><option value="">Manual input</option>{sources.data?.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</Select></Field>
        <Field label="Records (JSON array)" hint="The first record defines the schema. Use fictional data only.">
          <textarea className="input min-h-40 w-full font-mono text-xs" value={recordsText} onChange={(event) => setRecordsText(event.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-state-fail">{error}</p>}
      </div>
    </Modal>
  </>;
};
