import crypto from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { env } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resetOidcCache } from '../src/modules/auth/oidc.js';

// A local OpenID Connect provider standing in for Google: discovery, JWKS, PKCE-checked token endpoint, RS256 id_tokens.
const run = Date.now().toString(36);
interface Grant { challenge: string; nonce: string; sub: string; email: string; verified: boolean; aud?: string }
const grants = new Map<string, Grant>();
let server: http.Server;
let issuer: string;
let key: KeyLike;
let app: Express;
let orgId: string;
let userId: string;
const email = `google-${run}@oidc.test`;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const mock = express();
  mock.use(express.urlencoded({ extended: false }));
  mock.get('/.well-known/openid-configuration', (_req, res) => res.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
  mock.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));
  mock.post('/token', async (req, res) => {
    const g = grants.get(req.body.code);
    if (!g || req.body.client_id !== 'mock-client' || req.body.client_secret !== 'mock-secret' || req.body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'invalid_grant' });
    const challenge = crypto.createHash('sha256').update(String(req.body.code_verifier ?? '')).digest('base64url');
    if (challenge !== g.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    grants.delete(req.body.code);
    const idToken = await new SignJWT({ nonce: g.nonce, email: g.email, email_verified: g.verified, name: 'Google Person' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer).setAudience(g.aud ?? 'mock-client').setSubject(g.sub).setIssuedAt().setExpirationTime('5m')
      .sign(key);
    return res.json({ id_token: idToken, access_token: 'unused', token_type: 'Bearer' });
  });
  await new Promise<void>((resolve) => { server = mock.listen(0, '127.0.0.1', () => resolve()); });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(env, { GOOGLE_CLIENT_ID: 'mock-client', GOOGLE_CLIENT_SECRET: 'mock-secret', GOOGLE_OIDC_ISSUER: issuer });
  resetOidcCache();
  app = createApp();
  const role = await prisma.role.findFirstOrThrow({ where: { key: 'VIEWER', orgId: null } });
  orgId = (await prisma.organization.create({ data: { name: `OIDC ${run}`, slug: `oidc-${run}` } })).id;
  userId = (await prisma.user.create({ data: { email, name: 'Google Person' } })).id;
  await prisma.organizationMember.create({ data: { orgId, userId, roleId: role.id } });
});

afterAll(async () => {
  Object.assign(env, { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined });
  server?.close();
});

async function begin(agent: ReturnType<typeof request.agent>, next = '/sources') {
  const res = await agent.get(`/api/v1/auth/google/start?next=${encodeURIComponent(next)}&role=ADMIN&orgId=${crypto.randomUUID()}`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.location as string);
  expect(`${loc.origin}${loc.pathname}`).toBe(`${issuer}/authorize`);
  expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
  expect(loc.searchParams.get('client_id')).toBe('mock-client');
  return { state: loc.searchParams.get('state')!, nonce: loc.searchParams.get('nonce')!, challenge: loc.searchParams.get('code_challenge')! };
}

function grant(p: { challenge: string; nonce: string }, over: Partial<Grant> = {}) {
  const code = crypto.randomBytes(12).toString('hex');
  grants.set(code, { challenge: p.challenge, nonce: p.nonce, sub: `sub-${run}`, email, verified: true, ...over });
  return code;
}

const errorOf = (res: request.Response) => new URL(res.headers.location as string).searchParams.get('sso_error');
const hasSession = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => c.startsWith('aq_session=') && !c.startsWith('aq_session=;'));

