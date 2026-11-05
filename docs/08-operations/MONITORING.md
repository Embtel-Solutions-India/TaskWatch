# Monitoring

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Each signal says what **exists** in the code today and what is **proposed**. Proposed items need approval and are not built. All queries below are read-only `select`s; run them with a read-only DB role where possible. What to do when a signal fires: [RUNBOOK.md](RUNBOOK.md).

## 1. Summary

| Signal | Why it matters | Exists today | Proposed |
|---|---|---|---|
| Engine lag | WO FR-8 / AC-1: every level within 5 min of its threshold | No record of engine runs; only `console.error('[engine]', …)` on failure (`scheduler.ts:58`) | Record each tick (start, end, checked, changed) and alert if the last successful tick is > 5 min old |
| Job runs | Digest and nightly check must run once | `job_runs (job, run_key, ran_at)` for `weekly_digest` and `chain_check` (`001_init.sql:210-216`; `scheduler.ts:43-47`; `digest.ts:114`) | Same table or a log for engine, dispatcher and recurring |
| Chain checks | WO tamper evidence; AC-7 | `chain_checks` row per run with `ok` and `breaks` (`001_init.sql:200-208`); CoS gets an in-app/email/WhatsApp `chain_break` alert on failure (`scheduler.ts:22-36`); last 20 shown at `GET /api/admin/audit` | Alert if no `nightly` row for the last local day |
| Delivery failures | AC-5 | `notifications.status` = `failed` after 3 attempts with `error` text (`dispatcher.ts:6,68-72`); counts by channel/status at `GET /api/outbox` (`notifications.ts:73-77`) | Alert on any `failed` in the last hour, or a failure rate > 5 % [A] |
| Stuck sending | S-14 | Rows can stay in `sending` forever (`dispatcher.ts:41-46`) | Alert on `sending` older than 15 min |
| Held queue | Quiet hours | `held` rows with `send_after` (`notify.ts:35-37`) | Alert if a `held` row is > 15 min past `send_after` (dispatcher not draining) |
| Simulated deliveries in prod | Missing credentials | Status `simulated`; start log prints `simulated (no keys in .env)` (`index.ts:20,23`) | Alert on any `simulated` row in production |
| Process up | Availability | Start log only | `GET /api/health` (DB ping + last engine tick age), polled by an uptime checker [A] |
| Errors | Defects | `console.error` with the whole error (`middleware.ts:82`) | Structured log without PII ([ERROR_HANDLING §5](../04-engineering-standards/ERROR_HANDLING.md)); alert on a 5xx rate > 1 % [A] |
| Backups | WO 90 days | Nothing | Alert if the newest backup is > 26 h old; quarterly restore test logged |
| Rate-limit hits | Brute force | No rate limiting (S-1) | Count 429s per hour |

## 2. Queries (read-only)

**Engine lag (proxy, until ticks are recorded).** For open tasks, the newest escalation compared with the level's threshold. A row that is `> 5 min` late breaks AC-1. Thresholds come from `computeLevel` in code, so the dependable form is the proposed tick record; meanwhile check that escalations are being created at all:

```sql
select max(fired_at) as last_escalation, now() - max(fired_at) as age from escalations;
```

**Nightly chain check ran and passed:**
```sql
select ran_at, trigger, ok, tasks_checked, rows_checked, jsonb_array_length(breaks) as breaks
  from chain_checks order by ran_at desc limit 5;
select run_key, ran_at from job_runs where job = 'chain_check' order by ran_at desc limit 3;
```

**Weekly digest sent this Monday:**
```sql
select run_key, ran_at from job_runs where job = 'weekly_digest' order by ran_at desc limit 3;
```

**Delivery health (last 24 h):**
```sql
select channel, status, count(*) from notifications
 where created_at > now() - interval '24 hours' group by 1,2 order by 1,2;
```

**Stuck or overdue rows:**
```sql
select count(*) filter (where status = 'sending' and send_after < now() - interval '15 minutes') as stuck_sending,
       count(*) filter (where status = 'held'    and send_after < now() - interval '15 minutes') as held_overdue,
       count(*) filter (where status = 'pending' and send_after < now() - interval '15 minutes') as pending_overdue
  from notifications where channel <> 'inapp';
```

Do not export the `address` or `error` columns into tickets or chat: they hold personal data and provider responses (S-16).

## 3. Thresholds

| Alert | Threshold | Basis |
|---|---|---|
| Engine stalled | last successful tick > 5 min | **[WO FR-8]** |
| Escalation late | any level created > 5 min after its threshold | **[WO AC-1]** |
| Blocked alert late | lead's alert not `sent` within 5 min (outside quiet hours) | **[WO AC-3]**; D-85 for quiet hours |
| Nightly check missing | no `chain_check` row for the previous local day by 03:00 `NIGHTLY_TZ` | [WO "Tamper evidence"] |
| Chain break | any `chain_checks.ok = false` | [WO] (CoS is alerted by the app already) |
| Delivery failures | any `failed` in 1 h | [A] |
| Stuck/held/pending overdue | > 0 for 15 min | [A] |
| Backup age | > 26 h | [WO "Backups"] + [A] margin |

## 4. Who watches
Pilot: the Chief of Staff's office and the Embtel on-call person check §2 daily ([QA_STRATEGY.md §4](../05-testing-and-qa/QA_STRATEGY.md)). Production: automated alerts once the proposed items are approved and built. [A]
