import { Router } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '../lib/prisma.js';
import { encryptSecret, maskSecret, randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { asyncHandler, pageOf, param, parse } from '../lib/http.js';
import { env } from '../config/env.js';
import { requirePermission } from '../middleware/auth.js';
import { audit } from '../modules/audit.js';
import { API_KEY_SCOPES, PERMISSIONS, SYSTEM_ROLES, type PermissionKey } from '../modules/authz.js';
import { ctxOf, type RequestContext } from '../modules/context.js';
import { assertOutboundUrl } from '../lib/net.js';
import { controlJob, getJob } from '../modules/jobs/queue.js';
import { WEBHOOK_EVENTS } from '../modules/platform/events.js';
import { issueToken } from '../modules/auth/routes.js';
import { sendEmail } from '../modules/auth/email.js';
import * as C from '../services/connectors.js';

export const platformRouter = Router();

// ── Dashboard & search ───────────────────────────────────────────────────────
platformRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const orgId = ctx.orgId;
  const [sources, sets, projects, openAlerts, jobs, activity, tasks, exportsCount, registry] = await Promise.all([
    prisma.dataSource.groupBy({ by: ['status'], where: { orgId, deletedAt: null }, _count: { _all: true } }),
    prisma.syntheticSet.groupBy({ by: ['status'], where: { orgId, deletedAt: null }, _count: { _all: true } }),
    prisma.labelProject.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true, status: true, goldLockedAt: true }, orderBy: { createdAt: 'desc' }, take: 6 }),
    prisma.leakAlert.count({ where: { orgId, status: 'OPEN' } }),
    prisma.processingJob.findMany({ where: { orgId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED', 'FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ctx.permissions.has('activity.read') ? prisma.activityLog.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 10 }) : [],
    prisma.task.groupBy({ by: ['status'], where: { orgId }, _count: { _all: true } }),
    prisma.export.count({ where: { orgId, status: 'COMPLETED', deletedAt: null } }),
    prisma.canaryRegistry.count({ where: { orgId } }),
  ]);
  const pending = await prisma.engineItem.count({ where: { orgId, reviewStatus: 'PENDING' } });
  const sum = (g: { _count: { _all: number } }[]) => g.reduce((a, x) => a + x._count._all, 0);
  const statuses = (g: { status: string; _count: { _all: number } }[]) => Object.fromEntries(g.map((x) => [x.status, x._count._all]));
  res.json({
    pipeline: {
      firewall: { total: sum(sources), byStatus: statuses(sources) },
      twin: { total: sum(sets), byStatus: statuses(sets) },
      canary: { registered: registry, openAlerts },
      labeling: { projects: projects.length, tasks: statuses(tasks), pendingReview: pending },
      exports: { completed: exportsCount },
    },
    projects,
    jobs,
    activity,
  });
}));

platformRouter.get('/search', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return void res.json([]);
  const like = { contains: q, mode: 'insensitive' as const };
  const [sources, sets, projects] = await Promise.all([
    ctx.permissions.has('sources.read') ? prisma.dataSource.findMany({ where: { orgId: ctx.orgId, deletedAt: null, name: like }, take: 5, select: { id: true, name: true } }) : [],
    ctx.permissions.has('synthetic.read') ? prisma.syntheticSet.findMany({ where: { orgId: ctx.orgId, deletedAt: null, name: like }, take: 5, select: { id: true, name: true } }) : [],
    prisma.labelProject.findMany({ where: { orgId: ctx.orgId, deletedAt: null, name: like, ...(['LABELER', 'REVIEWER'].includes(ctx.roleKey) ? { members: { some: { userId: ctx.userId ?? '' } } } : {}) }, take: 5, select: { id: true, name: true } }),
  ]);
  res.json([
    ...sources.map((s) => ({ type: 'Data source', label: s.name, href: `/sources/${s.id}` })),
    ...sets.map((s) => ({ type: 'Synthetic set', label: s.name, href: `/synthetic/${s.id}` })),
    ...projects.map((p) => ({ type: 'Project', label: p.name, href: `/projects/${p.id}` })),
  ]);
}));

