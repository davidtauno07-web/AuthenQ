import { prisma, Prisma } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { createRng, hashSeed } from '../lib/prng.js';
import { tokenize } from '../domain/engine.js';
import { audit } from '../modules/audit.js';
import { can, type RequestContext } from '../modules/context.js';
import { emit, recordUsage } from '../modules/platform/events.js';

export interface LabelDef {
  value: string;
  description: string;
  shortcut?: string;
}

export interface ProjectConfig {
  autoAcceptThreshold: number;
  passes: number;
  dropout: number;
  seed: number;
  rules: { id: string; label: string; keywords: string[]; description: string }[];
  carryOver: { enabled: boolean };
  quality: { minAccuracy: number; minLockedTest: number; maxReviewRate: number; minAuditAccuracy: number };
  auditRate: number;
  shortcuts: Record<string, string>;
}

export const DEFAULT_CONFIG: ProjectConfig = {
  autoAcceptThreshold: 0.8,
  passes: 5,
  dropout: 0.15,
  seed: 7,
  rules: [],
  carryOver: { enabled: false },
  quality: { minAccuracy: 0.85, minLockedTest: 30, maxReviewRate: 0.5, minAuditAccuracy: 0.85 },
  auditRate: 0.05,
  shortcuts: { submit: 'Enter', submitNext: 'Mod+Enter', skip: 's', flag: 'f', next: 'j', prev: 'k', review: 'r', guidelines: 'g' },
};

export function projectConfig(p: { config: unknown }): ProjectConfig {
  const c = (p.config ?? {}) as Partial<ProjectConfig>;
  return { ...DEFAULT_CONFIG, ...c, quality: { ...DEFAULT_CONFIG.quality, ...(c.quality ?? {}) }, carryOver: { ...DEFAULT_CONFIG.carryOver, ...(c.carryOver ?? {}) }, shortcuts: { ...DEFAULT_CONFIG.shortcuts, ...(c.shortcuts ?? {}) } };
}

export function labelsOf(p: { labelSchema: unknown }): LabelDef[] {
  return ((p.labelSchema as { labels?: LabelDef[] })?.labels ?? []).map((l, i) => ({ ...l, shortcut: l.shortcut ?? String(i + 1) }));
}

export function taskText(project: { textFields: string[] }, data: Record<string, unknown>) {
  return project.textFields.map((f) => String(data[f] ?? '')).filter(Boolean).join('\n\n');
}

export interface SendInput {
  setId: string;
  tableName: string;
  name: string;
  description?: string;
  purpose?: string;
  labels: LabelDef[];
  textFields: string[];
  contextFields?: string[];
  sliceField?: string | null;
  carryOverField?: string | null;
  confirm: boolean;
}

