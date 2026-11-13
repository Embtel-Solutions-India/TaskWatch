# ADR-0015 Attendance, Vertical Working Time and GM-run Verticals: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GMs mark attendance; escalation knows who is away and counts working time per vertical; each vertical owns its time zone, quiet hours and working days and hours; a GM runs their own vertical's people and structure.

**Architecture:**
- **One working-time clock.** It lives in `shared/worktime.ts` (`WorkClock`: `elapsed` and `add`). It is built from a vertical's schedule minus the assignee's away intervals, and wall clock for Critical tasks. The ladder (`shared/levels.ts`), milestones (`shared/policy.ts`) and the D-125 over-time check all take it, so there is one implementation (ADR-0007).
- **The directory carries the vertical's settings.** `DirUser.timeZone`, `quietStart`/`quietEnd` and a new `work` schedule come from the person's vertical (org fallback). Every existing consumer (quiet hours, email dates, shifts) follows with no further change.
- **Attendance** is one table, one route file and two screens.
- **GM scope** is one server helper used by the people and structure routes.

**Tech Stack:** TypeScript, Express 5, `pg` (raw SQL), zod, node:test via tsx, React + TanStack Query, Playwright.

**Spec:** [design](../superpowers/specs/2026-11-13-attendance-and-vertical-time-design.md), [ADR-0015](../03-architecture/decisions/ADR-0015.md), decisions D-156…D-165 ([OPEN_QUESTIONS](../01-discovery/OPEN_QUESTIONS.md)).

## Global Constraints

- **AGENTS.md:**
  - No commit or push.
  - Ask before deleting anything (per-person `time_zone`/`quiet_*` columns stay).
  - Never hardcode secrets.
  - No repeated code.
- **Tests:** `npm test` drops `taskwatch_test`; the owner has approved runs this session. Pure test files may run freely.
- **No new dependency or job system.** Reuse `job_runs`, `admin_log`, `notify()`, `appendAdmin`.
- **Coding:**
  - zod `.strict()` on every body.
  - Errors via `invalid()`, `notFound()`, `forbidden()`, `HttpError`.
  - Parameterized SQL.
  - Object-level authorization on every `:id` and every `userId` in a body.
- **Statuses:** exactly `present | absent | half_day | leave`. A cleared day is stored as `unmarked`.
- **Marking:** today and past only, in the vertical's time zone (D-163). A future day gets 422 `day` with "Attendance can be marked for today and past days only."
- **Away for escalation:**
  - only `absent`, `leave` or a `half_day` range;
  - each interval starts no earlier than the row's `marked_at` (D-164).
- **Critical tasks:** wall clock for silence and deadlines, exactly as today (D-160).
- **No attendance** for: heads of any vertical, `cos`, `ceo` (D-161).
- **Vertical defaults:**
  - time zone = organization `settings.timezone`;
  - working hours = `settings.workdayStart`/`workdayEnd`;
  - working days = Mon–Fri `[1,2,3,4,5]` (0 = Sunday);
  - quiet hours = policy `quietHours`.
- **UI:** minimal; reuse `ui.tsx`; light and dark; 360 px.
- **Docs:** after each task update CHANGELOG, plus the tracker and FRD when a feature completes.

## Review Focus

