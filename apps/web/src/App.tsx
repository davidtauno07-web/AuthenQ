import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AcceptInvite, ForgotPassword, Login, Register, ResetPassword, VerifyEmail } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { SourceDetail, Sources } from './pages/Sources';
import { SyntheticDetail, SyntheticSets } from './pages/Synthetic';
import { Canary, CanaryValue } from './pages/Canary';
import { NewProject, ProjectGuidelines, ProjectLayout, ProjectOverview, Projects } from './pages/Projects';
import { Workspace } from './pages/Workspace';
import { Engine, Exports, Gold, Quality, Review } from './pages/ProjectPages';
import { Activity, Jobs, Notifications } from './pages/Activity';
import { Settings } from './pages/Settings';
import { Help } from './pages/Help';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div style={{ padding: 40 }}><Loading /></div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="sources" element={<Sources />} />
        <Route path="sources/:id" element={<SourceDetail />} />
        <Route path="synthetic" element={<SyntheticSets />} />
        <Route path="synthetic/:id" element={<SyntheticDetail />} />
        <Route path="canary" element={<Canary />} />
        <Route path="canary/values/:id" element={<CanaryValue />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/new" element={<NewProject />} />
        <Route path="projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectOverview />} />
          <Route path="guidelines" element={<ProjectGuidelines />} />
          <Route path="workspace" element={<Workspace />} />
          <Route path="gold" element={<Gold />} />
          <Route path="engine" element={<Engine />} />
          <Route path="review" element={<Review />} />
          <Route path="quality" element={<Quality />} />
          <Route path="exports" element={<Exports />} />
        </Route>
        <Route path="activity" element={<Activity />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings/*" element={<Settings />} />
        <Route path="help" element={<Help />} />
        <Route path="*" element={<div className="empty"><h3>Page not found</h3><p>The page you opened does not exist. Use the navigation on the left.</p></div>} />
      </Route>
    </Routes>
  );
}