/** Explicit, user-confirmed transfer of a synthetic table into a new labeling project. */
export async function sendToLabeling(ctx: RequestContext, input: SendInput) {
  if (!input.confirm) throw badRequest('Confirm that you want to send this synthetic set to labeling.');
  const set = await prisma.syntheticSet.findFirst({ where: { id: input.setId, orgId: ctx.orgId, deletedAt: null } });
  if (!set) throw notFound('Synthetic set');
  if (set.status !== 'READY') throw badRequest(`Only ready synthetic sets can be sent to labeling (this one is ${set.status.toLowerCase().replace('_', ' ')}).`);
  if (input.labels.length < 2) throw badRequest('Define at least two labels.');
  const values = input.labels.map((l) => l.value.trim());
  if (new Set(values).size !== values.length || values.some((v) => !v)) throw badRequest('Label names must be unique and not empty.');
  const sample = await prisma.syntheticRow.findFirst({ where: { setId: set.id, tableName: input.tableName } });
  if (!sample) throw badRequest(`The synthetic set has no table named "${input.tableName}".`);
  const fields = Object.keys(sample.data as object);
  for (const f of [...input.textFields, ...(input.contextFields ?? []), ...(input.sliceField ? [input.sliceField] : []), ...(input.carryOverField ? [input.carryOverField] : [])]) {
    if (!fields.includes(f)) throw badRequest(`"${f}" is not a column of the synthetic ${input.tableName} table.`);
  }
  if (!input.textFields.length) throw badRequest('Choose at least one text field for labelers to read.');

  const rows = await prisma.syntheticRow.findMany({ where: { setId: set.id, tableName: input.tableName }, orderBy: { rowIndex: 'asc' }, select: { id: true, data: true } });
  const project = await prisma.$transaction(
    async (tx) => {
      const send = await tx.send.create({
        data: { orgId: ctx.orgId, setId: set.id, recipient: input.name, recipientType: 'LABELING_PROJECT', channel: 'AuthenQ labeling workspace', recordCount: rows.length, sentById: ctx.userId },
      });
      const project = await tx.labelProject.create({
        data: {
          orgId: ctx.orgId,
          name: input.name,
          description: input.description ?? '',
          purpose: input.purpose ?? '',
          setId: set.id,
          sendId: send.id,
          tableName: input.tableName,
          labelSchema: { type: 'single', labels: input.labels.map((l, i) => ({ ...l, shortcut: l.shortcut ?? String(i + 1) })) } as unknown as Prisma.InputJsonValue,
          textFields: input.textFields,
          contextFields: input.contextFields ?? [],
          sliceField: input.sliceField ?? null,
          carryOverField: input.carryOverField ? ({ field: input.carryOverField } as Prisma.InputJsonValue) : undefined,
          config: DEFAULT_CONFIG as unknown as Prisma.InputJsonValue,
          status: 'ACTIVE',
          createdById: ctx.userId,
        },
      });
      await tx.send.update({ where: { id: send.id }, data: { projectId: project.id } });
      for (let i = 0; i < rows.length; i += 2000) {
        await tx.task.createMany({
          data: rows.slice(i, i + 2000).map((r, k) => ({
            orgId: ctx.orgId,
            projectId: project.id,
            syntheticRowId: r.id,
            ordinal: i + k + 1,
            priority: 0.5,
            priorityReason: 'Not yet prioritized; ordered as received.',
            sliceValue: input.sliceField ? String((r.data as Record<string, unknown>)[input.sliceField] ?? '') : null,
          })),
        });
      }
      const registry = await tx.canaryRegistry.findMany({ where: { setId: set.id, tableName: input.tableName }, select: { id: true } });
      for (let i = 0; i < registry.length; i += 5000) {
        await tx.exposure.createMany({ data: registry.slice(i, i + 5000).map((r) => ({ orgId: ctx.orgId, sendId: send.id, registryId: r.id })), skipDuplicates: true });
      }
      if (ctx.userId) await tx.projectMember.create({ data: { projectId: project.id, userId: ctx.userId, role: 'PROJECT_MANAGER' } });
      const doc = await tx.guidelineDoc.create({ data: { orgId: ctx.orgId, projectId: project.id, title: `${input.name} guidelines` } });
      const v1 = await tx.guidelineVersion.create({
        data: { orgId: ctx.orgId, docId: doc.id, projectId: project.id, version: 1, content: input.labels.map((l) => `- **${l.value}** — ${l.description}`).join('\n'), status: 'PUBLISHED', changeNote: 'Initial label definitions', publishedAt: new Date(), createdById: ctx.userId },
      });
      await tx.labelProject.update({ where: { id: project.id }, data: { activeGuidelineVersionId: v1.id } });
      await audit(ctx, { action: 'labeling.sent', resourceType: 'label_project', resourceId: project.id, summary: `Sent ${rows.length} synthetic ${input.tableName} records from "${set.name}" to labeling project "${input.name}"`, details: { setId: set.id, sendId: send.id, exposures: registry.length } }, tx);
      return project;
    },
    { timeout: 120_000 },
  );
  await emit(ctx.orgId, 'labeling.sent', { projectId: project.id, setId: set.id, records: rows.length });
  await recordUsage(ctx.orgId, 'labeling.tasks', rows.length, 'label_project', project.id);
  return project;
}

/** Project-level access: org permission plus project membership for non-admin labelers/reviewers. */
export async function getProjectOrThrow(ctx: RequestContext, id: string) {
  const p = await prisma.labelProject.findFirst({ where: { id, orgId: ctx.orgId, deletedAt: null } });
  if (!p) throw notFound('Labeling project');
  if (['LABELER', 'REVIEWER'].includes(ctx.roleKey)) {
    // API keys have no user, so they never pass a project-membership check.
    if (!ctx.userId) throw notFound('Labeling project');
    const m = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId: id, userId: ctx.userId } } });
    if (!m) throw notFound('Labeling project');
  }
  return p;
}

export async function listProjects(ctx: RequestContext) {
  const where: Prisma.LabelProjectWhereInput = { orgId: ctx.orgId, deletedAt: null };
  if (['LABELER', 'REVIEWER'].includes(ctx.roleKey)) {
    if (!ctx.userId) return [];
    where.members = { some: { userId: ctx.userId } };
  }
  const projects = await prisma.labelProject.findMany({ where, orderBy: { createdAt: 'desc' } });
  const counts = await prisma.task.groupBy({ by: ['projectId', 'status'], where: { projectId: { in: projects.map((p) => p.id) } }, _count: { _all: true } });
  return projects.map((p) => {
    const c = counts.filter((x) => x.projectId === p.id);
    const total = c.reduce((a, x) => a + x._count._all, 0);
    const done = c.filter((x) => ['LABELED', 'DONE'].includes(x.status)).reduce((a, x) => a + x._count._all, 0);
    return { ...p, labels: labelsOf(p), counts: Object.fromEntries(c.map((x) => [x.status, x._count._all])), total, done };
  });
}

