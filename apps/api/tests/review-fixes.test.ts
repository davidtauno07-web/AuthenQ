import { afterAll, describe, expect, it } from 'vitest';
import { detectTextEntities } from '../src/domain/firewall.js';
import { replaceValue } from '../src/domain/twin.js';
import { createRng } from '../src/lib/prng.js';
import { assertOutboundHost, isPrivateAddress } from '../src/lib/net.js';
import { prisma } from '../src/lib/prisma.js';
import { firewallGate, parseUpload } from '../src/services/firewall.js';
import { getProjectOrThrow, listProjects } from '../src/services/labeling.js';
import type { RequestContext } from '../src/modules/context.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('upload parsing', () => {
  it('keeps both columns when headers normalize to the same name', async () => {
    const [t] = await parseUpload('people.csv', Buffer.from('Customer ID,customer-id\n1,2\n'));
    expect(t!.rows[0]).toEqual({ customer_id: '1', customer_id_2: '2' });
  });
});

describe('outbound target policy', () => {
  it('classifies private, loopback and link-local addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('rejects public names that resolve to private addresses', async () => {
    await expect(assertOutboundHost('hooks.example.com', 'Webhook URLs', { block: true, resolve: async () => ['93.184.216.34', '10.0.0.5'] })).rejects.toThrow(/private/);
    await expect(assertOutboundHost('169.254.169.254', 'Webhook URLs', { block: true })).rejects.toThrow(/private/);
    await expect(assertOutboundHost('hooks.example.com', 'Webhook URLs', { block: true, resolve: async () => ['93.184.216.34'] })).resolves.toBeUndefined();
  });
});

describe('credential handling', () => {
  it('detects credential-like values in free text and Twin replaces them', () => {
    const found = detectTextEntities('My password: Hunter22x and key sk_live_abcdEFGH1234 please').SECRET ?? [];
    expect(found).toEqual(expect.arrayContaining(['Hunter22x', 'sk_live_abcdEFGH1234']));
    expect(replaceValue('SECRET', 'Hunter22x', createRng(1))).toMatch(/^\[redacted-secret-\d{6}\]$/);
  });
  it('blocks sign-off when a non-text sensitive column is set to Scrub text', () => {
    const gate = firewallGate({ status: 'NEEDS_REVIEW', currentScanId: 'x', tables: [{ name: 'users', columns: [{ name: 'api_token', classification: 'SENSITIVE', decision: 'SCRUB_TEXT', decisionSource: 'HUMAN', entityType: 'CREDENTIAL' }] }] });
    expect(gate.ready).toBe(false);
  });
});

describe('project membership for API keys', () => {
  it('denies labeler/reviewer API keys access to projects', async () => {
    const project = await prisma.labelProject.findFirst({ where: { deletedAt: null } });
    if (!project) return;
    const ctx: RequestContext = { orgId: project.orgId, userId: null, actorType: 'API_KEY', actorLabel: 'test key', roleKey: 'LABELER', permissions: new Set(['labeling.read', 'labeling.label']) };
    await expect(getProjectOrThrow(ctx, project.id)).rejects.toThrow();
    expect(await listProjects(ctx)).toEqual([]);
  });
});
