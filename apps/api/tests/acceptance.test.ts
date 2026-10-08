/**
 * Acceptance workflow from the master brief, verified against the seeded demo organization
 * (`npm run db:seed`): 300 customers / 800 tickets → Firewall → Twin → Canary → labeling →
 * gold → engine → review → quality → export → Canary scan → activity log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const DEMO_SLUG = 'northwind-demo';
let app: Express;
let agent: ReturnType<typeof request.agent>;
let orgId = '';
let projectId = '';
let seeded = false;

beforeAll(async () => {
  app = createApp();
  const org = await prisma.organization.findUnique({ where: { slug: DEMO_SLUG } });
  seeded = !!org && !!process.env.DEMO_PASSWORD;
  if (!seeded) return;
  orgId = org!.id;
  agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email: 'admin@authenq.demo', password: process.env.DEMO_PASSWORD });
  expect(res.status).toBe(200);
  projectId = (await prisma.labelProject.findFirstOrThrow({ where: { orgId } })).id;
});

afterAll(() => prisma.$disconnect());

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('acceptance: Support Tickets demo', () => {
  it('is seeded (run `npm run db:seed` first)', () => {
    expect(seeded).toBe(true);
  });

  it('Firewall: 300 customers and 800 tickets, classified and signed off', async () => {
    const source = await prisma.dataSource.findFirstOrThrow({ where: { orgId }, include: { tables: true } });
    const counts = Object.fromEntries(source.tables.map((t) => [t.name, t.rowCount]));
    expect(counts).toMatchObject({ customers: 300, tickets: 800 });
    expect(source.status).toBe('SIGNED_OFF');
    const sensitive = await prisma.sourceColumn.count({ where: { sourceId: source.id, classification: 'SENSITIVE' } });
    const outcome = await prisma.sourceColumn.count({ where: { sourceId: source.id, classification: 'OUTCOME' } });
    expect(sensitive).toBeGreaterThan(0);
    expect(outcome).toBeGreaterThan(0);
  });

  it('Twin + Canary: synthetic set is ready, safe and registered', async () => {
    const set = await prisma.syntheticSet.findFirstOrThrow({ where: { orgId } });
    expect(set.status).toBe('READY');
    expect(set.safetyPassed).toBe(true);
    expect(set.rowCount).toBe(1100);
    expect(await prisma.canaryRegistry.count({ where: { setId: set.id } })).toBeGreaterThan(1000);
    expect(await prisma.send.count({ where: { setId: set.id, recipientType: 'LABELING_PROJECT' } })).toBeGreaterThan(0);
  });

  it('labelers only ever see synthetic rows', async () => {
    const r = await agent.get(`/api/v1/projects/${projectId}/tasks?limit=200`);
    expect(r.status).toBe(200);
    const realEmails = (await prisma.sourceRow.findMany({ where: { orgId }, take: 300 }))
      .map((row) => (row.data as Record<string, unknown>).email)
      .filter((e): e is string => typeof e === 'string');
    const blob = JSON.stringify(r.body).toLowerCase();
    expect(realEmails.length).toBeGreaterThan(0);
    for (const e of realEmails) expect(blob).not.toContain(e.toLowerCase());
  });

  it('labeling: guidelines, 40+ examples, gold locked', async () => {
    const p = await prisma.labelProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(p.activeGuidelineVersionId).toBeTruthy();
    expect(p.goldLockedAt).toBeTruthy();
    expect(await prisma.exampleBank.count({ where: { projectId } })).toBeGreaterThanOrEqual(40);
    expect(await prisma.goldRecord.count({ where: { projectId, split: 'LOCKED_TEST', status: 'FINAL' } })).toBeGreaterThan(0);
  });

  it('engine: completed run routes items to auto-accept and review, keeping engine output', async () => {
    const run = await prisma.engineRun.findFirstOrThrow({ where: { projectId, status: 'COMPLETED' } });
    const auto = await prisma.engineItem.count({ where: { runId: run.id, routing: 'AUTO_ACCEPT' } });
    const review = await prisma.engineItem.count({ where: { runId: run.id, routing: 'REVIEW' } });
    expect(auto).toBeGreaterThan(0);
    expect(review).toBeGreaterThan(0);
    const item = await prisma.engineItem.findFirstOrThrow({ where: { runId: run.id } });
    expect(item.predicted).toBeTruthy();
    expect(item.rationale).toBeTruthy();
    expect(item.guidelineVersionId).toBeTruthy();
  });

  it('quality: report uses neutral wording and Wilson intervals', async () => {
    const r = await agent.get(`/api/v1/projects/${projectId}/quality`);
    expect(r.status).toBe(200);
    expect(r.body.evaluation.n).toBeGreaterThan(0);
    expect(r.body.evaluation.interval.low).toBeLessThanOrEqual(r.body.evaluation.accuracy);
    for (const c of r.body.gate.checks) expect(['within threshold', 'outside threshold']).toContain(c.wording);
    expect(['within human agreement level', 'outside human agreement level']).toContain(r.body.evaluation.agreementWording);
  });

  it('export: completed package with no real sensitive values', async () => {
    const exp = await prisma.export.findFirstOrThrow({ where: { projectId, status: 'COMPLETED' } });
    const safety = exp.safety as { passed: boolean; realValueMatches: number; realValuesChecked: number };
    expect(safety.passed).toBe(true);
    expect(safety.realValueMatches).toBe(0);
    expect(safety.realValuesChecked).toBeGreaterThan(0);
    expect(exp.recordCount).toBeGreaterThan(0);
    const dl = await agent.post(`/api/v1/projects/${projectId}/exports/${exp.id}/download`).set('x-csrf-token', csrfOf());
    expect(dl.status).toBe(200);
    expect(dl.body.url).toBeTruthy();
  });

  it('Canary: leak alert from a simulated leak, and activity is logged', async () => {
    expect(await prisma.leakAlert.count({ where: { orgId } })).toBeGreaterThan(0);
    expect(await prisma.canaryScan.count({ where: { orgId } })).toBeGreaterThanOrEqual(2);
    const actions = new Set((await prisma.activityLog.findMany({ where: { orgId }, select: { action: true } })).map((a) => a.action));
    expect(actions.size).toBeGreaterThan(10);
  });
});

function csrfOf(): string {
  const jar = (agent as unknown as { jar: { getCookie: (n: string, o: unknown) => { value: string } | undefined } }).jar;
  return jar.getCookie('aq_csrf', { domain: '127.0.0.1', path: '/', secure: false, script: false })?.value ?? '';
}