export async function projectDetail(ctx: RequestContext, id: string) {
  const p = await getProjectOrThrow(ctx, id);
  const [counts, guideline, members, examples, gold, runs, set] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where: { projectId: id }, _count: { _all: true } }),
    p.activeGuidelineVersionId ? prisma.guidelineVersion.findUnique({ where: { id: p.activeGuidelineVersionId } }) : null,
    prisma.projectMember.findMany({ where: { projectId: id } }),
    prisma.exampleBank.count({ where: { projectId: id } }),
    prisma.goldRecord.groupBy({ by: ['split', 'status'], where: { projectId: id }, _count: { _all: true } }),
    prisma.engineRun.findMany({ where: { projectId: id }, orderBy: { runNumber: 'desc' }, take: 10 }),
    prisma.syntheticSet.findUnique({ where: { id: p.setId }, select: { id: true, name: true, version: true } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: members.map((m) => m.userId) } }, select: { id: true, name: true, email: true } });
  return {
    ...p,
    labels: labelsOf(p),
    configResolved: projectConfig(p),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    guideline,
    members: members.map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) })),
    exampleCount: examples,
    gold: gold.map((g) => ({ split: g.split, status: g.status, count: g._count._all })),
    runs,
    set,
  };
}

export async function updateProject(ctx: RequestContext, id: string, input: { name?: string; description?: string; purpose?: string; labels?: LabelDef[]; config?: Partial<ProjectConfig>; status?: string }) {
  const p = await getProjectOrThrow(ctx, id);
  const data: Prisma.LabelProjectUpdateInput = {};
  if (input.name) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.purpose !== undefined) data.purpose = input.purpose;
  if (input.status) data.status = input.status;
  if (input.labels) {
    const existing = labelsOf(p).map((l) => l.value);
    const next = input.labels.map((l) => l.value);
    const removed = existing.filter((v) => !next.includes(v));
    if (removed.length) {
      const used = await prisma.label.count({ where: { projectId: id, OR: removed.map((r) => ({ values: { path: ['label'], equals: r } })) } });
      if (used) throw conflict(`Labels already in use cannot be removed (${removed.join(', ')}). Rename them in a new guideline version instead.`);
    }
    data.labelSchema = { type: 'single', labels: input.labels } as unknown as Prisma.InputJsonValue;
  }
  if (input.config) {
    const merged = { ...projectConfig(p), ...input.config, quality: { ...projectConfig(p).quality, ...(input.config.quality ?? {}) } };
    if (merged.autoAcceptThreshold < 0.5 || merged.autoAcceptThreshold > 1) throw badRequest('The auto-accept threshold must be between 0.5 and 1.');
    if (merged.passes < 1 || merged.passes > 15) throw badRequest('Passes must be between 1 and 15.');
    data.config = merged as unknown as Prisma.InputJsonValue;
  }
  const updated = await prisma.labelProject.update({ where: { id }, data });
  await audit(ctx, { action: 'labeling.project_updated', resourceType: 'label_project', resourceId: id, summary: `Updated project settings for "${updated.name}"`, before: { config: p.config, labels: p.labelSchema }, after: { config: updated.config, labels: updated.labelSchema } });
  return updated;
}

export async function addMember(ctx: RequestContext, projectId: string, userId: string, role: string) {
  await getProjectOrThrow(ctx, projectId);
  const member = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } } });
  if (!member) throw notFound('Member');
  const m = await prisma.projectMember.upsert({ where: { projectId_userId: { projectId, userId } }, create: { projectId, userId, role }, update: { role } });
  await audit(ctx, { action: 'labeling.member_added', resourceType: 'label_project', resourceId: projectId, summary: `Added a ${role.toLowerCase()} to the project` });
  return m;
}

// ── Guidelines & examples ─────────────────────────────────────────────────────
export async function listGuidelineVersions(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.guidelineVersion.findMany({ where: { projectId }, orderBy: { version: 'desc' } });
}

export async function createGuidelineVersion(ctx: RequestContext, projectId: string, input: { content: string; changeNote: string; decisionTree?: unknown; publish: boolean }) {
  const p = await getProjectOrThrow(ctx, projectId);
  const doc = await prisma.guidelineDoc.findFirst({ where: { projectId } });
  if (!doc) throw notFound('Guideline document');
  const last = await prisma.guidelineVersion.findFirst({ where: { docId: doc.id }, orderBy: { version: 'desc' } });
  const v = await prisma.$transaction(async (tx) => {
    if (input.publish) await tx.guidelineVersion.updateMany({ where: { docId: doc.id, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } });
    const v = await tx.guidelineVersion.create({
      data: {
        orgId: ctx.orgId,
        docId: doc.id,
        projectId,
        version: (last?.version ?? 0) + 1,
        content: input.content,
        decisionTree: input.decisionTree === undefined ? undefined : (input.decisionTree as Prisma.InputJsonValue),
        status: input.publish ? 'PUBLISHED' : 'DRAFT',
        changeNote: input.changeNote,
        publishedAt: input.publish ? new Date() : null,
        createdById: ctx.userId,
      },
    });
    if (input.publish) await tx.labelProject.update({ where: { id: projectId }, data: { activeGuidelineVersionId: v.id } });
    await audit(ctx, { action: input.publish ? 'guideline.published' : 'guideline.drafted', resourceType: 'guideline_version', resourceId: v.id, summary: `${input.publish ? 'Published' : 'Drafted'} guidelines v${v.version} for "${p.name}": ${input.changeNote}` }, tx);
    return v;
  });
  return v;
}

