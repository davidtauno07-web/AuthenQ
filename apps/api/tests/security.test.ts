import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword, sha256 } from '../src/lib/crypto.js';

const run = Date.now().toString(36);
const PASSWORD = `Sec-${run}-Passphrase!9`;
let app: Express;

interface Actor { agent: ReturnType<typeof request.agent>; csrf: string; orgId: string; userId: string }

async function makeOrg(tag: string, roleKey = 'ADMIN', orgId?: string): Promise<{ orgId: string; email: string; userId: string }> {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, orgId: null } });
  const email = `${tag}-${run}@security.test`;
  const user = await prisma.user.create({ data: { email, name: `${tag} user`, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() } });
  const id = orgId ?? (await prisma.organization.create({ data: { name: `Org ${tag} ${run}`, slug: `org-${tag}-${run}` } })).id;
  await prisma.organizationMember.create({ data: { orgId: id, userId: user.id, roleId: role.id } });
  return { orgId: id, email, userId: user.id };
}

async function login(email: string, orgId: string, userId: string): Promise<Actor> {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const csrf = decodeURIComponent(cookies.find((c) => c.startsWith('aq_csrf='))!.split(';')[0]!.slice('aq_csrf='.length));
  return { agent, csrf, orgId, userId };
}

let a: Actor;
let b: Actor;
let viewer: Actor;
let sourceA: string;
const createdOrgs: string[] = [];

beforeAll(async () => {
  app = createApp();
  const oa = await makeOrg('alpha');
  const ob = await makeOrg('beta');
  const ov = await makeOrg('viewer', 'VIEWER', oa.orgId);
  createdOrgs.push(oa.orgId, ob.orgId);
  a = await login(oa.email, oa.orgId, oa.userId);
  b = await login(ob.email, ob.orgId, ob.userId);
  viewer = await login(ov.email, oa.orgId, ov.userId);
  const s = await a.agent.post('/api/v1/sources').set('x-csrf-token', a.csrf).send({ name: 'Alpha private source <script>alert(1)</script>' });
  expect(s.status).toBe(201);
  sourceA = s.body.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });
});

describe('authentication and sessions', () => {
  it('rejects unauthenticated requests', async () => {
    const r = await request(app).get('/api/v1/sources');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });
  it('rejects a forged session cookie', async () => {
    const r = await request(app).get('/api/v1/auth/me').set('cookie', 'aq_session=forged-token-value');
    expect(r.status).toBe(401);
  });
  it('locks the account after repeated failed sign-ins', async () => {
    const u = await makeOrg('lockout');
    createdOrgs.push(u.orgId);
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password-123' });
    const r = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(user.lockedUntil && user.lockedUntil > new Date()).toBe(true);
  });
  it('does not reveal whether an email exists on password reset', async () => {
    const r1 = await request(app).post('/api/v1/auth/forgot-password').send({ email: `nobody-${run}@security.test` });
    const r2 = await request(app).post('/api/v1/auth/forgot-password').send({ email: `alpha-${run}@security.test` });
    expect(r1.status).toBe(r2.status);
    expect(r1.body).toEqual(r2.body);
  });
});

describe('CSRF', () => {
  it('rejects cookie-authenticated mutations without the CSRF header', async () => {
    const r = await a.agent.post('/api/v1/sources').send({ name: 'No csrf' });
    expect(r.status).toBe(403);
  });
  it('rejects a wrong CSRF token', async () => {
    const r = await a.agent.post('/api/v1/sources').set('x-csrf-token', b.csrf).send({ name: 'Wrong csrf' });
    expect(r.status).toBe(403);
  });
});

