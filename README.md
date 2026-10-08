# AuthenQ

**The Integrated Data Protection & AI Readiness Suite** — from raw data to AI-ready data, safely.

AuthenQ turns an organization's real data into synthetic, traceable, labeled and quality-measured datasets that a company can use to train its own models:

```
Firewall → Twin → Canary → Autonomous Labeling → (your model)
```

| Module | What it does |
| --- | --- |
| **Firewall** | Ingests uploads (CSV, TSV, XLSX, JSON, JSONL) or a PostgreSQL connector, discovers tables/columns/relationships, classifies every column from samples (sensitive, identifier, outcome, free text…), explains each classification, accepts human overrides with reasons, versions scans and blocks sign-off until every decision is made. Real rows never leave this boundary. |
| **Twin** | Generates a seeded, reproducible synthetic copy that keeps schema, keys, parent–child relationships, distributions and formats, replaces sensitive values (including inside free text), supports multipliers and rare-case amplification, and reports structure, distribution, relationship, uniqueness, variety, format and safety metrics. Sets that fail safety are held. |
| **Canary** | Registers every generated replacement value with an HMAC signature and its origin (set, table, record, column, seed). Tracks sends/exposures, scans pasted text, files, export packages and API submissions with indexed matching, and raises leak alerts. A clean scan never claims that no leak happened. |
| **Autonomous Labeling** | Explicit, user-confirmed transfer of synthetic rows into a labeling project; guidelines with versions and decision trees; example bank; record and grid workspaces; gold sets with double labeling, adjudication, splits and locking; a deterministic demo engine (Naive Bayes + Laplace smoothing + seeded token dropout + rules + confidence routing); review and audit queues; quality metrics; export packages with manifest, data card, lineage, checksums and safety checks. |

The demo engine is a local statistical classifier, not an LLM. External AI providers (OpenAI-compatible, Anthropic, self-hosted) are optional, feature-flagged and receive only synthetic records, guidelines and aggregates — the gateway rejects real data before any request is made.

## Stack

npm workspaces monorepo, TypeScript throughout.

- `apps/api` — Express API + background worker, Prisma/PostgreSQL, local or S3-compatible object storage.
- `apps/web` — React + Vite single-page app (strict black-and-white design system).

PostgreSQL also backs the durable job queue, locks and rate-limit buckets (see [docs/architecture.md](docs/architecture.md)), so Redis is not required.

## Quick start (local)

Requirements: Node.js 20+ (22 recommended), PostgreSQL 14+ (local install or `docker compose up -d`).

```bash
git clone https://github.com/davidtauno07-web/AuthenQ.git
cd AuthenQ
npm install                # one install at the root for all workspaces
cp .env.example .env       # then edit DATABASE_URL, secrets and DEMO_PASSWORD
npm run db:setup           # apply migrations + generate the Prisma client
npm run db:seed            # optional: Support Tickets demo (300 customers / 800 tickets)
npm run dev                # API :4000, worker, web :5173
```

Open http://localhost:5173. With the demo seeded, sign in as `admin@authenq.demo` (or `pm@`, `engineer@`, `reviewer@`, `labeler@`, `labeler2@`, `viewer@authenq.demo`) with the `DEMO_PASSWORD` from your `.env`.

On Windows with a local PostgreSQL service, create the database and user first (e.g. in pgAdmin or `psql -U postgres`):

```sql
CREATE USER authenq WITH PASSWORD 'choose-a-password';
CREATE DATABASE authenq OWNER authenq;
```

and set `DATABASE_URL=postgresql://authenq:choose-a-password@localhost:5432/authenq?schema=public` in `.env`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API, worker and web with reload |
| `npm run build` | Compile API and build the web bundle |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript for both apps |
| `npm test` | API unit, security and acceptance tests + web tests |
| `npm run test:e2e` | Acceptance workflow against the seeded demo |
| `npm run db:migrate` | Create a new migration (development) |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:seed` | Seed the demo (`SEED_RESET=1` to recreate) |

## Documentation

- [docs/architecture.md](docs/architecture.md) — modules, data boundaries, queue and storage
- [docs/configuration.md](docs/configuration.md) — every environment variable
- [docs/security.md](docs/security.md) — tenancy, authorization, secrets, audit, AI data policy
- [docs/operations.md](docs/operations.md) — deployment, health checks, monitoring, backup and rollback
- [docs/demo.md](docs/demo.md) — the Support Tickets acceptance workflow
- [docs/api.md](docs/api.md) — API overview, API keys and webhooks