// ── Jobs ─────────────────────────────────────────────────────────────────────
// Job events describe the resource they process, so they follow that resource's read permission.
const JOB_RESOURCE_PERMISSION: Record<string, PermissionKey> = { data_source: 'sources.read', synthetic_set: 'synthetic.read', engine_run: 'engine.run', export: 'exports.read' };
function jobVisibility(ctx: RequestContext): Prisma.ProcessingJobWhereInput {
  if (ctx.roleKey === 'ADMIN') return {};
  const types = Object.entries(JOB_RESOURCE_PERMISSION).filter(([, p]) => ctx.permissions.has(p)).map(([t]) => t);
  return { OR: [...(ctx.userId ? [{ createdById: ctx.userId }] : []), { resourceType: { in: types } }] };
}
function canSeeJob(ctx: RequestContext, job: { createdById: string | null; resourceType: string | null }) {
  if (ctx.roleKey === 'ADMIN' || (ctx.userId && job.createdById === ctx.userId)) return true;
  const perm = job.resourceType ? JOB_RESOURCE_PERMISSION[job.resourceType] : undefined;
  return !!perm && ctx.permissions.has(perm);
}
platformRouter.get('/jobs', asyncHandler(async (req, res) => {
  const { limit, offset } = pageOf(req.query);
  const where: Prisma.ProcessingJobWhereInput = { orgId: ctxOf(req).orgId, ...jobVisibility(ctxOf(req)), ...(req.query.status ? { status: String(req.query.status) } : {}), ...(req.query.resourceId ? { resourceId: String(req.query.resourceId) } : {}) };
  const [items, total] = await Promise.all([prisma.processingJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }).then((rows) => rows.map(({ payload: _p, errorDetail: _e, ...r }) => r)), prisma.processingJob.count({ where })]);
  res.json({ items, total });
}));
platformRouter.get('/jobs/:id', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const job = await getJob(ctx.orgId, param(req, 'id'));
  if (!canSeeJob(ctx, job)) throw notFound('Job');
  res.json({ ...job, payload: undefined, errorDetail: ctx.roleKey === 'ADMIN' ? job.errorDetail : undefined });
}));
platformRouter.post('/jobs/:id/:action(cancel|pause|resume|retry)', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const job = await getJob(ctx.orgId, param(req, 'id'));
  if (job.createdById !== ctx.userId && ctx.roleKey !== 'ADMIN') throw forbidden('Only the person who started this job or an admin can control it.');
  const out = await controlJob(ctx.orgId, job.id, req.params.action as 'cancel');
  await audit(ctx, { action: `job.${req.params.action}`, resourceType: 'job', resourceId: job.id, summary: `Requested ${req.params.action} of ${job.type.toLowerCase().replace(/_/g, ' ')} job` });
  res.json({ ...out, payload: undefined });
}));

// ── Activity ─────────────────────────────────────────────────────────────────
platformRouter.get('/activity', requirePermission('activity.read'), asyncHandler(async (req, res) => {
  const { limit, offset } = pageOf(req.query);
  const q = req.query as Record<string, string | undefined>;
  const where: Prisma.ActivityLogWhereInput = {
    orgId: ctxOf(req).orgId,
    ...(q.resourceType ? { resourceType: q.resourceType } : {}),
    ...(q.resourceId ? { resourceId: q.resourceId } : {}),
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.q ? { summary: { contains: q.q, mode: 'insensitive' } } : {}),
  };
  const [items, total] = await Promise.all([prisma.activityLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }), prisma.activityLog.count({ where })]);
  res.json({ items, total });
}));

