import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Select, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { Model } from '@/lib/types';

export const ModelsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0');
  const [provider, setProvider] = useState('MOCK');
  const [endpoint, setEndpoint] = useState('');
  const models = useQuery({ queryKey: ['models'], queryFn: () => apiRequest<Model[]>('/models') });
  const create = useMutation({
    mutationFn: () => apiRequest<Model>('/models', {
      method: 'POST',
      body: { name, version, provider, ...(provider === 'REST' ? { endpoint } : {}), isDemo: provider === 'MOCK' },
    }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['models'] }); setOpen(false); setName(''); notify('Model registered', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const health = useMutation({
    mutationFn: (id: string) => apiRequest(`/models/${id}/health`, { method: 'POST' }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['models'] }); notify('Health check completed', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  return <>
    <PageHeader title="Models" description="Register mock or external model adapters for repeated counterfactual testing." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>Register model</Button>} />
    <Card title="Model registry">
      {models.isLoading ? <LoadingState /> : models.isError ? <ErrorState error={models.error} onRetry={() => models.refetch()} /> : !models.data?.length ? <EmptyState title="No models registered" /> :
        <Table head={<><Th>Name</Th><Th>Provider</Th><Th>Environment</Th><Th>Status</Th><Th>Runs</Th><Th>Registered</Th><Th>Actions</Th></>}>
          {models.data.map((model) => <tr key={model.id} className="table-row">
            <Td><strong>{model.name}</strong><p className="text-xs text-ink-500">v{model.version} · {model.owner ?? 'No owner'}</p></Td>
            <Td>{humanize(model.provider)}{model.isDemo && <p className="text-xs text-ink-400">Demo adapter</p>}</Td>
            <Td>{humanize(model.environment)}</Td><Td><StatusBadge status={model.status} /></Td>
            <Td>{model._count?.testRuns ?? 0}</Td><Td>{formatDateTime(model.createdAt)}</Td>
            <Td>{hasRole('ANALYST') && <Button variant="secondary" loading={health.isPending} onClick={() => health.mutate(model.id)}>Check health</Button>}</Td>
          </tr>)}
        </Table>}
    </Card>
    <Modal open={open} onClose={() => setOpen(false)} title="Register model" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim() || (provider === 'REST' && !endpoint.trim())} loading={create.isPending} onClick={() => create.mutate()}>Register</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Version"><Input value={version} onChange={(event) => setVersion(event.target.value)} /></Field>
        <Field label="Provider"><Select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="MOCK">Mock (demo)</option><option value="REST">REST</option><option value="INTERNAL">Internal</option><option value="SANDBOX">Sandbox</option></Select></Field>
        {provider === 'REST' && <Field label="HTTPS endpoint"><Input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></Field>}
      </div>
    </Modal>
  </>;
};
