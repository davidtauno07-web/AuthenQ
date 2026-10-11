ALTER TABLE "data_sources"
  ADD COLUMN "retentionPolicy" TEXT NOT NULL DEFAULT 'KEEP_UNTIL_DELETED',
  ADD COLUMN "retentionDays" INTEGER,
  ADD COLUMN "retentionUntil" TIMESTAMP(3),
  ADD COLUMN "sourcePurgedAt" TIMESTAMP(3);

CREATE TABLE "deletion_records" (
  "id" UUID NOT NULL,
  "orgId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "items" JSONB NOT NULL DEFAULT '[]',
  "limitations" JSONB NOT NULL DEFAULT '[]',
  "requestedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "deletion_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "deletion_records_orgId_sourceId_idx" ON "deletion_records"("orgId", "sourceId");
