# API

Base path: `/api/v1`. JSON in and out. Errors use `{ "error": { "code", "message", "details?", "requestId" } }`.

## Authentication

- **Browser**: session cookie from `POST /auth/login`; send `x-csrf-token` (value of the `aq_csrf` cookie) on every non-GET request.
- **Machines**: `Authorization: Bearer aq_…` API keys (Settings → API keys). A key can do only what both its scopes and its service-account role allow.

## Main resources

| Area | Endpoints |
| --- | --- |
| Firewall | `GET/POST /sources`, `GET/DELETE /sources/:id`, `POST /sources/:id/upload`, `POST /sources/:id/scan`, `PATCH /columns/:id/decision`, `POST /sources/:id/sign-off` |
| Twin | `POST /sources/:id/synthetic-sets`, `GET /synthetic-sets`, `GET /synthetic-sets/:id`, `GET /synthetic-sets/:id/rows`, `POST /send-to-labeling` |
| Canary | `GET /canary/overview`, `GET /canary/registry`, `GET /canary/registry/:id`, `GET /canary/sends`, `GET/PATCH /canary/alerts`, `POST /canary/scan`, `POST /canary/scan-export/:id` |
| Labeling | `/projects`, `/projects/:id/{guidelines,examples,tasks,labels,views,gold,engine,trials,review,quality,exports}` |
| Platform | `/dashboard`, `/search`, `/jobs`, `/activity`, `/notifications`, `/org`, `/members`, `/roles`, `/api-keys`, `/webhooks`, `/settings`, `/feature-flags/:key`, `/usage`, `/security/events`, `/ai-providers`, `/connectors` |

Long-running work (scans, generation, engine runs, exports, imports) returns a job; poll `GET /jobs/:id` or subscribe to webhooks.

## Webhooks

Events are listed in Settings → Webhooks. Each delivery has `x-authenq-event`, `x-authenq-delivery` and `x-authenq-signature: t=<unix>,v1=<hex>` where `v1 = HMAC_SHA256(secret, "<t>.<raw body>")`. Reject deliveries older than five minutes. Failed deliveries retry with exponential backoff and can be redelivered manually.
