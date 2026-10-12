# Training readiness, splits and engine optimization

## Train / validation / test splits

Exports and the readiness check use the same split logic (`apps/api/src/domain/readiness.ts`).

- Gold records keep their split: locked test → `TEST`, tuning → `VALIDATION`.
- Every other labeled record follows the chosen strategy:
  - **Gold splits only** (default): `TRAIN`.
  - **Random**: deterministic hash of the export id, 80 / 10 / 10 by default.
  - **Stratified**: each label is spread across the splits in the same ratio.
  - **Grouped**: every non-gold record with the same slice value (for example the same customer) lands in one split. Needs at least 10 distinct groups; a slice with only a few categories is rejected with a clear message. Gold records keep their own split, so a group can only span splits through gold.
- **Leakage guard:** records whose normalized text (case, spacing and punctuation removed) is identical always share a split. If one of them is gold, the whole group follows the gold split.

## Readiness checks

`POST /api/v1/projects/:id/readiness` (permission `quality.read`, optional `splitStrategy` and `ratios`) returns the checks and an overall `ready` flag. The same report is written to `data_card.json` (`trainingReadiness`) in every export package.

| Check | Blocking | Meaning |
| --- | --- | --- |
| Empty records | yes | Labeled records with no text |
| Labels outside the schema | yes | Labels removed from the project since labeling |
| Conflicting duplicates | yes | Identical text with different labels |
| Leakage between splits | yes | Identical text in more than one split |
| Labels with too few examples | yes | Fewer than 10 records for a label |
| Flagged records | yes | Tasks flagged for a project manager (for example, external import conflicts) |
| Train, validation and test present | yes | Every split has at least one record |
| Duplicate records | no | Repeated text with the same label |
| Label imbalance | no | Largest / smallest label count above 20× |
| Unlabeled records | no | Records left out because they have no final label |

## Engine optimizer

`POST /api/v1/projects/:id/optimize` (permission `engine.run`) compares auto-accept thresholds 0.6–0.95 and 1, 3 or 5 self-consistency passes. The model is trained without the tuning split and scored on the final tuning gold only. **The locked test split is never read.** The recommendation is the setting with the lowest review rate whose auto-accepted labels reach the project's accuracy target, preferring fewer passes (time and cost scale with passes). Run the recommended setting as a setup trial before changing the project configuration.
