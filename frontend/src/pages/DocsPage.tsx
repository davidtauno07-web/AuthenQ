import { Link } from 'react-router-dom';
import { Card, PageHeader } from '@/components/ui';

export const DocsPage = () => <>
  <PageHeader title="Documentation" description="How AuthenQ measures potential privacy leakage and group outcome disparities." />
  <div className="grid gap-4 lg:grid-cols-2">
    <Card title="Start an assessment"><ol className="list-inside list-decimal space-y-2 text-sm text-ink-600">
      <li><Link className="underline" to="/datasets">Register a fictional dataset</Link> and scan for sensitive fields.</li>
      <li><Link className="underline" to="/models">Register a model</Link> or select a seeded mock adapter.</li>
      <li>Run a full assessment from <Link className="underline" to="/">Overview</Link>, or test each engine separately.</li>
      <li>Track stages in <Link className="underline" to="/test-runs">Test Runs</Link>, investigate <Link className="underline" to="/alerts">Alerts</Link> and download <Link className="underline" to="/reports">Reports</Link>.</li>
    </ol></Card>
    <Card title="Privacy Shield"><p className="text-sm text-ink-600">Prototype Privacy Simulation detects sensitive fields, separates source data from protected synthetic representations, generates adversarial linkage cases and scores potential re-identification risks. It does not provide a differential privacy guarantee.</p></Card>
    <Card title="Fairness Sword"><p className="text-sm text-ink-600">A provider adapter scores a baseline and counterfactual variant that differ in a protected attribute. The engine stores flip rates, selection-rate disparities, demographic parity and equal opportunity differences, confidence intervals and sample-size warnings. Low sample sizes or unknown ground truth can limit interpretation.</p></Card>
    <Card title="Monitoring and CI"><p className="text-sm text-ink-600">Schedules run checks at configured intervals. Simulated pipeline events can queue a full assessment; results and regression alerts are retained for review. Configured thresholds can be edited under <Link to="/settings" className="underline">Settings</Link>.</p></Card>
    <Card title="Compliance evidence"><p className="text-sm text-ink-600">PDF, JSON and CSV outputs record methodology, measurements and threshold decisions. These are evidence for review and do not constitute certification, legal advice, or guaranteed fairness or privacy.</p></Card>
  </div>
</>;
