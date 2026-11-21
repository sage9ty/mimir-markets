# Reversible release migrations

Make every release schema change **apply forward and roll back** with a
checksummed ledger, without requiring production secrets to rehearse.

This complements [`docs/RELEASE_READINESS.md`](./RELEASE_READINESS.md) (when
present) and the deployment rollback rehearsal: migrations cover the Postgres
projection schema; rollback rehearsal covers contract ids / feature flags.

---

## Why this exists

`lib/db.ts` still bootstraps tables with `CREATE TABLE IF NOT EXISTS` via
`ensureSchema`. That path is not reversible. Release work needs an explicit
up/down chain so operators can:

- Rehearse a migration from a clean checkout (CI / contributor laptop).
- Roll back the latest *reversible* release migration if a deploy fails.
- Detect rewritten history via checksum mismatch (fail-closed).
- Keep irreversible baselines (ledger + base platform marker) blocked unless
  an operator passes `--force-destructive`.

---

## Quick start (no secrets)

By default the runner uses the in-memory fixture store (`lib/migrations/memory-store.ts`).
Nothing reads `DATABASE_URL` unless you opt in with `--live`.

```bash
# Show registered vs applied (fixture store).
npm run migrate:status

# Apply all pending migrations in memory.
npm run migrate:up

# Revert the latest reversible migration (v3 today).
npm run migrate:down

# Full verify: registry checks + up → down(reversible) → up cycle.
npm run migrate:verify
```

All of the above default to `--fixture` (in-memory). They exit `0` on success
and `1 ` on checksum / step failure. Nothing reads `DATABASE_URL` in fixture
mode.

---

## Live mode (Postgres)

Pass `--live` to apply migrations to a real Postgres database. This selects the
reviewed `PostgresMigrationStore` and requires `DATABASE_URL` to be set.

```bash
# Show status against the live database.
DATABASE_URL="postgres://user:pass@localhost:5432/db" npm run migrate:status -- --live

# Apply pending migrations.
DATABASE_URL="postgres://user:pass@localhost:5432/db" npm run migrate:up -- --live

# Revert the latest reversible migration.
DATABASE_URL="postgres://user:pass@localhost:5432/db" npm run migrate:down -- --live
```

If `--live` is passed without `DATABASE_URL`, the runner exits non-zero with a
message telling you to set it (or drop `--live`). `--fixture` is the default and
always wins if both flags are present.

### What the Postgres store does

- Maintains the `schema_migrations` ledger (`version`,
  `id`, `checksum`, `applied_at`).
- Computes checksums via `lib/migrations/checksum.ts` and compares them to
  the ledger before applying anything.
- Takes a session-level advisory lock (`ha...` key derived from the ledger
  table name) for the duration of a run, so concurrent runners block instead of
  interleaving.
- Runs each migration in its own transaction and writes the ledger row in the
  same transaction, so a mid-migration error leaves the prior state intact.

### Local Postgres for testing

You can run a throw-away Postgres in Docker to exercise the live path:

```bash
docker run --rm -d name migrations-pg \
  -e 'POSTGRES_PASSWORD=postgres' \
  -p 5432:5432 \
  postgres:16

DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" \
  npm run migrate:up -- --live

# Running again is a no-op.
DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" \
  npm run migrate:up -- --live

docker stop migrations-pg
```

The unit tests in `tests/node/migrations.test.ts` use a fake pool to assert
the SQL sequence (lock → checksum compare → transaction → commit), so the Docker
step is optional and not required in CI.

---

## Read-index restore previews

Restore previews for the Postgres read index (`lib/server/read-index-backup.ts`)
are **dry-run only**. A preview reports which tables would be touched, the
backup generation being inspected, and the expected row coverage, and it
verifies the backup schema version and content fingerprint against the
current registry. Preview mode performs **no database writes**; it does not
open a write transaction and does not modify `schema_migrations`.

What a preview reports:

- Affected tables and their expected row counts.
- Backup generation and expected coverage.
- Schema check: the backup's schema version must match a registered
  migration version, otherwise the preview fails closed.
- Fingerprint check: the backup fingerprint must match the recomputed
  checksum of its payload; a mismatch fails closed and is reported as a
  checksum error, not a partial restore.

Soroban contract state remains authoritative; the read index is rebuilt from
chain events, so a preview never treats indexed rows as the source of truth.

---

## How it works

```
registry (lib/migrations/registry.ts)
    ↓
runner plan (up ascending / down descending)
    ↓
MigrationStore transaction (MemoryMigrationStore in fixture mode,
                               PostgresMigrationStore in live mode)
    ↓
schema_migrations ledger row written or removed
```

| Version | Id | Reversible? | Role |
| --- | --- | --- | --- |
| 1 | `001_schema_migrations_ledger` | No (destructive escape hatch) | Creates the ledger table |
| 2 | `base-platform-schema-v2` | No (destructive escape hatch) | Aligns with the existing `lib/db.ts` marker |
| 3 | `003_release_migration_events` | **Yes** | Audit table for release up/down events |

---

## Adding a release migration

1. Append a new object to `MIGRATIONS` in `lib/migrations/registry.ts`.
2. Give it the next integer `version`, a stable `id`, and a short `description`.
3. Write `up` SQL that is safe to run once (prefer `IF NOT EXISTS` / guarded DDL).
4. Write `down` SQL that undoes `up` exactly. If that is impossible without
   data loss, set `irreversible: true` and an `irreversibleReason`.
5. Never embed secrets, connection strings, or live credentials in SQL.
6. Add / extend tests in `tests/node/migrations.test.ts`.
7. Run `npm run migrate:verify` and `npm run test:smoke`.

Do **not** edit SQL for a version that may already be applied in any
environment — add a new version instead. Checksum mismatches fail closed.

---

## Failure behaviour

| Condition | Behaviour |
| --- | --- |
| Reversible migration with empty `down` | Registry / apply refused |
| Checksum mismatch vs ledger | Status + migrate refuse |
| Down on irreversible without flag | Step fails with actionable message |
| Transaction error mid-up | Ledger row not recorded; prior state kept |
| Concurrent runners | Second runner blocks on the advisory lock |
| Secrets in error text | Redacted before surfacing |

---

## Relation to `lib/db.ts`

`ensureSchema` remains the bootstrapping path for application runtime. The
migration runner is the **release control plane**: it records versions, proves
reversibility for new changes, and blocks unsafe downs. Version `2` matches the
existing `base-platform-schema-v2` ledger seed so both stay aligned.
Moving the `ensureSchema` SQL into migrations is a separate follow-up.

---

## Operational impact

- **Release:** run `npm run migrate:verify` in CI / pre-release; treat failures
  as a hard gate for schema-changing releases. For the live database, run
  `npm run migrate:up -- --live` with `DATABASE_URL` configured.
- **Rollback:** `npm run migrate:down -- --live` reverts the latest reversible
  migration only. Baseline versions stay blocked on purpose.
- `**Secrets / env:** fixture mode never needs `DATABASE_URL`. Live mode reads it
  from the environment only. Do not paste connection strings into issues, PR
  bodies, or migration SQL.