export async function publishGuidelineVersion(ctx: RequestContext, projectId: string, versionId: string) {
  await getProjectOrThrow(ctx, projectId);
  const v = await prisma.guidelineVersion.findFirst({ where: { id: versionId, projectId } });
  if (!v) throw notFound('Guideline version');
  await prisma.$transaction([
    prisma.guidelineVersion.updateMany({ where: { docId: v.docId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } }),
    prisma.guidelineVersion.update({ where: { id: v.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } }),
    prisma.labelProject.update({ where: { id: projectId }, data: { activeGuidelineVersionId: v.id } }),
  ]);
  await audit(ctx, { action: 'guideline.published', resourceType: 'guideline_version', resourceId: v.id, summary: `Published guidelines v${v.version}` });
}

export async function listExamples(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.exampleBank.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
}

export async function addExample(ctx: RequestContext, projectId: string, input: { text: string; label: string; explanation?: string; taskId?: string }) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (!labelsOf(p).some((l) => l.value === input.label)) throw badRequest(`"${input.label}" is not a label in this project.`);
  if (input.taskId) {
    const task = await prisma.task.findFirst({ where: { id: input.taskId, projectId }, include: { gold: { select: { split: true } } } });
    if (!task) throw notFound('Task');
    if (task.gold?.split === 'LOCKED_TEST') throw badRequest('This task is in the locked test split. Locked-test records cannot become examples, because the engine must never train on them.');
  }
  const ex = await prisma.exampleBank.create({
    data: { orgId: ctx.orgId, projectId, text: input.text, labels: { label: input.label }, explanation: input.explanation ?? '', source: input.taskId ? 'REVIEW_CORRECTION' : 'MANUAL', taskId: input.taskId, createdById: ctx.userId },
  });
  await audit(ctx, { action: 'example.added', resourceType: 'example_bank', resourceId: ex.id, summary: `Added a "${input.label}" example` });
  return ex;
}

export async function deleteExample(ctx: RequestContext, projectId: string, id: string) {
  await getProjectOrThrow(ctx, projectId);
  const r = await prisma.exampleBank.deleteMany({ where: { id, projectId } });
  if (!r.count) throw notFound('Example');
  await audit(ctx, { action: 'example.deleted', resourceType: 'example_bank', resourceId: id, summary: 'Removed an example' });
}

// ── Workspace ────────────────────────────────────────────────────────────────
export interface TaskFilter {
  status?: string;
  label?: string;
  source?: string;
  slice?: string;
  q?: string;
  sort?: 'priority' | 'ordinal' | 'confidence';
  mine?: boolean;
  gold?: boolean;
  limit: number;
  offset: number;
}

export async function listTasks(ctx: RequestContext, projectId: string, f: TaskFilter) {
  const p = await getProjectOrThrow(ctx, projectId);
  const where: Prisma.TaskWhereInput = { projectId };
  if (f.status) where.status = { in: f.status.split(',') };
  if (f.slice) where.sliceValue = f.slice;
  if (f.source) where.finalSource = f.source;
  if (f.label) where.finalLabels = { path: ['label'], equals: f.label };
  if (f.gold !== undefined) where.gold = f.gold ? { isNot: null } : { is: null };
  if (f.mine && ctx.userId) where.labels = { some: { userId: ctx.userId } };
  if (f.q) {
    const or: Prisma.TaskWhereInput[] = p.textFields.map((tf) => ({ syntheticRow: { data: { path: [tf], string_contains: f.q } } }));
    or.push({ syntheticRow: { syntheticKey: { contains: f.q, mode: 'insensitive' } } });
    where.OR = or;
  }
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = f.sort === 'ordinal' ? [{ ordinal: 'asc' }] : [{ priority: 'desc' }, { ordinal: 'asc' }];
  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy,
      take: f.limit,
      skip: f.offset,
      include: {
        syntheticRow: { select: { data: true, syntheticKey: true } },
        gold: { select: { split: true, status: true } },
        engineItems: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, predicted: true, source: true, confidence: true, rationale: true, routing: true, reviewStatus: true, ruleCited: true } },
        labels: ctx.userId ? { where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 1, select: { values: true, kind: true, createdAt: true } } : false,
      },
    }),
    prisma.task.count({ where }),
  ]);
  return { tasks: tasks.map((t) => shapeTask(p, t)), total };
}

type TaskWithRelations = Prisma.TaskGetPayload<{
  include: { syntheticRow: { select: { data: true; syntheticKey: true } }; gold: { select: { split: true; status: true } }; engineItems: { select: { id: true; predicted: true; source: true; confidence: true; rationale: true; routing: true; reviewStatus: true; ruleCited: true } } };
}> & { labels?: { values: Prisma.JsonValue; kind: string; createdAt: Date }[] };

