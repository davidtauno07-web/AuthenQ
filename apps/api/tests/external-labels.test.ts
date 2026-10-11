import { describe, expect, it } from 'vitest';
import { readZip } from '../src/lib/zip.js';

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('external labeling export and import (database)', () => {
  it('exports synthetic records without the locked test set and validates imported labels', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const XL = await import('../src/services/externalLabels.js');
    const org = await prisma.organization.findUnique({ where: { slug: 'northwind-demo' } });
    if (!org) return;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@authenq.demo' } });
    const ctx = { orgId: org.id, userId: admin.id, actorType: 'USER', actorLabel: 'test', roleKey: 'ADMIN', permissions: new Set<never>() } as never;
    const project = await prisma.labelProject.findFirstOrThrow({ where: { orgId: org.id } });
    const labels = (project.labelSchema as { labels: { value: string }[] }).labels.map((l) => l.value);

    const out = await XL.externalExport(ctx, project.id, { format: 'jsonl', onlyUnlabeled: false, recipient: 'Test vendor' });
    const files = readZip(out.zip);
    expect(files.map((f) => f.name).sort()).toEqual(['README.md', 'data.jsonl', 'manifest.json']);
    const rows = files.find((f) => f.name === 'data.jsonl')!.data.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>);
    const locked = await prisma.goldRecord.findMany({ where: { projectId: project.id, split: 'LOCKED_TEST' }, select: { taskId: true } });
    const exported = new Set(rows.map((r) => r.authenq_task_id));
    expect(locked.every((g) => !exported.has(g.taskId))).toBe(true);
    const send = await prisma.send.findUniqueOrThrow({ where: { id: out.sendId }, include: { _count: { select: { exposures: true } } } });
    expect(send.recipientType).toBe('EXTERNAL_TOOL');
    expect(send._count.exposures).toBeGreaterThan(0);

    const open = await prisma.task.findMany({ where: { projectId: project.id, status: { in: ['OPEN', 'SKIPPED', 'FLAGGED', 'IN_REVIEW'] }, finalSource: null, gold: { is: null } }, take: 2 });
    expect(open).toHaveLength(2);
    const labeled = await prisma.task.findFirstOrThrow({ where: { projectId: project.id, status: 'LABELED', finalSource: 'HUMAN', gold: { is: null } } });
    const current = (labeled.finalLabels as { label: string }).label;
    const other = labels.find((l) => l !== current)!;
    const csv = [
      'authenq_task_id,label,note',
      `${open[0]!.id},${labels[0]!.toUpperCase()},case-insensitive`,
      `${open[0]!.id},${labels[0]},dup`,
      `${open[1]!.id},not-a-label,`,
      `00000000-0000-0000-0000-000000000000,${labels[0]},`,
      `${labeled.id},${other},`,
      ...(locked[0] ? [`${locked[0].taskId},${labels[0]},`] : []),
    ].join('\n');
    const dry = await XL.importExternalLabels(ctx, project.id, { content: csv, filename: 'labels.csv', dryRun: true });
    expect(dry.valid).toBe(2);
    expect(dry.conflicts).toHaveLength(1);
    expect(dry.errors.map((e) => e.problem).join(' ')).toMatch(/more than once.*not a label.*No record/s);
    if (locked[0]) expect(dry.errors.some((e) => /Locked test/.test(e.problem))).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: open[0]!.id } })).finalSource).toBeNull();

    await expect(XL.importExternalLabels(ctx, project.id, { content: csv, filename: 'labels.csv', dryRun: false })).rejects.toThrow(/problems/);
    const done = await XL.importExternalLabels(ctx, project.id, { content: csv, filename: 'labels.csv', dryRun: false, acceptErrors: true });
    expect(done.imported).toBe(2);
    const t0 = await prisma.task.findUniqueOrThrow({ where: { id: open[0]!.id } });
    expect(t0.finalSource).toBe('EXTERNAL_IMPORT');
    expect((t0.finalLabels as { label: string }).label).toBe(labels[0]);
    const conflicted = await prisma.task.findUniqueOrThrow({ where: { id: labeled.id } });
    expect(conflicted.status).toBe('FLAGGED');
    expect((conflicted.finalLabels as { label: string }).label).toBe(current);
    await expect(XL.importExternalLabels(ctx, project.id, { content: '{bad', filename: 'x.json', dryRun: true })).rejects.toThrow(/could not be read/);
  });
});
