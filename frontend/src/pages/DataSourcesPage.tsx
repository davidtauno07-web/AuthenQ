import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { DataSource } from '@/lib/types';

export const DataSourcesPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('DEMO');
  const [configuration, setConfiguration] = useState('{}');
  const [error, setError] = useState('');
  const sources = useQuery({ queryKey: ['data-sources'], queryFn: () => apiRequest<DataSource[]>('/data-sources') });
  const create = useMutation({
    mutationFn: (config: Record<string, unknown>) => apiRequest<DataSource>('/data-sources', { method: 'POST', body: { name, type, configuration: config } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['data-sources'] }); setOpen(false); setError(''); notify('Data source registered', 'success'); },
    onError: (reason: Error) => setError(reason.message),
  });
  const test = useMutation({
    mutationFn: (id: string) => apiRequest(`/data-sources/${id}/test-connection`, { method: 'POST' }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['data-sources'] }); notify('Connection check completed', 'success'); },
    onError: (reason: Error) => notify(reason.message, 'error'),
  });
  const submit = () => {
    try {
      const parsed: unknown = JSON.parse(configuration);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object.');
      setError('');
      create.mutate(parsed as Record<string, unknown>);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Invalid configuration'); }
  };
  return <>
    <PageHeader title="Data Sources" description="Configure demo, CSV, and warehouse source references. Store credential environment-variable names rather than secret values." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>Add source</Button>} />
    <Card title="Connected sources">
      {sources.isLoading ? <LoadingState /> : sources.isError ? <ErrorState error={sources.error} onRetry={() => sources.refetch()} /> : !sources.data?.length ? <EmptyState title="No data sources yet" /> :
        <Table head={<><Th>Name</Th><Th>Type</Th><Th>Datasets</Th><Th>Connection</Th><Th>Checked</Th><Th>Actions</Th></>}>
          {sources.data.map((source) => <tr key={source.id} className="table-row"><Td className="font-medium">{source.name}</Td><Td>{source.type}</Td><Td>{source._count?.datasets ?? 0}</Td><Td><StatusBadge status={source.connectionStatus} /></Td><Td>{formatDateTime(source.lastCheckedAt)}</Td><Td>{hasRole('ANALYST') && <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate(source.id)}>Test connection</Button>}</Td></tr>)}
        </Table>}
    </Card>
    <Modal open={open} title="Add data source" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim()} loading={create.isPending} onClick={submit}>Save source</Button></>}>
      <div className="space-y-4">
        <Field label="Source name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Type"><Select value={type} onChange={(event) => setType(event.target.value)}><option value="DEMO">Demo</option><option value="CSV">CSV</option><option value="WAREHOUSE">Warehouse</option><option value="POSTGRES">Postgres</option><option value="MYSQL">MySQL</option><option value="SNOWFLAKE">Snowflake</option><option value="REST_API">REST API</option></Select></Field>
        <Field label="Configuration (JSON)" hint="Do not enter credentials. Reference environment-variable names."><textarea className="input min-h-28 w-full font-mono text-xs" value={configuration} onChange={(event) => setConfiguration(event.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-state-fail">{error}</p>}
      </div>
    </Modal>
  </>;
};