function shapeTask(p: { textFields: string[]; contextFields: string[]; config: unknown; labelSchema: unknown }, t: TaskWithRelations) {
  const data = t.syntheticRow.data as Record<string, unknown>;
  const ei = t.engineItems[0];
  // Locked-test gold tasks never show an engine suggestion, to keep evaluation independent.
  const hideSuggestion = t.gold?.split === 'LOCKED_TEST';
  return {
    id: t.id,
    ordinal: t.ordinal,
    status: t.status,
    priority: t.priority,
    priorityReason: t.priorityReason,
    sliceValue: t.sliceValue,
    key: t.syntheticRow.syntheticKey,
    text: taskText(p, data),
    fields: Object.fromEntries(p.textFields.map((f) => [f, data[f]])),
    context: Object.fromEntries(p.contextFields.map((f) => [f, data[f]])),
    finalLabels: t.finalLabels,
    finalSource: t.finalSource,
    gold: t.gold,
    suggestion: ei && !hideSuggestion ? { ...ei, label: (ei.predicted as { label?: string })?.label ?? null } : null,
    myLabel: t.labels?.[0] ?? null,
  };
}

export async function getTask(ctx: RequestContext, projectId: string, taskId: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const t = await prisma.task.findFirst({
    where: { id: taskId, projectId },
    include: {
      syntheticRow: { select: { data: true, syntheticKey: true } },
      gold: { select: { split: true, status: true } },
      engineItems: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, predicted: true, source: true, confidence: true, rationale: true, routing: true, reviewStatus: true, ruleCited: true } },
      labels: ctx.userId ? { where: { userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 1, select: { values: true, kind: true, createdAt: true } } : false,
    },
  });
  if (!t) throw notFound('Task');
  const history = await prisma.label.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' }, select: { id: true, values: true, source: true, kind: true, userId: true, createdAt: true, guidelineVersionId: true, note: true } });
  return { ...shapeTask(p, t), history, similar: await similarCases(p, taskText(p, t.syntheticRow.data as Record<string, unknown>), taskId) };
}

/** Next tasks for record mode: highest priority open tasks not yet labeled by this user. */
export async function nextTasks(ctx: RequestContext, projectId: string, count = 5, after?: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const where: Prisma.TaskWhereInput = { projectId, status: { in: ['OPEN'] }, ...(ctx.userId ? { labels: { none: { userId: ctx.userId } } } : {}) };
  if (after) where.id = { not: after };
  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ priority: 'desc' }, { ordinal: 'asc' }],
    take: Math.min(count, 20),
    include: {
      syntheticRow: { select: { data: true, syntheticKey: true } },
      gold: { select: { split: true, status: true } },
      engineItems: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, predicted: true, source: true, confidence: true, rationale: true, routing: true, reviewStatus: true, ruleCited: true } },
    },
  });
  return tasks.map((t) => shapeTask(p, t));
}

