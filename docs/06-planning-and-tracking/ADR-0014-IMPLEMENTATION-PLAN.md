# ADR-0014 Scheduled Tasks, Deadline Escalation and Vertical Policies: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasks carry a scheduled window. Escalation runs on fixed deadline timestamps whose L2/L3 delays come from a per-vertical policy, which the vertical's GM edits and the CoS edits or overrides. Employees get a 10-minute warning and a floating countdown. Reviewers get their own deadline.

**Architecture:**
- **No new infrastructure.** The pure rules live in `shared/` (ADR-0007): milestones, policy merge, countdown selection.
- **Deadline milestones are stored on the task** (`deadline_l2_at`, `deadline_l3_at`) whenever its due date, priority or assignee changes. The existing 60 s engine reads them.
- **One-shot notices** (warning, start, review R1/R2) use the existing `job_runs` idempotency.
- **Policy** stays in `sla_rules`: a sparse per-vertical row, a version counter, and history in `admin_log`.

**Tech Stack:** TypeScript, Express 5, `pg` (raw SQL), zod, node:test via tsx, React + TanStack Query, Playwright.

**Spec:** [ADR-0014](../03-architecture/decisions/ADR-0014.md) (Accepted). Decisions: [OPEN_QUESTIONS §14](../01-discovery/OPEN_QUESTIONS.md), D-140…D-153.

## Global Constraints

- **AGENTS.md:**
  - No commit or push.
  - Ask before deleting anything.
  - `npm test` and the api tests drop `taskwatch_test`, so **every run of `server/test/api.test.ts` needs the owner's OK**.
  - The pure test files (`rules.test.ts`, `workflow.test.ts`, …) need no DB and may run freely.
- **No new dependency, table or job system.** Reuse `job_runs`, `admin_log`, `sla_rules`, `routing.ts`, `notify()`.
- **One implementation of every rule in `shared/`**, used by the server engine, the client mock and the Policies simulator (ADR-0007).
- **Constants (system-controlled, never in policy):**
  - `PRE_DEADLINE_WARNING_MINUTES = 10`
  - `START_NOTICE_MINUTES = 10`
- **Ship defaults reproduce today's behaviour exactly:**
  - `deadlineDelaysMinutes` = `{ critical: [1440, 4320], high: [1440, 4320], normal: [1440, 4320], low: [1440, 4320] }`
  - The D-152 values are entered through the UI in Task 14, never hard-coded:
    - critical `[30, 120]`
    - high `[240, 1440]`
    - normal and low `[1440, 4320]`
- **Review SLA defaults (D-152, new behaviour, so code defaults):** `reviewSlaMinutes = { critical: 30, high: 240, normal: 1440, low: 2880 }`.
- **Validation:**
  - L2 delay ≥ 5 and L3 > L2, each ≤ 43200 (30 days), whole minutes.
  - Review SLA 5…10080.
  - At most 10 extra recipients per level.
- **Coding:**
  - Errors go through `invalid()`, `notFound()` and `HttpError` (ERROR_HANDLING).
  - zod `.strict()` on every body.
  - `guardText` on free text.
  - Parameterized SQL only.
  - Object-level authorization on every `:scope` and `:id`.
- **UI changes are minimal.** Reuse `ui.tsx` components. Every screen works in light and dark.
- **After each phase,** update CHANGELOG, HANDOFF, CURRENT_STATE, the tracker, the RTM and the affected FRD.

## Review Focus

