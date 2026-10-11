# Connectors

All connectors share one driver interface (`apps/api/src/connectors/types.ts`): connection test, object discovery, schema discovery, paged reads, and incremental reads where the source supports them. Drivers are registered in `apps/api/src/connectors/registry.ts`.

## Status

| Connector | Category | Status | Verified against |
| --- | --- | --- | --- |
| PostgreSQL | Database | Verified | PostgreSQL 16 |
| MySQL | Database | Verified | MySQL 8.4 |
| Microsoft SQL Server / Azure SQL | Database | Verified | SQL Server 2022 |
| Oracle Database (thin driver) | Database | Verified | Oracle Database 23ai Free |
| MongoDB | Database | Verified | MongoDB 7 |
| SQLite | File upload | Verified | `better-sqlite3`, opened read-only from memory |
| Amazon S3 / S3-compatible | Object storage | Verified | LocalStack 3.8 S3 API |
| Azure Blob Storage | Object storage | Verified | Azurite (official emulator) |
| Google Cloud Storage | Object storage | Verified | fake-gcs-server (JSON API emulator) |
| Amazon Redshift | Warehouse | **Not verified** | PostgreSQL driver; no live cluster |
| Snowflake | Warehouse | **Not verified** | SQL API v2; no live account |
| Google BigQuery | Warehouse | **Not verified** | REST v2 + service-account JWT; no live project |
| Databricks SQL | Warehouse | **Not verified** | Statement Execution API 2.0; no live workspace |

The object-storage connectors were tested against emulators, not live AWS, Azure or Google Cloud accounts. Unverified connectors are listed in the catalog with their prerequisites, but they can only be created after an administrator enables the `connectors.unverified` feature flag.

CSV, TSV, JSON, JSONL, XLSX and SQLite files can be uploaded directly or read from object storage (50 MB per file).

## Behaviour

- **Credentials**: the whole configuration is encrypted at rest (`ConnectorAccount.credentialsEnc`). Only non-secret settings are returned by the API. Removing a connector deletes the stored credentials.
- **Read-only**: drivers only issue `SELECT`/list/get calls and request read-only sessions where the database allows it (PostgreSQL, MySQL, Oracle, SQL Server `ApplicationIntent=ReadOnly`). Always use a read-only account.
- **Outbound policy**: every host in the configuration is checked by `lib/net.ts` before connecting. Private addresses are blocked in production unless allowlisted.
- **Reads**: imports read in pages of 5,000 rows, up to 250,000 rows per object, and record a `ConnectorSync`. Transient network errors are retried twice with backoff.
- **Errors**: driver errors are stripped of passwords, tokens, keys and connection strings before they are stored, logged or shown.
- **Preview**: `POST /connectors/:id/preview` returns at most 100 source rows per page. It requires `connectors.manage` and `sources.real.preview`, and every preview is audited without row content.
- **Audit**: create, test, failed test, preview, import and delete actions are written to the activity log.

## Limitations

- Incremental reads (`readPage` with `incremental.column` / `after`) work in the drivers for the SQL databases and MongoDB, but Firewall imports always do a full refresh.
- `mongodb+srv://` hosts are checked by their SRV name only. The resolved replica-set members are not checked.
- Snowflake results beyond the first partition are not fetched.

## Integration tests

```bash
docker compose -f docker-compose.connectors.yml up -d
npm run test:connectors --workspace apps/api
```

The suite (`apps/api/tests/connectors.it.test.ts`) seeds every server, then checks discovery, schema, pagination, incremental reads and error redaction. It is skipped in the normal `npm test` run.
