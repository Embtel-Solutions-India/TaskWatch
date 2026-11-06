# Performance, Progress & Workload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measured tasks (target, unit, achieved, result, estimate, purpose), giver ratings, and server-computed progress, outcome, timeliness, quality, score, efficiency and workload, shown on a team leaderboard, a person breakdown and a workload view.

**Architecture:** All formulas live in one pure module `shared/performance.ts` (ADR-0007 pattern, like `shared/levels.ts`). The server stores the new task fields (migration 014), extends the existing task actions, adds one `rate` action to `shared/workflow.ts`, and serves aggregates from `services/performance.ts`. The client gets form/detail/review/rate changes and three server-only pages.

**Tech Stack:** TypeScript, Express, zod, PostgreSQL (`pg`), luxon, React 19 + TanStack Query, node:test via `tsx`.

**Spec:** [docs/02-product-requirements/features/PERFORMANCE-FRD.md](../02-product-requirements/features/PERFORMANCE-FRD.md) (approved 2026-11-06). Read it with this plan.

## Global Constraints

- **Never commit or push** (AGENTS.md). Each task ends with a verification step instead of a commit.
- `npm test` drops `taskwatch_test`: the **owner** runs it (`! npm test`). The implementer runs `npx tsc --noEmit -p server`, `-p client`, the pure test files, `npx tsx client/src/selfcheck.ts`, and `npm run build`.
- Migrations: draft 014 in the scratchpad, dry-run it in a rolled-back transaction on `taskwatch_test` and dev, back up dev with `C:/Program Files/PostgreSQL/18/bin/pg_dump.exe --no-password`, then place it (DATABASE_MIGRATION_POLICY drafting rule). Never echo the connection string.
- Score weights fixed: **Outcome 0.50, Timeliness 0.20, Quality 0.30**; scores 0–100, rounded to one decimal **for display only**.
- Tasks weigh equally. No hours tracking, no HR appraisal, no revenue figures, no spreadsheet fields.
- Ranking floor: **5** eligible tasks. Workload: **5** working days, **Mon–Fri** in the person's zone, capacity from Settings `workdayStart`–`workdayEnd`; bands **<50 light, 50–100 normal, >100 overloaded**. Rate window **3 working days** (display only; rating stays possible later).
- Validation ranges: `target` > 0; `unit` 1–40 chars, required with a target; `estimatedHours` 0.25–200, required on new/edited tasks; `purpose` `revenue` | `support`, required on new/edited tasks; `achieved` ≥ 0; `result` ≤ 1000; `shortfallReason` ≤ 500; `qualityScore` / `outcomeScore` integers 0–100.
- New zod schemas carry user-facing field messages (ERROR_HANDLING §7) and are `.strict()`. Authorization on the server for every id (404 when not visible). Every change to these fields writes the task activity log with before/after.
- The client mock is not extended with scoring: the three new pages show "Available with the server backend" in mock mode; new task fields are optional in client types.
- The FRD §6.6 employee dashboard tiles (own score, open-task progress, load) are built in **Phase 8** with the dashboard, from the Task 5 endpoints; not in this plan.
- Escalation unchanged (D-121): estimates never change windows. Recording `achieved` is a progress update (resets the silence clock, sets `progress`).

## Review Focus

1. **Target edge values**: achieved above target caps at 100; an open task past due with a target and no achieved counts 0 outcome, not "not rated". → Task 1 tests.
2. **Period boundaries in the organization's zone**: a task due Sunday 23:30 in the org zone belongs to that week, not the next. → Task 1 test.
3. **Extended due date**: an extension moves the task into the new date's period and out of the old one. → Task 5 integration test.
4. **No eligible tasks**: score is `null` (shown "—"), never 0, and the person is not ranked. → Task 1 test.
5. **Reassigned after the due date**: excluded from the new assignee's Timeliness, still in their Outcome. → Task 1 test (pure) and Task 5 (query supplies `reassignedAfterDue`).

---

### Task 1: Shared performance module

**Files:**
- Create: `shared/performance.ts`; add `"./performance": "./performance.ts"` to `shared/package.json` exports
- Test: `server/test/performance.test.ts` (pure, no DB)

