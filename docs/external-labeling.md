# Labeling outside AuthenQ

Project managers (`labeling.manage`) can label a project's records in another tool, from the project's Export page.

## Export

`POST /projects/:projectId/external-export` with `{ format: "csv" | "json" | "jsonl", recipient, onlyUnlabeled }` returns a ZIP containing:

- `data.<format>`: one record per task with `authenq_task_id`, `record_number`, the project's text and context fields, and empty `label` and `note` columns.
- `manifest.json`: the project, synthetic set, labels, columns, record count and SHA-256 checksum of the data file.
- `README.md`: instructions and label definitions.

Only synthetic rows are exported, and locked test records are always left out. Every export is recorded as a Canary send (`EXTERNAL_TOOL`), with exposures for each registered value, and added to the activity log.

## Import

`POST /projects/:projectId/external-import` (multipart `file`, CSV/TSV/JSON/JSONL up to 10 MB and 50,000 rows). The `dryRun` field defaults to `true`, so a request only validates unless it sets `dryRun` to `false`.

Validation reports, per row:

- a missing or unknown `authenq_task_id`, or the same record appearing twice;
- a label that is not in the project (matching ignores case);
- a gold or locked test record (gold is labeled in AuthenQ only).

Rows with an empty label are skipped. A label that disagrees with an existing human or reviewed label is a **conflict**: the import keeps it but leaves the current final label unchanged and flags the task (status `FLAGGED`) so a project manager can resolve it from the grid's Flagged filter.

The import refuses to run if any rows have problems, unless `acceptErrors=true` confirms that only the valid rows should be imported. Imported labels have source `EXTERNAL_IMPORT` and a batch ID in their note, so they appear separately in quality reports and provenance.