// ── Notifications ────────────────────────────────────────────────────────────
platformRouter.get('/notifications', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  if (!ctx.userId) return void res.json({ items: [], unread: 0 });
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { orgId: ctx.orgId, userId: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { orgId: ctx.orgId, userId: ctx.userId, readAt: null } }),
  ]);
  res.json({ items, unread });
}));
platformRouter.post('/notifications/read', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const ids = parse(z.object({ ids: z.array(z.string().uuid()).optional() }), req.body ?? {}).ids;
  await prisma.notification.updateMany({ where: { orgId: ctx.orgId, userId: ctx.userId ?? '', readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
  res.json({ ok: true });
}));

// ── Organization & members ───────────────────────────────────────────────────
platformRouter.get('/org', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
  const billing = await prisma.billingAccount.findUnique({ where: { orgId: ctx.orgId } });
  res.json({ ...org, billing });
}));
platformRouter.patch('/org', requirePermission('org.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ name: z.string().trim().min(2).max(120) }), req.body);
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
  const org = await prisma.organization.update({ where: { id: ctx.orgId }, data: { name: body.name } });
  await audit(ctx, { action: 'org.updated', resourceType: 'organization', resourceId: org.id, summary: `Renamed organization to ${org.name}`, before: { name: before.name }, after: { name: org.name } });
  res.json(org);
}));
platformRouter.get('/roles', asyncHandler(async (_req, res) => {
  res.json({ roles: Object.entries(SYSTEM_ROLES).map(([key, r]) => ({ key, ...r })), permissions: PERMISSIONS });
}));
platformRouter.get('/members', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const members = await prisma.organizationMember.findMany({ where: { orgId: ctx.orgId }, include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true, emailVerifiedAt: true } }, role: { select: { key: true, name: true } } }, orderBy: { createdAt: 'asc' } });
  res.json(members.map((m) => ({ id: m.id, status: m.status, role: m.role, user: ctx.permissions.has('members.manage') ? m.user : { id: m.user.id, name: m.user.name }, createdAt: m.createdAt })));
}));
platformRouter.post('/members/invite', requirePermission('members.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(Object.keys(SYSTEM_ROLES) as [string, ...string[]]), name: z.string().max(120).optional() }), req.body);
  const role = await prisma.role.findFirstOrThrow({ where: { key: body.role, orgId: null } });
  const user = (await prisma.user.findUnique({ where: { email: body.email } })) ?? (await prisma.user.create({ data: { email: body.email, name: body.name ?? body.email.split('@')[0]! } }));
  const existing = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: user.id } } });
  if (existing?.status === 'ACTIVE') throw conflict('This person is already a member.');
  await prisma.organizationMember.upsert({ where: { orgId_userId: { orgId: ctx.orgId, userId: user.id } }, create: { orgId: ctx.orgId, userId: user.id, roleId: role.id, status: 'INVITED' }, update: { roleId: role.id, status: 'INVITED' } });
  // Membership stays INVITED until the invitee accepts, even if they already have an account.
  const token = await issueToken(user.id, 'INVITE', 72);
  await sendEmail(
    user.email,
    'You have been invited to AuthenQ',
    user.passwordHash
      ? `Open ${env.APP_URL}/accept-invite?token=${token} and confirm with your existing AuthenQ password to join.`
      : `Open ${env.APP_URL}/accept-invite?token=${token} to join.`,
  );
  await audit(ctx, { action: 'member.invited', resourceType: 'member', resourceId: user.id, summary: `Invited ${body.email} as ${role.name}` });
  res.status(201).json({ ok: true });
}));
platformRouter.patch('/members/:id', requirePermission('members.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ role: z.enum(Object.keys(SYSTEM_ROLES) as [string, ...string[]]).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }), req.body);
  const m = await prisma.organizationMember.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId }, include: { role: true, user: true } });
  if (!m) throw notFound('Member');
  if (m.userId === ctx.userId) throw badRequest('You cannot change your own role or status.');
  if (m.role.key === 'ADMIN' && (body.role && body.role !== 'ADMIN' || body.status === 'SUSPENDED')) {
    const admins = await prisma.organizationMember.count({ where: { orgId: ctx.orgId, status: 'ACTIVE', role: { key: 'ADMIN' } } });
    if (admins <= 1) throw badRequest('The organization must keep at least one active admin.');
  }
  const role = body.role ? await prisma.role.findFirstOrThrow({ where: { key: body.role, orgId: null } }) : null;
  await prisma.organizationMember.update({ where: { id: m.id }, data: { ...(role ? { roleId: role.id } : {}), ...(body.status ? { status: body.status } : {}) } });
  if (body.status === 'SUSPENDED') await prisma.session.updateMany({ where: { userId: m.userId, orgId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(ctx, { action: 'member.updated', resourceType: 'member', resourceId: m.userId, summary: `Updated ${m.user.email}: ${[role && `role ${role.name}`, body.status && `status ${body.status}`].filter(Boolean).join(', ')}`, before: { role: m.role.key, status: m.status }, after: body });
  res.json({ ok: true });
}));
platformRouter.delete('/members/:id', requirePermission('members.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const m = await prisma.organizationMember.findFirst({ where: { id: param(req, 'id'), orgId: ctx.orgId }, include: { user: true, role: true } });
  if (!m) throw notFound('Member');
  if (m.userId === ctx.userId) throw badRequest('You cannot remove yourself.');
  if (m.role.key === 'ADMIN' && (await prisma.organizationMember.count({ where: { orgId: ctx.orgId, status: 'ACTIVE', role: { key: 'ADMIN' } } })) <= 1) throw badRequest('The organization must keep at least one active admin.');
  await prisma.$transaction([prisma.session.updateMany({ where: { userId: m.userId, orgId: ctx.orgId }, data: { revokedAt: new Date() } }), prisma.organizationMember.delete({ where: { id: m.id } })]);
  await audit(ctx, { action: 'member.removed', resourceType: 'member', resourceId: m.userId, summary: `Removed ${m.user.email} from the organization` });
  res.status(204).end();
}));

