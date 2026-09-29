import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, ResultBadge, Select, StatusBadge, Table, Td, Th } from '@/components/ui';
import type { ApiKey, Integration } from '@/lib/types';

export const IntegrationsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [kind, setKind] = useState('GITHUB');
  const [keyName, setKeyName] = useState('');
  const [plaintext, setPlaintext] = useState('');
  const integrations = useQuery({ queryKey: ['integrations'], queryFn: () => apiRequest<Integration[]>('/integrations') });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => apiRequest<ApiKey[]>('/integrations/api-keys/list'), enabled: hasRole('ORG_ADMIN') });
  const create = useMutation({
    mutationFn: () => apiRequest<Integration>('/integrations', { method: 'POST', body: { name, repository: repository || null, integrationType: kind } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['integrations'] }); setOpen(false); notify('Integration created', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const activate = useMutation({
    mutationFn: (id: string) => apiRequest(`/integrations/${id}`, { method: 'PATCH', body: { status: 'ACTIVE' } }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['integrations'] }),
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const simulate = useMutation({
    mutationFn: (id: string) => apiRequest(`/integrations/${id}/events`, { method: 'POST', body: { commit: 'demo-change' } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['integrations'] }); notify('Simulated pipeline test queued', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const createKey = useMutation({
    mutationFn: () => apiRequest<ApiKey & { apiKey: string }>('/integrations/api-keys', { method: 'POST', body: { name: keyName } }),
    onSuccess: (result) => { setPlaintext(result.apiKey); setKeyName(''); cache.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const revokeKey = useMutation({
    mutationFn: (id: string) => apiRequest(`/integrations/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (error: Error) => notify(error.message, 'error'),
  });
  return <>
    <PageHeader title="Integrations" description="Simulate CI gate events for registered models and manage organization API keys." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>Add integration</Button>} />
    <Card title="CI and model integrations">
      {integrations.isLoading ? <LoadingState /> : integrations.isError ? <ErrorState error={integrations.error} onRetry={() => integrations.refetch()} /> : !integrations.data?.length ? <EmptyState title="No integrations registered" /> :
        <Table head={<><Th>Name</Th><Th>Repository</Th><Th>Status</Th><Th>Last event</Th><Th>Last result</Th><Th>Actions</Th></>}>
          {integrations.data.map((item) => <tr key={item.id} className="table-row">
            <Td>{item.name}<p className="text-xs text-ink-500">{humanize(item.integrationType)}</p></Td><Td>{item.repository ?? '—'}</Td><Td><StatusBadge status={item.status} /></Td><Td>{formatDateTime(item.lastEventAt)}</Td><Td><ResultBadge result={item.lastResult} /></Td>
            <Td>{hasRole('ANALYST') && <div className="flex gap-2">{item.status !== 'ACTIVE' && <Button variant="secondary" onClick={() => activate.mutate(item.id)}>Activate</Button>}<Button variant="secondary" disabled={item.status !== 'ACTIVE'} loading={simulate.isPending} onClick={() => simulate.mutate(item.id)}>Simulate event</Button></div>}</Td>
          </tr>)}
        </Table>}
      <p className="mt-4 text-xs text-ink-500">Simulation requires a model and dataset configured on the integration. Configure these IDs through the integration API; inspect the result in <Link to="/test-runs" className="underline">Test Runs</Link>.</p>
    </Card>
    {hasRole('ORG_ADMIN') && <Card title="API keys" className="mt-6">
      <div className="mb-4 flex flex-wrap gap-2"><Input aria-label="New API key name" placeholder="Key name" value={keyName} onChange={(event) => setKeyName(event.target.value)} /><Button disabled={keyName.trim().length < 2} loading={createKey.isPending} onClick={() => createKey.mutate()}>Create key</Button></div>
      {plaintext && <div role="status" className="mb-4 rounded border border-state-warn p-3 text-sm">Copy this key now; it cannot be recovered: <code className="block break-all select-all font-mono">{plaintext}</code><Button variant="ghost" onClick={() => setPlaintext('')}>Dismiss</Button></div>}
      {keys.data?.length ? <Table head={<><Th>Name</Th><Th>Prefix</Th><Th>Last used</Th><Th>Created</Th><Th>Action</Th></>}>{keys.data.map((key) => <tr className="table-row" key={key.id}><Td>{key.name}</Td><Td>{key.prefix}</Td><Td>{formatDateTime(key.lastUsedAt)}</Td><Td>{formatDateTime(key.createdAt)}</Td><Td><Button variant="secondary" loading={revokeKey.isPending} onClick={() => revokeKey.mutate(key.id)}>Revoke</Button></Td></tr>)}</Table> : <EmptyState title="No API keys" />}
    </Card>}
    <Modal open={open} title="Add integration" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Save integration</Button></>}>
      <div className="space-y-4"><Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Type"><Select value={kind} onChange={(event) => setKind(event.target.value)}><option>GITHUB</option><option>GITLAB</option><option>MODEL_API</option><option>WEBHOOK</option></Select></Field><Field label="Repository"><Input value={repository} onChange={(event) => setRepository(event.target.value)} /></Field></div>
    </Modal>
  </>;
};
