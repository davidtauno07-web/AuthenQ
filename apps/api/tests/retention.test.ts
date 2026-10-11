import { describe, expect, it } from 'vitest';

const rep = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('source retention and deletion (database)', () => {
  it('validates policies, deletes every real copy, verifies it and blocks further Twin generation', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const fw = await import('../src/services/firewall.js');
    const retention = await import('../src/services/retention.js');
    const twin = await import('../src/services/twin.js');
    const org = await prisma.organization.findUnique({ where: { slug: 'northwind-demo' } });
    if (!org) return;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@authenq.demo' } });
    const ctx = { orgId: org.id, userId: admin.id, actorType: 'USER', actorLabel: 'test', roleKey: 'ADMIN', permissions: new Set<never>() } as never;
    const source = await fw.createSource(ctx, { name: `retention-test-${Date.now()}`, kind: 'UPLOAD' } as never);
    await fw.ingestTables(org.id, source.id, [{ name: 'people', rows: rep(30, (i) => ({ id: `P-${i}`, city: i % 2 ? 'Windhoek' : 'Swakopmund' })) }]);
    expect(await prisma.sourceRow.count({ where: { sourceId: source.id } })).toBe(30);

    await expect(retention.setRetention(ctx, source.id, { policy: 'DELETE_AFTER_DAYS', days: 0 })).rejects.toThrow(/days/);
    await retention.setRetention(ctx, source.id, { policy: 'DELETE_AFTER_DAYS', days: 30 });
    expect(await retention.enforceRetention(new Date())).toBeGreaterThanOrEqual(0);
    expect(await prisma.processingJob.count({ where: { resourceId: source.id, type: 'SOURCE_PURGE' } })).toBe(0);
    await retention.enforceRetention(new Date(Date.now() + 31 * 86_400_000));
    expect(await prisma.processingJob.count({ where: { resourceId: source.id, type: 'SOURCE_PURGE' } })).toBe(1);
    await prisma.processingJob.deleteMany({ where: { resourceId: source.id, type: 'SOURCE_PURGE' } });

    await expect(retention.requestPurge(ctx, source.id, { confirm: false, reason: 'x' })).rejects.toThrow(/Confirm/);
    await expect(retention.requestPurge(ctx, source.id, { confirm: true, reason: ' ' })).rejects.toThrow(/reason/);
    const rec = await retention.requestPurge(ctx, source.id, { confirm: true, reason: 'Retention test' });
    expect(rec.status).toBe('COMPLETED');
    const items = rec.items as { kind: string; found: number; remaining: number; verified: boolean }[];
    expect(items.find((i) => i.kind === 'DATABASE_ROWS')).toMatchObject({ found: 30, remaining: 0, verified: true });
    expect(JSON.stringify(rec)).not.toMatch(/Windhoek|Swakopmund/);
    expect(await prisma.sourceRow.count({ where: { sourceId: source.id } })).toBe(0);
    const info = await retention.getRetention(ctx, source.id);
    expect(info.purgedAt).not.toBeNull();
    expect(info.limitations.join(' ')).toMatch(/Backups/);
    await expect(retention.requestPurge(ctx, source.id, { confirm: true, reason: 'again' })).rejects.toThrow(/already/);
    await expect(fw.uploadToSource(ctx, source.id, { originalname: 'x.csv', buffer: Buffer.from('a\n1\n'), mimetype: 'text/csv' })).rejects.toThrow(/deleted/);
    expect(await fw.ingestTables(org.id, source.id, [{ name: 't', rows: [{ a: '1' }] }])).toEqual({ skipped: true });
    expect(await prisma.sourceRow.count({ where: { sourceId: source.id } })).toBe(0);
    await expect(twin.createSyntheticSet(ctx, source.id, { name: 'x' } as never)).rejects.toThrow();
    expect(await prisma.activityLog.count({ where: { resourceId: source.id, action: 'source.purged' } })).toBe(1);
  });
});
