import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';

export const orgSettingsSchema = z.object({
  thresholds: z.object({
    privacyRiskScore: z.number().min(0).max(100).default(25),
    counterfactualFlipRate: z.number().min(0).max(1).default(0.05),
    demographicParityDifference: z.number().min(0).max(1).default(0.05),
    equalOpportunityDifference: z.number().min(0).max(1).default(0.05),
    regressionDelta: z.number().min(0).max(1).default(0.03),
  }),
  testing: z.object({
    defaultTestSize: z.number().int().min(50).max(50_000).default(2_000),
    defaultFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']).default('WEEKLY'),
    defaultProtectedAttributes: z.array(z.string()).default(['gender', 'age', 'ethnicity']),
    syntheticRecordMultiplier: z.number().min(0.1).max(5).default(1),
  }),
  notifications: z.object({
    alertOnPrivacyBreach: z.boolean().default(true),
    alertOnFairnessBreach: z.boolean().default(true),
    alertOnRegression: z.boolean().default(true),
    minimumSeverity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('LOW'),
  }),
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

/** Settings are patched section by section, so every field is optional here. */
export const settingsPatchSchema = z.object({
  thresholds: orgSettingsSchema.shape.thresholds.partial().optional(),
  testing: orgSettingsSchema.shape.testing.partial().optional(),
  notifications: orgSettingsSchema.shape.notifications.partial().optional(),
});

export type OrgSettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_ORG_SETTINGS: OrgSettings = orgSettingsSchema.parse({
  thresholds: {},
  testing: {},
  notifications: {},
});

/** Stored settings may predate a schema change, so they are always re-parsed. */
export const getOrgSettings = async (organizationId: string): Promise<OrgSettings> => {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw notFound('Organization not found');
  const parsed = orgSettingsSchema.safeParse(org.settings);
  return parsed.success ? parsed.data : DEFAULT_ORG_SETTINGS;
};

export const updateOrgSettings = async (
  organizationId: string,
  patch: OrgSettingsPatch,
): Promise<OrgSettings> => {
  const current = await getOrgSettings(organizationId);
  const merged = orgSettingsSchema.parse({
    thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) },
    testing: { ...current.testing, ...(patch.testing ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  });
  await prisma.organization.update({
    where: { id: organizationId },
    data: { settings: merged as unknown as Prisma.InputJsonValue },
  });
  return merged;
};

export const updateOrganization = async (
  organizationId: string,
  data: { name?: string; industry?: string | null },
) => prisma.organization.update({ where: { id: organizationId }, data });