**Interfaces:**
- Produces:
  ```ts
  export const WEIGHTS = { outcome: 0.5, timeliness: 0.2, quality: 0.3 } as const;
  export const RANK_MIN_TASKS = 5;
  export type Purpose = 'revenue' | 'support';
  export interface ScoredTask {
    id: number; status: Status; dueAt: Date; completedAt: Date | null;
    target: number | null; achieved: number | null;
    outcomeScore: number | null; qualityScore: number | null; reviewed: boolean;
    shortfallAccepted: boolean | null; reassignedAfterDue: boolean; scored: boolean;
    priority: Priority; reworkCount: number;
  }
  export function taskProgress(t: { status: Status; target: number | null; achieved: number | null; progress: number }): number | null; // cancelled → null
  export function taskOutcome(t: ScoredTask, now: Date): number | null;   // null = not rated
  export function isOnTime(t: ScoredTask, now: Date): boolean;
  export function isEligible(t: ScoredTask, from: Date, to: Date, now: Date): boolean; // from inclusive, to exclusive
  export function periodBounds(kind: 'week' | 'month', anchor: Date, zone: string): { from: Date; to: Date };
  export interface PersonScore { outcome: number | null; timeliness: number | null; quality: number | null; efficiency: number | null;
    efficiencyByPressure: { high: number | null; normal: number | null }; score: number | null;
    eligible: number; ranked: boolean; flags: ('no_quality_reviews' | 'outcome_not_rated')[]; }
  export function personScore(tasks: ScoredTask[], from: Date, to: Date, now: Date): PersonScore;
  export function rankRows<T extends { score: number | null; ranked: boolean; name: string }>(rows: T[]): (T & { rank: number | null })[];
  export interface WorkloadInput { status: Status; dueAt: Date; estimatedHours: number | null; priority: Priority }
  export function workload(tasks: WorkloadInput[], opts: { now: Date; zone: string; workdayStart: string; workdayEnd: string }):
    { openHours: number; windowHours: number; capacityHours: number; loadPercent: number; band: 'light' | 'normal' | 'overloaded';
      highShare: number; overdue: number; blocked: number; noEstimate: number };
  ```
  `Status` from `./workflow`; `Priority` = `'critical' | 'high' | 'normal' | 'low'` (declare locally or import from `./levels` if exported there).

Rules to encode (FRD §5): eligible = `scored` && status not `cancelled`/`draft` && `from ≤ dueAt < to` && (`dueAt ≤ now` || completed). Outcome with target = `min(achieved/target×100, 100)` (achieved null → 0); without target = `outcomeScore` (null → not rated). Accepted shortfall (`shortfallAccepted === true`) excludes the task from O, T and E. T excludes `reassignedAfterDue`. Q = mean of `qualityScore` over reviewed eligible tasks. E = mean over eligible (non-accepted) of `outcome if on time else 0`; `efficiencyByPressure.high` over critical+high. Score: weighted sum over the parts present, divided by the sum of the present weights; all missing → null. `ranked = eligible >= RANK_MIN_TASKS && score !== null`. `rankRows`: ranked rows sorted by score desc (ties share a rank, next rank skips), unranked after, rank null. Open task past due = late. Workload: open = `LADDER_STATUSES`; window = now → end of the 5th working day (today counts if a working day) in `zone`; capacity = 5 × (workdayEnd − workdayStart) hours; `loadPercent` = Σ estimate of open tasks due in window ÷ capacity × 100; `highShare` = critical+high share of those hours (0 when none).