1. **A GM forgets to mark anyone today.** Escalation is identical to having no attendance feature, and no away notices go out (Task 6 test `unmarked days change nothing`).
2. **A GM marks yesterday as leave after L2 fired.** Levels never drop and no escalation is cleared (Task 3 test `a mark only counts from marked_at`).
3. **A Normal task left Friday 17:00 in a Mon–Fri 09–18 vertical.** No silence level climbs over the weekend. The same Critical task climbs as today (Task 2 and Task 3 tests).
4. **A GM edits a person from another vertical, or grants `cos`.** The response is 404 / 403 and nothing changes (Task 5 tests).
5. **A vertical in a different time zone from the organization.** "Today" for marking, quiet hours and email dates all use the vertical's zone (Task 4 test `vertical zone drives today and quiet hours`).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `shared/worktime.ts` (new) | `Schedule`, `Interval`, `WorkClock`, `makeWorkClock`, `WALL_CLOCK`, `scheduleOf` | 1 |
| `shared/performance.ts` | `workingHours` delegates to `makeWorkClock` | 1 |
| `shared/levels.ts`, `shared/policy.ts` | Silence clock and L2/L3 via `WorkClock` | 2 |
| `server/src/db/migrations/019_attendance_worktime.sql` (new) | Vertical columns + `attendance` table | 3 |
| `server/src/services/directory.ts` | `DirUser` time fields from the vertical; `work` schedule | 3 |
| `server/src/services/worktime.ts` (new) | `awayIntervals`, `clockFor` (server side) | 3 |
| `server/src/engine/levels.ts`, `engine/engine.ts`, `services/queries.ts`, `services/tasks.ts` | Pass clocks; stamp milestones; `timeUsed` | 3 |
| `server/src/services/structure.ts`, `routes/people.ts` | Vertical working-time settings; GM scope (`canManageVertical`) | 4, 5 |
| `server/src/services/attendance.ts`, `routes/attendance.ts` (new), `app.ts` | Attendance API, away notice | 6 |
| `client/src/features/attendance/AttendancePages.tsx` (new), `app/routes.tsx`, `services/api/attendance.ts` (new) | Attendance and My attendance screens | 7 |
| `client/src/features/org/VerticalsPage.tsx`, `features/staff/StaffPages.tsx`, `features/tasks/TaskDetailPage.tsx` | Working-time fields, GM scope, person form, away tag | 4, 5, 7 |
| `server/test/worktime.test.ts` (new), `rules.test.ts`, `api.test.ts`, `e2e/attendance.spec.ts` (new) | Tests | all |

---

## Phase 1: one working-time clock (no behaviour change)

### Task 1: `shared/worktime.ts` and `workingHours` on top of it

**Files:** Create `shared/worktime.ts`; modify `shared/performance.ts` (`workingHours` body); test `server/test/worktime.test.ts`.

**Interfaces (Produces):**
- `interface Schedule { zone: string; days: readonly number[]; start: string; end: string }`
  - `days` uses 0 = Sunday.
  - `start`/`end` are `HH:MM`; `end <= start` means overnight.
  - `end === '24:00'` with `start === '00:00'` means all day.
- `interface Interval { from: number; to: number }` (epoch ms, half-open).
- `interface WorkClock { elapsed(from: number, to: number): number; add(from: number, ms: number): number }`
  - Both are in ms.
  - `add` returns the instant at which `ms` of working time has passed after `from`.
- `const WALL_CLOCK: WorkClock`: `elapsed = to − from`, `add = from + ms`.
- `const ALWAYS: Schedule`: all 7 days, `00:00`–`24:00`, zone `UTC`.
- `makeWorkClock(s: Schedule, away?: readonly Interval[]): WorkClock`: working windows of `s` in `s.zone`, minus `away`.
- `scheduleOf(entity: { timeZone: string | null; workDays: number[] | null; workStart: string | null; workEnd: string | null }, org: { timezone: string; workdayStart: string; workdayEnd: string }): Schedule`: the fallbacks from Global Constraints.

- [x] **Step 1: Write failing tests** (`describe('worktime')`):
  - `elapsed` over Fri 17:00 → Mon 10:00 Asia/Kolkata, schedule Mon–Fri 09–18, equals 2 h.
  - `add(Fri 17:00, 2h)` equals Mon 10:00.
  - Overnight schedule 20:00–08:00 Mon–Fri: `elapsed(Tue 07:00, Tue 21:00)` = 2 h.
  - DST: `America/Los_Angeles`, 09–18, across 2026-11-01 counts 9 h per weekday.
  - Away interval Tue 09:00–13:00 removes 4 h from `elapsed(Tue 09:00, Tue 18:00)`; `add` skips it.
  - `ALWAYS` gives `elapsed` equal to wall clock.
  - `workingHours(from, to, zone, shift)` returns the same values as before for the existing D-125 cases (keep those tests unchanged).
