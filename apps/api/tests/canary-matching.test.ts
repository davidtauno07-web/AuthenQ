import { describe, expect, it } from 'vitest';
import { classifyFuzzy, extractFuzzy, fuzzyKey } from '../src/domain/canary.js';

describe('canary approximate matching keys', () => {
  it('builds fuzzy keys per entity type', () => {
    expect(fuzzyKey('264811234567', 'PHONE')).toBe('d:1234567');
    expect(fuzzyKey('avery.quill.412@example.com', 'EMAIL')).toBe('e:avery.quill.412');
    expect(fuzzyKey('avery quill', 'PERSON_NAME')).toBe('n:avery quill');
    expect(fuzzyKey('quill avery', 'PERSON_NAME')).toBe('n:avery quill');
    expect(fuzzyKey('123', 'PHONE')).toBeNull();
  });

  it('extracts reformatted phones, reordered names and other-domain emails from text', () => {
    const keys = extractFuzzy('Call 0811 234 567 or write to avery.quill.412@other.org — signed, Quill Avery');
    expect(keys.has('d:1234567')).toBe(true);
    expect(keys.has('e:avery.quill.412')).toBe(true);
    expect(keys.has('n:avery quill')).toBe(true);
    expect(classifyFuzzy('d:1234567').matchType).toBe('APPROXIMATE');
    expect(classifyFuzzy('e:x').matchType).toBe('HEURISTIC');
  });
});

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('canary scan match types and investigation (database)', () => {
  it('distinguishes exact, normalized and approximate matches and requires notes to close alerts', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const canary = await import('../src/services/canary.js');
    const org = await prisma.organization.findUnique({ where: { slug: 'northwind-demo' } });
    if (!org) return;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@authenq.demo' } });
    const ctx = { orgId: org.id, userId: admin.id, actorType: 'USER', actorLabel: 'test', roleKey: 'ADMIN', permissions: new Set<never>() } as never;
    const phone = await prisma.canaryRegistry.findFirstOrThrow({ where: { orgId: org.id, entityType: 'PHONE', fuzzyKey: { not: null } } });
    const email = await prisma.canaryRegistry.findFirstOrThrow({ where: { orgId: org.id, entityType: 'EMAIL', fuzzyKey: { not: null } } });

    const exact = await canary.scanText(ctx, { text: `contact: ${email.value}`, inputName: 'exact', inputType: 'TEXT' });
    expect(exact.verdict).toBe('FOUND');
    expect(exact.matches.find((m) => m.registryId === email.id)?.matchType).toBe('EXACT');

    const upper = await canary.scanText(ctx, { text: `contact: ${email.value.toUpperCase()}`, inputName: 'normalized', inputType: 'TEXT' });
    expect(upper.matches.find((m) => m.registryId === email.id)?.matchType).toBe('NORMALIZED');

    const tail = phone.normalized.slice(-7);
    const approx = await canary.scanText(ctx, { text: `ring 099 ${tail.slice(0, 3)} ${tail.slice(3)}`, inputName: 'approx', inputType: 'TEXT' });
    const hit = approx.matches.find((m) => m.registryId === phone.id);
    expect(hit?.matchType).toBe('APPROXIMATE');
    expect(hit!.confidence).toBeLessThan(0.9);
    expect(approx.limitations.join(' ')).toMatch(/Exposure history/);

    const none = await canary.scanText(ctx, { text: 'nothing registered here at all', inputName: 'clean', inputType: 'TEXT' });
    expect(none.verdict).toBe('NOT_FOUND');

    const alert = await prisma.leakAlert.findFirstOrThrow({ where: { scanId: approx.scanId, registryId: phone.id } });
    await expect(canary.updateAlert(ctx, alert.id, { status: 'RESOLVED' })).rejects.toThrow(/note/);
    await expect(canary.updateAlert(ctx, alert.id, { assignedToId: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(/active members/);
    await canary.updateAlert(ctx, alert.id, { status: 'INVESTIGATING', assignedToId: admin.id, note: 'Checking with vendor' });
    const closed = await canary.updateAlert(ctx, alert.id, { status: 'FALSE_POSITIVE' });
    expect(closed.note).toMatch(/Checking with vendor/);
    expect(closed.resolvedById).toBe(admin.id);
    const filtered = await canary.listAlerts(ctx, undefined, { matchType: 'APPROXIMATE', q: 'approx' });
    expect(filtered.some((a) => a.id === alert.id)).toBe(true);
  });
});