1. **A task edited from Normal to Critical after creation:** the milestones must be restamped with Critical delays (Task 3 test `restamps on priority edit`).
2. **A GM sends a field their vertical may not override** (e.g. `quietHours`): 422, nothing saved, no version bump (Task 8 test `GM cannot set org-wide fields`).
3. **A task assigned 5 minutes before it is due:** exactly one message (the assignment notice carries "due in 5 min"), no separate warning (Task 5 test `no warning when assigned inside the window`).
4. **A server restart or second instance during an engine run:** no duplicate warning, R1/R2 or escalation (Task 5 and Task 11 tests run the engine twice and count notifications = 1).
5. **A policy saved while tasks are open:** they keep their milestones until "Apply to open tasks"; silence windows change live as today (Task 9 test `policy change keeps open milestones`).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `shared/policy.ts` (new) | Policy types for the new fields, defaults, `resolvePolicy`, `deadlineMilestones`, `VERTICAL_FIELDS`, constants | 1, 7 |
| `shared/levels.ts` | `computeLevel` reads `deadlineAt` milestones instead of `overdueOffsetsHours` | 2 |
| `shared/schedule.ts` (new) | `nextCountdown`, `overlaps`, `outsideWorkingHours` | 6, 12 |
| `server/src/domain.ts` | `RulesConfig` gains the new fields; `DEFAULT_RULES` ship values | 1 |
| `server/src/engine/levels.ts` | Adapter passes stored milestones | 2 |
| `server/src/db/migrations/018_deadline_schedule.sql` (new) | Columns + backfill (ADR §12) | 3 |
| `server/src/services/tasks.ts` | `stampMilestones`, start time, submission requirements, reviewer, multi-assign, reassign rule | 3, 4, 11 |
| `server/src/engine/engine.ts` | Warning / start / review notices; accountability; giver cc and extra cc on L1+ | 5, 10, 11 |
| `server/src/notify/messages.ts`, `shared/notifications.ts` | New event types; Critical L1 not quietable | 5, 11 |
| `server/src/services/rules.ts`, `server/src/routes/rules.ts` | Sparse vertical overrides, versions, GM authorization, apply-to-open | 7, 8, 9 |
| `server/src/routes/tasks.ts` | Body fields: `startTime`, `submissionRequirements`, `reviewerId`, `assigneeIds`, reassign `dueDate`/`dueTime` | 4, 11 |
| `server/src/routes/schedule.ts` (new), `server/src/app.ts` | `GET /api/schedule` | 12 |
| `client/src/features/tasks/TaskFormPage.tsx` | Start time, duration, requirements, reviewer, multi-assignee, soft warnings | 4, 12 |
| `client/src/features/shell/DeadlineTimer.tsx` (new), `client/src/app/Shell.tsx` | Floating countdown | 6 |
| `client/src/features/tasks/TaskDetailPage.tsx` | Window, milestones, countdown, accountable, on-time badge | 6, 10 |
| `client/src/features/admin/AdminPages.tsx` (`PoliciesPage`), `client/src/app/routes.tsx` | Inherited/Custom fields, GM entry, history, apply dialog | 9 |
| `client/src/features/schedule/SchedulePage.tsx` (new) | Team and my-day schedule | 12 |
| `client/src/services/api/*` | Server calls + mock parity | 4, 6, 9, 12 |
| `server/test/rules.test.ts`, `server/test/schedule.test.ts` (new), `server/test/api.test.ts`, `e2e/*.spec.ts` | Tests | all |

---

## Phase 1: plumbing, no behaviour change

### Task 1: Policy fields, defaults and field-level merge (shared)

**Files:**
- Create: `shared/policy.ts`
- Modify: `server/src/domain.ts` (`RulesConfig`, `DEFAULT_RULES`); `client/src/constants/index.ts:95` (client default rules copy gets the same fields)
- Test: `server/test/rules.test.ts`

**Interfaces:**
- Produces:
  - `type DeadlineDelays = Record<Priority, [l2Minutes: number, l3Minutes: number]>`
  - `type ExtraRecipients = { l1: number[]; l2: number[]; l3: number[] }`
  - `interface PolicyExtras { deadlineDelaysMinutes: DeadlineDelays; reviewSlaMinutes: Record<Priority, number>; extraRecipients: ExtraRecipients }`. `RulesConfig` extends it.
  - `const SHIP_DEADLINE_DELAYS: DeadlineDelays`
  - `const DEFAULT_REVIEW_SLA: Record<Priority, number>`
  - `const PRE_DEADLINE_WARNING_MINUTES = 10`, `const START_NOTICE_MINUTES = 10`
  - `const VERTICAL_FIELDS = ['windowsHours', 'multiples', 'deadlineDelaysMinutes', 'reviewSlaMinutes', 'extraRecipients'] as const`
  - `resolvePolicy<T extends object>(base: T, ...layers: Array<DeepPartial<T> | null | undefined>): T` (leaf-wise merge; arrays and tuples are leaves)
  - `deadlineMilestones(dueAt: number, priority: Priority, p: Pick<PolicyExtras, 'deadlineDelaysMinutes'>): [number, number, number]`
  - `legacyDelays(overdueOffsetsHours: [number, number, number]): DeadlineDelays`: for a stored default row that has offsets but no delays, each priority gets `[o[1]*60, o[2]*60]`.

- [x] **Step 1: Write failing tests** in `rules.test.ts`, `describe('ADR-0014 policy')`:
  - `deadlineMilestones(T0, 'critical', { deadlineDelaysMinutes: SHIP_DEADLINE_DELAYS })` equals `[T0, T0+24h, T0+72h]`.
  - With `{ critical: [30, 120] }` it equals `[T0, T0+30min, T0+2h]`.
  - `resolvePolicy(base, { deadlineDelaysMinutes: { critical: [30, 120] } })` keeps `high` from base and changes only critical.
  - `resolvePolicy(base, orgLayer, verticalLayer)`: a vertical leaf wins over org, and an org change to an un-overridden leaf shows through ("global change never overwrites customisation").
  - `resolvePolicy(base, { multiples: [1, 2, 3, 4] })` replaces the whole tuple.
  - `legacyDelays([0, 24, 72])` deep-equals `SHIP_DEADLINE_DELAYS`.