- [x] **Step 2:** `cd server && npx tsx --test test/worktime.test.ts`. Expected: FAIL (module not found).
- [x] **Step 3:** Implement `shared/worktime.ts` with `zonedInstant`/`wallClock` from `shared/levels.ts`.
  - `add` walks working windows forward from `from`, at most 400 days, then returns `Infinity`.
  - `workingHours(from, to, zone, shift)` becomes `makeWorkClock({ zone, days: [1,2,3,4,5], start: shift.start, end: shift.end }).elapsed(...) / 3_600_000`, rounded as before.
- [x] **Step 4:** Run `npx tsx --test test/worktime.test.ts test/performance.test.ts`. Expected: PASS. Then `npm run typecheck` → 0.

### Task 2: Ladder and milestones take a `WorkClock`

**Files:** Modify `shared/levels.ts` (`LevelInput`, `computeLevel`), `shared/policy.ts` (`deadlineMilestones`); test `server/test/rules.test.ts`.

**Interfaces:**
- Consumes `WorkClock`, `WALL_CLOCK` (Task 1).
- Produces:
  - `LevelInput.silenceClock?: WorkClock` (default `WALL_CLOCK`). Silence time = `silenceClock.elapsed(clockStartedAt, now)`. The silence `reachedAt[k]` = `silenceClock.add(clockStartedAt, threshold_k)`.
  - `deadlineMilestones(dueAt, priority, p, clock: WorkClock = WALL_CLOCK)`: L2/L3 = `clock.add(dueAt, minutes × 60_000)`.

- [x] **Step 1: Write failing tests** in `describe('D-160 working-time ladder')`:
  - `normal task does not climb over the weekend`:
    - clock = Mon–Fri 09–18 Kolkata;
    - `clockStartedAt` Fri 17:00, `now` Mon 08:59;
    - window 48 h → `silenceLevel = -1`.
  - `critical task climbs over the weekend as today`: with `WALL_CLOCK` and the same times → `silenceLevel = 3`.
  - `L2 counts working minutes after due`: Normal due Fri 17:00, delay 1440 min → L2 at 1440 working minutes later, the exact instant computed by `add`.
  - All existing ESC-02 and ADR-0014 tests pass unchanged (they use the default `WALL_CLOCK`).
- [x] **Step 2:** `npx tsx --test test/rules.test.ts`. Expected: the new tests FAIL.
- [x] **Step 3:** Implement. No caller change yet (the default is wall clock).
- [x] **Step 4:** `npx tsx --test test/rules.test.ts test/levels-dst.test.ts test/workflow.test.ts` → PASS; `npm run typecheck` → 0.

## Phase 2: vertical working time and attendance in the engine

### Task 3: Migration 019, directory from the vertical, clocks wired into the server

**Files:**
- Create `server/src/db/migrations/019_attendance_worktime.sql` (use the next free number if 019 is taken).
- Create `server/src/services/worktime.ts`.
- Modify `services/directory.ts`, `engine/levels.ts`, `engine/engine.ts`, `services/queries.ts`, `services/tasks.ts` (`stampMilestones`, `timeUsed`).
- Test `api.test.ts`.

**Migration (exact columns):**
- `entities` add:
  - `time_zone text`;
  - `quiet_enabled boolean`, `quiet_start text`, `quiet_end text`;
  - `work_days int[]`, `work_start text`, `work_end text`.
  - All nullable (null = organization default).
- `create table attendance`:
  - `organization_id int not null`;
  - `user_id int not null references users(id)`;
  - `day date not null`;
  - `status text not null check (status in ('present','absent','half_day','leave','unmarked'))`;
  - `away_from text`, `away_to text`;
  - `marked_by int not null references users(id)`;
  - `marked_at timestamptz not null`;
  - `primary key (user_id, day)`;
  - `foreign key (user_id, organization_id) references users (id, organization_id)`.
- Index on `(organization_id, day)`.