// ── API keys ─────────────────────────────────────────────────────────────────
platformRouter.get('/api-keys', requirePermission('apikeys.manage'), asyncHandler(async (req, res) => {
  const keys = await prisma.apiKey.findMany({ where: { orgId: ctxOf(req).orgId }, orderBy: { createdAt: 'desc' }, include: { serviceAccount: { select: { name: true, roleKey: true } } } });
  res.json({ keys: keys.map(({ keyHash: _h, ...k }) => k), scopes: API_KEY_SCOPES });
}));
platformRouter.post('/api-keys', requirePermission('apikeys.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ name: z.string().trim().min(2).max(80), role: z.enum(['PROJECT_MANAGER', 'DATA_ENGINEER', 'REVIEWER', 'LABELER', 'VIEWER']), scopes: z.array(z.enum(API_KEY_SCOPES as [string, ...string[]])).min(1), expiresInDays: z.number().int().min(1).max(730).optional() }), req.body);
  const sa = await prisma.serviceAccount.upsert({ where: { orgId_name: { orgId: ctx.orgId, name: body.name } }, create: { orgId: ctx.orgId, name: body.name, roleKey: body.role }, update: { roleKey: body.role, disabledAt: null } });
  const raw = `aq_${randomToken(30)}`;
  const key = await prisma.apiKey.create({ data: { orgId: ctx.orgId, serviceAccountId: sa.id, name: body.name, prefix: raw.slice(0, 10), keyHash: sha256(raw), scopes: body.scopes, createdById: ctx.userId, expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null } });
  await audit(ctx, { action: 'apikey.created', resourceType: 'api_key', resourceId: key.id, summary: `Created API key ${key.prefix}… "${key.name}" (${body.role}, ${body.scopes.length} scopes)` });
  res.status(201).json({ id: key.id, prefix: key.prefix, key: raw, note: 'Copy this key now. It will not be shown again.' });
}));
platformRouter.delete('/api-keys/:id', requirePermission('apikeys.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.apiKey.updateMany({ where: { id: param(req, 'id'), orgId: ctx.orgId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw notFound('API key');
  await audit(ctx, { action: 'apikey.revoked', resourceType: 'api_key', resourceId: req.params.id, summary: 'Revoked an API key' });
  res.status(204).end();
}));

// ── Webhooks ─────────────────────────────────────────────────────────────────
async function validateWebhookUrl(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('Enter a valid URL.');
  }
  if (env.NODE_ENV === 'production' && u.protocol !== 'https:') throw badRequest('Webhook URLs must use HTTPS.');
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('Webhook URLs must use HTTP or HTTPS.');
  await assertOutboundUrl(url, 'Webhook URLs');
}
platformRouter.get('/webhooks', requirePermission('webhooks.manage'), asyncHandler(async (req, res) => {
  const rows = await prisma.webhookEndpoint.findMany({ where: { orgId: ctxOf(req).orgId }, orderBy: { createdAt: 'desc' }, include: { deliveries: { orderBy: { createdAt: 'desc' }, take: 10 } } });
  const endpoints = rows.map(({ secretEnc: _s, deliveries, ...e }) => ({ ...e, deliveries: deliveries.map(({ payload: _p, ...d }) => d) }));
  res.json({ endpoints, events: WEBHOOK_EVENTS });
}));
platformRouter.post('/webhooks', requirePermission('webhooks.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ url: z.string().max(500), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) }), req.body);
  await validateWebhookUrl(body.url);
  const secret = `whsec_${randomToken(24)}`;
  const ep = await prisma.webhookEndpoint.create({ data: { orgId: ctx.orgId, url: body.url, events: body.events, secretEnc: encryptSecret(secret) } });
  await audit(ctx, { action: 'webhook.created', resourceType: 'webhook', resourceId: ep.id, summary: `Added webhook ${body.url} for ${body.events.join(', ')}` });
  res.status(201).json({ id: ep.id, secret, note: 'Copy this signing secret now. It will not be shown again.' });
}));
platformRouter.patch('/webhooks/:id', requirePermission('webhooks.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ active: z.boolean().optional(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional() }), req.body);
  const r = await prisma.webhookEndpoint.updateMany({ where: { id: param(req, 'id'), orgId: ctx.orgId }, data: body });
  if (!r.count) throw notFound('Webhook');
  await audit(ctx, { action: 'webhook.updated', resourceType: 'webhook', resourceId: req.params.id, summary: 'Updated a webhook endpoint', after: body });
  res.json({ ok: true });
}));
platformRouter.delete('/webhooks/:id', requirePermission('webhooks.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.webhookEndpoint.deleteMany({ where: { id: param(req, 'id'), orgId: ctx.orgId } });
  if (!r.count) throw notFound('Webhook');
  await audit(ctx, { action: 'webhook.deleted', resourceType: 'webhook', resourceId: req.params.id, summary: 'Removed a webhook endpoint' });
  res.status(204).end();
}));
platformRouter.post('/webhooks/:id/redeliver/:deliveryId', requirePermission('webhooks.manage'), asyncHandler(async (req, res) => {
  const r = await prisma.webhookDelivery.updateMany({ where: { id: param(req, 'deliveryId'), endpointId: param(req, 'id'), orgId: ctxOf(req).orgId }, data: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0 } });
  if (!r.count) throw notFound('Delivery');
  res.json({ ok: true });
}));