- [ ] **Step 1: Write the failing tests** in `server/test/performance.test.ts`:
  - `owner example O`: three tasks target/achieved 10/10, 50/40, 5/4 → `personScore(...).outcome` ≈ 86.67 (`Math.abs(x-86.667)<0.01`).
  - `owner example T`: 10 eligible, 8 on time → 80.
  - `owner example Q`: reviewed scores 95/90/85 → 90.
  - `score formula`: parts (92,90,95)→92.5, (88,95,90)→90.0, (85,85,92)→87.1, (78,80,85)→80.5 (test a helper path via `personScore` inputs or export `combine(o,t,q)` and test it).
  - `no quality reviews`: O=80,T=100 no reviewed → score = (40+20)/0.7 ≈ 85.71, flags include `no_quality_reviews`.
  - `cap and missing achieved` (Review Focus 1): achieved 140 of 100 → 100; open past due, target 100, achieved null → 0.
  - `accepted shortfall excluded`: a 50% task with `shortfallAccepted: true` does not lower O or T.
  - `reassigned after due` (Review Focus 5): excluded from T only.
  - `no eligible tasks` (Review Focus 4): score null, ranked false.
  - `ranking floor and ties`: 4 eligible → unranked; two rows 90.0 → both rank 1, next rank 3.
  - `week bounds in zone` (Review Focus 2): `periodBounds('week', 2026-11-08T18:00Z (Sun 23:30 IST), 'Asia/Kolkata')` → from 2026-11-02T00:00 IST, to 2026-11-09T00:00 IST.
  - `workload bands`: 9-hour workday, open tasks 10 h + 30 h due within window → capacity 45, loadPercent ≈ 88.9, band normal; 50 h → overloaded; estimate null counted in `noEstimate`, adds 0.
