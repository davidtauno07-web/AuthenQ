import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, ResultBadge, Select, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { Dataset, Model, MonitoringSchedule, TestRun, TestType } from '@/lib/types';

export const MonitoringPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [modelId, setModelId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [testType, setTestType] = useState<TestType>('FULL_ASSESSMENT');
  const [frequency, setFrequency] = useState('WEEKLY');
  const schedules = useQuery({ queryKey: ['monitoring'], queryFn: () => apiRequest<MonitoringSchedule[]>('/monitoring/schedules') });
  const models = useQuery({ queryKey: ['models'], queryFn: () => apiRequest<Model[]>('/models') });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => apiRequest<Dataset[]>('/datasets') });
  const create = useMutation({
    mutationFn: () => apiRequest<MonitoringSchedule>('/monitoring/schedules', { method: 'POST', body: { name, modelId: modelId || null, datasetId: datasetId || null, testType, frequency } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['monitoring'] }); setOpen(false); notify('Monitoring schedule created', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiRequest(`/monitoring/schedules/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['monitoring'] }),
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const run = useMutation({
    mutationFn: (id: string) => apiRequest<TestRun>(`/monitoring/schedules/${id}/run`, { method: 'POST' }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['monitoring'] }); notify('Scheduled test queued', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  return <>
    <PageHeader title="Monitoring" description="Schedule regular privacy and fairness checks, then inspect outcome changes over time." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>New schedule</Button>} />
    <Card title="Schedules">
      {schedules.isLoading ? <LoadingState /> : schedules.isError ? <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} /> : !schedules.data?.length ? <EmptyState title="No monitoring schedules" /> :
        <Table head={<><Th>Name</Th><Th>Scope</Th><Th>Frequency</Th><Th>Next run</Th><Th>Last result</Th><Th>Status</Th><Th>Actions</Th></>}>
          {schedules.data.map((item) => <tr key={item.id} className="table-row">
            <Td className="font-medium">{item.name}</Td><Td>{item.testType}<p className="text-xs text-ink-500">{item.model?.name ?? '—'} · {item.dataset?.name ?? '—'}</p></Td>
            <Td>{item.frequency}</Td><Td>{formatDateTime(item.nextRun)}</Td><Td><ResultBadge result={item.lastResult} /></Td>
            <Td><StatusBadge status={item.enabled ? 'ACTIVE' : 'PAUSED'} /></Td>
            <Td>{hasRole('ANALYST') && <div className="flex gap-2"><Button variant="secondary" loading={run.isPending} onClick={() => run.mutate(item.id)}>Run now</Button><Button variant="ghost" onClick={() => update.mutate({ id: item.id, enabled: !item.enabled })}>{item.enabled ? 'Pause' : 'Resume'}</Button></div>}</Td>
          </tr>)}
        </Table>}
    </Card>
    <p className="mt-4 text-sm text-ink-500">Compare historical outcomes in <Link to="/test-runs" className="underline">Test Runs</Link> and review regression warnings in <Link to="/alerts" className="underline">Alerts</Link>.</p>
    <Modal open={open} title="Create monitoring schedule" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim() || (testType !== 'PRIVACY' && !modelId) || (testType !== 'FAIRNESS' && !datasetId)} loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Test type"><Select value={testType} onChange={(event) => setTestType(event.target.value as TestType)}><option value="FULL_ASSESSMENT">Full assessment</option><option value="PRIVACY">Privacy</option><option value="FAIRNESS">Fairness</option></Select></Field>
        <Field label="Model"><Select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">No model</option>{models.data?.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field>
        <Field label="Dataset"><Select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}><option value="">No dataset</option>{datasets.data?.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</Select></Field>
        <Field label="Frequency"><Select value={frequency} onChange={(event) => setFrequency(event.target.value)}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></Select></Field>
      </div>
    </Modal>
  </>;
};
