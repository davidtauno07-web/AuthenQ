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
import { ModuleHub } from './pages/ModuleHub';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div style={{ padding: 40 }}><Loading /></div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return children;
}

function RequirePerm({ perm, children }: { perm: string; children: JSX.Element }) {
  const { can } = useAuth();
  if (!can(perm)) {
    return (
      <div className="empty" role="alert">
        <h3>You do not have access to this area</h3>
        <p>Your role does not include the permission required for this page. Ask an administrator if you need access.</p>
      </div>
    );
  }
  return children;
}

const guard = (perm: string, el: JSX.Element) => <RequirePerm perm={perm}>{el}</RequirePerm>;

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
        <Route path="sources" element={guard('sources.read', <Sources />)} />
        <Route path="sources/:id" element={guard('sources.read', <SourceDetail />)} />
        <Route path="synthetic" element={guard('synthetic.read', <SyntheticSets />)} />
        <Route path="synthetic/:id" element={guard('synthetic.read', <SyntheticDetail />)} />
        <Route path="canary" element={guard('canary.read', <Canary />)} />
        <Route path="canary/values/:id" element={guard('canary.read', <CanaryValue />)} />
        <Route path="projects" element={guard('labeling.read', <Projects />)} />
        <Route path="workspace" element={guard('labeling.label', <ModuleHub module="workspace" />)} />
        <Route path="gold" element={guard('quality.read', <ModuleHub module="gold" />)} />
        <Route path="quality" element={guard('quality.read', <ModuleHub module="quality" />)} />
        <Route path="exports" element={guard('exports.read', <ModuleHub module="exports" />)} />
        <Route path="projects/new" element={guard('labeling.manage', <NewProject />)} />
        <Route path="projects/:projectId" element={guard('labeling.read', <ProjectLayout />)}>
          <Route index element={<ProjectOverview />} />
          <Route path="guidelines" element={<ProjectGuidelines />} />
          <Route path="workspace" element={<Workspace />} />
          <Route path="gold" element={<Gold />} />
          <Route path="engine" element={<Engine />} />
          <Route path="review" element={<Review />} />
          <Route path="quality" element={<Quality />} />
          <Route path="exports" element={<Exports />} />
        </Route>
        <Route path="activity" element={guard('activity.read', <Activity />)} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings/*" element={<Settings />} />
        <Route path="help" element={<Help />} />
        <Route path="*" element={<div className="empty"><h3>Page not found</h3><p>The page you opened does not exist. Use the navigation on the left.</p></div>} />
      </Route>
    </Routes>
  );
}
