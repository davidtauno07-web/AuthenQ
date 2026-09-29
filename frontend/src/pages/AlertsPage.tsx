import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime, formatNumber, humanize } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { AlertStatusBadge, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, Select, SeverityBadge, Table, Td, Th } from '@/components/ui';
import type { Alert, AlertStatus } from '@/lib/types';

export const AlertsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [status, setStatus] = useState('');
  const alerts = useQuery({ queryKey: ['alerts', status], queryFn: () => apiRequest<{ items: Alert[]; total: number }>(`/alerts?${status ? `status=${status}&` : ''}pageSize=100`) });
  const update = useMutation({
    mutationFn: ({ id, next }: { id: string; next: AlertStatus }) => apiRequest(`/alerts/${id}`, { method: 'PATCH', body: { status: next } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['alerts'] }); notify('Alert status updated', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  return <>
    <PageHeader title="Alerts" description="Threshold breaches and regressions are potential risks requiring human review." />
    <Card title="Findings" action={<Field label="Filter by status"><Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option>{['NEW', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'].map((item) => <option key={item}>{item}</option>)}</Select></Field>}>
      {alerts.isLoading ? <LoadingState /> : alerts.isError ? <ErrorState error={alerts.error} onRetry={() => alerts.refetch()} /> : !alerts.data?.items.length ? <EmptyState title="No alerts match this filter" /> :
        <Table head={<><Th>Severity</Th><Th>Finding</Th><Th>Measurement</Th><Th>Run</Th><Th>When</Th><Th>Status</Th></>}>
          {alerts.data.items.map((alert) => <tr key={alert.id} className="table-row">
            <Td><SeverityBadge severity={alert.severity} /></Td>
            <Td><strong>{alert.title}</strong><p className="max-w-sm text-xs text-ink-500">{alert.description}</p>{alert.recommendedAction && <p className="mt-1 text-xs">Recommendation: {alert.recommendedAction}</p>}</Td>
            <Td>{humanize(alert.metricName)}<p className="text-xs text-ink-500">{formatNumber(alert.currentValue, 4)} / {formatNumber(alert.threshold, 4)}</p></Td>
            <Td>{alert.testRun && <Link className="underline" to={`/test-runs/${alert.testRun.id}`}>{alert.testRun.reference}</Link>}</Td>
            <Td>{formatDateTime(alert.createdAt)}</Td>
            <Td><AlertStatusBadge status={alert.status} />{hasRole('ANALYST') && <Select aria-label={`Update ${alert.title}`} className="mt-2" value={alert.status} onChange={(event) => update.mutate({ id: alert.id, next: event.target.value as AlertStatus })}>{['NEW', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'].map((item) => <option key={item}>{item}</option>)}</Select>}</Td>
          </tr>)}
        </Table>}
    </Card>
    {(alerts.data?.total ?? 0) > 100 && <p className="mt-3 text-sm text-ink-500">Showing the first 100 alerts. Refine the status filter to see more.</p>}
    {update.isPending && <span className="sr-only">Updating alert</span>}
    <Link className="mt-4 inline-block text-sm underline" to="/reports">Generate compliance evidence</Link>
  </>;
};
