ALTER TABLE "canary_registry" ADD COLUMN "fuzzyKey" TEXT;
CREATE INDEX "canary_registry_orgId_fuzzyKey_idx" ON "canary_registry"("orgId", "fuzzyKey");

UPDATE "canary_registry" SET "fuzzyKey" = 'd:' || right("normalized", 7)
  WHERE "entityType" IN ('PHONE', 'CREDIT_CARD', 'GOVERNMENT_ID', 'FINANCIAL_ACCOUNT') AND length("normalized") >= 7;
UPDATE "canary_registry" SET "fuzzyKey" = 'e:' || split_part("normalized", '@', 1)
  WHERE "entityType" = 'EMAIL' AND length(split_part("normalized", '@', 1)) >= 5;
UPDATE "canary_registry" SET "fuzzyKey" = 'n:' || array_to_string(ARRAY(SELECT unnest(string_to_array("normalized", ' ')) AS t ORDER BY t), ' ')
  WHERE "entityType" = 'PERSON_NAME' AND position(' ' IN "normalized") > 0;

ALTER TABLE "leak_alerts"
  ADD COLUMN "matchType" TEXT NOT NULL DEFAULT 'NORMALIZED',
  ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN "assignedToId" UUID;
