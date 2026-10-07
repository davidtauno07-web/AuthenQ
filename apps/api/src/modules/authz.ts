/**
 * Role-based access control. Permissions are enforced server-side on every
 * route through `requirePermission`; the frontend only mirrors them for UX.
 */
export const PERMISSIONS = {
  'org.manage': 'Manage organization profile, plan and policies',
  'members.manage': 'Invite, remove and change roles of members',
  'sources.read': 'View data sources and Firewall results (metadata only)',
  'sources.write': 'Create data sources, upload data and run Firewall scans',
  'sources.real.preview': 'Preview real source values inside the Firewall boundary',
  'firewall.decide': 'Override Firewall classifications',
  'firewall.signoff': 'Sign off a Firewall scan',
  'synthetic.read': 'View synthetic sets and quality reports',
  'synthetic.write': 'Generate synthetic sets and send them to labeling',
  'canary.read': 'View Canary registry, sends and alerts',
  'canary.scan': 'Scan text and files with Canary and manage alerts',
  'labeling.read': 'View labeling projects and analytics',
  'labeling.label': 'Label tasks in the workspace',
  'labeling.review': 'Review engine output and adjudicate',
  'labeling.manage': 'Configure projects, labels, guidelines and members',
  'gold.manage': 'Sample, split and lock the Gold Set',
  'engine.run': 'Configure, estimate and run the labeling engine',
  'quality.read': 'View quality reports',
  'exports.read': 'View and download exports',
  'exports.create': 'Create exports',
  'exports.override': 'Record an override reason for a blocked export gate',
  'activity.read': 'View activity, lineage and audit logs',
  'settings.manage': 'Manage organization settings',
  'apikeys.manage': 'Manage API keys and service accounts',
  'webhooks.manage': 'Manage webhook endpoints',
  'connectors.manage': 'Manage connectors and credentials',
  'ai.manage': 'Manage AI provider configuration',
  'security.read': 'View security and login events',
  'deletion.manage': 'Delete projects, sources, sets and exports',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: PermissionKey[] }> = {
  ADMIN: { name: 'Admin', description: 'Full control of the organization', permissions: ALL },
  PROJECT_MANAGER: {
    name: 'Project Manager',
    description: 'Runs labeling projects, gold sets, engine runs and exports',
    permissions: [
      'sources.read', 'synthetic.read', 'synthetic.write', 'canary.read', 'labeling.read', 'labeling.label',
      'labeling.review', 'labeling.manage', 'gold.manage', 'engine.run', 'quality.read', 'exports.read',
      'exports.create', 'exports.override', 'activity.read',
    ],
  },
  DATA_ENGINEER: {
    name: 'Data Engineer',
    description: 'Connects sources, runs Firewall and Twin',
    permissions: [
      'sources.read', 'sources.write', 'sources.real.preview', 'firewall.decide', 'synthetic.read', 'synthetic.write',
      'canary.read', 'canary.scan', 'labeling.read', 'quality.read', 'exports.read', 'activity.read', 'connectors.manage',
    ],
  },
  REVIEWER: {
    name: 'Reviewer',
    description: 'Reviews engine output and adjudicates disagreements',
    permissions: ['labeling.read', 'labeling.label', 'labeling.review', 'quality.read', 'synthetic.read'],
  },
  LABELER: { name: 'Labeler', description: 'Labels assigned synthetic records', permissions: ['labeling.read', 'labeling.label'] },
  VIEWER: {
    name: 'Viewer',
    description: 'Read-only access to non-sensitive metadata and reports',
    permissions: ['sources.read', 'synthetic.read', 'canary.read', 'labeling.read', 'quality.read', 'exports.read', 'activity.read'],
  },
};

export const API_KEY_SCOPES = ALL.filter((p) => !['members.manage', 'apikeys.manage', 'org.manage', 'sources.real.preview'].includes(p));