// ── Settings, feature flags, usage ──────────────────────────────────────────
const SETTING_KEYS = ['retention.days', 'export.requireOverrideApproval', 'workspace.shortcuts', 'security.sessionHours', 'security.requireMfa'] as const;
platformRouter.get('/settings', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const [settings, flags, overrides, retention] = await Promise.all([
    prisma.setting.findMany({ where: { orgId: ctx.orgId } }),
    prisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
    prisma.orgFeatureFlag.findMany({ where: { orgId: ctx.orgId } }),
    prisma.dataRetentionPolicy.findMany({ where: { orgId: ctx.orgId } }),
  ]);
  res.json({ settings: Object.fromEntries(settings.map((s) => [s.key, s.value])), keys: SETTING_KEYS, flags: flags.map((f) => ({ ...f, enabled: overrides.find((o) => o.key === f.key)?.enabled ?? f.enabled })), retention });
}));
platformRouter.put('/settings/:key', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const key = req.params.key as (typeof SETTING_KEYS)[number];
  if (!SETTING_KEYS.includes(key)) throw badRequest('Unknown setting.');
  const value = parse(z.object({ value: z.union([z.string().max(1000), z.number(), z.boolean(), z.record(z.string().max(50))]) }), req.body).value;
  const before = await prisma.setting.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key } } });
  await prisma.setting.upsert({ where: { orgId_key: { orgId: ctx.orgId, key } }, create: { orgId: ctx.orgId, key, value: value as Prisma.InputJsonValue }, update: { value: value as Prisma.InputJsonValue } });
  await audit(ctx, { action: 'settings.updated', resourceType: 'setting', resourceId: key, summary: `Changed setting ${key}`, before: before?.value, after: value });
  res.json({ ok: true });
}));
platformRouter.put('/feature-flags/:key', requirePermission('settings.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const flag = await prisma.featureFlag.findUnique({ where: { key: req.params.key } });
  if (!flag) throw notFound('Feature flag');
  const enabled = parse(z.object({ enabled: z.boolean() }), req.body).enabled;
  await prisma.orgFeatureFlag.upsert({ where: { orgId_key: { orgId: ctx.orgId, key: flag.key } }, create: { orgId: ctx.orgId, key: flag.key, enabled }, update: { enabled } });
  await audit(ctx, { action: 'feature_flag.updated', resourceType: 'feature_flag', resourceId: flag.key, summary: `${enabled ? 'Enabled' : 'Disabled'} ${flag.key}` });
  res.json({ ok: true });
}));
platformRouter.get('/usage', asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [usage, limits] = await Promise.all([
    prisma.usageEvent.groupBy({ by: ['metric'], where: { orgId: ctx.orgId, createdAt: { gte: since } }, _sum: { quantity: true } }),
    prisma.usageLimit.findMany({ where: { orgId: ctx.orgId } }),
  ]);
  res.json({ since, metrics: usage.map((u) => ({ metric: u.metric, quantity: u._sum.quantity ?? 0, limit: limits.find((l) => l.metric === u.metric)?.limit ?? null })) });
}));

