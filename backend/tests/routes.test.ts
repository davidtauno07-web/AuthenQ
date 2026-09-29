import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('public and protected API routes', () => {
  const app = createApp();

  it('responds to health checks and rejects unauthenticated tenant access', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const datasets = await request(app).get('/api/datasets');
    expect(datasets.status).toBe(401);
    const alerts = await request(app).get('/api/alerts');
    expect(alerts.status).toBe(401);
  });

  it('rejects invalid registration and invalid bearer tokens', async () => {
    const invalid = await request(app).post('/api/auth/register').send({
      name: 'A',
      email: 'invalid',
      password: 'short',
    });
    expect(invalid.status).toBe(400);
    const unauthorizedJoin = await request(app).post('/api/auth/register').send({
      name: 'Intruder', email: 'intruder@example.test', password: 'password123',
      organizationName: 'Unauthorized', organizationId: '00000000-0000-0000-0000-000000000001',
    });
    expect(unauthorizedJoin.status).toBe(400);
    const protectedResponse = await request(app).get('/api/test-runs').set('Authorization', 'Bearer invalid');
    expect(protectedResponse.status).toBe(401);
  });
});
