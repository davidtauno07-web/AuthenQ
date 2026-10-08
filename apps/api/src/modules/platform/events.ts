import { assertOutboundUrl } from '../../lib/net.js';
import { createHmac } from 'node:crypto';
import { prisma, Prisma } from '../../lib/prisma.js';
import { decryptSecret } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';

export const WEBHOOK_EVENTS = [
  'source.scanned',
  'synthetic_set.completed',
  'labeling.sent',
  'engine_run.completed',
  'export.completed',
  'canary.leak_alert',
  'gold.locked',
  'job.failed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Records the event for every active subscribed endpoint; delivery happens in the worker. */
export async function emit(orgId: string, event: WebhookEvent, data: Record<string, unknown>) {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { orgId, active: true, events: { has: event } } });
  if (!endpoints.length) return;
  const payload = { event, orgId, occurredAt: new Date().toISOString(), data } as Prisma.InputJsonValue;
  await prisma.webhookDelivery.createMany({ data: endpoints.map((e) => ({ orgId, endpointId: e.id, event, payload })) });
}

export function signWebhook(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const BACKOFF_S = [10, 60, 300, 1800, 7200];

export async function deliverPendingWebhooks(limit = 20, fetchImpl: typeof fetch = fetch) {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
    include: { endpoint: true },
    take: limit,
    orderBy: { nextAttemptAt: 'asc' },
  });
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000);
    let status = 0;
    let snippet = '';
    let error: string | null = null;
    try {
      await assertOutboundUrl(d.endpoint.url, 'Webhook URLs');
      const res = await fetchImpl(d.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-authenq-event': d.event,
          'x-authenq-delivery': d.id,
          'x-authenq-signature': signWebhook(decryptSecret(d.endpoint.secretEnc), ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      });
      status = res.status;
      snippet = (await res.text()).slice(0, 300);
    } catch (err) {
      error = (err as Error).message;
    }
    const ok = status >= 200 && status < 300;
    const attempts = d.attempts + 1;
    await prisma.webhookDelivery.update({
      where: { id: d.id },
      data: ok
        ? { status: 'DELIVERED', attempts, responseStatus: status, responseSnippet: snippet, deliveredAt: new Date(), lastError: null }
        : {
            status: attempts >= BACKOFF_S.length + 1 ? 'DEAD' : 'RETRYING',
            attempts,
            responseStatus: status || null,
            responseSnippet: snippet || null,
            lastError: error ?? `HTTP ${status}`,
            nextAttemptAt: new Date(Date.now() + (BACKOFF_S[attempts - 1] ?? 7200) * 1000),
          },
    });
    if (!ok) logger.warn({ deliveryId: d.id, status, error }, 'webhook delivery failed');
  }
  return due.length;
}

export async function notify(orgId: string, userIds: string[], type: string, title: string, body: string, link?: string) {
  if (!userIds.length) return;
  await prisma.notification.createMany({ data: userIds.map((userId) => ({ orgId, userId, type, title, body, link })) });
}

export async function notifyRole(orgId: string, roleKeys: string[], type: string, title: string, body: string, link?: string) {
  const members = await prisma.organizationMember.findMany({
    where: { orgId, status: 'ACTIVE', role: { key: { in: roleKeys } } },
    select: { userId: true },
  });
  await notify(orgId, members.map((m) => m.userId), type, title, body, link);
}

export async function recordUsage(orgId: string, metric: string, quantity: number, resourceType?: string, resourceId?: string) {
  await prisma.usageEvent.create({ data: { orgId, metric, quantity, resourceType, resourceId } });
}

export async function isFeatureEnabled(orgId: string, key: string): Promise<boolean> {
  const override = await prisma.orgFeatureFlag.findUnique({ where: { orgId_key: { orgId, key } } }).catch(() => null);
  if (override) return override.enabled;
  const flag = await prisma.featureFlag.findUnique({ where: { key } });
  return flag?.enabled ?? false;
}

export async function getSetting<T>(orgId: string, key: string, fallback: T): Promise<T> {
  const s = await prisma.setting.findUnique({ where: { orgId_key: { orgId, key } } });
  return (s?.value as T) ?? fallback;
}
