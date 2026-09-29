# AuthenQ

Autonomous adversarial privacy and fairness testing around existing AI models and data pipelines. The prototype runs Privacy Shield, Fairness Sword, scheduled assessments, regression checks, alerts, downloadable Compliance Evidence Reports, and a simulated CI integration. The React workspace uses the supplied AuthenQ logo.

## Run locally

Requirements: Node.js 20+, npm, Docker Compose (or PostgreSQL with a matching connection string). Run commands from the repository root.

```sh
cp .env.example .env
# Change JWT_SECRET before using outside your local machine.
docker compose up -d postgres
npm ci
npm run db:setup
npm run db:seed
npm run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:4000`; `/api/health` returns job queue status. The Vite dev server proxies `/api` to the API. Seed login: `admin@authenq.demo` / `AuthenQ!Demo2026`; analyst and viewer accounts use the same fictional demo password. **Do not reuse demo credentials or development configuration in production.** Seeding replaces the demo tenant and its data; other organizations are retained.

Docker fallback: if the image is unavailable, create a PostgreSQL database/user matching `DATABASE_URL`, then run the same migration, generation, seed and dev commands. Reports are written to `storage/reports`; this directory is ignored by Git.

## One-click workflow

Sign in, select a dataset and model in Overview, and choose **Run full AuthenQ assessment**. The API queues one run and advances through sensitive-field detection, protected synthetic generation, adversarial privacy analysis, counterfactual model testing, metric evaluation, regression comparison, alerts, and PDF report generation. Follow stage progress in Test Runs, review flagged values in Alerts, and download evidence in Reports. Privacy Shield and Fairness Sword can also be run separately.

The seeded Northbank Financial demo contains fictional lending and hiring data, mock models, prior assessments, monitoring schedules, reports, and alerts. Routes enforce organization ownership and viewer/analyst/admin permissions. Dataset raw records remain on the server; the UI only receives schema, detections, protected synthetic previews, case summaries, and metrics.

## API and architecture

Express API routes (all tenant resources require bearer JWT):

| Area | Routes | Key operations |
| --- | --- | --- |
| Sessions | `/api/auth` | register organization, login, logout, password change, reset request/confirm, current user |
| Organization | `/api/organization` | settings, users/roles, audit entries |
| Inputs | `/api/data-sources`, `/api/datasets`, `/api/models` | register, scan, generate synthetic representation, test connections/providers |
| Testing | `/api/test-runs` | create privacy/fairness/full assessment, poll progress, results, counterfactual cases |
| Oversight | `/api/monitoring`, `/api/alerts`, `/api/dashboard` | scheduled runs, metric history, human triage, aggregated trends |
| Evidence | `/api/reports` | generate and download PDF/JSON/CSV |
| CI | `/api/integrations` | simulate pipeline events, manage API keys |

`database/schema.prisma` contains organization-scoped persistent entities. Prisma migrations live under `database/migrations`. Privacy and fairness engines live under `backend/src/engines`. The backend `JobRunner` and scheduler execute in process; use a durable queue and a separate worker for production. `backend/src/engines/models` contains replaceable mock, REST, internal and sandbox adapters. CI integration events are simulated through an authenticated route, not an installed GitHub Action; API keys are stored hashed, but browser sessions currently use JWT. Data-source connection tests check configuration and environment variable availability, not a live external database transaction.

### Interpretation limits

Privacy Shield is a **Prototype Privacy Simulation** using suppression, generalization, resampling, noise, and adversarial linkage checks. It does **not** implement differential privacy and offers no mathematical privacy guarantee. Fairness Sword computes group outcomes and counterfactual flips from available labels; small samples and missing ground truth limit conclusions. Results and reports signal potential risk for human review. They are not legal determinations, fairness certifications, or guarantees of regulatory compliance.

## Verify

```sh
npm run typecheck
npm run lint
npm test
npm run build
curl http://localhost:4000/api/health
```

Backend tests exercise privacy/fairness engines and protected routes; frontend tests exercise login success/failure. A seeded local run exercises the async full assessment path. Do not use the fictional seed credentials outside a local prototype.