async function similarCases(p: { id: string; textFields: string[] }, text: string, excludeId: string) {
  const tokens = new Set(tokenize(text));
  if (!tokens.size) return [];
  const solved = await prisma.task.findMany({
    where: { projectId: p.id, finalLabels: { not: Prisma.AnyNull }, id: { not: excludeId }, OR: [{ gold: { is: null } }, { gold: { split: { not: 'LOCKED_TEST' } } }] },
    take: 1500,
    orderBy: { updatedAt: 'desc' },
    select: { id: true, finalLabels: true, finalSource: true, syntheticRow: { select: { data: true } } },
  });
  return solved
    .map((s) => {
      const t = taskText(p, s.syntheticRow.data as Record<string, unknown>);
      const other = new Set(tokenize(t));
      let inter = 0;
      for (const x of tokens) if (other.has(x)) inter++;
      return { id: s.id, text: t.slice(0, 400), label: (s.finalLabels as { label?: string })?.label, source: s.finalSource, score: inter / (tokens.size + other.size - inter || 1) };
    })
    .filter((s) => s.score > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function updateGoldAfterLabel(tx: Prisma.TransactionClient, ctx: RequestContext, taskId: string) {
  const gold = await tx.goldRecord.findUnique({ where: { taskId } });
  if (!gold || gold.status === 'FINAL') return gold;
  const labels = await tx.label.findMany({ where: { taskId, kind: 'GOLD' }, orderBy: { createdAt: 'asc' } });
  const perUser = new Map<string, string>();
  for (const l of labels) perUser.set(l.userId ?? l.id, (l.values as { label: string }).label);
  const values = [...perUser.values()];
  let status = gold.status;
  let finalLabels: Prisma.InputJsonValue | undefined;
  if (values.length >= gold.requiredLabels) {
    if (new Set(values).size === 1) {
      status = 'FINAL';
      finalLabels = { label: values[0]! };
    } else status = 'NEEDS_ADJUDICATION';
  } else status = values.length ? 'PARTIAL' : 'PENDING';
  await tx.goldRecord.update({ where: { id: gold.id }, data: { status, finalLabels } });
  if (status === 'FINAL') await tx.task.update({ where: { id: taskId }, data: { status: 'DONE', finalLabels: finalLabels!, finalSource: 'GOLD' } });
  void ctx;
  return gold;
}

export async function submitLabel(ctx: RequestContext, projectId: string, input: { taskId: string; label: string; durationMs?: number; note?: string }) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (!labelsOf(p).some((l) => l.value === input.label)) throw badRequest(`"${input.label}" is not a label in this project.`);
  const task = await prisma.task.findFirst({ where: { id: input.taskId, projectId }, include: { gold: true } });
  if (!task) throw notFound('Task');
  if (task.gold?.split === 'LOCKED_TEST' && p.goldLockedAt) throw forbidden('This task belongs to the locked test set and cannot be changed while the gold set is locked.');
  const isGold = !!task.gold && task.gold.status !== 'FINAL';
  return prisma.$transaction(async (tx) => {
    const label = await tx.label.create({
      data: {
        orgId: ctx.orgId,
        projectId,
        taskId: task.id,
        userId: ctx.userId,
        values: { label: input.label },
        source: isGold ? 'GOLD' : 'HUMAN',
        kind: isGold ? 'GOLD' : 'WORK',
        guidelineVersionId: p.activeGuidelineVersionId,
        goldVersion: isGold ? p.goldVersion : null,
        durationMs: input.durationMs ? Math.min(Math.round(input.durationMs), 3_600_000) : null,
        note: input.note?.slice(0, 1000),
      },
    });
    if (isGold) await updateGoldAfterLabel(tx, ctx, task.id);
    else await tx.task.update({ where: { id: task.id }, data: { status: 'LABELED', finalLabels: { label: input.label }, finalSource: 'HUMAN', finalLabelId: label.id } });
    return label;
  });
}

export async function bulkLabel(ctx: RequestContext, projectId: string, taskIds: string[], label: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (!labelsOf(p).some((l) => l.value === label)) throw badRequest(`"${label}" is not a label in this project.`);
  if (taskIds.length > 500) throw badRequest('Bulk labeling is limited to 500 tasks at a time.');
  const tasks = await prisma.task.findMany({ where: { id: { in: taskIds }, projectId, gold: { is: null } }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    for (const t of tasks) {
      const l = await tx.label.create({ data: { orgId: ctx.orgId, projectId, taskId: t.id, userId: ctx.userId, values: { label }, source: 'HUMAN', kind: 'WORK', guidelineVersionId: p.activeGuidelineVersionId, note: 'bulk' } });
      await tx.task.update({ where: { id: t.id }, data: { status: 'LABELED', finalLabels: { label }, finalSource: 'HUMAN', finalLabelId: l.id } });
    }
    await audit(ctx, { action: 'labeling.bulk_label', resourceType: 'label_project', resourceId: projectId, summary: `Bulk-labeled ${tasks.length} tasks as "${label}"` }, tx);
  });
  return { labeled: tasks.length, skippedGold: taskIds.length - tasks.length };
}

export async function setTaskStatus(ctx: RequestContext, projectId: string, taskId: string, action: 'skip' | 'flag' | 'reopen', note?: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const task = await prisma.task.findFirst({ where: { id: taskId, projectId }, include: { gold: { select: { split: true } } } });
  if (!task) throw notFound('Task');
  if (p.goldLockedAt && task.gold?.split === 'LOCKED_TEST') throw badRequest('This task is in the locked test split. Unlock the gold set (creating a new gold version) before changing it.');
  const status = action === 'skip' ? 'SKIPPED' : action === 'flag' ? 'FLAGGED' : 'OPEN';
  if (action === 'reopen' && !can(ctx, 'labeling.review')) throw forbidden();
  await prisma.task.update({ where: { id: taskId }, data: { status, ...(action === 'reopen' ? { finalLabels: Prisma.DbNull, finalSource: null, finalLabelId: null } : {}) } });
  if (action !== 'skip') await audit(ctx, { action: `task.${action}`, resourceType: 'task', resourceId: taskId, summary: `${action === 'flag' ? 'Flagged' : 'Reopened'} task #${task.ordinal}${note ? ` — ${note}` : ''}` });
  return { status };
}

// ── Saved views ──────────────────────────────────────────────────────────────
export async function listViews(ctx: RequestContext, projectId: string) {
  await getProjectOrThrow(ctx, projectId);
  return prisma.savedView.findMany({ where: { projectId, OR: [{ userId: ctx.userId ?? '' }, { shared: true }] }, orderBy: { createdAt: 'asc' } });
}

export async function saveView(ctx: RequestContext, projectId: string, input: { name: string; filters: Record<string, unknown>; shared: boolean }) {
  await getProjectOrThrow(ctx, projectId);
  if (!ctx.userId) throw forbidden();
  return prisma.savedView.create({ data: { orgId: ctx.orgId, projectId, userId: ctx.userId, name: input.name, filters: input.filters as Prisma.InputJsonValue, shared: input.shared } });
}

export async function deleteView(ctx: RequestContext, projectId: string, id: string) {
  const r = await prisma.savedView.deleteMany({ where: { id, projectId, userId: ctx.userId ?? '' } });
  if (!r.count) throw notFound('Saved view');
}

// ── Gold set ─────────────────────────────────────────────────────────────────
export async function sampleGold(ctx: RequestContext, projectId: string, input: { strategy: 'RANDOM' | 'COVERAGE' | 'HARD_CASE' | 'DISAGREEMENT'; count: number; split: 'EXAMPLE' | 'TUNING' | 'LOCKED_TEST'; requiredLabels: number }) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (p.goldLockedAt && input.split === 'LOCKED_TEST') throw badRequest('The locked test set is locked. Unlock it (creating a new gold version) to add records.');
  if (input.count < 1 || input.count > 1000) throw badRequest('Sample between 1 and 1,000 records.');
  const pool = await prisma.task.findMany({ where: { projectId, gold: { is: null } }, select: { id: true, sliceValue: true, priority: true, ordinal: true } });
  const rng = createRng(hashSeed(projectId, p.goldVersion, input.strategy, Date.now()));
  let chosen: { id: string; reason: string }[] = [];
  if (input.strategy === 'RANDOM') {
    chosen = rng.shuffle(pool).slice(0, input.count).map((t) => ({ id: t.id, reason: 'Uniform random sample of unlabeled-for-gold tasks.' }));
  } else if (input.strategy === 'COVERAGE') {
    const bySlice = new Map<string, typeof pool>();
    for (const t of pool) bySlice.set(t.sliceValue ?? '(none)', [...(bySlice.get(t.sliceValue ?? '(none)') ?? []), t]);
    const slices = [...bySlice.entries()].map(([k, v]) => [k, rng.shuffle(v)] as const);
    let i = 0;
    while (chosen.length < input.count && slices.some(([, v]) => v.length)) {
      const [k, v] = slices[i % slices.length]!;
      const t = v.shift();
      if (t) chosen.push({ id: t.id, reason: `Coverage sample: ensures the "${k}" slice is represented.` });
      i++;
    }
  } else if (input.strategy === 'HARD_CASE') {
    chosen = [...pool].sort((a, b) => b.priority - a.priority).slice(0, input.count).map((t) => ({ id: t.id, reason: `Hard case: engine uncertainty score ${t.priority.toFixed(2)}.` }));
  } else {
    const conflicted = await prisma.$queryRaw<{ taskId: string; n: bigint }[]>`
      SELECT "taskId", COUNT(DISTINCT "values"->>'label') AS n FROM labels WHERE "projectId" = ${projectId}::uuid GROUP BY "taskId" HAVING COUNT(DISTINCT "values"->>'label') > 1`;
    const engineDisagree = await prisma.$queryRaw<{ taskId: string }[]>`
      SELECT e."taskId" FROM engine_items e JOIN tasks t ON t.id = e."taskId"
      WHERE e."projectId" = ${projectId}::uuid AND e."reviewStatus" = 'CORRECTED'`;
    const ids = new Set([...conflicted.map((c) => c.taskId), ...engineDisagree.map((e) => e.taskId)]);
    chosen = pool.filter((t) => ids.has(t.id)).slice(0, input.count).map((t) => ({ id: t.id, reason: 'Disagreement: labelers or reviewer and engine disagreed on this record.' }));
    if (!chosen.length) throw badRequest('No disagreements found yet. Use another sampling strategy.');
  }
  await prisma.goldRecord.createMany({
    data: chosen.map((c) => ({ orgId: ctx.orgId, projectId, taskId: c.id, split: input.split, sampling: input.strategy, selectionReason: c.reason, requiredLabels: input.requiredLabels, goldVersion: p.goldVersion })),
    skipDuplicates: true,
  });
  await audit(ctx, { action: 'gold.sampled', resourceType: 'label_project', resourceId: projectId, summary: `Sampled ${chosen.length} ${input.split.toLowerCase().replace('_', ' ')} gold records (${input.strategy.toLowerCase()}), ${input.requiredLabels} label(s) each` });
  return { added: chosen.length };
}

