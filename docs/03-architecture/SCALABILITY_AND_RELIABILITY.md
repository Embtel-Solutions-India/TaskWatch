# Scalability and Reliability

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Changes in §2–§4 are **Proposed — needs approval**. Nothing was load-tested or run. Backup/restore runbooks belong to [../08-operations/](../08-operations/); this file states only the architectural requirements.

Related: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) · [DATABASE_DESIGN.md](DATABASE_DESIGN.md) · [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)

## 1. Deployment shape
One Node process (API + scheduler + static SPA) and one PostgreSQL database, single region [V-S `server/src/index.ts`, `app.ts:65-69`; PRD NFR Availability]. RTO/RPO are not stated [OPEN — PRD NFR Availability]. The design below stays correct if a second instance is started (e.g. during a rolling deploy), which today it is not (S-15).

## 2. Scheduler: single leader (S-15)

> **Implemented 2026-11-04 (T-1.17):** `isLeader()` in `server/src/jobs/scheduler.ts` holds the lock on a dedicated connection; `migrate()` takes a blocking lock. Keys: `LOCK_KEYS` in `server/src/db/pool.ts`.
Today every process runs every job; each job has only an in-process `busy` flag [V-S `server/src/jobs/scheduler.ts:50-65, 67-76`].

What is already multi-instance safe (existing infrastructure):
| Job | Why it is safe today | Evidence |
|---|---|---|
| dispatcher | claims rows with `for update skip locked` | [V-S `notify/dispatcher.ts:40-48`] |
| recurring | claims one schedule at a time with `for update skip locked` | [V-S `services/recurring.ts:97`] |
| digest, nightly chain check | deduplicated by `insert … into job_runs … on conflict do nothing` | [V-S `scheduler.ts:43-47`; `001_init.sql:210-216`] |
| engine | per-task row lock + unique active (task, level) index; a second instance mostly re-checks and finds nothing to do | [V-S `engine/engine.ts:61, 74`; `001_init.sql:141`] |

**Proposed:** wrap the one shared helper `every()` so a tick runs only on the instance holding a Postgres session advisory lock — one change covers all five jobs:
```ts
// inside every(): run fn only if this instance is the leader for `name`
const c = await pool.connect();
try {
  const { rows } = await c.query('select pg_try_advisory_lock(hashtext($1)) as ok', [`taskwatch:${name}`]);
  if (rows[0].ok) try { await fn(); } finally { await c.query('select pg_advisory_unlock(hashtext($1))', [`taskwatch:${name}`]); }
} finally { c.release(); }
```
- Uses only `pg` and Postgres built-ins (no new dependency). Holds one pool connection per running job (pool `max: 10` [V-S `db/pool.ts:8`]).
- Same lock around `migrate()` at start-up, because two instances starting together would both try to apply the same file [V-S `index.ts:9`; `db/migrate.ts:8-32`].
- `kickDispatcher()` stays outside the lock; it is safe because of `skip locked` [V-S `dispatcher.ts:17-23`].

## 3. Dispatcher: stuck `sending` recovery and idempotency (S-14)
Today a row is set to `sending` and `attempts+1` when claimed; if the process dies before the result is written, the row stays `sending` forever [V-S `dispatcher.ts:40-48`]. Failures retry up to 3 attempts with a linear 5-minute × attempts backoff [V-S `dispatcher.ts:6, 67-75`].

**Proposed (no new column):** treat `send_after` as a lease.
- Claim: `set status='sending', attempts=attempts+1, send_after = now() + interval '10 minutes'` and select `status in ('pending','held') or (status='sending' and send_after <= now())`.
- A crash leaves the row claimable again after the lease; `attempts` still caps it at 3 → `failed`.
- Lease (10 min) ≫ provider timeouts (WhatsApp `AbortSignal.timeout(15_000)` [V-S `notify/channels.ts:48`]) [A].

**Idempotency:**
| Operation | Key | Evidence |
|---|---|---|
| Escalation firing | unique active (task_id, level) | [V-S `001_init.sql:141`] |
| Due-soon / overdue notices | `tasks.due_soon_sent_for` / `overdue_sent_for` = the `due_at` already notified | [DATABASE_DESIGN.md §3.4](DATABASE_DESIGN.md) |
| Recurring instance | unique (recurring_id, occurrence_date) | [DATABASE_DESIGN.md §3.4](DATABASE_DESIGN.md) |
| Digest, chain check | `job_runs (job, run_key)` | [V-S `001_init.sql:210-216`] |
| External send | **at-least-once**: a crash after the provider accepted but before the row is updated can resend once. Accepted; WhatsApp/email duplicates are rare and harmless compared with a lost alert [A]. |
| Client retries of mutations | not idempotent; the UI disables the button while pending (existing `useAction`) [A] |

