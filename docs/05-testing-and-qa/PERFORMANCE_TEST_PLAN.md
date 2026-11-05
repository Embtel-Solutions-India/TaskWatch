# Performance Test Plan

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> **Every threshold below marked [A] is a proposal for approval.** The WO sets only two performance facts: the engine runs at least every 5 minutes (FR-8), and each level fires within 5 minutes of its threshold (AC-1). The PRD adds "task detail p95 < 300 ms at 10k tasks" as [A] ([PRD §4](../02-product-requirements/PRODUCT_REQUIREMENTS.md)).
> Status: **planned, not run.**

## 1. Target volumes [A]

| Dimension | v1 target | 7-year horizon | Basis |
|---|---|---|---|
| Active users | 150 | 300 | 6 entities in the WO; pilot is BAIS only [A] |
| Open tasks at once | 2 000 | 5 000 | [A]; D-10 recommends client-side lists up to ~5k rows |
| Total tasks | 10 000 | 150 000 | 7-year retention, nothing deleted [WO "Retention"] |
| `activity_log` rows | 150 000 | 3 000 000 | ~15 rows per task [A] |
| Notifications per day | 3 000 | 10 000 | 3 channels × alerts [A] |
| Attachments | 20 000 files | 300 000 files | [A] |

A generator script that fills `taskwatch_test` (never the dev DB) to these volumes is a prerequisite. It must write through the services so that hash chains are valid. Its use needs approval because it writes to a DB ([AI_AGENT_GUARDRAILS §2.6](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)).

## 2. What to measure

### P-1 Scope queries
- **Today:** `visibilityFilter` passes the viewer's scope as an id array, `assignee_id = any($1) or assigner_id = $2`; the scope comes from the in-memory directory (`dir.descendants`). [V-S] `services/access.ts:11-26`. Lists are capped at 500 (`queries.ts:106`), notifications at 40, audit at 100 (`admin.ts:22`). [V-S] (S-17)
- **Measure:** p50/p95 of `GET /api/tasks?view=open|team|escalated|red|blocked|closed`, `GET /api/tasks/summary`, `GET /api/dashboard?days=90`, for the CoS (no filter), a manager with ~60 people in scope, and a staff member.
- **Check:** `EXPLAIN (ANALYZE, BUFFERS)` uses `tasks_assignee_idx` / `tasks_open_idx` (`001_init.sql:73-74`); no sequential scan of `tasks` for non-CoS users at 150 000 tasks. An index on `assigner_id` does not exist today. [V-S]
- **Thresholds [A]:** list p95 < 300 ms; dashboard p95 < 800 ms; summary p95 < 150 ms, at the v1 volume, local Postgres.

### P-2 Task detail and chain verification
- **Today:** every `GET /api/tasks/:id` calls `verifyChains(pool, [taskId])` (`queries.ts:188`), which re-hashes that task's log rows. Cost is O(rows of that task), not O(all rows). [V-S]
- **Measure:** detail p95 for a task with 15, 200 and 2 000 log rows.
- **Threshold [A]:** p95 < 300 ms at 200 rows (PRD target).

### P-3 Nightly chain check
- **Today:** `verifyChains()` with no ids loads **every** `activity_log` row into memory in one query (`services/activity.ts:105-115`). [V-S] At 3 M rows this is a memory risk.
- **Measure:** duration and peak RSS at 150 000 and 3 000 000 log rows.
- **Thresholds [A]:** finishes in < 10 min and peak RSS < 512 MB at the 7-year volume. If not, batch by task id ranges (a code change for review, not part of this plan).

### P-4 Engine tick
- **Today:** each tick loads all open tasks and all active escalations, computes levels in memory, and opens one transaction per task that needs work (`engine/engine.ts:37-64`). Interval `ENGINE_INTERVAL_MS`, default 60 s (`config.ts:67`). [V-S]
- **Measure:** tick duration with 2 000 and 5 000 open tasks: (a) steady state, nothing changes; (b) burst, 500 tasks cross a threshold in the same tick (for example, after a rules change re-evaluates all tasks).
- **Thresholds:**
  - steady tick < 2 s [A];
  - burst tick < 60 s [A], so that tick duration + interval ≤ 5 min and AC-1 still holds [WO FR-8, AC-1];
  - **engine lag** (time from a threshold to the escalation row's `fired_at`) p100 < 5 min. **This one is a WO requirement, not an assumption.** [WO AC-1]

### P-5 Dispatcher throughput
- **Today:** every 15 s it claims up to 100 due rows (`for update skip locked`) and sends them one by one (`notify/dispatcher.ts:35-46`). Theoretical ceiling about 400 sends/min per instance. [V-S]
- **Measure:** with a stubbed channel that adds 300 ms latency [A], time to drain 1 000 pending rows; time to release a morning batch of held rows at 08:00 IST.
- **Thresholds [A]:** an alert is sent within 2 min of `send_after` at p95 for ≤ 300 queued rows; the 08:00 IST held batch drains within 10 min. L2/L3 are never held, so their delivery time is the AC-5 path.

### P-6 Recurring and digest jobs
- Recurring: generation of 200 schedules due at the same minute finishes in < 30 s [A].
- Digest: Monday 09:00 IST for 150 recipients finishes in < 5 min [A], once only (`job_runs`). [V-S] `services/digest.ts:114`

### P-7 Exports
- CSV and PDF for 90 days at the v1 volume: < 5 s and < 10 MB [A]. PDF uses `pdfkit` in-process. [V-S]

### P-8 Session store and sign-in
- `connect-pg-simple` reads the session on every request. [V-S] `app.ts:31-47`. Measure the added latency (< 10 ms p95 [A]).

## 3. Method

- Environment: a local Postgres 18 test instance, the server started against `taskwatch_test`, no real channels (credentials removed as in `api.test.ts:10`).
- Load: Node's built-in `fetch` in a small script with fixed concurrency (10/50 users). A load tool (k6, autocannon) is ***Proposed — needs approval*** (new dependency).
- Clock: pin the clock (`clock.setFixed`) to create threshold crossings on demand; measure engine lag in the pilot with the real clock (TC-ESC-08-02).
- Record: environment, data volume, command, p50/p95/p99, and the date. No result counts until it is recorded.

## 4. Limits and caps (for D-10)

| Endpoint | Cap today [V-S] | Proposal [A] |
|---|---|---|
| `GET /api/tasks` | 500 rows | Keep a hard cap; return `truncated: true`; server pagination once a scope can exceed 2 000 open rows (D-10) |
| `GET /api/notifications` | 40 | Keep |
| `GET /api/outbox` | 500 (per S-17) | Paginate |
| `GET /api/admin/audit` | 100 | Paginate with filters (AUD-01) |
| Escalated-to-FO list in summary | 20 (`queries.ts:137`) | Keep |
| JSON body | 200 kb (`app.ts:29`) | Keep |
| Upload | 15 MiB (`config.ts:65`) | D-13 |

## 5. Exit criteria
- P-4 engine lag p100 < 5 min at the v1 volume (blocking, WO).
- All [A] thresholds either met or explicitly waived by the user.
- Results recorded in [RELEASE_READINESS.md](RELEASE_READINESS.md).