**Interfaces:**
- Consumes Tasks 1–2.
- Produces:
  - `DirUser.timeZone`, `quietStart`, `quietEnd` now resolved from the vertical (`entities`), else the organization. The per-person columns are no longer read.
  - New `DirUser.work: Schedule`.
  - `awayIntervals(db, organizationId, userIds: number[], from: Date, to: Date): Promise<Map<number, Interval[]>>`. It reads `absent`/`leave` (the whole working day) and `half_day` (`away_from`–`away_to`) rows, each clipped to start at `marked_at`.
  - `clockFor(user: DirUser, priority: Priority, away: Interval[]): WorkClock`: `WALL_CLOCK` for `critical`, else `makeWorkClock(user.work, away)`.
  - `taskLevel(t, cfg, now, silenceClock?: WorkClock)`.
  - `stampMilestones` passes `makeWorkClock(assignee.work)` for non-Critical. Away is not subtracted from deadlines.
  - `timeUsed` uses `makeWorkClock(person.work)`. Away is not subtracted.

- [x] **Step 1: Write failing API tests** in `describe('ADR-0015 working time and away')`:
  - **Test fixture:** in `before`, give every fixture vertical the `ALWAYS` schedule (`work_days {0..6}`, `00:00`–`24:00`), so all earlier suites keep their behaviour. Each new test sets its own schedule and restores it in `finally`.
  - `normal silence skips the weekend`: BAIS Mon–Fri 09–18 Kolkata; Normal task, last update Fri 17:00; `setNow` Mon 08:59 + `runEngine` → level −1. The same as Critical → level ≥ 1.
  - `a mark only counts from marked_at`:
    - a Normal task reaches L1;
    - then mark yesterday as leave (SQL insert with `marked_at = now`) and `runEngine`;
    - the level is unchanged and no escalation is cleared.
  - `leave today pauses non-Critical silence, not Critical`: mark leave at 09:00; at 18:00 the Normal level is unchanged from 09:00, the Critical one climbs.
  - `vertical zone drives quiet hours`: BAIS zone `America/Los_Angeles`, quiet 21:00–08:00; an L0 email for Staff A1 (personal zone Asia/Kolkata) at 22:00 LA is `held`.
  - `L2 stamped in working minutes`: a Normal task due Fri 17:00 → `deadline_l2_at` = `add(due, 1440 min)` under Mon–Fri 09–18.
- [x] **Step 2:** `npm test`. Expected: the new tests FAIL; all others pass.
- [x] **Step 3:** Implement:
  - **Migration and directory:** the directory joins `entities` for the time fields; `toDirUser` builds `work` with `scheduleOf`.
  - **Engine:** the engine (both `taskLevel` call sites) loads `awayIntervals` once per run for the assignees of the tasks it evaluates, over `[min(clock_started_at), now]`.
  - **Task lists:** `queries.ts` does the same per list request.
- [x] **Step 4:** `npm test` → all PASS (report the count); `npm run typecheck` → 0.

### Task 4: Vertical working-time settings (API + Verticals page)

**Files:** Modify `services/structure.ts` (entity update), `routes/people.ts` (`PUT /entities/:id` body), `client/src/features/org/VerticalsPage.tsx`, `client/src/services/api/admin*.ts`; test `api.test.ts`.

**Interfaces:**
- **Body additions** on `PUT /api/entities/:id`, each optional (`null` = organization default):
  - `timeZone` (IANA, validated with `Intl.DateTimeFormat`);
  - `quietHours: { enabled, start, end }`;
  - `workDays: number[]` (1–7 distinct values in 0–6);
  - `workStart`, `workEnd` (`HH:MM`, or `24:00` for end).
- **Audit:** `vertical.worktime_changed` with before and after.
- **Response:** `GET /api/entities` returns each vertical's resolved and stored values.
- **Apply:** "Apply to open tasks" reuses `POST /api/rules/:scope/apply`, which restamps with the new clock (D-165).

- [x] **Step 1: Failing tests:**
  - `GM sets their vertical's working time; audited`;
  - `bad zone → 422 timeZone`;
  - `vertical zone drives today and quiet hours` (pairs with Task 3);
  - `open tasks keep milestones until apply` (D-165).
