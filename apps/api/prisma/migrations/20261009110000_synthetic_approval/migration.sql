ALTER TABLE "synthetic_sets"
  ADD COLUMN "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "approvalReason" TEXT,
  ADD COLUMN "approvedById" UUID,
  ADD COLUMN "approvedAt" TIMESTAMP(3);
-- Sets generated before human approval existed were already in use; keep them usable.
UPDATE "synthetic_sets" SET "approvalStatus" = 'APPROVED' WHERE "status" = 'READY';
