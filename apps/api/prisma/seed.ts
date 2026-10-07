/**
 * Deterministic demo seed: the Support Tickets acceptance workflow end to end
 * (Firewall → Twin → Canary → Labeling → Gold → Engine → Review → Quality → Export).
 * Run with `npm run db:seed`. Set SEED_RESET=1 to wipe and reseed an existing database.
 */
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/crypto.js';
import { createRng } from '../src/lib/prng.js';
import { loadPermissions } from '../src/middleware/auth.js';
import { ensureSystemData } from '../src/modules/bootstrap.js';
import type { RequestContext } from '../src/modules/context.js';
import { DEMO_DECISION_TREE, DEMO_GUIDELINE, DEMO_LABELS, DEMO_RULES, demoTruthForText, generateDemoDataset } from '../src/domain/demoData.js';
import * as firewall from '../src/services/firewall.js';
import * as twin from '../src/services/twin.js';
import * as labeling from '../src/services/labeling.js';
import * as engine from '../src/services/engine.js';
import * as exportsSvc from '../src/services/exports.js';
import { scanText } from '../src/services/canary.js';
import { qualityReport } from '../src/services/quality.js';
import { drainJobs } from '../src/worker/handlers.js';

const DEMO_SLUG = 'northwind-demo';
const USERS = [
  { key: 'admin', email: 'admin@authenq.demo', name: 'Ada Admin', role: 'ADMIN' },
  { key: 'pm', email: 'pm@authenq.demo', name: 'Paula Manager', role: 'PROJECT_MANAGER' },
  { key: 'engineer', email: 'engineer@authenq.demo', name: 'Erik Engineer', role: 'DATA_ENGINEER' },
  { key: 'reviewer', email: 'reviewer@authenq.demo', name: 'Rita Reviewer', role: 'REVIEWER' },
  { key: 'labeler', email: 'labeler@authenq.demo', name: 'Liam Labeler', role: 'LABELER' },
  { key: 'labeler2', email: 'labeler2@authenq.demo', name: 'Lena Labeler', role: 'LABELER' },
  { key: 'viewer', email: 'viewer@authenq.demo', name: 'Victor Viewer', role: 'VIEWER' },
] as const;

const LABEL_DESCRIPTIONS: Record<string, string> = {
  Billing: 'Charges, invoices, refunds for a charge, payment amounts.',
  'Technical Issue': 'Errors, crashes, slowness, sync or export failures.',
  'Account Access': 'Login, password, two-factor, locked accounts, ownership.',
  Shipping: 'Delivery status, tracking, wrong address, damaged parcels.',
  Cancellation: 'Ending a subscription, contract, renewal or order; deletion.',
  'Feature Request': 'Suggestions for new capabilities.',
};

const log = (msg: string) => console.warn(`[seed] ${msg}`);

async function reset() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  // TRUNCATE does not fire the row-level append-only trigger on activity_log; this is a full database reset.
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
}