- [ ] **Step 2: Run** `cd server && npx tsx --test test/performance.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `shared/performance.ts` per the interfaces and rules above (luxon is not available in `shared/` — compute zone dates with `Intl.DateTimeFormat`, as `shared/levels.ts` does for quiet hours).
- [ ] **Step 4: Run** the same command — Expected: all PASS. Run `npx tsc --noEmit -p server` and `-p client` — Expected: exit 0.
- [ ] **Step 5: No commit** (AGENTS.md).

### Task 2: Migration 014 and measured task fields (create, edit, detail, recurring)

**Files:**
- Create: `server/src/db/migrations/014_performance.sql` (drafted in scratchpad first)
- Modify: `server/src/services/tasks.ts` (`TaskInput`, `checkTask`, `createTask`, `updateTask`), `server/src/routes/tasks.ts` (`taskBody`), `server/src/services/queries.ts` (`toTaskView`, detail), `server/src/services/recurring.ts` + `routes/recurring.ts` (schedule fields, copied to generated tasks)
- Test: `server/test/api.test.ts` new `describe('Performance (PERF): measured tasks, ratings, scores, workload')`

**Interfaces:**
- Produces (DB, `tasks`): `target numeric`, `unit text`, `achieved numeric`, `result text`, `estimated_hours numeric`, `purpose text check (purpose in ('revenue','support'))`, `quality_score smallint check 0–100`, `outcome_score smallint check 0–100`, `shortfall_reason text`, `shortfall_accepted boolean`, `shortfall_decided_by int references users`, `shortfall_decided_at timestamptz`, `scored boolean not null default true` — the migration sets `scored = false` on every existing row, then keeps the default true. `recurring_tasks`: `target`, `unit`, `estimated_hours`, `purpose`.
- Produces (API): task create/edit body adds `target?: number|null`, `unit?: string`, `estimatedHours: number`, `purpose: 'revenue'|'support'`; `TaskView` adds `target, unit, achieved, result, estimatedHours, purpose, qualityScore, outcomeScore, shortfallReason, shortfallAccepted, progress` (progress via `taskProgress`), `awaitingRating: boolean`.
- Field messages: `target` "Enter a target above 0.", `unit` "Name the unit, e.g. emails.", `estimatedHours` "Between 0.25 and 200 hours.", `purpose` "Choose revenue or support.".

- [ ] **Step 1: Write failing integration tests**: create with target 150/unit "emails"/estimate 2/purpose revenue → detail returns them; missing estimate → 422 `estimatedHours`; target without unit → 422 `unit`; target 0 → 422; draft may omit estimate and purpose (validated on publish); a schedule with target/estimate/purpose generates a task carrying them; pre-existing rows have `scored = false` (insert via SQL a task without the new fields in the test fixture? use one created before the migration is not possible — assert the column default: a new task has `scored = true`).
- [ ] **Step 2: Draft + dry-run + back up + place migration 014** (Global Constraints).
- [ ] **Step 3: Implement** the fields in `TaskInput`/`checkTask`/insert/update (edit logs before/after), `taskBody`, `toTaskView`, recurring create/edit/generation.
- [ ] **Step 4: Verify**: `npx tsc --noEmit -p server` exit 0; owner runs `! npm test` — Expected: new tests pass.
- [ ] **Step 5: No commit.**

### Task 3: Assignee reporting — progress with achieved, completion with result and shortfall

**Files:** Modify `server/src/routes/tasks.ts` (`progress`, `complete` schemas), `server/src/services/tasks.ts` (`postProgress`, `completeTask`, `submitTask`). Test: same describe.

**Interfaces:**
- `progress` body adds `achieved?: number` (≥ 0). When set on a task with a target: stores `achieved`, sets `progress = taskProgress(...)`, counts as the assignee update (existing clock reset path).
- `complete` and `submit` bodies add `achieved?: number`, `result?: string`, `shortfallReason?: string`. Rule: if (target set and final achieved < target) or (now > due_at) → `shortfallReason` required, else 422 `shortfallReason` "Explain the shortfall or delay."
- [ ] **Step 1: Failing tests**: progress with achieved 70 on target 150 → progress 47, `last_update_at` moved; complete with achieved 140/150 and no reason → 422; with reason → completed, `awaitingRating` true; late completion with achieved = target still needs a reason.
- [ ] **Step 2: Implement.** **Step 3: Verify** tsc exit 0; owner `! npm test`. **Step 4: No commit.**

### Task 4: Giver ratings — review scores and the Rate action

**Files:** Modify `shared/workflow.ts` (add `'rate'` to `TaskAction`; `ActionTask` gains `ratable: boolean`), `server/src/services/access.ts`/`queries.ts` (compute `ratable`), `server/src/services/tasks.ts` (`reviewTask`, new `rateTask`), `server/src/routes/tasks.ts`, `client/src/services/api/tasks.ts` mock `allowedActions` facts (pass `ratable: false`). Test: `server/test/workflow.test.ts` + api describe.

**Interfaces:**
- `ratable` = (status `completed` and not reviewed and (no target and `outcome_score` null, or `shortfall_reason` set and `shortfall_accepted` null)) or (open, `due_at < now`, a reason exists: `shortfall_reason` or `blocked_reason`, `shortfall_accepted` null). Rule in `allowedActions`: `if (task.ratable && f.isGiver) out.add('rate')`.
- `POST /api/tasks/:id/rate` body `{ outcomeScore?: int 0–100, shortfallAccepted?: boolean }` (strict; at least one) → `rateTask(actor, id, input)`; stores, sets `shortfall_decided_by/at`, logs `rated`. Later re-rating allowed (updates).
- `review` body adds `qualityScore?: int 0–100`, `outcomeScore?: int 0–100`; on `approved`: `qualityScore` required ("Give a quality score from 0 to 100."), `outcomeScore` required when the task has no target; may include `shortfallAccepted`.
- [ ] **Step 1: Failing tests**: workflow unit — giver gets `rate` when `ratable`, assignee does not; api — approve without quality score → 422; approve with 90 → `quality_score` 90; completed no-target task → giver rates 80 → `outcome_score` 80, `awaitingRating` false; non-giver rate → 403; open blocked past-due task → giver accepts delay.
- [ ] **Step 2: Implement.** **Step 3: Verify** `npx tsx --test test/workflow.test.ts` pass, tsc both exit 0, owner `! npm test`. **Step 4: No commit.**

### Task 5: Performance service and API

**Files:** Create `server/src/services/performance.ts`, `server/src/routes/performance.ts`; register in `server/src/app.ts`. Modify `server/src/services/queries.ts` `assigneeOptions` (add `load: { loadPercent, band }`). Test: api describe.

**Interfaces:**
- `GET /api/performance/leaderboard?teamId=&period=week|month|custom&from=&to=` → `{ team: {id,name}, from, to, weights: WEIGHTS, rows: [{ userId, name, outcome, timeliness, quality, efficiency, score, eligible, ranked, rank, flags }] }`. Default period: current month in the org zone (`settings.timezone`).
- `GET /api/performance/people/:id?from=&to=` → `{ person, score: PersonScore, tasks: [{ id, title, dueAt, completedAt, outcome, onTime, quality, reviewed, reworkCount, excluded: null | 'accepted' | 'not_rated' | 'reassigned_after_due' | 'pending_review' }] }`.
- `GET /api/workload?teamId=` → `{ team, rows: [{ userId, name, ...workload() }] }`.
- Scope (FRD §3): own team for everyone; other teams in scope need `view_team_reports` (team must contain someone in the viewer's reports, or be the viewer's own); any team in the organization needs `view_org_reports`; otherwise 404 for that team id. People breakdown: the viewer may see the person's tasks (existing `canViewUser`) — employees may open only themselves. Team = `users.team_id` now. Every query filters `organization_id`.
- Task rows: `scored` tasks of the team's current members, joined to the latest `assignments` row to compute `reassignedAfterDue = assigned_at > due_at`, plus review counts (`reworkCount` = `changes_requested` reviews).
- [ ] **Step 1: Failing tests**: a fixture team with 5 completed measured tasks for one person → leaderboard row score matches `personScore`; a staff member can read their own team's board and gets 404 for another team; a lead without `view_team_reports` cannot see another team; extended due moves a task across the month boundary (Review Focus 3); workload row bands for a seeded load; cross-organization team id → 404.
- [ ] **Step 2: Implement.** **Step 3: Verify** tsc exit 0; owner `! npm test`. **Step 4: No commit.**

### Task 6: Client — task form, detail, review and rate

**Files:** Modify `client/src/types/index.ts` (optional new `Task`/`TaskView` fields), `client/src/services/api/tasks.ts` + `tasksServer.ts` (bodies and mapping, `rateTask`), `client/src/features/tasks/TaskFormPage.tsx`, `TaskDetailPage.tsx`, the review dialog, `client/src/features/work/RecurringPage.tsx`.

**Interfaces:** `rateTask(id: string, input: { outcomeScore?: number; shortfallAccepted?: boolean }): void | Promise<void>` (mock: throws ApiError 501 "Available with the server backend."). Form fields: Target, Unit, Estimated hours, Purpose (Revenue-oriented / Support). Detail: progress bar from `progress`, achieved entry in the progress dialog, result + shortfall reason in the complete/submit dialog, "Awaiting rating" tag (with "rate within 3 working days" until that passes) and a **Rate** dialog when `actions` includes `rate`, scores once given. Review approve: quality score (and outcome score when no target).
- [ ] **Step 1:** Implement; keep the existing design components (`Field`, `Input`, `Select`, `Dialog`, `Tag`).
- [ ] **Step 2: Verify** `npx tsc --noEmit -p client` exit 0, `npx tsx client/src/selfcheck.ts` ok, `npm run build` ok; browser-check as Maria (giver) and Priya (assignee): create measured task → report 70 → complete with reason → rate. **Step 3: No commit.**

### Task 7: Client — leaderboard, person breakdown, workload

**Files:** Create `client/src/services/api/performanceServer.ts`, `client/src/services/api/performance.ts` (BACKEND switch; mock returns the "server backend" notice), `client/src/features/performance/LeaderboardPage.tsx`, `PersonPerformancePage.tsx`, `WorkloadPage.tsx`; modify `client/src/app/routes.tsx` (`/performance`, `/performance/people/:id`, `/workload`, all `server: true`, nav section Management) and the assignee picker in `TaskFormPage.tsx` (append ` · load 72% (normal)`).

**Interfaces:** consumes Task 5 endpoints. Leaderboard table columns exactly: Rank · Employee · Outcome · Timeliness · Quality · Score; under the table the line "Score = Outcome × 50% + Timeliness × 20% + Quality × 30%. Figures rounded to one decimal."; markers "Not ranked (fewer than 5 tasks)" and "No quality reviews"; period picker week/month/custom; team picker lists only teams returned as visible.
- [ ] **Step 1:** Implement. **Step 2: Verify** tsc, selfcheck, build; browser-check as Sofia (own team board only), Maria (her teams) and Rahul (all teams), and the workload bands. **Step 3: No commit.**

### Task 8: Docs and tracking

**Files:** `docs/06-planning-and-tracking/IMPLEMENTATION_TRACKER.md` (add PERF-01…PERF-07 rows), `REQUIREMENT_TRACEABILITY_MATRIX.md`, `docs/05-testing-and-qa/TEST_CASE_INVENTORY.md`, `docs/03-architecture/API_CONTRACTS.md`, `DATABASE_DESIGN.md` §6 (migration 014), the FRD "Built" note, `docs/07-project-memory/*`.
- [ ] **Step 1:** Update each. **Step 2: Verify** every relative link resolves (link-check loop as used before). **Step 3: No commit.**
