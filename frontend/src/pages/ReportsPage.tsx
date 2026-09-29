import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, downloadFile } from '@/lib/api';
import { formatBytes, formatDateTime, humanize } from '@/lib/format';
import { useAuth } from '@/auth/AuthContext';
import { useToast } from '@/components/ToastProvider';
import { Button, Card, EmptyState, ErrorState, Field, LoadingState, Modal, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import type { Report, TestRun } from '@/lib/types';

export const ReportsPage = () => {
  const { hasRole } = useAuth();
  const { notify } = useToast();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState('PDF');
  const [reportType, setReportType] = useState('MODEL_RISK_ASSESSMENT');
  const [testRunId, setTestRunId] = useState('');
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => apiRequest<Report[]>('/reports') });
  const runs = useQuery({ queryKey: ['test-runs', 'completed'], queryFn: () => apiRequest<TestRun[]>('/test-runs?status=COMPLETED&limit=100') });
  const generate = useMutation({
    mutationFn: () => apiRequest<Report>('/reports', { method: 'POST', body: { format, reportType, testRunId: testRunId || null } }),
    onSuccess: () => { cache.invalidateQueries({ queryKey: ['reports'] }); setOpen(false); notify('Compliance Evidence Report created', 'success'); },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  return <>
    <PageHeader title="Reports" description="Generate downloadable Compliance Evidence Reports and AI Risk Assessments for human review. Reports are evidence, not certifications or legal conclusions." actions={hasRole('ANALYST') && <Button onClick={() => setOpen(true)}>Generate report</Button>} />
    <Card title="Report library">
      {reports.isLoading ? <LoadingState /> : reports.isError ? <ErrorState error={reports.error} onRetry={() => reports.refetch()} /> : !reports.data?.length ? <EmptyState title="No reports generated yet" /> :
        <Table head={<><Th>Title</Th><Th>Type</Th><Th>Format</Th><Th>Size</Th><Th>Generated</Th><Th>Download</Th></>}>
          {reports.data.map((report) => <tr key={report.id} className="table-row">
            <Td className="font-medium">{report.title}</Td><Td>{humanize(report.reportType)}</Td><Td>{report.format}</Td><Td>{formatBytes(report.fileSize)}</Td><Td>{formatDateTime(report.createdAt)}</Td>
            <Td><Button variant="secondary" onClick={() => downloadFile(`/reports/${report.id}/download`, `authenq-${report.id}.${report.format.toLowerCase()}`).catch((error: Error) => notify(error.message, 'error'))}>Download</Button></Td>
          </tr>)}
        </Table>}
    </Card>
    <Modal title="Generate Compliance Evidence Report" open={open} onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={generate.isPending} onClick={() => generate.mutate()}>Generate</Button></>}>
      <div className="space-y-4">
        <Field label="Report type"><Select value={reportType} onChange={(event) => setReportType(event.target.value)}>{['MODEL_RISK_ASSESSMENT', 'PRIVACY_ASSESSMENT', 'FAIRNESS_ASSESSMENT', 'CONTINUOUS_MONITORING', 'EXECUTIVE_SUMMARY'].map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</Select></Field>
        <Field label="Format"><Select value={format} onChange={(event) => setFormat(event.target.value)}><option>PDF</option><option>JSON</option><option>CSV</option></Select></Field>
        <Field label="Scope"><Select value={testRunId} onChange={(event) => setTestRunId(event.target.value)}><option value="">Completed runs from the last 30 days</option>{runs.data?.map((run) => <option key={run.id} value={run.id}>{run.reference} · {humanize(run.testType)}</option>)}</Select></Field>
        <p className="text-xs text-ink-500">The report records methods, measurements and thresholds. Findings need qualified human review.</p>
      </div>
    </Modal>
  </>;
};
