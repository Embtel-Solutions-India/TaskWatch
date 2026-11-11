# Performance, Progress & Workload — Design (PERF)

_Status: **APPROVED by the owner 2026-11-06** ("looks good"). Nothing is built yet; next step is the implementation plan. Supersedes the open parts of [PERFORMANCE_SCOPE_GAP_ANALYSIS](../../01-discovery/PERFORMANCE_SCOPE_GAP_ANALYSIS.md) where they overlap._

> **Source tags:** **[OWNER]** decided by the product owner in the 2026-11-06 design conversation · **[CALL]** the designer's call, open to the owner's correction · **[BUILT]** already in the system · **[BUILDER]** left to the implementer.

**Built 2026-11-06 ([PERFORMANCE_PLAN](../../06-planning-and-tracking/PERFORMANCE_PLAN.md) Tasks 1–8).** Formulas in `shared/performance.ts`; migration 014; measured fields, reporting, review scores and the Rate action on the server; `GET /api/performance/{teams,leaderboard,people/:id}` and `/api/workload`; client Review/Rate dialogs, finish fields, task facts, and the Performance and Workload pages. Deviations: an extra `/api/performance/teams` for the team picker; the shortfall-reason rule applies to scored tasks only; `achieved` on a task without a target is a 422; breakdown access = self, `view_org_reports`, or `view_team_reports` for people below. Employee dashboard tiles (§6.6) move to Phase 8 (PERF-07). **PERF-07 server built 2026-11-06:** `me` on `GET /api/dashboard` (own month score from `personBreakdown`, average progress of open measured tasks, load from `workloadFor`); **PERF-07 client built 2026-11-06:** three tiles under the KPI row of the staff dashboard (score this month linking to the person's breakdown, progress of open measured tasks, load with band); hidden in mock mode (the prototype has no scores).

## 1. Why

Management needs to see, per person and per team, **what was asked, what was done, what came of it, whether it was on time and how good it was**, and how loaded each person is before more work is assigned. Today TaskWatch knows who was assigned what and when, and escalates silence; it does not know targets, achieved amounts, quality or effort. The BAIS spreadsheet tried to fill this gap by hand and produced unreliable data (see the gap analysis §3).

**Success:** a manager can open a team leaderboard for a month, see each person's score, click a score and see exactly which tasks produced it, and trust that nobody was marked down for a shortfall they could not control.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Every task can carry a **target**, a **unit**, the **achieved** amount and a **result** note. [OWNER]
2. Compute **progress**, **outcome**, **timeliness**, **quality**, a **performance score**, **efficiency** and **workload** from task data on the server.
3. A **team leaderboard** per period, with an explained, drill-down score.

**Non-goals (v1)**
- **No hours tracking.** No timers, no logged working minutes, no active/paused time. Timeliness is judged against the deadline only. [OWNER] (The work order excludes "time tracking by the hour".)
- **No HR appraisal** workflow: no appraisal forms, ratings cycles, payroll or HR links. [OWNER, "exclude HR for now"]
- **No spreadsheet fields** carried over as such: no daily funnel, service line, channel, time blocks, daily plan, "max 7 tasks". [OWNER]
- **No department templates.** Target and unit are typed freely by the task giver. [OWNER]
- **No revenue figures** in any score. [brief; consistent with OWNER's formula]

**Anti-goals (failure even if it works)**
- A person ranked down for an accepted, outside-their-control shortfall or delay.
- An unreviewed task silently counted as perfect quality.
- Ranking people who do different kinds of work against each other (ranking is within a team only).
- A score nobody can explain from the underlying tasks.

## 3. Hierarchy and who sees what

Organization → **Founder's Office team** → **verticals** (BAIS, USAIS, IE, Embtel, BAAS) → **teams** → **people**. [OWNER] This is the existing model: vertical = `entities`, team = `teams`, people in a reporting line [BUILT, ADR-0004/0010]. No new level.

| Viewer | Sees |
|---|---|
| Employee | Own scores and breakdown; **the leaderboard of their own team** [OWNER] |
| Team lead / manager | Leaderboards of the teams in their scope, **team by team** [OWNER]; drill-down into those people's tasks |
| Founder's Office (CoS, CEO) | Every team's leaderboard, team by team [OWNER] |

Scope uses the existing server-side visibility rules (reporting line, Founder's Office sees all) [BUILT]. A leaderboard row links only to tasks the viewer may already see; an employee seeing their team's board sees the scores of teammates, not their tasks. [CALL]

**Permissions** [CALL]: no new permission keys. Everyone may see their own team's board. Boards of other teams in scope need the existing `view_team_reports`; every team in the organization needs `view_org_reports` (CEO, CoS by default). Workload pages follow the same rule.

**Which team a score lands in** [CALL]: the person's **current** team (`users.team_id`) when the board is viewed. Team history is not stored; someone who moves team takes their period scores with them. People without a team appear under "No team" for management only.

## 4. New task data

Set by the **task giver** when assigning or editing [OWNER]:

| Field | Type | Rule |
|---|---|---|
| `target` | number > 0, optional | Empty = a task without a number. |
| `unit` | free text ≤ 40, required when `target` is set | e.g. "emails", "posts", "leads". [OWNER: freely] |
| `estimatedHours` | number 0.25–200, **required** | Expected effort. Used for workload only. [OWNER] |
| `purpose` | `revenue` \| `support`, **required** | Revenue-oriented vs support work. [OWNER: task giver sets it] Shown in reports and workload; **not** in the score. [CALL] |
| `priority` | existing | [BUILT] |

Set by the **assignee** while working or when finishing:

| Field | Type | Rule |
|---|---|---|
| `achieved` | number ≥ 0 | Only on tasks with a target. May exceed target. |
| `result` | free text ≤ 1000 | What came of the work ("6 replies, 2 consultations booked"). Not scored. [OWNER: "the result of task"] |
| `shortfallReason` | free text ≤ 500 | Required to finish a task with `achieved < target`, or to finish late. [CALL] |

Set by the **task giver** (the assigner; for a reassigned task, whoever assigned it last) [CALL]:

| Field | Type | Rule |
|---|---|---|
| `shortfallAccepted` | yes / no, with who and when | Marks the shortfall or delay as outside the person's control. Audited. [OWNER for the rule; CALL that the task giver decides] |
| `qualityScore` | integer 0–100 | Given by the reviewer **when approving** a task that went through review. [OWNER: formula] |
| `outcomeScore` | integer 0–100 | Only for tasks **without** a target: given by the reviewer when approving, or by the task giver in the **Rate** step. [OWNER] |

**Rate step** [OWNER]: after an assignee completes a task that did not go through review, the task giver gets a **Rate** action: an outcome score (tasks without a target) and accept / not accept for any shortfall or delay reason. Until rated the task shows **"awaiting rating"** and is left out of the affected score part. The window is **3 working days** [CALL]; after it the task stays "not rated" and excluded, and the giver can still rate it later (the score then updates). Reviewed tasks are rated in the review itself.

Existing fields reused: `due_at` (latest approved deadline), `original_due_at`, `completed_at`, `review_required`, status, activity log [BUILT].

**Recording `achieved` is a progress update** [CALL]: it is an assignee update, so it resets the silence clock exactly like posting progress does today (WO FR-3: assignee updates reset the clock), and on tasks with a target it sets the existing `progress` field to `min(achieved ÷ target, 1) × 100`. The assignee enters it once.

**Recurring schedules** [CALL] get the same giver fields (target, unit, estimated hours, purpose) and copy them to each generated task.

**Existing data** [CALL]: the new required fields apply to tasks created or edited after launch. Tasks created before launch are **not scored** (excluded from O, T, Q, E). Open pre-launch tasks without an estimate show "no estimate" in workload and add 0 hours until the task giver edits them; the workload page lists how many such tasks each person has.

## 5. Calculations (all server-side, one shared module)

All formulas live in one pure module used by server and client (pattern of `shared/levels.ts`, ADR-0007) [CALL]. Scores are rounded to one decimal for display only.

### 5.1 Progress (per task) — percentage [OWNER]
- Task with a target: `min(achieved ÷ target × 100, 100)`.
- Task without a target: the assignee's progress % (the existing 0–100 field) [BUILT].
- Completed: 100. Cancelled: not shown.
- **Team/person progress** = average progress of their open tasks. [CALL]

### 5.2 Which tasks count in a period [OWNER]
A task belongs to the period that contains its **latest approved due date**. If the due date is extended, the task moves to the period of the new date; the original stays in the audit history.

**Eligible** = due in the period, due date already passed (or completed), **not cancelled**, not a draft. [CALL for cancelled/draft] Periods: week (Mon–Sun), month, custom range, in the organization's time zone. [CALL]

### 5.3 Outcome O (0–100) [OWNER formula]
Per task:
- With a target: `min(achieved ÷ target × 100, 100)` at completion, or at the due date if still open.
- Without a target: `outcomeScore` (the reviewer's/task giver's 0–100). Completed without any score: **excluded from O and shown as "outcome not rated"**. [CALL]

Per person: **weighted average** `O = Σ(task outcome × weight) ÷ Σ(weight)`; the weight comes from the task's priority, set in Settings (1–10, default 1 = all tasks weigh the same) and printed with every score [OWNER, D-124, 2026-11-11; was a plain average]. Tasks with an **accepted shortfall** are excluded from the denominator [OWNER].

**Whose task it is** [CALL]: a task scores for the person assigned **when it was completed** (or on its due date, if still open then). If it was reassigned **after** its due date had already passed, it is excluded from the new assignee's Timeliness (they inherited a late task) but counts in their Outcome and Quality.

### 5.4 Timeliness T (0–100) [OWNER formula]
`T = tasks completed on or before their due date ÷ eligible tasks × 100`.
- Due date = latest approved one [OWNER].
- Tasks not yet due are excluded [OWNER].
- Accepted delays are excluded (Blocked is not automatically late) [OWNER].
- An open task past its due date counts as late, **including a Blocked one**, unless the task giver accepts the delay. The giver may accept a delay while the task is still open once a reason exists (the block reason counts as one). [CALL]
- On time / late only; no graduated penalty [OWNER].

### 5.5 Quality Q (0–100) [OWNER formula]
`Q = average qualityScore of eligible tasks that were reviewed`. Unreviewed tasks are **pending review**, never 100 [OWNER]. Rework rounds ("changes requested") do not lower Q directly; the reviewer's final score is what counts, and rework count is shown beside it. [CALL]

### 5.6 Performance score S [OWNER, D-124]
**Since 2026-11-11: `S = O`, the weighted Outcome Score alone.** The leaderboard ranks on it. Timeliness, Quality and Efficiency are still computed and shown for context, but do not change the rank.
- Superseded rule (2026-11-06 to 2026-11-10): `S = O × 0.50 + T × 0.20 + Q × 0.30`. Its code (`combine()`, `WEIGHTS`) and tests were removed on 2026-11-11 with the owner's approval.
- The ranking rule and the priority weights in force are printed under the leaderboard and on the person page.
- People with **fewer than 5 eligible tasks** in the period are listed but **not ranked**. [CALL]

Worked check (owner's example, D-124): 10/10, 40/50, 4/5 with equal weights → (100 + 80 + 80) ÷ 3 = **86.67**. With Critical 3 on the first task: (300 + 80 + 80) ÷ 5 = 92. (`server/test/performance.test.ts`)

### 5.7 Efficiency E (0–100), shown, not in S [CALL from OWNER's "how much was completed in the given time"]
`E = average over eligible tasks of (task outcome % if completed on time, else 0)`, accepted shortfalls/delays excluded. Shown **split by priority** (Critical/High vs Normal/Low) so work under pressure is visible. [CALL]

### 5.8 Workload (per person, now) [OWNER: priority + effort; CALL for the formula]
- **Open load** = Σ `estimatedHours` of open tasks (assigned, in progress, blocked, changes requested, reopened, in review).
- **Next 5 working days load %** = Σ `estimatedHours` of open tasks due within the next 5 working days ÷ (5 × working hours per day from Settings `workdayStart`–`workdayEnd`) × 100. Working days are **Monday–Friday** in the person's time zone; no holiday calendar in v1. [CALL]
- Shown with the share of that load that is **Critical/High**, plus counts of **overdue** and **blocked** tasks.
- Bands: under 50 % "light", 50–100 % "normal", over 100 % "overloaded". Replaces the count-based `overloadThreshold` for this view. [CALL]
- Shown to the task giver **in the assignee picker** when assigning. [CALL]

## 6. Screens (keep the current design language)

1. **Task form**: target, unit, estimated hours, purpose. **Task detail**: progress bar, achieved/result entry, shortfall reason, task giver's accept control, scores once given. [BUILDER: layout]
2. **Review approve**: requires a 0–100 quality score (and an outcome score when the task has no target).
3. **Team leaderboard** (new page): period picker, team picker (only teams in scope), table Rank · Person · Outcome · Timeliness · Quality · Score, formula line under the table, "not ranked" and "no quality reviews" markers, click-through to the person.
4. **Person breakdown**: the tasks behind each of O, T, Q, with excluded tasks and why.
5. **Workload**: per-team list of people with load %, band, critical share, overdue, blocked.
6. Employee dashboard tiles: own score, progress of open tasks, load. [BUILDER: placement]

## 7. Constraints

- Server computes everything; the client never derives scores from raw data it could not see (DASH-03 rule). [BUILT pattern]
- Every change to target, achieved, scores, shortfall acceptance is in the tamper-evident activity log with before/after. [BUILT pattern]
- Zod validation with field messages, object-level authorization, no PII in logs (AGENTS.md).
- Shared rules module; no duplicated formulas.
- Must land **before Phase 8 (dashboards)** so dashboards and reports use these figures once.
- Escalation ladder unchanged: estimates do **not** change update windows. [CALL; D-121]

## 8. Left to the builder

Migration shape, API paths (follow API_CONTRACTS conventions), caching of period aggregates, page layouts within the existing design system, test inventory (unit tests for every formula incl. the owner's worked example; integration tests for scope and exclusions).

## 9. Decisions recorded

D-110 owner: proceed without HR appraisal and without hours tracking (Founder's Office confirmation still advisable, since the WO is theirs) · D-111 department = vertical (existing entity), team = team · D-112 no time capture · D-113 n/a in v1 · D-114 task giver sets purpose · D-115/D-116 dropped (no funnel, no daily plan) · D-117 employees see their team board, management team by team · D-118/D-119 n/a (no funnel, no revenue) · D-120 open (migration) · D-121 open, default no.

## D-125: standard times and the over-time reason (owner, 2026-11-11; CODE_COMPLETE)

- **Standard task times.** `shared/standardTasks.ts` holds the default catalog: 82 rows transcribed from *Sales & Marketing — Task Time Estimation and SLA Guide*, each with section, task, min–max minutes per batch, batch size and unit. The organization's copy is the `standardTasks` setting, edited by the CoS under Settings → Standard task times (strict validation; at most 500 rows; omitted on save = unchanged). Everyone may read it (public settings), because the task form needs it.
- **Recommended estimate.** On the task form a "Standard task" picker fills the unit and the estimate: `recommendedHours = average(min, max) × quantity ÷ per`, rounded to 0.25 h, within 0.25–200 h. The quantity is the target, or one batch. The manager may keep it or type their own; changing the target shows a new recommendation with a "Use it" button.
- **Working time.** `workingHours(from, to, zone, shift)` counts the hours inside shifts that start Monday to Friday; an overnight shift (end ≤ start) runs past midnight. `shiftOf`: a person's own quiet window (D-105; the night team's 08:00–20:00) gives the complementary shift (20:00–08:00); everyone else works the Settings workday. The clock starts automatically at the scheduled start, else at assignment; no timer and nothing to enter. Public holidays are not excluded (owner accepted).
- **Over-time reason.** At submit or complete, `worked > estimatedHours` on a scored task requires the reason field, as late or short tasks already do: *"Took 7.5 working hours against a 5 h standard: explain the delay."* A newly given reason is also posted as a task comment ("Reason for delay or shortfall: …").
- **Reviewer.** The task page shows "Working time: 7.5 h of 5 h standard (+50 %)" next to the reason. Accepting the reason leaves the task out of the score (the existing shortfall acceptance); otherwise it is scored as usual.
- **Targets.** Finishing below a numeric target already required a reason (PERF-02); unchanged.
- Tests: `server/test/performance.test.ts` (weekday, weekend, overnight shift, outside the shift, shiftOf, catalog size and recommendations); `api.test.ts` "D-125: over the standard working time…" (not run yet).

## D-128: leaderboard visuals and analytics (owner, 2026-11-11; CODE_COMPLETE)

Visibility is unchanged (D-117). Above the leaderboard table, `BoardVisuals` shows:
- **Top performers:** a podium of the three highest-ranked people (1st in the middle); names link to the person page when the viewer may open it.
- **Outcome scores:** a bar for everyone with a score in the period, best first, with their rank; a bar opens the person page when allowed.
- **Score trend:** the team's average Outcome Score for each of the last 8 weeks ending with the period (`GET /api/performance/analytics` `trend`). Weeks without scored tasks are skipped, and at least two weeks are needed.
- **Team comparison:** only for viewers who may see more than one team: each team's average Outcome Score in the period, best first (`teams`). Choosing a bar opens that team's board. Teams without scores are listed as "No scores yet", never drawn as 0.
- Team average = `averageScore` (`shared/performance.ts`): the mean of the members' Outcome Scores, leaving out people without one, to one decimal. Access: the same team check as the leaderboard (404 outside scope).
