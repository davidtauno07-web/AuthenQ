# Demo: Support Tickets acceptance workflow

`npm run db:seed` creates the **Northwind Support (demo)** organization (`northwind-demo`) and runs the full pipeline deterministically:

1. **Firewall** — uploads `customers` (300 rows) and `tickets` (800 rows) with names, emails, phones and addresses, plus outcome fields. Scans, classifies, confirms the `tickets.customer_id → customers.customer_id` relationship, records human decisions and signs off.
2. **Twin** — generates 1,100 synthetic rows with a fixed seed; safety passes with zero real-value collisions; 1,516 values are registered with Canary.
3. **Send to labeling** — explicit transfer to the *Ticket intent* project (labels: Billing, Technical Issue, Account Access, Shipping, Cancellation, Feature Request) with a published guideline, decision tree and 40+ examples.
4. **Gold** — coverage sampling into example/tuning/locked-test splits, double labeling by two labelers, adjudication, lock.
5. **Workspace** — 160 tasks labeled by people.
6. **Engine** — demo engine run (rules → Naive Bayes → confidence routing); items auto-accepted or routed to review; part of the review queue is completed.
7. **Quality** — accuracy on the locked test with Wilson interval, per-label F1, κ, calibration, slices, error clusters.
8. **Export** — JSONL package (728 records) with manifest, data card, lineage and checksums; real-value check finds 0 matches.
9. **Canary** — one clean scan and one simulated leak that raises an alert.

Accounts (password = `DEMO_PASSWORD`): `admin@`, `pm@`, `engineer@`, `reviewer@`, `labeler@`, `labeler2@`, `viewer@authenq.demo`.

`npm run test:e2e` verifies all of the above. Re-seed from scratch with `SEED_RESET=1 npm run db:seed`.