async function main() {
  const existing = await prisma.organization.findUnique({ where: { slug: DEMO_SLUG } });
  if (existing && process.env.SEED_RESET !== '1') {
    log('Demo organization already exists. Set SEED_RESET=1 to wipe and reseed.');
    return;
  }
  if (existing || process.env.SEED_RESET === '1') {
    log('Resetting database…');
    await reset();
  }
  await ensureSystemData();

  const org = await prisma.organization.create({ data: { name: 'Northwind Support (Demo)', slug: DEMO_SLUG } });
  await prisma.billingAccount.create({ data: { orgId: org.id } });
  const passwordHash = await hashPassword(env.DEMO_PASSWORD);
  const users: Record<string, { id: string; name: string }> = {};
  for (const u of USERS) {
    const role = await prisma.role.findFirstOrThrow({ where: { key: u.role, orgId: null } });
    const user = await prisma.user.create({ data: { email: u.email, name: u.name, passwordHash, emailVerifiedAt: new Date() } });
    await prisma.organizationMember.create({ data: { orgId: org.id, userId: user.id, roleId: role.id } });
    users[u.key] = user;
  }
  const ctxFor = async (key: string): Promise<RequestContext> => {
    const u = USERS.find((x) => x.key === key)!;
    return { orgId: org.id, userId: users[key]!.id, actorType: 'USER', actorLabel: u.name, roleKey: u.role, permissions: await loadPermissions(u.role, org.id) };
  };
  const admin = await ctxFor('admin');
  const eng = await ctxFor('engineer');
  const pm = await ctxFor('pm');
  const reviewer = await ctxFor('reviewer');
  const labelerA = await ctxFor('labeler');
  const labelerB = await ctxFor('labeler2');

  // ── Firewall ──
  log('Firewall: ingesting 300 customers and 800 tickets…');
  const data = generateDemoDataset();
  const source = await firewall.createSource(eng, { name: 'Support Tickets', description: 'CRM export of customers and their support tickets (demo data standing in for real records).', kind: 'DEMO' });
  await firewall.ingestTables(org.id, source.id, [
    { name: 'customers', rows: data.customers },
    { name: 'tickets', rows: data.tickets },
  ]);
  await prisma.dataSource.update({ where: { id: source.id }, data: { status: 'DRAFT' } });
  await firewall.startScan(eng, source.id);
  await drainJobs();
  const cols = await prisma.sourceColumn.findMany({ where: { sourceId: source.id }, include: { table: true } });
  for (const c of cols) {
    if (c.classification === 'NEEDS_DECISION') {
      const decision = (c.decision ?? 'KEEP') as firewall.Decision;
      await firewall.decideColumn(eng, c.id, { decision, reason: c.name === 'legacy_category' ? 'Historic outcome field; kept so it can be carried over as an engine hint.' : 'Reviewed: accepted the Firewall suggestion.' });
    }
  }
  const rels = await prisma.sourceRelation.findMany({ where: { sourceId: source.id } });
  for (const r of rels) await firewall.confirmRelation(eng, r.id, true);
  await firewall.signOff(admin, source.id);
  log(`Firewall: ${cols.length} columns classified, ${rels.length} relationship(s) confirmed, signed off.`);

  // ── Twin ──
  log('Twin: generating synthetic copy…');
  const created = await twin.createSyntheticSet(eng, source.id, { name: 'Support Tickets — synthetic v1', seed: 42, multiplier: 1 });
  await drainJobs();
  const set = await prisma.syntheticSet.findUniqueOrThrow({ where: { id: (created as { id: string }).id } });
  if (set.status !== 'READY') throw new Error(`Synthetic set ended in status ${set.status}; the demo seed expects READY.`);
  log(`Twin: ${set.rowCount} synthetic rows, ${set.canaryCount} Canary values registered.`);

  // ── Send to labeling ──
  const project = await labeling.sendToLabeling(pm, {
    setId: set.id,
    tableName: 'tickets',
    name: 'Support ticket intent',
    description: 'Classify synthetic support tickets by primary customer intent to train a routing model.',
    purpose: 'Train an in-house ticket routing classifier without exposing customer data.',
    labels: DEMO_LABELS.map((l, i) => ({ value: l, description: LABEL_DESCRIPTIONS[l]!, shortcut: String(i + 1) })),
    textFields: ['subject', 'body'],
    contextFields: ['channel', 'priority'],
    sliceField: 'channel',
    carryOverField: 'legacy_category',
    confirm: true,
  });
  for (const k of ['reviewer', 'labeler', 'labeler2'] as const) await labeling.addMember(pm, project.id, users[k]!.id, k === 'reviewer' ? 'REVIEWER' : 'LABELER');
  await labeling.createGuidelineVersion(pm, project.id, { content: DEMO_GUIDELINE, changeNote: 'Full guidelines with decision rules and edge cases', decisionTree: DEMO_DECISION_TREE, publish: true });
  await labeling.updateProject(pm, project.id, { config: { rules: DEMO_RULES } });

  const p = await prisma.labelProject.findUniqueOrThrow({ where: { id: project.id } });
  const allTasks = await prisma.task.findMany({ where: { projectId: p.id }, orderBy: { ordinal: 'asc' }, include: { syntheticRow: true } });
  const truthOf = (t: (typeof allTasks)[number]) => demoTruthForText(labeling.taskText(p, t.syntheticRow.data as Record<string, unknown>)) ?? 'Technical Issue';
  const rng = createRng(2026);
  const noisy = (truth: string, rate: number) => (rng.next() < rate ? DEMO_LABELS[rng.int(0, DEMO_LABELS.length - 1)]! : truth);

  // 40 curated examples (from synthetic text only).
  for (const t of allTasks.slice(0, 40)) {
    await labeling.addExample(pm, p.id, { text: labeling.taskText(p, t.syntheticRow.data as Record<string, unknown>), label: truthOf(t), explanation: 'Curated example from the guideline workshop.' });
  }

  // ── Gold ──
  log('Gold: sampling and double-labeling…');
  await labeling.sampleGold(pm, p.id, { strategy: 'COVERAGE', count: 60, split: 'LOCKED_TEST', requiredLabels: 2 });
  await labeling.sampleGold(pm, p.id, { strategy: 'RANDOM', count: 30, split: 'TUNING', requiredLabels: 1 });
  const gold = await prisma.goldRecord.findMany({ where: { projectId: p.id }, include: { task: { include: { syntheticRow: true } } } });
  for (const g of gold) {
    const truth = truthOf(g.task as (typeof allTasks)[number]);
    await labeling.submitLabel(labelerA, p.id, { taskId: g.taskId, label: noisy(truth, 0.04), durationMs: 9000 + rng.int(0, 15000) });
    if (g.requiredLabels > 1) await labeling.submitLabel(labelerB, p.id, { taskId: g.taskId, label: noisy(truth, 0.06), durationMs: 9000 + rng.int(0, 15000) });
  }
  const disputes = await prisma.goldRecord.findMany({ where: { projectId: p.id, status: 'NEEDS_ADJUDICATION' }, include: { task: { include: { syntheticRow: true } } } });
  for (const d of disputes) await labeling.adjudicate(reviewer, p.id, d.id, truthOf(d.task as (typeof allTasks)[number]), 'Resolved against guideline decision rules.');
  // Single-labeled gold that disagreed with the truth stays final as labeled (human truth), as in real projects.
  await labeling.lockGold(pm, p.id, true);
  log(`Gold: ${gold.length} records, ${disputes.length} adjudicated, locked.`);

  // ── Human labeling of a first batch ──
  const goldIds = new Set(gold.map((g) => g.taskId));
  const work = allTasks.filter((t) => !goldIds.has(t.id)).slice(40, 200);
  for (const [i, t] of work.entries()) await labeling.submitLabel(i % 2 ? labelerB : labelerA, p.id, { taskId: t.id, label: noisy(truthOf(t), 0.03), durationMs: 7000 + rng.int(0, 20000) });
  log(`Workspace: ${work.length} tasks labeled by two labelers.`);

  // ── Engine ──
  log('Engine: demo run on remaining tasks…');
  await engine.startRun(pm, p.id, { scope: 'ALL_UNLABELED', engineType: 'DEMO' });
  await drainJobs();

  // ── Review (leave a few pending so the queue is visible) ──
  const pending = await engine.reviewQueue(reviewer, p.id, 'review', 1000, 0);
  const toReview = pending.items.slice(0, Math.max(0, pending.items.length - 12));
  for (const it of toReview) {
    const truth = demoTruthForText(it.text) ?? it.predicted;
    if (truth === it.predicted) await engine.reviewItem(reviewer, p.id, it.id, { action: 'accept' });
    else await engine.reviewItem(reviewer, p.id, it.id, { action: 'correct', label: truth, note: 'Corrected per guideline.', addToExamples: rng.next() < 0.3 });
  }
  const auditSample = await engine.reviewQueue(reviewer, p.id, 'audit', 100, 0);
  for (const it of auditSample.items) {
    const truth = demoTruthForText(it.text) ?? it.predicted;
    await engine.reviewItem(reviewer, p.id, it.id, truth === it.predicted ? { action: 'accept' } : { action: 'correct', label: truth, note: 'Audit correction.' });
  }
  log(`Review: ${toReview.length} reviewed, ${pending.items.length - toReview.length} left pending, ${auditSample.items.length} audited.`);

  // ── Quality + export ──
  const report = await qualityReport(pm, p.id);
  const overrideReason = report.gate.ready ? undefined : 'Demo export: remaining review items are excluded edge cases; recorded for the acceptance walkthrough.';
  await exportsSvc.createExport(pm, p.id, { format: 'JSONL', includeSplits: ['TRAIN', 'VALIDATION'], overrideReason });
  await drainJobs();
  const exp = await prisma.export.findFirstOrThrow({ where: { projectId: p.id } });
  log(`Quality: accuracy ${report.evaluation?.accuracy?.toFixed(3) ?? 'n/a'}, gate ${report.gate.ready ? 'within thresholds' : 'overridden'}. Export v${exp.version}: ${exp.status}, ${exp.recordCount} records.`);

  // ── Canary scans: one simulated leak, one clean ──
  const leaked = await prisma.canaryRegistry.findMany({ where: { setId: set.id, entityType: { in: ['EMAIL', 'PHONE'] } }, take: 2, orderBy: { createdAt: 'asc' } });
  await scanText(eng, { inputName: 'vendor-forum-post.txt', inputType: 'TEXT', text: `Found this in a public forum thread:\n"Contact ${leaked.map((l) => l.value).join(' or ')} for the dataset."` });
  await scanText(eng, { inputName: 'quarterly-report.txt', inputType: 'TEXT', text: 'Quarterly support volume rose 12% with most tickets about billing and shipping.' });
  log('Canary: one simulated leak alert and one clean scan recorded.');

  console.warn('\nDemo accounts (password from DEMO_PASSWORD in .env):');
  for (const u of USERS) console.warn(`  ${u.role.padEnd(16)} ${u.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
