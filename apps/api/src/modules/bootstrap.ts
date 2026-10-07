import { prisma } from '../lib/prisma.js';
import { PERMISSIONS, SYSTEM_ROLES } from './authz.js';

export const FEATURE_FLAGS = [
  { key: 'engine.external_ai', stage: 'BETA', enabled: false, description: 'Allow engine runs through a configured external AI provider (synthetic data only).' },
  { key: 'canary.api_scan', stage: 'GA', enabled: true, description: 'Allow API keys with canary.scan to submit text for Canary scanning.' },
] as const;

/** Idempotently creates the permission catalog, system roles and feature flags. */
export async function ensureSystemData() {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }
  const perms = await prisma.permission.findMany();
  for (const [key, r] of Object.entries(SYSTEM_ROLES)) {
    let role = await prisma.role.findFirst({ where: { key, orgId: null } });
    role = role
      ? await prisma.role.update({ where: { id: role.id }, data: { name: r.name, description: r.description, isSystem: true } })
      : await prisma.role.create({ data: { key, name: r.name, description: r.description, isSystem: true } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({ data: r.permissions.map((p) => ({ roleId: role!.id, permissionId: perms.find((x) => x.key === p)!.id })) });
  }
  for (const f of FEATURE_FLAGS) {
    await prisma.featureFlag.upsert({ where: { key: f.key }, create: { ...f }, update: { description: f.description, stage: f.stage } });
  }
}
