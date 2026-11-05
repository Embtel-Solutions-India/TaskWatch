# Code Review Guidelines

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Reviewers tick every applicable box and link evidence. A box that does not apply is marked N/A with a reason. Standards referenced: [CODING_STANDARDS.md](CODING_STANDARDS.md), [ERROR_HANDLING.md](ERROR_HANDLING.md), [DATABASE_MIGRATION_POLICY.md](DATABASE_MIGRATION_POLICY.md), [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md).

## 1. Scope and process
- [ ] The change names its feature ID(s) and touches only the files needed for them.
- [ ] No architecture decision changed without an approved ADR (guardrail G-3).
- [ ] Nothing deleted without the user's OK (G-2). No commit or push was made by an agent (G-1).
- [ ] No new dependency, or a written justification exists ([CODING_STANDARDS §6](CODING_STANDARDS.md)).

## 2. Security
- [ ] No secret, token, real email or phone number in the diff (G-4, [WO "Secrets"]).
- [ ] Route is behind `requireUser` unless it is a signed-out auth route (C-1). [V-S] `middleware.ts:26-38`
- [ ] Non-GET routes rely on `csrfGuard`; no CORS was enabled (S-3, SEC-4). [V-S] `app.ts:50`
- [ ] Nothing new is reachable in production that depends on `devLogin` or `demoTools` (SEC-10). [V-S] `config.ts:60-62`
- [ ] Free text goes through `findSensitiveId` (C-6), including file names and rule notes if touched (S-12).
- [ ] CSV output goes through `csvCell`, and leading tab/CR are also neutralised (S-13). [V-S] `exports.ts:6-11`
- [ ] Uploads: authorize **before** writing to disk; type allowlist; size from config (S-4, S-5, SEC-8).
- [ ] Responses carry only the personal data the viewer needs (SEC-9; TASK-05 directory leak; S-16 outbox).

## 3. Authorization: object-level checks
- [ ] Every handler with `:id` (task, attachment, escalation, person, recurring, rule scope) loads the object and checks it against the viewer **in the service**, using `services/access.ts`. [V-S] `access.ts:11-30`
- [ ] Nested ids are checked together: `/tasks/:id/attachments/:aid` matches `a.task_id = :id` ([V-S] `routes/tasks.ts:129-135`, the existing good pattern).
- [ ] Lists use `visibilityFilter` in SQL, not a filter in JS after fetching everything. [V-S] `access.ts:20-26`
- [ ] Aggregates (dashboard, reports, digest, search, option lists) are computed over scoped rows only (DASH-03, RPT-04, SRCH-01).
- [ ] Role and permission edits: you cannot change your own role, and the last active CoS cannot be removed or deactivated (S-9, STAFF-02/03).
- [ ] A new negative test proves a user outside scope is refused (see [SECURITY_TEST_PLAN.md](../05-testing-and-qa/SECURITY_TEST_PLAN.md)).

## 4. Validation parity with the UI
- [ ] Every zod limit matches the UI's limit for the same field. Known mismatches to resolve, not copy:
  - task title: server 3–200 (`routes/tasks.ts:52`) [V-S] vs PRD 4–140 (TASK-01) [V-C];
  - upload size 15 MiB vs 25 MB (D-13).
- [ ] Unknown body fields are rejected (`.strict()`), per SEC-7.
- [ ] Validation failures return 422 with `fields` keyed by the UI's field names ([ERROR_HANDLING §3](ERROR_HANDLING.md)).
- [ ] Local wall-clock input is converted with `parseLocalDue` in the actor's zone, never trusted as UTC. [V-S] `services/tasks.ts:20-24`

## 5. Transactions and concurrency
- [ ] Any change that writes more than one row (task + log + notifications, reassign, extension decision, org move) runs inside one `tx()`. [V-S] `pool.ts:12-25`
- [ ] The task row is locked with `for update` before a state change, as `lockTask` and `applyLevel` do. [V-S] `services/tasks.ts:36-40`, `engine/engine.ts:74`
- [ ] Re-evaluation after a mutation (C-7) runs inside the same transaction (`applyLevel(c, id)`).
- [ ] State-transition races return 409, not a silent overwrite.
- [ ] Jobs remain safe if two instances run them (S-15): `job_runs` keys, `for update skip locked`, or an advisory lock. [V-S] `scheduler.ts:43-47`, `dispatcher.ts:41-46`

## 6. Performance (N+1)
- [ ] No query inside a loop over tasks or people. Use set-based SQL, `= any($1)`, or the in-memory `Directory`.
- [ ] Reporting-tree expansion uses the directory (`dir.descendants`) or a recursive CTE, not one query per level.
- [ ] Lists have a cap or pagination (S-17, D-10).
- [ ] Hash-chain verification stays per task (`verifyChains(pool, [taskId])`, `queries.ts:188`). [V-S] Never verify every chain on a request path.
- [ ] New filters have an index, or the review explains why not ([PERFORMANCE_TEST_PLAN.md](../05-testing-and-qa/PERFORMANCE_TEST_PLAN.md)).

## 7. Time zones
- [ ] Business time comes from `clock.now()`. [V-S] `clock.ts`
- [ ] Stored as `timestamptz` (UTC). Displayed with the **viewer's** zone; quiet hours use the **recipient's** zone; the digest uses IST. [WO] [V-S] `config.ts:69`
- [ ] Day boundaries (recurrence, "due today", reports by date) state which zone they use (D-5).
- [ ] A test covers at least one IST and one PT case when the change touches time (AC-9).

## 8. Logging and errors
- [ ] Errors use `HttpError` helpers; no stack or SQL in responses.
- [ ] No PII or secret in logs ([ERROR_HANDLING §5](ERROR_HANDLING.md)).
- [ ] Every state change appends to `activity_log` or `admin_log` (C-5); nothing updates or deletes them.

## 9. Tests
- [ ] Unit tests for pure logic and integration tests through real HTTP were added or updated ([TESTING_STRATEGY.md](../05-testing-and-qa/TESTING_STRATEGY.md)).
- [ ] No assertion weakened, skipped or deleted (guardrails §2.5).
- [ ] Test IDs from [TEST_CASE_INVENTORY.md](../05-testing-and-qa/TEST_CASE_INVENTORY.md) appear in the test titles or the change description.
- [ ] The author states exactly which commands were run. "Not run" is acceptable; "passes" without output is not.

## 10. Docs and tracker
- [ ] PRD or ADR updated if behaviour changed; evidence tags present.
- [ ] Env var, job or runbook changes reflected in [../08-operations/](../08-operations/).
- [ ] [IMPLEMENTATION_TRACKER.md](../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) row updated; hand-off in [../07-project-memory/](../07-project-memory/).
