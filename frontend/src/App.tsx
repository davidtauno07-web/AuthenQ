import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactElement } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { AppShell } from '@/components/AppShell';
import { LoadingState } from '@/components/ui';
const LoginPage = lazy(() => import('@/pages/LoginPage').then(({ LoginPage }) => ({ default: LoginPage })));
const RegisterPage = lazy(() => import('@/pages/RegisterPage').then(({ RegisterPage }) => ({ default: RegisterPage })));
const OverviewPage = lazy(() => import('@/pages/OverviewPage').then(({ OverviewPage }) => ({ default: OverviewPage })));
const PrivacyShieldPage = lazy(() => import('@/pages/PrivacyShieldPage').then(({ PrivacyShieldPage }) => ({ default: PrivacyShieldPage })));
const FairnessSwordPage = lazy(() => import('@/pages/FairnessSwordPage').then(({ FairnessSwordPage }) => ({ default: FairnessSwordPage })));
const TestRunsPage = lazy(() => import('@/pages/TestRunsPage').then(({ TestRunsPage }) => ({ default: TestRunsPage })));
const TestRunDetailPage = lazy(() => import('@/pages/TestRunDetailPage').then(({ TestRunDetailPage }) => ({ default: TestRunDetailPage })));
const ModelsPage = lazy(() => import('@/pages/ModelsPage').then(({ ModelsPage }) => ({ default: ModelsPage })));
const DatasetsPage = lazy(() => import('@/pages/DatasetsPage').then(({ DatasetsPage }) => ({ default: DatasetsPage })));
const DatasetDetailPage = lazy(() => import('@/pages/DatasetDetailPage').then(({ DatasetDetailPage }) => ({ default: DatasetDetailPage })));
const DataSourcesPage = lazy(() => import('@/pages/DataSourcesPage').then(({ DataSourcesPage }) => ({ default: DataSourcesPage })));
const MonitoringPage = lazy(() => import('@/pages/MonitoringPage').then(({ MonitoringPage }) => ({ default: MonitoringPage })));
const AlertsPage = lazy(() => import('@/pages/AlertsPage').then(({ AlertsPage }) => ({ default: AlertsPage })));
const ReportsPage = lazy(() => import('@/pages/ReportsPage').then(({ ReportsPage }) => ({ default: ReportsPage })));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then(({ IntegrationsPage }) => ({ default: IntegrationsPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })));
const DocsPage = lazy(() => import('@/pages/DocsPage').then(({ DocsPage }) => ({ default: DocsPage })));

const RequireAuth = ({ children }: { children: ReactElement }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-10">
        <LoadingState label="Restoring session" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
};

export const App = () => (
  <Suspense fallback={<LoadingState label="Loading workspace" />}>
    <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route
      element={
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      }
    >
      <Route index element={<OverviewPage />} />
      <Route path="/privacy-shield" element={<PrivacyShieldPage />} />
      <Route path="/fairness-sword" element={<FairnessSwordPage />} />
      <Route path="/test-runs" element={<TestRunsPage />} />
      <Route path="/test-runs/:id" element={<TestRunDetailPage />} />
      <Route path="/models" element={<ModelsPage />} />
      <Route path="/datasets" element={<DatasetsPage />} />
      <Route path="/datasets/:id" element={<DatasetDetailPage />} />
      <Route path="/data-sources" element={<DataSourcesPage />} />
      <Route path="/monitoring" element={<MonitoringPage />} />
      <Route path="/alerts" element={<AlertsPage />} />
      <Route path="/reports" element={<ReportsPage />} />
      <Route path="/integrations" element={<IntegrationsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/docs" element={<DocsPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </Suspense>
);