- [x] **Step 2:** Run `cd server && npx tsx --test test/rules.test.ts`. Expected: FAIL (module not found).
- [x] **Step 3:** Implement `shared/policy.ts`. Add the fields to `RulesConfig` and `DEFAULT_RULES`:
  - `deadlineDelaysMinutes: SHIP_DEADLINE_DELAYS`
  - `reviewSlaMinutes: DEFAULT_REVIEW_SLA`
  - `extraRecipients: { l1: [], l2: [], l3: [] }`

  Do the same on the client constant.
- [x] **Step 4:** Run the same command. Expected: PASS, and every earlier test in the file still passes.
- [x] **Step 5:** `npm run typecheck` → 0 errors. No commit (AGENTS.md).

### Task 2: Ladder reads stored milestones (shared + server adapter)

**Files:**
- Modify: `shared/levels.ts` (`LevelInput`, `computeLevel`, `LadderRules`)
- Modify: `server/src/engine/levels.ts` (`LevelInput`, `computeLevel`, `taskLevel`)
- Modify: `client/src/services/api/base.ts:79`, `client/src/services/core.ts:153`, `client/src/features/admin/AdminPages.tsx:331`, `client/src/selfcheck.ts:17`
- Test: `server/test/rules.test.ts`

**Interfaces:**
- Consumes: `deadlineMilestones` (Task 1).
- Produces:
  - Shared `LevelInput.deadlineAt: readonly [number, number, number]` (L1, L2, L3 instants). This is required.
  - `LadderRules` drops `overdueOffsetsHours`.
  - Server `LevelInput.deadlineAt?: [Date, Date, Date]`. When omitted, the adapter computes it with `deadlineMilestones(dueAt, priority, cfg)`, so the existing unit tests are unchanged.
  - `taskLevel(t: { status; priority; clock_started_at; due_at; deadline_l2_at: Date | null; deadline_l3_at: Date | null }, cfg, now)`. A null milestone falls back to `deadlineMilestones`.

- [x] **Step 1: Write failing tests:**
  - `progress never moves the deadline level`: Critical, `deadlineAt = [due, due+30m, due+2h]`, `clockStartedAt = now` (just updated), `now = due+31m` → `level 2`, `reason 'overdue'`.
  - `stored milestones win over rules`: rules have ship delays; `deadlineAt` has +30 min → level 2 at due+30m.
  - `reachedAt[2] === deadlineAt[1]`.
