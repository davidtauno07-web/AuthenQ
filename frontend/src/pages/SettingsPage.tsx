import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, ErrorState, Field, Input, LoadingState, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import type { AuditEntry, OrgSettings, Organization, User } from '@/lib/types';

export const SettingsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const settings = useQuery({ queryKey: ['organization', 'settings'], queryFn: () => apiRequest<OrgSettings>('/organization/settings') });
  const organization = useQuery({ queryKey: ['organization'], queryFn: () => apiRequest<Organization>('/organization') });
  const users = useQuery({ queryKey: ['organization', 'users'], queryFn: () => apiRequest<User[]>('/organization/users') });
  const audit = useQuery({ queryKey: ['organization', 'audit'], queryFn: () => apiRequest<{ items: AuditEntry[] }>('/organization/audit?pageSize=15') });
  useEffect(() => { if (settings.data && !draft) setDraft(settings.data); }, [settings.data, draft]);
  const save = useMutation({
    mutationFn: () => apiRequest<OrgSettings>('/organization/settings', { method: 'PUT', body: draft }),
    onSuccess: (result) => { setDraft(result); cache.invalidateQueries({ queryKey: ['organization', 'settings'] }); notify('Settings saved', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const numberField = (label: string, key: keyof OrgSettings['thresholds'], step: string, max: number) => <Field label={label}><Input type="number" step={step} min={0} max={max} disabled={!hasRole('ORG_ADMIN')} value={draft?.thresholds[key] ?? ''} onChange={(event) => setDraft((current) => current && ({ ...current, thresholds: { ...current.thresholds, [key]: Number(event.target.value) } }))} /></Field>;
  return <>
    <PageHeader title="Settings" description={`Organization policy, testing defaults, notifications and access for ${organization.data?.name ?? 'your organization'}.`} actions={hasRole('ORG_ADMIN') && <Button disabled={!draft} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>} />
    {settings.isLoading ? <LoadingState /> : settings.isError ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : draft && <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Thresholds"><div className="grid gap-4 sm:grid-cols-2">
          {numberField('Privacy risk score (0–100)', 'privacyRiskScore', '1', 100)}
          {numberField('Counterfactual flip rate (0–1)', 'counterfactualFlipRate', '0.01', 1)}
          {numberField('Demographic parity difference (0–1)', 'demographicParityDifference', '0.01', 1)}
          {numberField('Equal opportunity difference (0–1)', 'equalOpportunityDifference', '0.01', 1)}
          {numberField('Regression delta (0–1)', 'regressionDelta', '0.01', 1)}
        </div></Card>
        <Card title="Testing defaults"><div className="space-y-4">
          <Field label="Default test size"><Input type="number" min={50} max={50000} disabled={!hasRole('ORG_ADMIN')} value={draft.testing.defaultTestSize} onChange={(event) => setDraft({ ...draft, testing: { ...draft.testing, defaultTestSize: Number(event.target.value) } })} /></Field>
          <Field label="Protected attributes (comma-separated)"><Input disabled={!hasRole('ORG_ADMIN')} value={draft.testing.defaultProtectedAttributes.join(', ')} onChange={(event) => setDraft({ ...draft, testing: { ...draft.testing, defaultProtectedAttributes: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) } })} /></Field>
          <Field label="Default frequency"><Select disabled={!hasRole('ORG_ADMIN')} value={draft.testing.defaultFrequency} onChange={(event) => setDraft({ ...draft, testing: { ...draft.testing, defaultFrequency: event.target.value as OrgSettings['testing']['defaultFrequency'] } })}><option>DAILY</option><option>WEEKLY</option><option>MONTHLY</option><option>CUSTOM</option></Select></Field>
        </div></Card>
        <Card title="Notifications"><div className="space-y-3">
          {(['alertOnPrivacyBreach', 'alertOnFairnessBreach', 'alertOnRegression'] as const).map((key) => <label key={key} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.notifications[key]} disabled={!hasRole('ORG_ADMIN')} onChange={(event) => setDraft({ ...draft, notifications: { ...draft.notifications, [key]: event.target.checked } })} />{key.replace(/([A-Z])/g, ' $1')}</label>)}
          <Field label="Minimum severity"><Select disabled={!hasRole('ORG_ADMIN')} value={draft.notifications.minimumSeverity} onChange={(event) => setDraft({ ...draft, notifications: { ...draft.notifications, minimumSeverity: event.target.value } })}>{['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((value) => <option key={value}>{value}</option>)}</Select></Field>
        </div></Card>
        <Card title="Security and access"><p className="mb-4 text-sm text-ink-500">Access is scoped to your organization. Admins manage roles; analysts can run tests and investigate alerts; viewers can inspect results.</p>
          <Table head={<><Th>User</Th><Th>Role</Th><Th>Last login</Th></>}>{users.data?.map((user) => <tr className="table-row" key={user.id}><Td>{user.name}<p className="text-xs text-ink-500">{user.email}</p></Td><Td>{user.role}</Td><Td>{formatDateTime(user.lastLoginAt)}</Td></tr>)}</Table>
        </Card>
      </div>
      <Card title="Recent audit activity" className="mt-6">
        {audit.data?.items?.length ? <Table head={<><Th>Action</Th><Th>Resource</Th><Th>User</Th><Th>When</Th></>}>{audit.data.items.map((item) => <tr className="table-row" key={item.id}><Td>{item.action}</Td><Td>{item.resourceType ?? '—'}</Td><Td>{item.user?.name ?? 'System'}</Td><Td>{formatDateTime(item.createdAt)}</Td></tr>)}</Table> : <p className="text-sm text-ink-500">No audit events yet.</p>}
      </Card>
    </>}
  </>;
};
