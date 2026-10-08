# Configuration

All configuration is read from environment variables (the API and worker load `.env` from the repository root when present). Copy `.env.example` to `.env`.

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | yes | `development`, `test` or `production`. Production enables secure cookies and stricter guards. |
| `APP_URL` | yes | Public URL of the web app; used in emails and CORS/cookie settings. |
| `API_PORT` | no | API port (default 4000). The Vite dev server proxies `/api` to it. |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `SESSION_SECRET` | yes | 32+ characters. Signs session material. Production refuses placeholder values. |
| `ENCRYPTION_KEY` | yes | 32+ characters. AES-256-GCM key for connector credentials, webhook secrets, AI keys and MFA secrets. |
| `CANARY_SECRET` | yes | 32+ characters. HMAC key for Canary signatures. Rotating it invalidates existing signatures. |
| `SESSION_TTL_HOURS` | no | Session lifetime. |
| `SESSION_ROTATE_MINUTES` | no | How often an active session's token is rotated. |
| `STORAGE_DRIVER` | no | `local` (default) or `s3`. |
| `STORAGE_LOCAL_DIR` | no | Directory for the local driver (relative to the API working directory). |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | for `s3` | S3-compatible storage. For MinIO run `docker compose --profile s3 up -d` and use path-style. |
| `WORKER_CONCURRENCY` | no | Jobs processed in parallel per worker process. |
| `WORKER_POLL_MS` | no | Queue poll interval. |
| `EMAIL_DRIVER` | no | `log` (development: links are written to the API log) or `smtp`. |
| `SMTP_URL`, `EMAIL_FROM` | for `smtp` | Mail transport. Quote `EMAIL_FROM` if it contains spaces or `<>`. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY` | no | Optional defaults for external AI providers. Providers can also be configured per organization in Settings → AI providers. |
| `DEMO_PASSWORD` | seed only | Password for the seeded demo accounts. Never use in production. |

## Organization settings and feature flags

Admins manage these in **Settings → Feature flags & policies**:

- `engine.external_ai` (beta, off by default) — allow engine runs through an external AI provider.
- `canary.api_scan` — allow API keys with the `canary.scan` scope to submit text for scanning.
- Policies: `retention.days`, `export.requireOverrideApproval`, `workspace.shortcuts`, `security.sessionHours`, `security.requireMfa`.
