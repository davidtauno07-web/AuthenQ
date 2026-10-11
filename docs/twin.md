# Twin pattern learning and review

Twin (`twin-2.0`, patterns `patterns-1.0`) generates synthetic data that keeps the **structure** of the source, never its identities.

## Pattern learning

For each column set to Replace, Twin learns from aggregate statistics only. Any group seen fewer than 5 times is ignored.

- **Phone numbers:** country and network prefixes (for example `+264 81`, or `081` and `085`) and the digit-group format.
- **Identifiers:** literal prefixes (`NA`, `CUS-`), length and character shape.
- **Email:** shared domains and address style (first.last, f.last…). Domains used by fewer than 5 records are replaced with reserved example domains.
- **Dates:** format (YYYY-MM-DD, DD/MM/YYYY…) and the 5th–95th percentile year range.
- **Names:** number of name parts. Names come from a built-in synthetic list.
- **Postcodes and generic values:** common shapes and lengths.

Every generated value is checked against real values and earlier generated values, so it never collides with either. The quality report records each learned pattern, its confidence, what it preserves, its limitations and its **conformance** (the share of generated values that use a source format). The Pattern conformance metric has a threshold of 90%.

## Review stages

1. **Before generation:** `GET /sources/:id/twin-plan` shows how each column will be treated. Each replaced column can use `PATTERN` (the default) or `GENERIC`. A weak pattern (confidence below 60%) blocks generation until the reviewer switches it to Generic or sends `acknowledgeReview: true`. The chosen strategies are stored on the set and in the audit log.
2. **After generation:** sets start as `approvalStatus = PENDING`. `POST /synthetic-sets/:id/review` (permission `firewall.signoff`) approves or rejects the set. Rejecting needs a reason. Approving with any check outside its threshold also needs a reason. Only approved sets can be sent to labeling.
3. **Comparison:** `GET /synthetic-sets/:id/compare?table=` (permission `sources.real.preview`) shows up to 20 real and 20 synthetic rows next to each other. The rows are not paired, and every view is audited.

## Limitations

- Patterns are learned from the source itself; no external country reference data is bundled.
- The pre-generation plan learns from the first 5,000 rows of each table, while generation learns from all rows.