## 4. Query patterns
- **Scope.** Today the reporting tree is walked in memory from a cached directory [V-S `services/directory.ts:64-78, 113-119`; `services/access.ts:12-26`]. Target: a recursive CTE, cycle-safe, used inside list/report/dashboard/search SQL:
  ```sql
  with recursive scope(id) as (
    select $1::int
    union
    select u.id from users u join scope s on u.manager_id = s.id
  ) select … from tasks t where t.assignee_id in (select id from scope) or t.assigner_id = $1 or t.reviewer_id = $1
  ```
  `union` (not `union all`) stops on loops. Index `users_manager_idx` exists [V-S `001_init.sql:27`].
- **Engine tick** reads all open tasks and active escalations once, computes levels in memory, and locks only tasks that change [V-S `engine/engine.ts:37-65`]. Cost is O(open tasks) per minute; fine at the volumes in §6.
- **Chain verification on every detail read.** `GET /tasks/:id` runs `verifyChains(pool, [taskId])` [V-S `services/queries.ts:188`], which re-reads every log row of that task (a second query alongside the log query for display) and re-hashes them: O(rows of one task), not O(all rows). **Proposed:** verify over the rows already fetched for display (no second query) and cache nothing. If a task's log ever grows large (> ~1 000 rows [A]), show the last nightly result instead. The nightly full check is O(all rows) [V-S `services/activity.ts:105-156`] and runs once a day.
- **No N+1:** list rows are built with joins/aggregates (existing style in `services/queries.ts`); `actions[]` per row is computed in memory from the row plus the caller's permissions and pending-extension flag (one grouped query).
- **Caps:** ADR-0009 (proposed).

## 5. Backups and restore [WO p.5]
| Requirement | Design |
|---|---|
| Daily backup | `pg_dump -Fc` of the TaskWatch database once a day |
| **and the upload files** | `UPLOAD_DIR` [V-S `config.ts:64`] is not in the database; it must be copied in the same backup run, otherwise attachments (evidence) are lost |
| 90-day retention | delete backup sets older than 90 days (backups are copies, not the system of record; 7-year retention applies to the live data, [DATABASE_DESIGN.md §5](DATABASE_DESIGN.md)) |
| Quarterly restore test | restore into a scratch database, run `verifyChains` (the chain check) and spot-check attachments by SHA-256 (`attachments.sha256` [V-S `001_init.sql:121`]); record the result |
| Secrets | backups are stored encrypted; keys in the secrets store (WO FO-2026-CRM-01 WP-1) |

The nightly chain anchor ([SECURITY_ARCHITECTURE.md §9](SECURITY_ARCHITECTURE.md) option B) gives a restore test something independent to compare against.

## 6. Target volumes [A]
No volumes are given in the WO. Assumptions for sizing (to be confirmed with the Founder's Office):
| Item | Assumption |
|---|---|
| Entities | 6 [WO p.1] |
| Users | ≤ 300 |
| New tasks | ≤ 25 000 / year → ≤ 175 000 over 7-year retention |
| Open tasks at once | ≤ 3 000 |
| Activity-log rows | ~15 / task → ≤ 2.7 M over 7 years |
| Notification rows | ~3 channels × ~6 alerts / task → ≤ 3 M over 7 years |
| Concurrent users | ≤ 100 |

At these sizes a single Postgres with the indexes in [DATABASE_DESIGN.md §3](DATABASE_DESIGN.md) is ample; the PRD target "task detail p95 < 300 ms at 10k tasks" [A, PRD NFR Performance] is not at risk from the data volume. The engine's per-minute full pass over ≤ 3 000 open tasks is in-memory arithmetic.

## 7. Failure behaviour
| Failure | Behaviour |
|---|---|
| SMTP / WhatsApp down | rows retry (3 attempts) then `failed`, visible in the delivery log; in-app notification already delivered [V-S `notify/notify.ts:44`] |
| Credentials missing | channel runs in simulation mode, rows `simulated` [V-S `channels.ts:26, 75`] |
| Process restart mid-tick | engine work is per-task transactions (re-run safely); dispatcher lease (§3) |
| Missed recurring runs | not backfilled today [V-S per EXISTING_SYSTEM_ANALYSIS §3.6]; behaviour under D-5 [D-5, decided] |
| DB unavailable | API returns 500 envelope; `GET /api/health` reports `db: false` |
