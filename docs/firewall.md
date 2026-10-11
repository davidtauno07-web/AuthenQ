# Firewall classification and review

The Firewall scans a sample of each column (up to the configured sample size, spread evenly over the table) and classifies it as **Sensitive**, **Non-sensitive**, **Needs decision**, **Outcome** or **Identifier**. Classifier version: `firewall-profile-2.0` (recorded on every scan).

## Signals

- **Column name** — known naming patterns (email, phone, name, address, birth date, postal code, gender, credentials…).
- **Values** — format patterns (email, phone, IBAN, IP, card numbers with Luhn check, dates), personal-name shape, embedded entities in free text, and words shared with name columns elsewhere in the source.
- **Schema** — inferred primary keys and foreign-key relationships.
- **Profile** — empty share, uniqueness, length range, numeric range, value shapes (`A` = capital, `a` = small letter, `9` = digit), common prefixes (phone country/area codes, ID prefixes) and email domains.
- **Combination risk** — two or more quasi-identifiers in one table (postal code, birth date, city, special-category data) are flagged together, because combined they can re-identify people.

Name and value evidence are combined: agreement raises confidence; a name that does not match its values (for example `email` holding segment codes) lowers confidence to at most 60% and records a limitation. Values alone can classify a column (phone numbers, personal names) when the name gives no hint.

## What each finding shows

Classification, entity type, confidence, explanation, suggested transformation, data type and format, evidence, limitations (sample size, empty values, unsampled rows, free-text detection limits, combination risk) and the safe profile.

**Profiles are aggregate-only.** Any shape, prefix or domain seen fewer than 5 times in the sample is suppressed, so no individual real value can be read from a profile. Real values are only visible through the separately permissioned, audited preview.

## Review workflow

Classification review and the transformation decision are separate steps.

1. **Classification review** (`PATCH /columns/:id/classification`, permission `firewall.decide`):
   - `APPROVE` — the classification is correct.
   - `CHANGE` — set Sensitive, Non-sensitive, Outcome or Identifier (identifier only for key columns). Reason required. The classifier's original result is kept in `systemClassification`; an invalid transformation (for example Keep on a column changed to Sensitive) is reset to a safe one and logged.
   - `REJECT` — the classification is wrong and needs investigation. Reason required. Sign-off stays blocked until it is changed.
2. **Bulk approval** (`POST /sources/:id/classifications/approve`) approves pending confident classifications. Uncertain ones are only included with `includeUncertain: true` and a reason.
3. **Transformation decision** (`PATCH /columns/:id/decision`) — unchanged: overriding a suggestion needs a reason; sensitive columns cannot be kept.

Every review is written to the activity log with before/after state and the reason.

## Gate

Sign-off (and therefore Twin) is blocked while any column:

- is unscanned;
- has an uncertain classification (`needsReview`: Needs decision, confidence below 80%, name/value mismatch, value-only detection, or combination risk) that has not been approved or changed;
- has a rejected classification;
- is Needs decision without a human transformation decision;
- is sensitive and set to Keep, or uses Scrub text on a non-text column.

Any review or decision change after sign-off returns the source to Needs review.

## Rescans

Human classification changes survive rescans. An approval survives only if the classifier returns the same classification; otherwise the column goes back to pending review. Human transformation decisions always survive.

## Limitations

- Classification is based on a sample; rare values outside it are not inspected.
- Free-text detection is pattern-based and cannot find every personal detail (unknown names, indirect descriptions).
- Personal-name detection relies on capitalised name shapes and is tuned for Latin-script names.
