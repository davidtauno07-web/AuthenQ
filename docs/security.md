# Security

## Tenancy and authorization

- Every tenant-owned row carries `orgId`; services always filter by the caller's organization, and lookups by id return **404** for other organizations' records (no existence leak).
- Authorization is enforced server-side with permission keys (`requirePermission(...)`); the UI only hides what the server would refuse anyway.
- System roles: Admin, Project manager, Data engineer, Reviewer, Labeler, Viewer. The matrix is visible in Settings → Members & roles.
- Viewing real Firewall rows requires `sources.real.preview` and every preview is audited.

## Authentication

- Passwords hashed with scrypt; minimum 12 characters; account lockout with exponential back-off after repeated failures.
- HTTP-only, `SameSite=Lax` session cookie (`Secure` in production) with server-side sessions, rotation and revocation; "sign out everywhere".
- CSRF: every cookie-authenticated mutation must send `x-csrf-token` matching the session's token.
- Optional TOTP two-factor authentication; organizations can require it.
- Email verification, password reset and invitations use single-use hashed tokens with expiry. Reset responses never reveal whether an email exists.
- API keys (`aq_…`) are shown once, stored as SHA-256 hashes, scoped, bound to a service-account role, expire and can be revoked.

## Secrets

Connector credentials, webhook signing secrets, AI provider keys and MFA secrets are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) and only ever returned masked. Logs redact passwords, tokens, keys, secrets, credentials, row data and prompts. Production startup fails if any secret still has a placeholder value.

## Data protection

- Real rows live only in `SourceRow`. Twin replaces sensitive values (also inside free text via a real-value index and name-token scrub) and fails safety if any real value survives.
- Export packages are compared with all real sensitive values before completion; matches block the export.
- External AI receives synthetic data, guidelines and aggregates only; real data is rejected by the gateway.
- Webhook URLs must be HTTPS in production and cannot target private network ranges. Deliveries are signed (`x-authenq-signature: t=…,v1=HMAC-SHA256`).

## Input handling

zod validation on every route, JSON body size limit, upload size and extension allow-list, parameterized queries via Prisma, and rate limits on authentication, uploads and the API as a whole.

## Audit

`ActivityLog` records who did what, before/after values and request ids. A database trigger makes it append-only: `UPDATE` and `DELETE` are rejected (`activity_log is append-only`).

## Tests

`apps/api/tests/security.test.ts` covers tenant isolation/IDOR, authentication, lockout, CSRF, RBAC, malformed JSON, prototype pollution, SQL-injection-shaped input, upload rejection, API key hashing, webhook/AI secret handling, signed-link tampering and audit immutability. `apps/api/tests/domain.test.ts` covers the real-data-to-AI block and Twin leak prevention.
