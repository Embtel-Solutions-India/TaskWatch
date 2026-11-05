# Database Migration Policy

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Schema facts are in [EXISTING_SYSTEM_ANALYSIS §3.2](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md). Backups and restore are in [../08-operations/RUNBOOK.md](../08-operations/RUNBOOK.md).

## 1. How migrations work today [V-S]

- Files: `server/src/db/migrations/NNN_name.sql`. Only `001_init.sql` exists.
- Runner: `server/src/db/migrate.ts`.
  - Creates `schema_migrations(name text primary key, applied_at)` if missing (`migrate.ts:9`).
  - Lists `*.sql`, sorts by file name (`:12`), skips names already recorded (`:15`).
  - Runs each file **in its own transaction** together with the `schema_migrations` insert (`:18-23`). A failure rolls back that file and stops the run (`:25-26`).
- Who runs it:
  - `npm run db:migrate` and `npm run db:setup` (`setup.ts:23`).
  - **Every server start**: `index.ts:9` calls `migrate()` before listening. That covers `npm start` and `npm run dev:server`.
  - The integration tests, after dropping the schema (`api.test.ts:54-56`).

Because the server migrates on start-up, **deploying new code is applying migrations**. The backup rule in §5 therefore applies to every deploy that includes a new migration file.

## 2. Rules

1. **Forward-only.** No down-migrations. To undo, write a new migration. [A] (the runner has no down step [V-S])
2. **Numbered, zero-padded, one concern per file**: `002_entities_teams.sql`, `003_permissions.sql`. Sort order is execution order (`migrate.ts:12`). Never reuse or renumber.
3. **Never edit an applied migration.** The runner tracks by file name only; an edited file is silently not re-run, so environments drift. A file counts as applied once it has run anywhere outside a developer's own throwaway DB.
4. **Plain SQL, idempotent where cheap** (`create … if not exists`, `add column if not exists`), so a re-run after a partial manual fix is safe.
5. **No `begin`/`commit` inside the file.** The runner already wraps it (`migrate.ts:18-23`). Statements that cannot run in a transaction (`create index concurrently`) need a reviewed exception. [A]
6. **Keep the existing conventions**: enums as `text` + `CHECK`; `timestamptz` for every instant; FKs for every reference; snake_case. [V-S] `001_init.sql`
7. **Case-insensitive unique email.** The current `email text not null unique` is case-sensitive (`001_init.sql:13`). [V-S] The fix (a unique index on `lower(email)`) needs a data check first, because existing duplicates would fail the migration.

## 3. Append-only tables (never weaken)

| Table | Protection | Evidence |
|---|---|---|
| `activity_log` | Triggers reject UPDATE, DELETE and TRUNCATE; `unique(task_id, seq)`; per-task SHA-256 chain | [V-S] `001_init.sql:89-112` |
| `admin_log` | Triggers reject UPDATE, DELETE and TRUNCATE; **not** hash-chained (S-11) | [V-S] `001_init.sql:185-198` |

A migration must not:
- drop or disable these triggers, even temporarily;
- add columns that need back-filling of existing log rows (that is an UPDATE, and the trigger will reject it). Add nullable columns and write them only for new rows;
- change `canonicalJSON` inputs or the hash formula without an ADR, because old rows would fail verification. [V-S] `services/activity.ts`

New log-like tables (for example extension decisions, logins for S-10) use the same `taskwatch_forbid_change()` trigger function. [V-S] `001_init.sql:104-107`

Retention is 7 years for closed tasks and their logs, and people are archived, never deleted [WO]. No migration deletes task, user or log rows.

## 4. Data migrations need approval

Moving to the client model (D-1, D-4, D-8, D-20) reshapes data in the `taskwatch` DB. **[D-18, decided]**

- A data migration (anything that UPDATEs or DELETEs existing rows, or maps old values to new ones) needs the user's explicit OK, recorded against D-18 before it runs on any shared or production DB.
- Write it as its own numbered file, separate from DDL, and state in its header comment: what rows change, how many on the dev DB (counted with a read-only `select count(*)`), and how to recover (restore from the §5 backup).
- Status mappings (for example `open` → `assigned` under D-20) must be listed in the ADR first.

## 5. Backups before migrating

- Before applying a new migration to any DB other than a throwaway local or test DB: take a `pg_dump -Fc` and confirm the file is non-empty. [A] (procedure: [RUNBOOK.md](../08-operations/RUNBOOK.md))
- Production follows the WO: daily backups, 90-day retention, one restore test per quarter. [WO "Backups"]
- Since the server migrates at start-up, the deploy procedure takes the backup **before** starting the new version ([../08-operations/DEPLOYMENT.md](../08-operations/DEPLOYMENT.md)).

## 6. Test database isolation

- Integration tests use `TEST_DATABASE_URL`, default `postgres://localhost:5432/taskwatch_test` (`api.test.ts:9`). [V-S]
- They **drop and recreate the `public` schema** of that DB (`api.test.ts:54-55`). [V-S] That is why `npm test` needs approval ([AI_AGENT_GUARDRAILS §2.6](AI_AGENT_GUARDRAILS.md)).
- `TEST_DATABASE_URL` must never point at the dev or production DB. A guard is *Proposed*: refuse to run unless the DB name ends in `_test`. [A]
- `npm run db:seed -- --reset` also drops `public` on `DATABASE_URL`; it only refuses when `NODE_ENV=production` (`seed.ts:457-459`). [V-S]

## 7. Review checklist for a migration
- [ ] New file, next number, nothing applied was edited.
- [ ] Runs cleanly on an empty DB **and** on a copy of the current dev DB.
- [ ] No trigger on `activity_log` or `admin_log` touched.
- [ ] Data changes are separate and approved (D-18).
- [ ] Indexes support the new scope queries (see [../05-testing-and-qa/PERFORMANCE_TEST_PLAN.md](../05-testing-and-qa/PERFORMANCE_TEST_PLAN.md)).
- [ ] Backup step is in the deploy notes.

## Drafting rule while a dev server is running (added 2026-11-04)
The owner keeps `tsx watch` running against the dev DB. Any restart applies pending migrations, and a restart can be triggered by an unrelated source edit. Workflow:
1. Draft the new migration **outside** `server/src/db/migrations/`, in the agent scratchpad.
2. Prove it against `taskwatch_test`: copy it in, run `npm test`, then remove the copy. Or apply it with a one-off runner pointed at the test DB.
3. Only then place it in `server/src/db/migrations/`.
4. Back up dev with `pg_dump --no-password` before any data-changing migration (003). Normalise the URL scheme in memory and redact errors (KNOWN_ISSUES KI-16, KI-17).
