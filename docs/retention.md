# Source retention and deletion

Each data source has a retention policy for the **real** data AuthenQ holds. Admins (`firewall.signoff`) choose it on the source page.

| Policy | Behaviour |
| --- | --- |
| `KEEP_UNTIL_DELETED` (default) | Real data is kept so new synthetic sets can be generated and compared. |
| `DELETE_AFTER_APPROVED_TWIN` | Real data is deleted as soon as a synthetic set from this source is approved. |
| `DELETE_AFTER_DAYS` | Real data is deleted after 1–3650 days. |

## Where real data lives and who can read it

- Rows: the `source_rows` table in PostgreSQL, scoped by organisation.
- Uploaded files: `source-uploads/` in the configured storage (local disk or the S3 bucket).
- Readers: only the ingest, scan and Twin jobs, plus admins with `sources.real.preview` (the preview and the audited comparison). Labelers, reviewers, exports and external AI never receive real rows.

## Deletion

Deletion runs when a policy comes due (the worker checks every 15 minutes), when an admin uses **Delete real data now** (`POST /sources/:id/purge`, which needs `confirm` and a reason), or when the source is deleted. It:

1. Deletes the real rows, then counts them again.
2. Deletes each uploaded source file from storage, then tries to read it back to confirm it is gone.
3. Checks that no queued or running ingest, scan or Twin job could still read the data.
4. Writes a `DeletionRecord` with counts per item (found, deleted, remaining, verified) and the status `COMPLETED` or `PARTIAL`. It never stores source content, and the action is added to the activity log.

After deletion, Twin generation and source comparison are blocked for that source. Existing synthetic sets remain usable.

## What deletion does not cover

- Backups of the database or storage made before the deletion.
- Old object versions, if bucket versioning is on.
- Data in your own connected databases or buckets, which AuthenQ never modifies.
- Aggregate Firewall statistics. These are kept and contain no individual values.

AuthenQ therefore reports deletion as verified within AuthenQ's own storage, not as permanent erasure everywhere.
