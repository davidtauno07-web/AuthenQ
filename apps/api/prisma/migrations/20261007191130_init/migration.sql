-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'TEAM',
    "region" TEXT NOT NULL DEFAULT 'default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("teamId","userId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prevTokenHash" TEXT,
    "csrfToken" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_events" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "email" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "orgId" UUID,
    "userId" UUID,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factors" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TOTP',
    "secretEnc" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_connections" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_accounts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "roleKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "service_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "serviceAccountId" UUID,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "stage" TEXT NOT NULL DEFAULT 'BETA',
    "description" TEXT NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "org_feature_flags" (
    "orgId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "org_feature_flags_pkey" PRIMARY KEY ("orgId","key")
);

-- CreateTable
CREATE TABLE "usage_events" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_limits" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "limit" DOUBLE PRECISION NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTH',

    CONSTRAINT "usage_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'TEAM',
    "status" TEXT NOT NULL DEFAULT 'BILLING_DISABLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_policies" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "retainDays" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "confirmedText" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_accounts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "credentialsEnc" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastHealthAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "connector_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_syncs" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "connector_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_jobs" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "connectorAccountId" UUID NOT NULL,
    "processingJobId" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseStatus" INTEGER,
    "responseSnippet" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "dataClass" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_versions" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "checkpoint" JSONB,
    "result" JSONB,
    "error" TEXT,
    "errorDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "actorId" UUID,
    "actorType" TEXT NOT NULL DEFAULT 'USER',
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "details" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "jobId" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_providers" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "connectorAccountId" UUID,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "currentScanId" UUID,
    "signedOffScanId" UUID,
    "signedOffAt" TIMESTAMP(3),
    "signedOffById" UUID,
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_tables" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "primaryKey" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "source_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_columns" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "dataType" TEXT NOT NULL DEFAULT 'string',
    "format" TEXT,
    "isPrimaryKey" BOOLEAN NOT NULL DEFAULT false,
    "isForeignKey" BOOLEAN NOT NULL DEFAULT false,
    "classification" TEXT NOT NULL DEFAULT 'UNSCANNED',
    "entityType" TEXT,
    "explanation" TEXT,
    "confidence" DOUBLE PRECISION,
    "decision" TEXT,
    "decisionSource" TEXT,
    "generalization" JSONB,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "source_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_relations" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "fromTable" TEXT NOT NULL,
    "fromColumn" TEXT NOT NULL,
    "toTable" TEXT NOT NULL,
    "toColumn" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MANY_TO_ONE',
    "confidence" DOUBLE PRECISION NOT NULL,
    "explanation" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "source_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_rows" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "source_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall_scans" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "classifierVersion" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "summary" JSONB,
    "jobId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "firewall_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall_findings" (
    "id" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "columnId" UUID NOT NULL,
    "classification" TEXT NOT NULL,
    "entityType" TEXT,
    "suggestedAction" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "stats" JSONB NOT NULL,

    CONSTRAINT "firewall_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firewall_decisions" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "columnId" UUID NOT NULL,
    "scanId" UUID,
    "previous" TEXT,
    "decision" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firewall_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synthetic_sets" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "algorithmVersion" TEXT NOT NULL,
    "firewallScanId" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "safetyPassed" BOOLEAN,
    "qualityReport" JSONB,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "canaryCount" INTEGER NOT NULL DEFAULT 0,
    "jobId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "synthetic_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synthetic_rows" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "tableName" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "syntheticKey" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "synthetic_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canary_registry" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "syntheticRowId" UUID NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "generationMeta" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canary_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sends" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipientType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "projectId" UUID,
    "exportId" UUID,
    "recordCount" INTEGER NOT NULL,
    "sentById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exposures" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "sendId" UUID NOT NULL,
    "registryId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exposures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canary_scans" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "inputType" TEXT NOT NULL,
    "inputName" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "matchCount" INTEGER NOT NULL,
    "candidates" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "canary_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leak_alerts" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "scanId" UUID NOT NULL,
    "registryId" UUID NOT NULL,
    "matchedText" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leak_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_projects" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "purpose" TEXT NOT NULL DEFAULT '',
    "setId" UUID NOT NULL,
    "sendId" UUID NOT NULL,
    "tableName" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'CLASSIFICATION',
    "labelSchema" JSONB NOT NULL,
    "textFields" TEXT[],
    "contextFields" TEXT[],
    "sliceField" TEXT,
    "carryOverField" JSONB,
    "config" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SETUP',
    "activeGuidelineVersionId" UUID,
    "goldVersion" INTEGER NOT NULL DEFAULT 1,
    "goldLockedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "label_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_docs" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guideline_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guideline_versions" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "docId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "decisionTree" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT NOT NULL DEFAULT '',
    "fileId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "guideline_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "example_bank" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID,
    "text" TEXT NOT NULL,
    "labels" JSONB NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "example_bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "syntheticRowId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorityReason" TEXT,
    "sliceValue" TEXT,
    "assignedToId" UUID,
    "finalLabels" JSONB,
    "finalSource" TEXT,
    "finalLabelId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID,
    "values" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "engineRunId" UUID,
    "engineItemId" UUID,
    "guidelineVersionId" UUID,
    "goldVersion" INTEGER,
    "durationMs" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gold_records" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "split" TEXT NOT NULL,
    "sampling" TEXT NOT NULL,
    "selectionReason" TEXT NOT NULL,
    "requiredLabels" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "finalLabels" JSONB,
    "goldVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gold_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjudications" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "goldRecordId" UUID,
    "labelIds" TEXT[],
    "finalValues" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "adjudicatorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjudications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_runs" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "engineType" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "guidelineVersionId" UUID,
    "goldVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "estimate" JSONB NOT NULL,
    "spendCap" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totals" JSONB,
    "jobId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "engine_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_items" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "predicted" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "ruleCited" TEXT,
    "modelInfo" JSONB NOT NULL,
    "passes" JSONB NOT NULL,
    "routing" TEXT NOT NULL,
    "routingReason" TEXT NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "guidelineVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setup_trials" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_trials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "options" JSONB NOT NULL,
    "gate" JSONB,
    "safety" JSONB,
    "manifest" JSONB,
    "dataCard" JSONB,
    "overrideReason" TEXT,
    "overrideById" UUID,
    "fileId" UUID,
    "recordCount" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "jobId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "facts" JSONB,
    "proposal" JSONB,
    "proposalStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_orgId_key_key" ON "roles"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_orgId_userId_key" ON "organization_members"("orgId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_orgId_name_key" ON "teams"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_prevTokenHash_key" ON "sessions"("prevTokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");