describe('Google OIDC sign-in', () => {
  it('reports setup required and refuses to start when credentials are absent', async () => {
    Object.assign(env, { GOOGLE_CLIENT_ID: undefined });
    const p = await request(app).get('/api/v1/auth/providers');
    expect(p.body.google.configured).toBe(false);
    expect(p.body.google.setup).toMatch(/GOOGLE_CLIENT_ID/);
    const s = await request(app).get('/api/v1/auth/google/start');
    expect(errorOf(s)).toBe('not_configured');
    Object.assign(env, { GOOGLE_CLIENT_ID: 'mock-client' });
    expect((await request(app).get('/api/v1/auth/providers')).body.google.configured).toBe(true);
  });

  it('signs in an existing member, links the identity, and never escalates role or tenant', async () => {
    const agent = request.agent(app);
    const p = await begin(agent);
    const res = await agent.get(`/api/v1/auth/google/callback?code=${grant(p)}&state=${p.state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${env.APP_URL}/sources`);
    expect(hasSession(res)).toBe(true);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.org.id).toBe(orgId);
    const memberships = await prisma.organizationMember.findMany({ where: { userId }, include: { role: true } });
    expect(memberships.map((m) => m.role.key)).toEqual(['VIEWER']);
    expect(await prisma.userIdentity.count({ where: { userId, provider: 'GOOGLE' } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { orgId, action: 'auth.login.google' } })).toBeGreaterThan(0);
  });

  it('rejects a mismatched state without creating a session', async () => {
    const agent = request.agent(app);
    const p = await begin(agent);
    const res = await agent.get(`/api/v1/auth/google/callback?code=${grant(p)}&state=forged`);
    expect(errorOf(res)).toBe('invalid_state');
    expect(hasSession(res)).toBe(false);
  });

  it('rejects a callback without the flow cookie (expired or replayed)', async () => {
    const p = await begin(request.agent(app));
    const res = await request(app).get(`/api/v1/auth/google/callback?code=${grant(p)}&state=${p.state}`);
    expect(errorOf(res)).toBe('expired');
  });

  it('rejects a reused flow after a completed callback', async () => {
    const agent = request.agent(app);
    const p = await begin(agent);
    await agent.get(`/api/v1/auth/google/callback?code=${grant(p)}&state=${p.state}`);
    const again = await agent.get(`/api/v1/auth/google/callback?code=${grant(p)}&state=${p.state}`);
    expect(errorOf(again)).toBe('expired');
  });

  it('rejects an id_token with the wrong nonce or audience', async () => {
    const a1 = request.agent(app);
    const p1 = await begin(a1);
    expect(errorOf(await a1.get(`/api/v1/auth/google/callback?code=${grant(p1, { nonce: 'other' })}&state=${p1.state}`))).toBe('invalid_token');
    const a2 = request.agent(app);
    const p2 = await begin(a2);
    expect(errorOf(await a2.get(`/api/v1/auth/google/callback?code=${grant(p2, { aud: 'someone-else' })}&state=${p2.state}`))).toBe('invalid_token');
  });

  it('fails when the PKCE verifier does not match the challenge', async () => {
    const agent = request.agent(app);
    const p = await begin(agent);
    const res = await agent.get(`/api/v1/auth/google/callback?code=${grant({ ...p, challenge: 'wrong' })}&state=${p.state}`);
    expect(errorOf(res)).toBe('provider_error');
  });

  it('does not create accounts for unknown or unverified Google emails', async () => {
    const a1 = request.agent(app);
    const p1 = await begin(a1);
    const stranger = `stranger-${run}@oidc.test`;
    expect(errorOf(await a1.get(`/api/v1/auth/google/callback?code=${grant(p1, { sub: `x-${run}`, email: stranger })}&state=${p1.state}`))).toBe('no_account');
    expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);
    const a2 = request.agent(app);
    const p2 = await begin(a2);
    expect(errorOf(await a2.get(`/api/v1/auth/google/callback?code=${grant(p2, { sub: `y-${run}`, verified: false })}&state=${p2.state}`))).toBe('email_unverified');
  });

  it('handles user cancellation and blocks open redirects', async () => {
    const agent = request.agent(app);
    await begin(agent);
    expect(errorOf(await agent.get('/api/v1/auth/google/callback?error=access_denied'))).toBe('cancelled');
    const a2 = request.agent(app);
    const p = await begin(a2, '//evil.example/steal');
    const res = await a2.get(`/api/v1/auth/google/callback?code=${grant(p)}&state=${p.state}`);
    expect(res.headers.location).toBe(`${env.APP_URL}/`);
  });
});
