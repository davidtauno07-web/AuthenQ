-- An earlier migration approved existing READY sets automatically. Send them back for human review.
UPDATE "synthetic_sets" SET "approvalStatus" = 'PENDING', "approvalReason" = NULL WHERE "approvalStatus" = 'APPROVED' AND "approvedById" IS NULL;