-- CreateIndex
CREATE INDEX "login_events_email_createdAt_idx" ON "login_events"("email", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_orgId_createdAt_idx" ON "security_events"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "mfa_factors_userId_idx" ON "mfa_factors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sso_connections_orgId_domain_key" ON "sso_connections"("orgId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "service_accounts_orgId_name_key" ON "service_accounts"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_keyHash_key" ON "api_keys"("keyHash");

-- CreateIndex
CREATE INDEX "api_keys_orgId_idx" ON "api_keys"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "settings_orgId_key_key" ON "settings"("orgId", "key");

-- CreateIndex
CREATE INDEX "usage_events_orgId_metric_createdAt_idx" ON "usage_events"("orgId", "metric", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "usage_limits_orgId_metric_key" ON "usage_limits"("orgId", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_orgId_key" ON "billing_accounts"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "data_retention_policies_orgId_resourceType_key" ON "data_retention_policies"("orgId", "resourceType");

-- CreateIndex
CREATE INDEX "deletion_requests_orgId_createdAt_idx" ON "deletion_requests"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "consent_records_orgId_key_idx" ON "consent_records"("orgId", "key");

-- CreateIndex
CREATE INDEX "connector_accounts_orgId_idx" ON "connector_accounts"("orgId");

-- CreateIndex
CREATE INDEX "connector_syncs_connectorAccountId_startedAt_idx" ON "connector_syncs"("connectorAccountId", "startedAt");

-- CreateIndex
CREATE INDEX "connector_jobs_connectorAccountId_idx" ON "connector_jobs"("connectorAccountId");

-- CreateIndex
CREATE INDEX "webhook_endpoints_orgId_idx" ON "webhook_endpoints"("orgId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_createdAt_idx" ON "webhook_deliveries"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "files_orgId_purpose_idx" ON "files"("orgId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_fileId_version_key" ON "file_versions"("fileId", "version");

-- CreateIndex
CREATE INDEX "processing_jobs_status_runAfter_idx" ON "processing_jobs"("status", "runAfter");

-- CreateIndex
CREATE INDEX "processing_jobs_orgId_createdAt_idx" ON "processing_jobs"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "processing_jobs_resourceType_resourceId_idx" ON "processing_jobs"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "job_events_jobId_createdAt_idx" ON "job_events"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_orgId_readAt_idx" ON "notifications"("userId", "orgId", "readAt");

-- CreateIndex
CREATE INDEX "saved_views_projectId_idx" ON "saved_views"("projectId");

-- CreateIndex
CREATE INDEX "comments_orgId_resourceType_resourceId_idx" ON "comments"("orgId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "activity_log_orgId_createdAt_idx" ON "activity_log"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_log_orgId_resourceType_resourceId_idx" ON "activity_log"("orgId", "resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_providers_orgId_name_key" ON "ai_providers"("orgId", "name");

-- CreateIndex
CREATE INDEX "data_sources_orgId_deletedAt_idx" ON "data_sources"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "source_tables_sourceId_name_key" ON "source_tables"("sourceId", "name");

-- CreateIndex
CREATE INDEX "source_columns_sourceId_idx" ON "source_columns"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "source_columns_tableId_name_key" ON "source_columns"("tableId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "source_relations_sourceId_fromTable_fromColumn_toTable_toCo_key" ON "source_relations"("sourceId", "fromTable", "fromColumn", "toTable", "toColumn");

-- CreateIndex
CREATE INDEX "source_rows_sourceId_idx" ON "source_rows"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "source_rows_tableId_rowIndex_key" ON "source_rows"("tableId", "rowIndex");

-- CreateIndex
CREATE UNIQUE INDEX "firewall_scans_sourceId_version_key" ON "firewall_scans"("sourceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "firewall_findings_scanId_columnId_key" ON "firewall_findings"("scanId", "columnId");

-- CreateIndex
CREATE INDEX "firewall_decisions_columnId_createdAt_idx" ON "firewall_decisions"("columnId", "createdAt");

-- CreateIndex
CREATE INDEX "synthetic_sets_orgId_deletedAt_idx" ON "synthetic_sets"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "synthetic_sets_sourceId_version_key" ON "synthetic_sets"("sourceId", "version");

-- CreateIndex
CREATE INDEX "synthetic_rows_setId_tableName_syntheticKey_idx" ON "synthetic_rows"("setId", "tableName", "syntheticKey");

-- CreateIndex
CREATE UNIQUE INDEX "synthetic_rows_setId_tableName_rowIndex_key" ON "synthetic_rows"("setId", "tableName", "rowIndex");

-- CreateIndex
CREATE INDEX "canary_registry_orgId_normalized_idx" ON "canary_registry"("orgId", "normalized");

-- CreateIndex
CREATE INDEX "canary_registry_orgId_signature_idx" ON "canary_registry"("orgId", "signature");

-- CreateIndex
CREATE INDEX "canary_registry_setId_idx" ON "canary_registry"("setId");

-- CreateIndex
CREATE INDEX "sends_orgId_createdAt_idx" ON "sends"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "exposures_registryId_idx" ON "exposures"("registryId");

-- CreateIndex
CREATE UNIQUE INDEX "exposures_sendId_registryId_key" ON "exposures"("sendId", "registryId");

-- CreateIndex
CREATE INDEX "canary_scans_orgId_createdAt_idx" ON "canary_scans"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "leak_alerts_orgId_status_idx" ON "leak_alerts"("orgId", "status");

-- CreateIndex
CREATE INDEX "label_projects_orgId_deletedAt_idx" ON "label_projects"("orgId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_projectId_userId_key" ON "project_members"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "guideline_versions_docId_version_key" ON "guideline_versions"("docId", "version");

-- CreateIndex
CREATE INDEX "example_bank_projectId_idx" ON "example_bank"("projectId");

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "tasks_projectId_priority_idx" ON "tasks"("projectId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_projectId_syntheticRowId_key" ON "tasks"("projectId", "syntheticRowId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_projectId_ordinal_key" ON "tasks"("projectId", "ordinal");

-- CreateIndex
CREATE INDEX "labels_projectId_kind_idx" ON "labels"("projectId", "kind");

-- CreateIndex
CREATE INDEX "labels_taskId_createdAt_idx" ON "labels"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "labels_userId_idx" ON "labels"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "gold_records_taskId_key" ON "gold_records"("taskId");

-- CreateIndex
CREATE INDEX "gold_records_projectId_split_status_idx" ON "gold_records"("projectId", "split", "status");

-- CreateIndex
CREATE INDEX "adjudications_projectId_idx" ON "adjudications"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "engine_runs_projectId_runNumber_key" ON "engine_runs"("projectId", "runNumber");

-- CreateIndex
CREATE INDEX "engine_items_projectId_routing_reviewStatus_idx" ON "engine_items"("projectId", "routing", "reviewStatus");

-- CreateIndex
CREATE INDEX "engine_items_projectId_confidence_idx" ON "engine_items"("projectId", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "engine_items_runId_taskId_key" ON "engine_items"("runId", "taskId");

-- CreateIndex
CREATE INDEX "setup_trials_projectId_idx" ON "setup_trials"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "exports_projectId_version_key" ON "exports"("projectId", "version");

-- CreateIndex
CREATE INDEX "chat_messages_projectId_createdAt_idx" ON "chat_messages"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "service_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_feature_flags" ADD CONSTRAINT "org_feature_flags_key_fkey" FOREIGN KEY ("key") REFERENCES "feature_flags"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_syncs" ADD CONSTRAINT "connector_syncs_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_jobs" ADD CONSTRAINT "connector_jobs_connectorAccountId_fkey" FOREIGN KEY ("connectorAccountId") REFERENCES "connector_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "processing_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_tables" ADD CONSTRAINT "source_tables_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_columns" ADD CONSTRAINT "source_columns_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_columns" ADD CONSTRAINT "source_columns_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_rows" ADD CONSTRAINT "source_rows_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firewall_scans" ADD CONSTRAINT "firewall_scans_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firewall_findings" ADD CONSTRAINT "firewall_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "firewall_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firewall_findings" ADD CONSTRAINT "firewall_findings_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "source_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firewall_decisions" ADD CONSTRAINT "firewall_decisions_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "source_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthetic_sets" ADD CONSTRAINT "synthetic_sets_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthetic_rows" ADD CONSTRAINT "synthetic_rows_setId_fkey" FOREIGN KEY ("setId") REFERENCES "synthetic_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sends" ADD CONSTRAINT "sends_setId_fkey" FOREIGN KEY ("setId") REFERENCES "synthetic_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposures" ADD CONSTRAINT "exposures_sendId_fkey" FOREIGN KEY ("sendId") REFERENCES "sends"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposures" ADD CONSTRAINT "exposures_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "canary_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leak_alerts" ADD CONSTRAINT "leak_alerts_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "canary_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leak_alerts" ADD CONSTRAINT "leak_alerts_registryId_fkey" FOREIGN KEY ("registryId") REFERENCES "canary_registry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_projects" ADD CONSTRAINT "label_projects_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_docs" ADD CONSTRAINT "guideline_docs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guideline_versions" ADD CONSTRAINT "guideline_versions_docId_fkey" FOREIGN KEY ("docId") REFERENCES "guideline_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "example_bank" ADD CONSTRAINT "example_bank_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_syntheticRowId_fkey" FOREIGN KEY ("syntheticRowId") REFERENCES "synthetic_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gold_records" ADD CONSTRAINT "gold_records_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gold_records" ADD CONSTRAINT "gold_records_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_items" ADD CONSTRAINT "engine_items_runId_fkey" FOREIGN KEY ("runId") REFERENCES "engine_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_items" ADD CONSTRAINT "engine_items_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "label_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