- [x] **Step 2:** Run → FAIL.
- [x] **Step 3:** Implement the server, then a "Working time" block on each vertical card:
  - **Fields:** zone select, day toggles, start/end, quiet hours.
  - **Banner:** "Open tasks keep their escalation times until you apply the change" with an **Apply to open tasks** button.
- [x] **Step 4:** `npm test` and `npm run typecheck` → PASS / 0.

## Phase 3: GM runs their vertical (D-162)

### Task 5: Vertical-scoped staff and structure management

**Files:**
- Modify `routes/people.ts` (every `requirePermission('manage_staff', …)`), `services/staff.ts`, `services/structure.ts`, `services/me.ts` (bootstrap).
- Client: `app/routes.tsx` (`gm: true` on `/admin/staff` and `/admin/verticals`), `features/staff/StaffPages.tsx`, `features/org/VerticalsPage.tsx`.
- Test: `api.test.ts`.

**Interfaces (Produces):**
- `canManageVertical(actor: DirUser, dir: Directory, entityId: string): Promise<boolean>`: `manage_staff` holders → true; else true when `entityId` is in `headOf(actor)`.
- **Route checks:** each people/structure route replaces `requirePermission('manage_staff')` with a check on the **target's** vertical:
  - create: the body's `entityId`;
  - edit/status/reset: the person's current and new `entityId`;
  - teams: the team's `entity_id`.
- **GM limits:** 403 "Only the Chief of Staff can do that." when a non-`manage_staff` actor:
  - grants or removes `cos` or `ceo`;
  - grants `manager` to someone outside their vertical;
  - changes any `entities.head_id`;
  - creates or archives a vertical;
  - touches `FO`.
- **Lists:** `GET /api/people` for a GM includes contact fields for their vertical's people.

- [x] **Step 1: Failing tests:**
  - `GM adds, edits, deactivates and resets someone in their vertical`;
  - `GM gets 404 for a person in another vertical`;
  - `GM cannot grant cos or ceo (403), cannot change the head`;
  - `GM manages departments of their vertical only`;
  - `CoS unchanged`.
- [x] **Step 2:** Run → FAIL.
- [x] **Step 3:** Implement the server, then the client:
  - routes get `gm: true`;
  - the Staff page filters to the GM's vertical;
  - role choices are limited to staff/lead/manager;
  - the person form drops time zone and quiet hours and shows "Follows <vertical>: <zone>, <days> <start>–<end>" read-only.
- [x] **Step 4:** `npm test`, typecheck → PASS / 0.

## Phase 4: attendance

### Task 6: Attendance API and away notice

**Files:** Create `server/src/services/attendance.ts`, `server/src/routes/attendance.ts`; modify `app.ts`, `shared/notifications.ts` (event `away_tasks`); test `api.test.ts`.

**Interfaces (Produces):**
- `hasAttendance(u: DirUser, heads: Set<number>): boolean`: active, not `cos`/`ceo`, not a head of any vertical.
- `canMark(actor: DirUser, target: DirUser, heads: Map<string, number>): boolean`:
  - a vertical's head marks that vertical's members;
  - a `cos` marks `FO` members.
- **`PUT /api/attendance`** body `{ userIds: number[] (1–200), from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', status: 'present'|'absent'|'half_day'|'leave'|'unmarked', awayFrom?: 'HH:MM', awayTo?: 'HH:MM' }`:
  - **Validation:** `to` ≤ today in the vertical's zone, `from ≤ to`, at most 62 days.
  - **Half day:** needs `awayFrom < awayTo` inside working hours.
  - **Range:** one upsert per working day of the target's vertical.
  - **Audit:** one `attendance.marked` row per request (`after` = ids, days, status).
  - **Returns** `{ updated: number }`.
- **`GET /api/attendance?from&to&teamId&userId&status`:**
  - **Rows:** every person the caller may mark, per day in range. Unmarked days are returned as `status: 'unmarked'`, which the UI shows as absent (D-157).
  - **Caps:** 404 for a `userId` outside scope; range ≤ 62 days.