describe('tenant isolation and IDOR', () => {
  it('hides another organization’s source from lists and direct access', async () => {
    const list = await b.agent.get('/api/v1/sources');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(sourceA);
    expect((await b.agent.get(`/api/v1/sources/${sourceA}`)).status).toBe(404);
    expect((await b.agent.post(`/api/v1/sources/${sourceA}/scan`).set('x-csrf-token', b.csrf)).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/sources/${sourceA}`).set('x-csrf-token', b.csrf).send({ confirm: 'x' })).status).toBe(404);
  });
  it('blocks cross-tenant access to demo projects, exports and canary values', async () => {
    const project = await prisma.labelProject.findFirst({ where: { orgId: { notIn: createdOrgs } } });
    if (project) {
      expect((await b.agent.get(`/api/v1/projects/${project.id}`)).status).toBe(404);
      expect((await b.agent.get(`/api/v1/projects/${project.id}/exports`)).status).toBe(404);
      expect((await b.agent.get(`/api/v1/projects/${project.id}/tasks`)).status).toBe(404);
    }
    const canary = await prisma.canaryRegistry.findFirst({ where: { orgId: { notIn: createdOrgs } } });
    if (canary) expect((await b.agent.get(`/api/v1/canary/registry/${canary.id}`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/canary/registry')).body).toEqual([]);
  });
  it('rejects malformed ids without leaking database errors', async () => {
    const r = await a.agent.get("/api/v1/sources/1' OR '1'='1");
    expect([400, 404]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|postgres|syntax/i);
  });
});

describe('server-side authorization', () => {
  it('denies a viewer write actions regardless of the UI', async () => {
    expect((await viewer.agent.post('/api/v1/sources').set('x-csrf-token', viewer.csrf).send({ name: 'Viewer source' })).status).toBe(403);
    expect((await viewer.agent.post('/api/v1/api-keys').set('x-csrf-token', viewer.csrf).send({ name: 'k', role: 'VIEWER', scopes: ['canary.scan'] })).status).toBe(403);
    expect((await viewer.agent.get(`/api/v1/sources/${sourceA}/tables/x/preview`)).status).toBe(403);
  });
});

describe('input handling', () => {
  it('stores markup as inert text and serves JSON', async () => {
    const r = await a.agent.get(`/api/v1/sources/${sourceA}`);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body.name).toBe('Alpha private source <script>alert(1)</script>');
  });
  it('rejects malformed JSON and invalid payloads with 400', async () => {
    const bad = await a.agent.post('/api/v1/sources').set('x-csrf-token', a.csrf).set('content-type', 'application/json').send('{"name": ');
    expect(bad.status).toBe(400);
    const invalid = await a.agent.post('/api/v1/sources').set('x-csrf-token', a.csrf).send({ name: 1 });
    expect(invalid.status).toBe(400);
  });
  it('ignores prototype pollution keys', async () => {
    const r = await a.agent.post('/api/v1/sources').set('x-csrf-token', a.csrf).send(JSON.parse('{"name":"Proto test","__proto__":{"polluted":true}}'));
    expect(r.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('treats search input as data, not SQL', async () => {
    const r = await a.agent.get(`/api/v1/search?q=${encodeURIComponent("'; DROP TABLE \"User\"; --")}`);
    expect(r.status).toBe(200);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });
  it('rejects unsupported upload types and filenames with shell metacharacters stay inert', async () => {
    const r = await a.agent.post(`/api/v1/sources/${sourceA}/upload`).set('x-csrf-token', a.csrf).attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), 'evil;rm -rf.sh');
    expect(r.status).toBe(400);
  });
  it('rejects uploads with no file', async () => {
    const r = await a.agent.post(`/api/v1/sources/${sourceA}/upload`).set('x-csrf-token', a.csrf);
    expect(r.status).toBe(400);
  });
});

describe('secrets', () => {
  it('shows API keys once and stores only a hash', async () => {
    const r = await a.agent.post('/api/v1/api-keys').set('x-csrf-token', a.csrf).send({ name: 'CI key', role: 'VIEWER', scopes: ['canary.scan'] });
    expect(r.status).toBe(201);
    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(stored.keyHash).not.toBe(r.body.key);
    expect(stored.keyHash).toBe(sha256(r.body.key));
    const list = await a.agent.get('/api/v1/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(r.body.key);
    const asKey = await request(app).get('/api/v1/sources').set('authorization', `Bearer ${r.body.key}`);
    expect(asKey.status).toBe(403);
  });
  it('encrypts webhook secrets and never returns them again', async () => {
    const r = await a.agent.post('/api/v1/webhooks').set('x-csrf-token', a.csrf).send({ url: 'https://hooks.example.com/aq', events: ['export.completed'] });
    expect(r.status).toBe(201);
    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(stored.secretEnc).not.toContain(r.body.secret);
    expect(JSON.stringify((await a.agent.get('/api/v1/webhooks')).body)).not.toContain(r.body.secret);
  });
  it('masks AI provider keys', async () => {
    const raw = `sk-test-${run}-abcdefghijklmnop`;
    const r = await a.agent.post('/api/v1/ai-providers').set('x-csrf-token', a.csrf).send({ provider: 'OPENAI_COMPATIBLE', name: 'Test provider', model: 'gpt-test', apiKey: raw });
    expect(r.status).toBeLessThan(300);
    expect(JSON.stringify((await a.agent.get('/api/v1/ai-providers')).body)).not.toContain(raw);
  });
});

describe('signed downloads', () => {
  it('rejects tampered or unsigned download links', async () => {
    const r = await request(app).get('/api/v1/files/signed?key=org/exports/x.zip&exp=9999999999&sig=deadbeef');
    expect(r.status).toBe(403);
  });
});

describe('audit integrity', () => {
  it('records actions and rejects updates or deletes of the activity log', async () => {
    const entry = await prisma.activityLog.findFirstOrThrow({ where: { orgId: a.orgId } });
    await expect(prisma.activityLog.update({ where: { id: entry.id }, data: { summary: 'tampered' } })).rejects.toThrow();
    await expect(prisma.activityLog.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe('invitations', () => {
  it('keeps an existing account INVITED until it accepts', async () => {
    const other = await makeOrg('invitee');
    createdOrgs.push(other.orgId);
    const res = await a.agent.post('/api/v1/members/invite').set('x-csrf-token', a.csrf).send({ email: other.email, role: 'VIEWER' });
    expect(res.status).toBe(201);
    const m = await prisma.organizationMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: a.orgId, userId: other.userId } } });
    expect(m.status).toBe('INVITED');
  });
});
