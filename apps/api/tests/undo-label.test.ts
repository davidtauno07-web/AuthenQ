import { describe, expect, it } from 'vitest';

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('undo label (database)', () => {
  it('lets a labeler undo only their own recent, unreviewed work label', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const L = await import('../src/services/labeling.js');
    const org = await prisma.organization.findUnique({ where: { slug: 'northwind-demo' } });
    if (!org) return;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@authenq.demo' } });
    const other = await prisma.user.findFirstOrThrow({ where: { email: 'labeler@authenq.demo' } });
    const mk = (userId: string) => ({ orgId: org.id, userId, actorType: 'USER', actorLabel: 'test', roleKey: 'ADMIN', permissions: new Set<never>() }) as never;
    const project = await prisma.labelProject.findFirstOrThrow({ where: { orgId: org.id } });
    const value = (project.labelSchema as { labels: { value: string }[] }).labels[0]!.value;
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: project.id, status: { in: ['OPEN', 'IN_REVIEW', 'SKIPPED'] }, finalSource: null, gold: { is: null } } });
    await prisma.task.update({ where: { id: task.id }, data: { status: 'OPEN' } });
    const label = await L.submitLabel(mk(admin.id), project.id, { taskId: task.id, label: value });
    await expect(L.undoLabel(mk(other.id), project.id, label.id)).rejects.toThrow(/own labels/);
    const res = await L.undoLabel(mk(admin.id), project.id, label.id);
    expect(res.status).toBe('OPEN');
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.finalLabelId).toBeNull();
    expect(await prisma.label.count({ where: { id: label.id } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { orgId: org.id, action: 'label.undone', resourceId: task.id } })).toBeGreaterThan(0);
    const old = await L.submitLabel(mk(admin.id), project.id, { taskId: task.id, label: value });
    await prisma.label.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - L.UNDO_WINDOW_MS - 1000) } });
    await expect(L.undoLabel(mk(admin.id), project.id, old.id)).rejects.toThrow(/15 minutes/);
  });
});
