# Operations

## Processes

| Process | Command | Scale |
| --- | --- | --- |
| API | `npm run start` (after `npm run build`) | Stateless; run several behind a load balancer. |
| Worker | `npm run start:worker` | Run one or more; jobs are claimed with `SKIP LOCKED`. |
| Web | static files in `apps/web/dist` | Serve from any static host/CDN; route `/api` to the API. |

## Deployment

1. Provision PostgreSQL 14+ and (optionally) S3-compatible storage.
2. Set environment variables (see [configuration.md](configuration.md)) with strong, unique secrets.
3. `npm ci && npm run build`
4. `npm run db:deploy` — applies pending migrations (never run `db:migrate` in production).
5. Start API and worker processes; publish `apps/web/dist`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, migrations, the demo seed, all tests and the build on every pull request.

## Health checks

- `GET /health/live` — process is up.
- `GET /health/ready` — database reachable; returns 503 otherwise. Use it for readiness probes.
- `GET /health` — service name and `APP_VERSION`.

## Monitoring

The API and worker log structured JSON (pino) with request ids and secret redaction. Ship stdout to your log platform and alert on `level >= 50`, on job failures (`ProcessingJob.status = FAILED`) and on new `LeakAlert` rows. Job progress and failures are visible to admins under **Jobs**.

## Backup and retention

Back up PostgreSQL (point-in-time recovery recommended) and the object storage bucket together. `retention.days` controls cleanup of completed jobs, scans and expired sessions.

## Rollback

- **Application**: redeploy the previous build; API and worker are stateless.
- **Database**: migrations are additive. If a release must be reverted after a migration, keep the new schema (old code ignores new columns/tables) or restore from the pre-deploy backup. Take a backup before every `db:deploy`.
- **Data**: synthetic sets, gold versions, guideline versions and exports are versioned and never overwritten, so a bad run can be superseded rather than edited.