export async function listGold(ctx: RequestContext, projectId: string, split?: string, status?: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const records = await prisma.goldRecord.findMany({
    where: { projectId, ...(split ? { split } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'asc' },
    take: 1000,
    include: { task: { select: { id: true, ordinal: true, syntheticRow: { select: { data: true, syntheticKey: true } }, labels: { where: { kind: 'GOLD' }, select: { id: true, userId: true, values: true, createdAt: true } } } } },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(records.flatMap((r) => r.task.labels.map((l) => l.userId!).filter(Boolean)))] } }, select: { id: true, name: true } });
  const summary = await prisma.goldRecord.groupBy({ by: ['split', 'status'], where: { projectId }, _count: { _all: true } });
  return {
    goldVersion: p.goldVersion,
    lockedAt: p.goldLockedAt,
    summary: summary.map((s) => ({ split: s.split, status: s.status, count: s._count._all })),
    records: records.map((r) => ({
      id: r.id,
      split: r.split,
      sampling: r.sampling,
      selectionReason: r.selectionReason,
      requiredLabels: r.requiredLabels,
      status: r.status,
      finalLabels: r.finalLabels,
      task: { id: r.task.id, ordinal: r.task.ordinal, key: r.task.syntheticRow.syntheticKey, text: taskText(p, r.task.syntheticRow.data as Record<string, unknown>).slice(0, 500) },
      labels: r.task.labels.map((l) => ({ ...l, userName: users.find((u) => u.id === l.userId)?.name })),
    })),
  };
}

