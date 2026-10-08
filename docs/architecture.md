# Architecture

## Pipeline and data boundaries

```
             ┌────────────── Firewall boundary (real data) ──────────────┐
 upload / ─▶ │ DataSource → SourceTable/SourceColumn → SourceRow (real)  │
 connector   │ FirewallScan → FirewallFinding → FirewallDecision → sign-off│
             └───────────────────────────┬───────────────────────────────┘
                                         │ Twin (seeded generation, safety check)
                                         ▼
             SyntheticSet → SyntheticRow ──▶ CanaryRegistry (HMAC signatures)
                                         │ explicit "Send to labeling" (Send + Exposure)
                                         ▼
             LabelProject → Task → Label / GoldRecord / EngineRun / EngineItem
                                         ▼
             Export (ZIP: data, manifest, data card, lineage, checksums, safety)
```

- `SourceRow` is the **only** table holding real rows. Everything after the Firewall reads `SyntheticRow`.
- Sending synthetic rows to labeling is an explicit, confirmed user action that records a `Send` and per-value `Exposure` rows for Canary lineage.
- Exports re-check every output record against the real sensitive values in the Firewall; any match blocks the export.
- External AI (`apps/api/src/domain/aiGateway.ts`) only accepts payload parts classed `SYNTHETIC`, `GUIDELINE`, `AGGREGATE` or `METADATA`; `REAL` is rejected before a request is built.

## Code layout

```
apps/api/src
  config/     environment parsing and production guards
  domain/     pure engines: firewall, twin, canary, engine (Naive Bayes), quality, aiGateway, demoData
  services/   orchestration + persistence per module (tenant-scoped)
  routes/     HTTP routes (zod-validated) → services
  modules/    auth (sessions, MFA, tokens), authz (roles/permissions), audit, context
  middleware/ auth, CSRF, rate limiting, errors
  worker/     job handlers and the worker process
  modules/jobs durable PostgreSQL job queue
  lib/        prisma, crypto, storage, zip, prng, logger
apps/web/src
  components/ layout shell, command palette, UI primitives
  pages/      one file per module
  lib/        API client (CSRF), React Query hooks, auth context, formatting
```

## Jobs, locks and rate limiting

The brief names Redis/BullMQ. This build uses PostgreSQL for the same responsibilities so a single database is enough to run AuthenQ:

- **Durable queue** — `ProcessingJob` + `JobEvent`. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, heartbeat while running, checkpoint progress, and support retry with backoff, cancel, pause and resume. Stale locks (no heartbeat) are reclaimed.
- **Rate limiting** — fixed-window counters in `RateLimitBucket`.
- **Locks** — row-level locks and status transitions inside transactions.

The queue is behind `modules/jobs/queue.ts`; moving to BullMQ/Redis later only touches that module and the worker entry point.

## Storage

`lib/storage.ts` provides `local` (filesystem, default for development) and `s3` (AWS S3, MinIO, or any S3-compatible service) drivers. Downloads use short-lived signed URLs (HMAC for local, presigned for S3). Only export packages can be downloaded through a signed link.

## Determinism

Twin generation, engine token dropout, gold sampling and audit sampling use a seeded PRNG (`lib/prng.ts`), so the same inputs and seed always produce the same output. Versions are recorded on every artifact (`firewall-rules-*`, `twin-*`, `demo-nb-*`).