- [x] **Step 2:** Run `npx tsx --test test/rules.test.ts`. Expected: FAIL on the new tests.
- [x] **Step 3:** In `computeLevel`, replace the `overdueOffsetsHours` loop and the `reachedAt` past-due candidate with `t.deadlineAt[k-1]`. Update the four client call sites to pass `deadlineAt` (from the task DTO's milestones, or `deadlineMilestones` in the simulator and mock).
- [x] **Step 4:** Run `npx tsx --test test/rules.test.ts test/levels-dst.test.ts test/workflow.test.ts`. Expected: all PASS, including every existing ESC-02 case, unchanged.
- [x] **Step 5:** `npm run typecheck` → 0.

### Task 3: Migration 018 and milestone stamping

**Files:**
- Create: `server/src/db/migrations/018_deadline_schedule.sql`. Use exactly ADR §12, with `policy_version text`, plus `tasks_deadline_idx on tasks (deadline_l2_at)`.
- Modify: `server/src/services/tasks.ts` (create/publish, edit, `doDueChange`, `doReassign`, reopen); `server/src/services/rules.ts` (`RuleSet.versionTag(entityId): string`); `server/src/services/queries.ts` (TASK_COLUMNS + DTO `milestones: [string, string, string]`)
- Test: `server/test/api.test.ts` (**owner OK to run**)

**Interfaces:**
- Consumes: `deadlineMilestones`; `getRuleSet(org).for(entity)`.
- Produces:
  - `stampMilestones(c: pg.PoolClient, taskId: number): Promise<void>`. It reads `due_at`, `priority` and `entity_id`, then writes `deadline_l2_at`, `deadline_l3_at` and `policy_version = versionTag(entity)`.
  - `versionTag` returns `"default@<v>"` or `"default@<v>,<ENTITY>@<v>"`.
  - The task DTO gains `milestones`, `policyVersion`, `startAt`, `submissionRequirements` and `reviewerId`.

- [x] **Step 1: Write failing API tests,** `describe('ADR-0014 milestones')`:
  - `stamps on create`: a Critical task due in 3 h → `deadline_l2_at − due_at = 24h`, `deadline_l3_at − due_at = 72h`, `policy_version = 'default@1'`.
  - `restamps on due change`: FR-5 change +2 h → both milestones move +2 h.
  - `restamps on priority edit`: Normal → Critical with the default changed to critical `[30, 120]` → milestones +30 min / +2 h.
  - `drafts are stamped at publish, not create`.
  - `AC-2 unchanged at ship values`: the existing TC-ESC-02-04 passes untouched.
- [x] **Step 2:** Run the api tests (owner OK). Expected: the new tests FAIL.
- [x] **Step 3:** Write the migration. Call `stampMilestones` after every write that sets `due_at`, `priority`, assignee (reassign) or status → `assigned`/`reopened`. Bump `sla_rules.version` in `saveRules` (`version = sla_rules.version + 1` in the upsert) and put `version` into the `admin_log` `after`.
- [x] **Step 4:** Run the api tests (owner OK). Expected: all PASS; the total equals the earlier total plus the new tests.
- [x] **Step 5:** Start the dev server (it migrates). `npm run db:seed -- --reset` only with the owner's OK. Spot-check one task's milestones in the UI: no visible change. Update CHANGELOG/HANDOFF: "Phase 1 done, no behaviour change".

---

## Phase 2: scheduling, warnings, countdown

### Task 4: Start time, duration, submission requirements, reviewer, multi-assign (D-144, D-153)

**Files:**
- Modify: `server/src/routes/tasks.ts:140-165` and `createTask` / `updateTask` in `services/tasks.ts`; `client/src/features/tasks/TaskFormPage.tsx`; `client/src/services/api/tasks.ts` (`createTask`, `updateTask`, mock)
- Test: `server/test/api.test.ts`

**Interfaces:**
- **Body additions:**
  - `startTime?: HH:MM`. Used only with `startDate`; default `'00:00'` as today.
  - `submissionRequirements?: string` (≤ 2000, `guardText`).
  - `reviewerId?: number`. Only when `reviewRequired`. Must be an active org member holding `review_tasks`, not the assignee; default = creator (as today).
  - `assigneeIds?: number[]` (1–20, distinct). Mutually exclusive with `assigneeId`.
- **Response:**
  - `assigneeIds` → `201 { tasks: Task[] }`. One `createTask` per person in **one transaction**: all or none.
  - `assigneeId` → unchanged `{ task }`.
- **Client:**
  - Start time input next to start date.
  - Read-only "Duration 1 h 30 min" from `due − start`.
  - Submission requirements textarea.
  - Reviewer select (visible when "Review required" is ticked).
  - Assignee multi-select.

- [x] **Step 1: Write failing tests:**
  - `start time is kept`: startDate + startTime 12:00 in the giver's zone → `start_at` is 12:00 local.
  - `start after due is refused` → 422 `startDate`.
  - `reviewer must hold review_tasks` → 422 `reviewerId`.
  - `reviewer cannot be the assignee` → 422.
  - `multi-assign creates one task per person`: `[5, 6]` → 2 tasks, separate ids, same title and due, each with its own milestones.
  - `multi-assign is all or none`: `[5, 99999]` → 422 and 0 tasks created.
  - `requirements shown on detail`: GET returns `submissionRequirements`.
- [x] **Step 2:** Run the api tests (owner OK). Expected: FAIL.
- [x] **Step 3:** Implement the server; then the client form fields; then mock parity in `services/api/tasks.ts`.
- [x] **Step 4:** Run the api tests (owner OK) and `npm run typecheck`. Expected: PASS, 0 errors.
- [x] **Step 5:** Browser check as Lead A: create a 12:00–13:30 Critical task for two people; both appear with duration 1 h 30 min. (Mock mode: form start/duration/also-assign checked, ledger Task 6.)

### Task 5: Pre-deadline warning, start notice, due-soon rule, giver on L1 (D-143, §9)

**Files:**
- Modify: `server/src/engine/engine.ts` (`sendDueNotices`, `applyLevel`); `server/src/notify/messages.ts`; `shared/notifications.ts` (types `deadline_warning`, `start_notice`; both in-app + push, not quietable); `services/tasks.ts` (the assignment notice text adds "due in N min" when due − now ≤ 10 min)
- Test: `server/test/api.test.ts`

**Rules (exact):**

| Job | When | Skipped when | To |
|---|---|---|---|
| `deadline_warning` | `now ≥ due − 10 min` and `now < due` | status `submitted`; or `assigned_at > due − 10 min` | assignee |
| `start_notice` | `start_at` set and `now ≥ start − 10 min` and `now < start` | status not in `assigned` | assignee |
| `due_soon` | existing timing | `due − dueSoonHours < assigned_at` (the window is shorter than dueSoonHours) | — |
| `overdue` notice | — | **removed**: L1 now copies the giver | — |

- Job keys: `deadline_warning` and `due_soon` use `${id}@${due_at.toISOString()}`; `start_notice` uses `${id}@${start_at.toISOString()}`.
- L1+ cc: add `t.assigner_id` when it is not already in To.

- [x] **Step 1: Write failing tests** (with `setNow`):
  - `warning fires once at T-10`: due in 30 min; at T−11 → 0 notices; at T−10 → 1 `deadline_warning` (in-app + push); engine run again → still 1.
  - `no warning when assigned inside the window`: assign at T−5 → 0 `deadline_warning`; the assignment notice text contains "due in 5 min".
  - `no warning after submission`.
  - `start notice once at start-10`.
  - `due_soon skipped for short tasks`: a 2 h task gets 0 `due_soon`; a 3-day task gets 1.
  - `giver copied on L1, no separate overdue notice`: at due → L1 cc includes the giver; `overdue` in-app count = 0.
- [x] **Step 2:** Run the api tests (owner OK). Expected: FAIL.
- [x] **Step 3:** Implement as in the table. Delete the `overdue` branch only after the owner confirms the removal (AGENTS.md: ask before deleting code). It was approved in ADR §9; say so when asking.
- [x] **Step 4:** Run the api tests (owner OK). Expected: PASS. Update TC-ESC-07-01 to the new rule. (api 161/161, ledger Task 5; TC-ESC-07-01 updated 2026-11-12.)

### Task 6: Floating countdown and task-detail timeline (D-149, US-05)

**Files:**
- Create: `shared/schedule.ts`; `client/src/features/shell/DeadlineTimer.tsx`
- Modify: `client/src/app/Shell.tsx` (render `<DeadlineTimer/>` after the topbar); `client/src/features/tasks/TaskDetailPage.tsx:81-104` (show "Scheduled 12:00–13:30", a live countdown, and "L1 13:30 · L2 14:00 · L3 15:30" from `t.milestones`); `client/src/styles.css`
- Test: `server/test/schedule.test.ts` (pure)

**Interfaces:**
- Produces: `nextCountdown(tasks: Array<{ id: string; title: string; status: Status; dueAt: number }>, now: number): { primary: CountdownItem | null; others: CountdownItem[] }`, where `CountdownItem = { id; title; dueAt; overdue: boolean; msLeft: number }` (`msLeft` < 0 when overdue).
  - It **includes** only tasks in `ACTIVE_STATUSES` with `dueAt − now ≤ 10 min`.
  - **Order:** overdue first by oldest `dueAt`, then soonest `dueAt`.
- **Data:** `listTasks('mine')` via `useApi`. It refreshes with the existing 60 s invalidation. Time comes from the client's server-adjusted `now()`, never `Date.now()`.
- **Pill:** top centre, `position: fixed`.
  - Shows the title, `mm:ss` left or `+mm:ss overdue` (danger colour), and a "+N more" button that opens a `Popover` listing the others.
  - Click opens the task.
  - The collapse button hides it to a dot, except when overdue.
  - Ticks every 1 s only while rendered.
  - `aria-live="polite"` text changes only on entering the window or going overdue.

- [x] **Step 1: Write failing tests** in `schedule.test.ts`:
  - Empty → `{ primary: null, others: [] }`.
  - A task due in 11 min → not included; due in 10 min → primary.
  - A submitted task → excluded.
  - Two overdue + one due in 5 min → primary is the oldest overdue; others are [newer overdue, due-in-5].
  - `msLeft` is negative for overdue.
- [x] **Step 2:** Run `npx tsx --test test/schedule.test.ts`. Expected: FAIL.
- [x] **Step 3:** Implement `nextCountdown`, then the component and the detail additions.
- [ ] **Step 4:** Run the tests (PASS) and `npm run typecheck` (0). Then a browser check with the dev clock as Staff: (Tests and typecheck passed; browser check done in mock mode except 360 px, ledger Task 6. Left open.)
  - the pill appears at T−10, counts down, turns red at T;
  - "+1 more" lists a second task;
  - light and dark; 360 px width.

---

## Phase 3: vertical policies

### Task 7: Sparse vertical overrides and resolution (D-142)

**Files:**
- Modify: `server/src/services/rules.ts` (`entityRulesSchema` → `verticalOverrideSchema`, `getRuleSet`, `checkRules`)
- Test: `server/test/rules.test.ts`, `server/test/api.test.ts`

**Interfaces:**
- `verticalOverrideSchema`: a strict, deep-partial object of `VERTICAL_FIELDS` only.
- `getRuleSet` computes:
  - the effective vertical policy = `resolvePolicy(DEFAULT_RULES, orgDefaultRow, verticalRow)`;
  - the org default = `resolvePolicy(DEFAULT_RULES, { deadlineDelaysMinutes: legacyDelays(row.overdueOffsetsHours) } if absent, row)`.

  Existing full rows (windows + multiples) are valid sparse rows, so **no data migration** is needed.
- `checkRules` adds the delay, SLA and recipients bounds (Global Constraints) under keys `d_<priority>`, `sla_<priority>` and `rcpt_<level>`.
- `extraRecipients` ids must be active users in that entity or `FO`. Otherwise 422 `rcpt_<level>`.

- [x] **Step 1: Write failing tests:**
  - Pure: `checkRules` rejects `[30, 20]` (`d_critical`), `[3, 20]` (L2 < 5) and SLA 0.
  - API: `vertical row with only critical delays inherits the rest`; `org default change shows through un-overridden fields`; `existing windows-only override still applies`.
- [x] **Step 2:** Run. Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Run the pure tests and the api tests (owner OK). Expected: PASS; TC-POL-03 updated for sparse rows. (api 168/168, ledger Task 7; sparse rows: TC-POL-04-01.)

### Task 8: GM authorization, scoped reads and history (D-141, D-150, US-02/03)

**Files:**
- Modify: `server/src/routes/rules.ts`; `server/src/services/me.ts` (bootstrap adds `headOf: string[]`, the entity ids where `head_id = me`)
- Test: `server/test/api.test.ts`

**Interfaces:**
- `canEditScope(user, dir, scope): 'all' | 'vertical' | null`:
  - a holder of `manage_escalation_policies` → `'all'`;
  - `scope !== 'default'` and `entities.head_id = user.id` (archived excluded) → `'vertical'`;
  - otherwise `null`.
- `PUT /api/rules/:scope`:
  - `null` → 403 for `default`, 404 for a vertical;
  - otherwise saves.
  - The vertical body uses `verticalOverrideSchema`, so org-wide fields → 422 from strict parsing.
- `GET /api/rules`:
  - a policy admin gets everything (today's shape plus `effective: Record<entity, RulesConfig>` and `versions`);
  - anyone else gets `defaults`, their own vertical's override and effective policy, and history filtered to `default` + own vertical.
- `GET /api/rules/history?scope=` (same filter, 50 rows, newest first).

- [x] **Step 1: Write failing tests** (fixture: set `entities.head_id = 3` for BAIS, restore after):
  - `GM edits own vertical` → 200, version 2, `admin_log` row with actor 3.
  - `GM edits other vertical` → 404.
  - `GM edits default` → 403.
  - `GM cannot set org-wide fields` (`{ quietHours: … }`) → 422, version unchanged.
  - `CoS overrides GM value` → 200, history shows both actors.
  - `staff sees only own vertical` → GET has no `EMB` key.
- [x] **Step 2:** Run (owner OK). Expected: FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** Run (owner OK). Expected: PASS.

### Task 9: Apply to open tasks, extra recipients and the Policies page (D-146, US-02/03)

**Files:**
- Modify: `server/src/routes/rules.ts` (`POST /api/rules/:scope/apply`, same authorization as PUT); `server/src/engine/engine.ts` (L1–L3 cc += `rules.extraRecipients['l'+k]`, deduped against To); `client/src/features/admin/AdminPages.tsx` `PoliciesPage`; `client/src/app/routes.tsx:81` (`allow`: perm **or** `headOf.length > 0`; nav label "Escalation Policies"); `client/src/services/api/admin.ts` (`applyPolicy(scope)`, `policyHistory(scope)`, mock parity using `resolvePolicy`)
- Test: `server/test/api.test.ts`

**Interfaces:**
- `apply`: in one transaction, `stampMilestones` for every task in that scope with a ladder status, then `runEngine({ organizationId, entityId })`.
  - Returns `{ updated: number }`.
  - `admin_log` kind `rules_applied`, `after: { scope, version, updated }`.
- **Page:**
  - Scope picker for policy admins only; GMs land on their vertical.
  - Each overridable field has an **Inherited** (shows the global value) / **Custom** tag and a "Reset to global" button, which removes that leaf from the sparse body.
  - The deadline table is priorities × (L1 "At due time", fixed text; L2; L3), with minute/hour inputs.
  - Review SLA row. Recipients: a people picker per level, limited to the vertical + FO.
  - Org-wide sections are read-only for GMs.
  - The pre-deadline warning shows read-only as "10 min (system)".
  - Saving opens a diff dialog with a required note.
  - After saving: "N open tasks keep their schedule. [Apply to open tasks]".
  - History tab.
  - The simulator passes `deadlineAt` from `deadlineMilestones`.

- [x] **Step 1: Write failing tests:**
  - `policy change keeps open milestones`: an open Critical task; the GM sets critical `[30, 120]` → its milestones are unchanged; a new task gets +30 min.
  - `apply restamps open tasks`: POST apply → `updated ≥ 1`, milestones +30 min, `admin_log` `rules_applied`.
  - `extra L2 recipient copied`: add user 6 to `l2` → the L2 escalation has 6 as cc.
  - `extra recipient outside vertical refused` → 422 `rcpt_l2`.
- [x] **Step 2:** Run (owner OK). Expected: FAIL. (The apply test passed on first run: the route was written in Task 8, ledger Task 9.)
- [x] **Step 3:** Implement the server, then the page.
- [ ] **Step 4:** Run (owner OK) and typecheck. Browser check as the GM (Manager A, head of BAIS) and as the CoS: edit, Inherited/Custom, reset, history, apply; the GM has no scope picker. (Tests 170/170 and typecheck passed; CoS global scope checked in mock mode; GM page not browser-checked in server mode, ledger Task 9. Left open.)

---

## Phase 4: review accountability, reassign rule, quiet hours, schedule views

### Task 10: Accountability and reviewer on in-review escalations (D-145, US-06)

**Files:**
- Modify: `server/src/engine/engine.ts` (`applyLevel` insert sets `accountable`; while `submitted` with the latest round's `submitted_at ≤ due_at`: `accountable = 'reviewer'` and add `t.reviewer_id ?? t.assigner_id` to To); `server/src/notify/messages.ts` (in-review wording "waiting for review by X since HH:MM"); `server/src/services/reports.ts` (assignee escalation counts filter `accountable = 'assignee'`); `client/src/features/tasks/TaskDetailPage.tsx` (an "On time" / "Late" badge on each submission: `submittedAt ≤ dueAt`; "Accountable: reviewer" on history rows)
- Test: `server/test/api.test.ts`

- [x] **Step 1: Write failing tests:**
  - `on-time submission makes later escalations the reviewer's`: submit at T−1h; at T → L1 `accountable='reviewer'`, To includes the reviewer.
  - `late submission stays with the assignee`: submit at T+1h → the L1 fired at T stays `assignee`.
  - `accountability report excludes reviewer escalations from the assignee`.
- [x] **Step 2–4:** Run (owner OK) → FAIL → implement → PASS.

### Task 11: Reviewer SLA R1/R2, Critical L1 at night, reassign needs a new due (D-145, D-147, D-148)

**Files:**
- Modify: `server/src/engine/engine.ts` (`sendDueNotices`: `review_r1` at `submitted_at + sla`, To = reviewer; `review_r2` at `submitted_at + 2·sla`, To = the reviewer's manager, or the FO via the same fallback as `routing.ts`, cc = reviewer; keys `${id}@r${round}`); `server/src/notify/messages.ts` (`quietable: level <= 1 && priority !== 'critical'`); `server/src/routes/tasks.ts:281` (reassign body adds `dueDate?`, `dueTime?`); `services/tasks.ts` `reassignTask`; `shared/notifications.ts` (`review_r1`, `review_r2`); the client reassign dialog (due fields, required when the task is late or due within 10 min)
- Test: `server/test/api.test.ts`

**Exact error:** reassigning when `due_at ≤ now + 10 min` without a new due → `422 { dueDate: 'This task is past due or due within 10 minutes: set a new due time for the new assignee.' }`.

- [x] **Step 1: Write failing tests:**
  - `R1 once at SLA`: a Critical task submitted → at +29 min 0; at +30 min 1 `review_r1` to the reviewer; the engine run twice → 1.
  - `R2 to reviewer's manager at 2×SLA`.
  - `no R1 after decision`.
  - `Critical L1 email not held at night`: assignee and lead in quiet hours → the L1 email status `pending`, not `held`.
  - `Normal L1 still held` (BR-53 regression).
  - `reassign late task without due` → 422 with the exact message.
  - `reassign late task with new due` → 200 and new milestones.
- [x] **Step 2–4:** Run (owner OK) → FAIL → implement → PASS. Update TC-WF-07-01/02 and TC-ESC-04. (api 176/176, ledger Task 11; TC-WF-07-02 and TC-ESC-04-08 updated 2026-11-12.)

### Task 12: Schedule views and soft warnings (US-01, US-04, D-151)

**Files:**
- Create: `server/src/routes/schedule.ts` (mount in `app.ts`); `client/src/features/schedule/SchedulePage.tsx` (route `/schedule`, nav "Schedule")
- Modify: `shared/schedule.ts`; `client/src/features/tasks/TaskFormPage.tsx` (warnings); `client/src/services/api/tasks.ts` (`getSchedule`, mock)
- Test: `server/test/schedule.test.ts`, `server/test/api.test.ts`

**Interfaces:**
- `overlaps(items: Array<{ id: string; start: number; end: number }>): Set<string>`: ids whose `[start, end)` intersects another's. If there is no start, `start = end − 1 h`.
- `outsideWorkingHours(at: number, zone: string, workdayStart: string, workdayEnd: string): boolean`. Reuse `wallClock` from `shared/levels.ts`.
- `GET /api/schedule?date=YYYY-MM-DD&teamId=N` or `&userId=N` (default self).
  - Visibility uses the same scope as `performance.visibleTeamIds` / `canView`. Outside it → 404.
  - Returns `{ date, people: [{ userId, name, tasks: [{ id, title, priority, status, startAt, dueAt, submittedAt, overlap: boolean }] }] }`. Tasks are those whose window intersects that day in the person's zone.
- **Page:**
  - A lead sees a team picker, people as rows and the day as a timeline (blocks start→due, priority colour, overlap outline, late = red).
  - Staff see their own day grouped Upcoming / Active / Overdue / Completed.
- **"Scheduled" label (ADR §2, display only):** the shared status label shows "Scheduled" for `assigned` with `startAt > now`. Pure test: `assigned + future start → 'Scheduled'`, `assigned + past start → 'Open'`.
- **Form:** non-blocking warnings: "Due 22:00 is outside Ana's working hours (09:00–18:00)" and "Overlaps 2 of Ana's tasks".

- [x] **Step 1: Write failing tests:**
  - Pure: `overlaps` on [10–11, 10:30–12, 13–14] → {a, b}.
  - Pure: `outsideWorkingHours` at 22:00 Kolkata with 09:00–18:00 → true; 10:00 → false.
  - API: `schedule scoped`: Lead A sees team A; Lead A asks for team B → 404; staff `userId` of another person → 404.
- [ ] **Step 2–4:** Run → FAIL → implement → PASS. Browser check as Lead A (team day view) and as Staff A1 (my day), light and dark, 360 px. (Tests passed: schedule 8/8, api 178/178; team view and My day checked in mock mode; 360 px not checked, ledger Task 12. Left open.)

---

## Phase 5: adopt the approved values, end-to-end, docs

### Task 13: End-to-end

**Files:** Create `e2e/escalation-v2.spec.ts` (reuse `e2e/fixtures.ts` and the dev clock).

- [x] **Step 1:** Spec `countdown, L1 at due, GM-tuned L2`:
  1. Lead creates a Critical 12:00–12:40 task for Staff.
  2. Advance to 12:30: the pill shows `10:00`.
  3. At 12:40: the pill shows overdue; the lead's bell has L1.
  4. The GM sets critical L2 = 30 min and applies.
  5. At 13:10: the manager has L2.
- [x] **Step 2:** `npm run e2e` (owner's environment). Expected: all specs PASS, including `auth.spec.ts`.

### Task 14: Enter the D-152 values and close the docs

- [x] **Step 1:** As the CoS on `/admin/policies` → Global → set:
  - critical `[30 min, 2 h]`
  - high `[4 h, 24 h]`
  - normal and low `[24 h, 72 h]`

  Note "D-152 owner-approved defaults". Then decide with the owner whether to press "Apply to open tasks". Verify the history row.
- [x] **Step 2:** Update:
  - ESCALATION-FRD (ESC-02 offsets → milestones, ESC-07 notices, new ESC-10 warning/countdown, ESC-11 review SLA);
  - ADMINISTRATION-FRD (POL vertical policy, GM);
  - TASKS-FRD (start time, requirements, reviewer, multi-assign);
  - BUSINESS_RULES BR-22/29/31/53/64;
  - TEST_CASE_INVENTORY (new and changed TC ids);
  - IMPLEMENTATION_TRACKER, REQUIREMENT_TRACEABILITY_MATRIX (US-01…07, D-140…153);
  - CURRENT_STATE, HANDOFF, CHANGELOG, KNOWN_ISSUES.
- [x] **Step 3:** Full `npm test` (owner OK) + `npm run typecheck` + `npm run e2e`. Report the real counts. Release gate AC-1…AC-10: AC-2 now reads "per approved policy" (D-140); record that in RELEASE_READINESS.