// ── Security ─────────────────────────────────────────────────────────────────
platformRouter.get('/security/events', requirePermission('security.read'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const memberEmails = (await prisma.organizationMember.findMany({ where: { orgId: ctx.orgId }, include: { user: { select: { email: true } } } })).map((m) => m.user.email);
  const [events, logins] = await Promise.all([
    prisma.securityEvent.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.loginEvent.findMany({ where: { email: { in: memberEmails } }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  res.json({ events, logins });
}));

// ── AI providers ─────────────────────────────────────────────────────────────
platformRouter.get('/ai-providers', requirePermission('ai.manage'), asyncHandler(async (req, res) => {
  const rows = await prisma.aiProvider.findMany({ where: { orgId: ctxOf(req).orgId }, orderBy: { createdAt: 'asc' } });
  res.json(rows.map(({ apiKeyEnc, ...r }) => ({ ...r, apiKey: apiKeyEnc ? maskSecret('configured-secret') : null })));
}));
platformRouter.post('/ai-providers', requirePermission('ai.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ provider: z.enum(['OPENAI_COMPATIBLE', 'ANTHROPIC', 'SELF_HOSTED']), name: z.string().min(2).max(80), model: z.string().min(1).max(120), baseUrl: z.string().url().max(300).optional(), apiKey: z.string().max(500).optional(), enabled: z.boolean().default(false) }), req.body);
  if (body.baseUrl) await assertOutboundUrl(body.baseUrl, 'AI provider URLs');
  const p = await prisma.aiProvider.create({ data: { orgId: ctx.orgId, provider: body.provider, name: body.name, model: body.model, baseUrl: body.baseUrl, apiKeyEnc: body.apiKey ? encryptSecret(body.apiKey) : null, enabled: body.enabled } });
  await audit(ctx, { action: 'ai_provider.created', resourceType: 'ai_provider', resourceId: p.id, summary: `Added AI provider ${body.name} (${body.provider}, ${body.model})${body.enabled ? ', enabled' : ''}` });
  res.status(201).json({ id: p.id });
}));
platformRouter.patch('/ai-providers/:id', requirePermission('ai.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const body = parse(z.object({ enabled: z.boolean().optional(), model: z.string().max(120).optional(), apiKey: z.string().max(500).optional() }), req.body);
  const r = await prisma.aiProvider.updateMany({ where: { id: param(req, 'id'), orgId: ctx.orgId }, data: { enabled: body.enabled, model: body.model, ...(body.apiKey ? { apiKeyEnc: encryptSecret(body.apiKey) } : {}) } });
  if (!r.count) throw notFound('AI provider');
  await audit(ctx, { action: 'ai_provider.updated', resourceType: 'ai_provider', resourceId: req.params.id, summary: `Updated AI provider${body.enabled !== undefined ? ` (${body.enabled ? 'enabled' : 'disabled'})` : ''}` });
  res.json({ ok: true });
}));
platformRouter.delete('/ai-providers/:id', requirePermission('ai.manage'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  const r = await prisma.aiProvider.deleteMany({ where: { id: param(req, 'id'), orgId: ctx.orgId } });
  if (!r.count) throw notFound('AI provider');
  await audit(ctx, { action: 'ai_provider.deleted', resourceType: 'ai_provider', resourceId: req.params.id, summary: 'Removed an AI provider and its stored key' });
  res.status(204).end();
}));

// ── Connectors ───────────────────────────────────────────────────────────────
platformRouter.get('/connectors', requirePermission('sources.read'), asyncHandler(async (req, res) => {
  const ctx = ctxOf(req);
  res.json({ types: await C.availableConnectorTypes(ctx.orgId), connectors: await C.listConnectors(ctx) });
}));
platformRouter.post('/connectors', requirePermission('connectors.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ type: z.string(), name: z.string().trim().min(2).max(80), connectionString: z.string().min(10).max(1000) }), req.body);
  res.status(201).json(await C.createConnector(ctxOf(req), body));
}));
platformRouter.post('/connectors/:id/test', requirePermission('connectors.manage'), asyncHandler(async (req, res) => res.json(await C.checkConnector(ctxOf(req), param(req, 'id')))));
platformRouter.post('/connectors/:id/import', requirePermission('connectors.manage'), asyncHandler(async (req, res) => {
  const body = parse(z.object({ sourceId: z.string().uuid(), tables: z.array(z.string().max(130)).min(1).max(50) }), req.body);
  res.status(202).json(await C.importFromConnector(ctxOf(req), param(req, 'id'), body.sourceId, body.tables));
}));
platformRouter.delete('/connectors/:id', requirePermission('connectors.manage'), asyncHandler(async (req, res) => {
  await C.deleteConnector(ctxOf(req), param(req, 'id'));
  res.status(204).end();
}));
