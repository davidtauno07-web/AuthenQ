import { Link } from 'react-router-dom';
import { PageHead, Panel } from '../components/ui';

const STAGES = [
  { n: '01', t: 'Firewall', to: '/sources', d: 'Upload files or import database tables. The Firewall discovers tables, columns, types and relationships, classifies sensitive data with an explanation, and suggests an action for each column. A human reviews undecided columns, overrides with a reason where needed, and signs off. Twin cannot run on a source that is not signed off on its latest scan.' },
  { n: '02', t: 'Twin', to: '/synthetic', d: 'Generates a complete synthetic copy from the signed-off decisions: same schema, keys remapped, relationships intact, categorical and numeric distributions preserved, free text rebuilt with entities replaced. Generation is reproducible from a seed. A safety check compares the output to real values; any reproduction places the set on hold.' },
  { n: '03', t: 'Canary', to: '/canary', d: 'Every generated value is registered with a keyed signature, its origin and generation metadata. Each send (to a labeling project or export) records exposures. Scans of text, files and exports find registered values through an index and show where each came from and who received it. A clean scan does not prove that no leak happened.' },
  { n: '04', t: 'Autonomous Labeling', to: '/projects', d: 'Sending a READY set to labeling is an explicit, confirmed step. Projects have versioned guidelines with a decision tree, an example bank, and a Gold set (example, tuning and locked-test splits) built with random, coverage, hard-case and disagreement sampling, double labeling and adjudication. The engine applies, in order: carried-over outcomes (only when explicitly enabled), deterministic rules, a model, and human review for anything below the confidence threshold. Original engine output is preserved after correction.' },
  { n: '05', t: 'Quality & Export', to: '/projects', d: 'Accuracy on the locked test split with Wilson intervals, per-label precision/recall/F1, confusion matrix, calibration, Cohen\u2019s kappa for human agreement, review and audit rates, slice performance and error clusters. Exports are packaged with manifest, schema, labels, guideline version, provenance, data card, lineage, checksums, README and safety checks, and are blocked if the quality gate is outside threshold unless an authorized override reason is recorded.' },
];

export function Help() {
  return (
    <div className="stack lg">
      <PageHead title="Help & documentation" description="How AuthenQ turns organizational data into synthetic, traceable, labeled and quality-measured datasets." />
      {STAGES.map((s) => (
        <Panel key={s.n} title={<h2><span className="mono muted">{s.n}</span> {s.t}</h2>} actions={<Link className="small" to={s.to}>Open</Link>}>
          <p>{s.d}</p>
        </Panel>
      ))}
      <Panel title="Keyboard shortcuts">
        <table>
          <tbody>
            <tr><td><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd></td><td>Command palette and search</td></tr>
            <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>Choose a label in the workspace</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>Submit and go to the next task</td></tr>
            <tr><td><kbd>J</kbd> / <kbd>K</kbd></td><td>Next / previous task</td></tr>
            <tr><td><kbd>S</kbd> · <kbd>F</kbd> · <kbd>G</kbd></td><td>Skip · flag · toggle guidelines</td></tr>
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 8 }}>Workspace shortcuts can be changed per project in its settings.</p>
      </Panel>
      <Panel title="Roles">
        <p>Admin, Project manager, Data engineer, Reviewer, Labeler and Viewer. Permissions are enforced on the server; see Settings → Members for the full permission list of each role.</p>
      </Panel>
      <Panel title="API">
        <p>Every action in the interface is available through the REST API at <code>/api/v1</code>. Create an API key with specific scopes in Settings → API keys and send it as <code>Authorization: Bearer &lt;key&gt;</code>. Webhooks deliver signed events (<code>x-authenq-signature</code>, HMAC-SHA256) with retries.</p>
      </Panel>
    </div>
  );
}
