import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db/prisma.js';
import { createApp } from '../src/app.js';
import { jobRunner } from '../src/workers/jobRunner.js';

describe('tenant assessment workflow', () => {
  const app = createApp();
  const organizations: string[] = [];

  afterAll(async () => {
    await jobRunner.idle();
    for (const id of organizations) {
      await prisma.organization.delete({ where: { id } });
    }
    await prisma.$disconnect();
  });

  it('scopes datasets, runs privacy and fairness, raises alerts and downloads evidence', async () => {
    const suffix = randomUUID();
    const register = async (name: string) => {
      const response = await request(app).post('/api/auth/register').send({
        name: 'Test Admin',
        email: `${name}-${suffix}@example.test`,
        password: 'unit-test-password',
        organizationName: `${name} ${suffix}`,
      });
      expect(response.status).toBe(201);
      organizations.push(response.body.organization.id);
      return response.body.token as string;
    };

    const token = await register('first');
    const secondToken = await register('second');
    const records = Array.from({ length: 120 }, (_, index) => ({
      email: `person${index}@example.test`,
      gender: index % 2 === 0 ? 'male' : 'female',
      years_experience: 6,
      annual_income: 55000,
      credit_score: 680,
      ground_truth: index % 3 === 0,
    }));
    const datasetBody = {
      name: 'Lending cohort',
      schema: [
        { name: 'email', type: 'string' },
        { name: 'gender', type: 'string' },
        { name: 'years_experience', type: 'number' },
        { name: 'annual_income', type: 'number' },
        { name: 'credit_score', type: 'number' },
        { name: 'ground_truth', type: 'boolean' },
      ],
      records,
    };
    const foreignDataset = await request(app)
      .post('/api/datasets')
      .set('Authorization', `Bearer ${secondToken}`)
      .send(datasetBody);
    expect(foreignDataset.status).toBe(201);
    const crossTenantRead = await request(app)
      .get(`/api/datasets/${foreignDataset.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(crossTenantRead.status).toBe(404);

    const dataset = await request(app)
      .post('/api/datasets')
      .set('Authorization', `Bearer ${token}`)
      .send(datasetBody);
    expect(dataset.status).toBe(201);
    const scan = await request(app)
      .post(`/api/datasets/${dataset.body.id}/scan`)
      .set('Authorization', `Bearer ${token}`);
    expect(scan.status).toBe(200);
    expect(scan.body.detections).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldName: 'email', category: 'EMAIL' })]),
    );

    const viewer = await request(app)
      .post('/api/organization/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Test Viewer',
        email: `viewer-${suffix}@example.test`,
        password: 'unit-test-password',
        role: 'VIEWER',
      });
    expect(viewer.status).toBe(201);
    const viewerSession = await request(app).post('/api/auth/login').send({
      email: `viewer-${suffix}@example.test`,
      password: 'unit-test-password',
    });
    const denied = await request(app)
      .post(`/api/datasets/${dataset.body.id}/scan`)
      .set('Authorization', `Bearer ${viewerSession.body.token}`);
    expect(denied.status).toBe(403);
    const promote = await request(app)
      .patch(`/api/organization/users/${viewer.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ANALYST' });
    expect(promote.status).toBe(200);
    const demote = await request(app)
      .patch(`/api/organization/users/${viewer.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'VIEWER' });
    expect(demote.status).toBe(200);
    const staleToken = await request(app)
      .post(`/api/datasets/${dataset.body.id}/scan`)
      .set('Authorization', `Bearer ${viewerSession.body.token}`);
    expect(staleToken.status).toBe(403);

    const model = await request(app)
      .post('/api/models')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Biased model', provider: 'MOCK', demoBehavior: 'GENDER_SENSITIVE' });
    expect(model.status).toBe(201);
    const run = await request(app)
      .post('/api/test-runs')
      .set('Authorization', `Bearer ${token}`)
      .send({
        testType: 'FULL_ASSESSMENT',
        modelId: model.body.id,
        datasetId: dataset.body.id,
        configuration: {
          sampleSize: 120,
          caseCount: 120,
          protectedAttributes: [{ name: 'gender', values: ['male', 'female'] }],
          generateReport: true,
        },
      });
    expect(run.status).toBe(202);
    await jobRunner.idle();
    const detail = await request(app)
      .get(`/api/test-runs/${run.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('COMPLETED');
    expect(detail.body.privacyTests).toHaveLength(1);
    expect(detail.body.privacyTests[0].breakdown.statisticalSimilarity).toBeGreaterThanOrEqual(0);
    expect(detail.body.fairnessTests).toHaveLength(1);
    const fairness = detail.body.fairnessTests[0];
    expect(fairness.confidenceLow).toBeLessThanOrEqual(fairness.counterfactualFlipRate);
    expect(fairness.confidenceHigh).toBeGreaterThanOrEqual(fairness.counterfactualFlipRate);
    expect(detail.body.fairnessTests[0].counterfactualCases[0].originalProfile).not.toHaveProperty('email');
    expect(detail.body.alerts.length).toBeGreaterThan(0);
    expect(detail.body.reports).toHaveLength(1);

    const activity = await request(app)
      .get('/api/dashboard/activity')
      .set('Authorization', `Bearer ${token}`);
    expect(activity.status).toBe(200);
    expect(activity.body.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metricName: expect.any(String),
        currentValue: expect.any(Number),
        threshold: expect.any(Number),
      }),
    ]));

    const evidence = await request(app)
      .get(`/api/reports/${detail.body.reports[0].id}/download`)
      .set('Authorization', `Bearer ${token}`);
    expect(evidence.status).toBe(200);
    expect(evidence.headers['content-type']).toMatch(/application\/pdf/);
    const forbiddenEvidence = await request(app)
      .get(`/api/reports/${detail.body.reports[0].id}/download`)
      .set('Authorization', `Bearer ${secondToken}`);
    expect(forbiddenEvidence.status).toBe(404);
  }, 120_000);
});
