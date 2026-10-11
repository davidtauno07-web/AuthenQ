# Canary

Twin registers every value it generates for a replaced sensitive column. Each registration stores the value, a normalised form, a keyed HMAC signature (`CANARY_SECRET`) and a fuzzy key for approximate matching. A set's Canary count is only reported after every registration has been written; if registration fails, the generation job fails instead of reporting partial traceability.

## Exposure history

An exposure is recorded only when a real send happens: a labeling project, an export or an external tool. It holds the recipient, the channel, the project or export and the time. Copies made after a send are not visible.

## Scanning ("Was my data used?")

`POST /canary/scan` accepts pasted text or a TXT, CSV, TSV, JSON, JSONL, MD or LOG file. `POST /canary/scan-export/:id` scans an AuthenQ export package.

| Match type | How it matches | Confidence |
| --- | --- | --- |
| Exact | The registered value appears unchanged | 100% |
| Normalized | Same value with different case, spacing or punctuation (phones and IDs compared by digits) | 95% |
| Approximate | Same last 7 digits with a different prefix, or the same name parts in a different order | 70–75% |
| Heuristic | Same email name before the @ on a different domain | 45% |

Every hit is checked against its signature. The result gives a verdict: `FOUND` (at least one exact or normalized match), `POSSIBLE` (approximate or heuristic matches only) or `NOT_FOUND`. It also lists who the matched values were previously sent to, plus the scan's limitations.

## Investigating alerts

Each match creates a persistent leak alert with its match type, confidence, matched text and context. Alerts can be searched and filtered by status, match type and assignee, and assigned to an active member. Statuses: `OPEN`, `INVESTIGATING`, `REVIEWED`, `RESOLVED` and `FALSE_POSITIVE`. Closing an alert needs a note. Notes are added to the alert with a time stamp and the author's name, and every change goes into the activity log.

## Limitations

- A scan without matches does not prove that no leak happened elsewhere or in another form.
- Only replaced sensitive values are registered. Kept categories, numbers and generalised values cannot be traced.
- Approximate and heuristic matches can be coincidences.
- Only text is scanned. Images, PDFs and archives other than AuthenQ export packages are not read.
