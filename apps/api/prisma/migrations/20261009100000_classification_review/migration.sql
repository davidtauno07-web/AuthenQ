ALTER TABLE "source_columns"
  ADD COLUMN "systemClassification" TEXT,
  ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "reviewedById" UUID,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);