- **`GET /api/attendance/me?month=YYYY-MM`:** the caller's own days; 404 if `hasAttendance` is false.
- **Away notice** (D-158), when a mark sets someone away **today**:
  - find their open tasks due before the end of their next working day;
  - send one `notify()` (in-app + email) each to the assignee, their vertical's head (CoS for FO) and each distinct giver;
  - idempotent via `job_runs` key `away:<userId>:<day>`.

- [x] **Step 1: Failing tests:**
  - `GM marks present, absent, half day and leave for their members; audited`;
  - `no future days (422 day)`;
  - `cannot mark another vertical (404), a GM, the CoS or the CEO (422 userIds)`;
  - `CoS marks the Founder's Office only`;
  - `half day needs a valid range (422 awayFrom)`;
  - `unmarked days change nothing` (no notices, levels unchanged);
  - `away today notifies assignee, GM and giver once` (mark twice → still one each);
  - `everyone sees only their own month`.
- [x] **Step 2:** Run → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** `npm test`, typecheck → PASS / 0.

### Task 7: Attendance screens and the away tag

**Files:** Create `client/src/features/attendance/AttendancePages.tsx`, `client/src/services/api/attendance.ts`; modify `app/routes.tsx`, `features/tasks/TaskDetailPage.tsx`, `services/api/tasks*.ts` (DTO `assigneeAwayUntil`), `server/src/services/queries.ts` (DTO field).

**Interfaces:**
- **Routes:**
  - `/attendance`: title "Attendance", sidebar section Management, `gm: true` (CoS via FO).
  - `/my-attendance`: title "My attendance", General, shown only when `bootstrap.hasAttendance`.
- **Bootstrap:** `/api/me` gains `hasAttendance: boolean`.
- **Task DTO:** `assigneeAwayUntil: string | null`, the end of today's away interval when away now.

- [x] **Step 1:** Implement the Attendance page:
  - **Day tab (default):** today, one row per member with a status `Select`; half day reveals from/to time inputs; a "Mark all present" button.
  - **Month tab:** people × days grid. Unmarked cells are shown as absent with a dashed outline, so the GM sees gaps.
  - **Mark range dialog:** person(s), from–to (max today), status.
  - **Filters:** date range, department, person, status (including "Not marked").
  - **Export CSV.**
- [x] **Step 2:** Implement My attendance: a month calendar with colour per status and a legend, read-only.
- [x] **Step 3:** On the task page, show a `Tag` "Assignee on leave" or "Assignee away until 14:00" when `assigneeAwayUntil` is set.
- [x] **Step 4:** `npm run typecheck` → 0.
- [x] **Step 5: Browser check** in server mode, as a GM and as staff, in light and dark and at 360 px:
  - mark a half day;
  - mark leave for a past range;
  - filter "Not marked";
  - staff see their own calendar.

### Task 8: End-to-end and docs

**Files:** Create `e2e/attendance.spec.ts`; extend `e2e/server.ts` (BAIS working time `ALWAYS` except in this spec); update docs.

- [x] **Step 1: Spec** `GM marks leave; Normal task does not climb; Critical does; notice once`. It uses the dev clock like `escalation-v2.spec.ts`.
- [x] **Step 2:** `npm run e2e` → all pass (report the count).
- [x] **Step 3: Docs:**
  - STAFF-AND-ORG-FRD (attendance, GM scope, vertical working time);
  - ESCALATION-FRD (D-158, D-160);
  - ADMINISTRATION-FRD;
  - BUSINESS_RULES;
  - TEST_CASE_INVENTORY;
  - IMPLEMENTATION_TRACKER and RTM (D-156…D-165);
  - RELEASE_READINESS (AC-2 for non-Critical, D-160);
  - CURRENT_STATE, HANDOFF, CHANGELOG, KNOWN_ISSUES.
- [x] **Step 4:** Full `npm test` + `npm run typecheck` + `npm run e2e`. Report the real counts. Mark ADR-0015 "Accepted (built)".