export async function moveGoldSplit(ctx: RequestContext, projectId: string, goldId: string, split: 'EXAMPLE' | 'TUNING' | 'LOCKED_TEST') {
  const p = await getProjectOrThrow(ctx, projectId);
  const g = await prisma.goldRecord.findFirst({ where: { id: goldId, projectId } });
  if (!g) throw notFound('Gold record');
  if (p.goldLockedAt && (g.split === 'LOCKED_TEST' || split === 'LOCKED_TEST')) throw badRequest('The locked test set cannot change while the gold set is locked.');
  await prisma.goldRecord.update({ where: { id: goldId }, data: { split } });
  await audit(ctx, { action: 'gold.split_changed', resourceType: 'gold_record', resourceId: goldId, summary: `Moved a gold record from ${g.split} to ${split}`, before: { split: g.split }, after: { split } });
}

export async function adjudicate(ctx: RequestContext, projectId: string, goldId: string, label: string, reason: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  if (!labelsOf(p).some((l) => l.value === label)) throw badRequest(`"${label}" is not a label in this project.`);
  if (reason.trim().length < 5) throw badRequest('Explain the adjudication decision.');
  const g = await prisma.goldRecord.findFirst({ where: { id: goldId, projectId } });
  if (!g) throw notFound('Gold record');
  if (p.goldLockedAt && g.split === 'LOCKED_TEST') throw badRequest('The locked test set cannot change while the gold set is locked.');
  const labels = await prisma.label.findMany({ where: { taskId: g.taskId, kind: 'GOLD' } });
  await prisma.$transaction(async (tx) => {
    const l = await tx.label.create({ data: { orgId: ctx.orgId, projectId, taskId: g.taskId, userId: ctx.userId, values: { label }, source: 'ADJUDICATION', kind: 'FINAL', guidelineVersionId: p.activeGuidelineVersionId, goldVersion: p.goldVersion, note: reason } });
    await tx.adjudication.create({ data: { orgId: ctx.orgId, projectId, taskId: g.taskId, goldRecordId: g.id, labelIds: labels.map((x) => x.id), finalValues: { label }, reason, adjudicatorId: ctx.userId! } });
    await tx.goldRecord.update({ where: { id: g.id }, data: { status: 'FINAL', finalLabels: { label } } });
    await tx.task.update({ where: { id: g.taskId }, data: { status: 'DONE', finalLabels: { label }, finalSource: 'ADJUDICATION', finalLabelId: l.id } });
    await audit(ctx, { action: 'gold.adjudicated', resourceType: 'gold_record', resourceId: g.id, summary: `Adjudicated a gold record as "${label}": ${reason}`, details: { labels: labels.map((x) => (x.values as { label: string }).label) } }, tx);
  });
}

export async function lockGold(ctx: RequestContext, projectId: string, lock: boolean, reason?: string) {
  const p = await getProjectOrThrow(ctx, projectId);
  const cfg = projectConfig(p);
  if (lock) {
    if (p.goldLockedAt) throw badRequest('The gold set is already locked.');
    const finals = await prisma.goldRecord.count({ where: { projectId, split: 'LOCKED_TEST', status: 'FINAL' } });
    const pending = await prisma.goldRecord.count({ where: { projectId, split: 'LOCKED_TEST', status: { not: 'FINAL' } } });
    if (finals < cfg.quality.minLockedTest) throw badRequest(`The locked test split needs at least ${cfg.quality.minLockedTest} final records before locking (it has ${finals}).`);
    if (pending) throw badRequest(`${pending} locked-test records are not final yet. Finish labeling or adjudicate them first.`);
    await prisma.labelProject.update({ where: { id: projectId }, data: { goldLockedAt: new Date() } });
    await audit(ctx, { action: 'gold.locked', resourceType: 'label_project', resourceId: projectId, summary: `Locked gold set v${p.goldVersion} with ${finals} test records` });
    await emit(ctx.orgId, 'gold.locked', { projectId, goldVersion: p.goldVersion, records: finals });
  } else {
    if (!p.goldLockedAt) throw badRequest('The gold set is not locked.');
    if (!reason || reason.trim().length < 10) throw badRequest('Explain why the gold set must be unlocked (at least 10 characters).');
    await prisma.labelProject.update({ where: { id: projectId }, data: { goldLockedAt: null, goldVersion: p.goldVersion + 1 } });
    await audit(ctx, { action: 'gold.unlocked', resourceType: 'label_project', resourceId: projectId, summary: `Unlocked gold set; new version v${p.goldVersion + 1}: ${reason}` });
  }
}
