# Dashboards & Team Overview FRD (DASH)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). The WO FR-11 accountability tables (by entity / by person, CSV + PDF) are specified in [REPORTS-FRD.md](REPORTS-FRD.md) (RPT-05..07) and only linked here.
> Every rule in §1 is transcribed from `features/dashboard/insights.ts` and `services/api/misc.ts:getDashboard`. Thresholds are exact. Nothing here has been executed. No test has been run.

**Built 2026-11-06 (Phase 8 Batch A, T-8.1/T-8.2; server).** §1 rules and the per-layout composition are `shared/insights.ts` (`buildDashboard`, D-9/ADR-0007), epoch ms in, ISO out, days in the viewer's zone. `GET /api/dashboard` (`services/dashboard.ts` `roleDashboard`) gathers the scope with `queries.ts dashboardTasks` (the visibility rule = D-51 scope, non-draft) and returns the layout's widgets plus `l3Banner` and `me` (PERF-07). `GET /api/team/overview` (`teamOverview`). Deviations: the submitted-and-past-due quirk (§1.4 D) now reads "Past due (in review)"; staff-by-role counts each person once under their highest role. Client (T-8.5) is Batch B.

**Built 2026-11-06 (Batch B, T-8.5; client). DASH-01…03 code-complete.** `DashboardPage.tsx` and `TeamPage.tsx` render only the payload of `getDashboard(range, entity)` / `getTeamOverview()` (`services/api/misc.ts`); no `getDb()` in either (DASH-03-AC-4). The mock builds the same payload by calling the shared `buildDashboard` / `buildTeamOverview`. Team overview composition moved into `shared/insights.ts` too. The CoS filter is now labelled "Entity" (D-4). "New task" follows `canCreate` (AC-8). Browser-checked in server mode as CoS, manager, lead and staff, and in mock mode as CoS. Deviation: the attention item's level badge no longer shows the "acknowledged" style (the brief carries no ack flag).

**Hard requirement (DASH-03): every number on a dashboard is computed on the server, over data the viewer may see.** Today the client computes everything in the browser and reads the raw store for many widgets. [V-C `features/dashboard/DashboardPage.tsx:33, :107-119, :262, :358, :447, :486`]

---

## 1. Metric rules (shared by DASH-01 and DASH-02)

### 1.1 Base definitions

| Term | Definition | Evidence |
|---|---|---|
| Active status | `assigned`, `in_progress`, `changes_requested`, `reopened`. Add `blocked` per D-3/D-20. | [V-C `types/index.ts:37`; D-20] |
| Open now (`isOpenNow`) | Active status **or** `submitted`. Drafts, `completed`, `cancelled` are not open. | [V-C `insights.ts:15`] |
| Open at time *t* (`isOpenAt`) | Not a draft; `createdAt ≤ t`; not (`completedAt ≤ t`); not (`cancelled` and `updatedAt ≤ t`). | [V-C `insights.ts:9-14`] |
| Level | `computeLevel` for **active** statuses only; any other status has level −1 (so a `submitted` task is never "escalated"). | [V-C `services/api/base.ts:68-74`] |
| Silence level | The silence-only part of the level; `< 0` means the assignee updated within the window. | [V-C `services/engine/escalation.ts` `computeLevel`] |
| Overdue (task view) | Active status **and** `dueAt < now`. A `submitted` task is never overdue in this sense. | [V-C `base.ts:79`] |
| Range | 7, 30 or 90 days; default 30; remembered per browser (`dash.range`). | [V-C `insights.ts:7`; `DashboardPage.tsx:29, :63`] |
| Sample points | 10 evenly spaced instants ending now: `now − range + (i+1)/10 × range`, i = 0..9. | [V-C `insights.ts:18-20`] |

### 1.2 KPI tiles (`kpis`, `insights.ts:38-62`)

Each tile has a value, an optional previous value (delta), an optional 10-point sparkline, context text, a link and a polarity. Delta = value − previous; it is "good" when it rises for `up-good` and falls for `down-good`; percentages show the delta in points ("N pts"). [V-C `widgets.tsx:16-18`]

| Key | Label | Value | Previous (delta) | Sparkline | Context | Link | Polarity |
|---|---|---|---|---|---|---|---|
| `open` | Open tasks | count of open-now tasks | open-at(now − range) | open-at at the 10 points | "vs N days ago" | `<base>?status=open` | down-good |
| `overdue` | Overdue | count open-at(now) with `dueAt < now` (uses the **current** due date for history; unlike §1.1 it includes `submitted`) | same at now − range | same at the 10 points | "vs N days ago" | `<base>?due=overdue` | down-good |
| `critical` | Critical escalations | open-now tasks with level ≥ 2 | — | — | "L2 Manager or L3 Founder's Office" | `/escalations?level=2` | down-good |
| `review` | Awaiting review | tasks in `submitted` | — | — | "oldest N h" = max(now − `clockStartedAt`) rounded, or "queue clear" | `<base>?status=submitted` | down-good |
| `completion` | Completion rate | of tasks (not draft, not cancelled) with `dueAt` in [now − range, now): share with `completedAt < now`; no such tasks → "—" | same over [now − 2·range, now − range) | value at each point *p* over [p − range, p), "—" plotted as 0 | "tasks due in last N d" | `<base>?status=closed` | up-good |
| `compliance` | Update compliance | active tasks with silence level < 0 ÷ active tasks; none → "—" | — | — | "N active tasks" | `<base>?status=open` | up-good |
| `staff` (CoS/CEO only) | Active staff | active users in the selected entity scope | — | — | "N inactive · M without manager" | `/admin/staff` | up-good |

`<base>` is `/tasks/mine` on the Staff layout and `/tasks/team` elsewhere. [V-C `DashboardPage.tsx:103, :231, :287, :359`] The Staff layout drops `critical`. [V-C `DashboardPage.tsx:103`] The `staff` tile is CoS/CEO only. [V-C `DashboardPage.tsx:360`]

### 1.3 Health buckets (`health`, `insights.ts:72-82`)

Each open-now task falls into exactly one bucket, tested in this order:
1. **Overdue**: task-view overdue (§1.1).
2. **Escalated**: level ≥ 1.
3. **At risk**: level = 0, **or** `dueAt − now < 24 h`.
4. **On track**: everything else.

Health score = on-track ÷ total open × 100, rounded; 100 when there are no open tasks. [V-C `widgets.tsx:54-56`] Segment links: On track `?level=none`, At risk `?level=0`, Escalated `/escalations`, Overdue `?due=overdue`. [V-C `widgets.tsx:47-52`] The At-risk link does not include tasks that are at risk only because they are due within 24 h; the list filter must accept `?health=at_risk` so the drill-down matches the count. [V-C; A]

### 1.4 Attention list (`attention`, `insights.ts:93-111`)

For each open-now task, **at most one** of rules A–D (checked in order), plus E and F independently:

| Rule | Condition | Severity | Reason / detail | Action (own task / someone else's) |
|---|---|---|---|---|
| A | overdue **and** (priority = critical **or** level ≥ 2) | critical | "Critical task overdue" (priority critical) or "Task overdue" · "N h past due" | "Post an update or request an extension" / "Intervene: reassign or follow up" |
| B | overdue | high | "Overdue" · "N h past due" | "Post an update or request an extension" / "Follow up with the assignee" |
| C | next level is reached in **< 2 h** | high | "Reaches <level label> soon" · "in N min" (min 1) | "Post a progress update now" / "Nudge the assignee" |
| D | `dueAt − now < 24 h` | medium | "Due within 24 h" · "due in N h" | "Finish or post an update" / "Check progress" |
| E | active status, not acknowledged, `now − createdAt > 2 h` | medium | "Not acknowledged" · "assigned N h ago" | "Acknowledge the task" / "Remind the assignee" |
| F | `submitted`, viewer may review it, `now − clockStartedAt > 24 h` | high | "Review waiting > 24 h" · "submitted N h ago" | "Review the submission" |
| G | pending extension on a scoped task that the viewer may decide | medium | "Extension request awaiting you" · "asked N h ago" | "Approve or reject" |

- Hours are `round(|Δ| / 1 h)`. [V-C `insights.ts:96`]
- Sort: severity (critical, high, medium), then task level descending. [V-C `insights.ts:109-110`]
- Panel shows 6, with "Show all N" / "Show less" [V-C `widgets.tsx:82-90`]; the Manager layout shows 5 [V-C `DashboardPage.tsx:290`].
- CoS/CEO "Critical attention queue" drops medium items unless the task is at level ≥ 1. [V-C `DashboardPage.tsx:378`]
- "May review" and "may decide" come from `allowedActions` per task (`useReviewerSet`, `DashboardPage.tsx:79-93`); the server must compute them (C-2).
- Known quirk: for a `submitted` task past its due date, rule D fires with "due in N h" (absolute value), because §1.1 overdue is false. The server keeps the rule but should word it "Past due (in review)". [V-C `insights.ts:101`; A]

### 1.5 Trend (`trend`, `insights.ts:120-136`)

Buckets: 7 (range 7), 10 (range 30), 13 (range 90), equal width over [now − range, now). Per bucket:
- **created**: non-draft tasks with `createdAt` in the bucket;
- **completed**: tasks with `completedAt` in the bucket;
- **overdue** ("became overdue"): tasks whose `dueAt` is in the bucket, `dueAt ≤ now`, and that were open at `dueAt`.
Label = date of the bucket's last instant. [V-C `insights.ts:129`]

### 1.6 Workload (`workload`, `insights.ts:149-169`)

For each active person in the people set: **assigned** (non-draft, created in range), **active** (open now), **overdue** (active and overdue), **completed** (completed in range), **overloaded** = active > `settings.overloadThreshold` (1–50). Rows with all zeros are dropped. Sort: active desc, then overdue desc. Pill: "Overloaded" / "Behind" (overdue > 0) / "Balanced". [V-C `widgets.tsx:183-185`]

### 1.7 Escalation funnel (`funnel`, `insights.ts:171-182`)

Per level 0–3: **count** = open-now tasks at that level; **share** = count ÷ open tasks at level ≥ 0; **triggered** = escalation events at that level with `at ≥ now − range`; **prevTriggered** = events in [now − 2·range, now − range).

### 1.8 Activity heatmap (`activityHeatmap`, `insights.ts:185-195`)

Progress-update activities on scoped tasks in the last 28 days, counted in a 7 × 8 grid: weekday (Monday first) × 3-hour block. Today it uses the browser's zone; the server must use the **viewer's** time zone. [V-C `insights.ts:191-192`; WO "screens show the viewer's zone"]

### 1.9 Escalation response (`escalationResponse`, `insights.ts:197-211`)

Buckets: 7 (range 7), **6** (range 30), 13 (range 90). Per bucket: escalation events at level ≥ 1, with `at` in the bucket **and** acknowledged; **hours** = mean(`ackAt − at`), 0 when none; **count**. Only acknowledged events are counted. [V-C `DashboardPage.tsx:401`]

### 1.10 Payload aggregates (`getDashboard`, `services/api/misc.ts:278-349`)

| Field | Definition | Evidence |
|---|---|---|
| `visible` | tasks the viewer can view (`canViewTask`), not drafts | [V-C `misc.ts:280`] |
| `mine` | visible tasks assigned to the viewer | [V-C `:281`] |
| `scope` | CoS: all visible; others: visible tasks whose assignee is in the viewer's **transitive reports** **plus the viewer's own tasks and the tasks they assigned** (D-51, decided; the prototype excludes them). **The CEO sees everything, like the CoS** (D-33/D-40, decided; the prototype applies the reporting-line rule) | [V-C `:282`] |
| `mine.dueToday` | open, `dueAt ≤` end of today, not overdue. "Today" must be the viewer's zone (today: browser). | [V-C `:284-285, :313`] |
| `mine.overdue`, `awaitingReview`, `recent` (6 by `updatedAt`), `upcoming` (6 open not overdue by `dueAt`), `unacknowledged` (active, no `acknowledgedAt`), `completedThisWeek` (`completedAt ≥ now − 7 d`) | | [V-C `:314-319`] |
| `scope.escalated` / `critical` | open and level ≥ 1 / ≥ 2 | [V-C `:325-326`] |
| `scope.stale` ("awaiting update") | active and silence level ≥ 0 | [V-C `:328`] |
| `scope.completionRate` | completed ÷ non-cancelled tasks in scope (all time) | [V-C `:329`] |
| `scope.onTimeRate` | completed with `completedAt ≤ dueAt` ÷ completed | [V-C `:330`] |
| `scope.byLevel`, `overdueByPriority`, `assignedByMe` (visible, given by me, open), `pendingExtensions` | | [V-C `:331-334`] |
| `trend` (8 weekly buckets) | mine completed, scope completed, created, completed late | [V-C `:287-298`] |
| `workload` | CoS: everyone but me; others: my reports; active only; open, overdue, escalated; sorted by open | [V-C `:299-306`] |
| `teams` | per team: open, overdue, escalated, completionRate (completed ÷ non-cancelled); teams with no data dropped | [V-C `:338-342`] |
| `staffStats` | total, active, without manager — **computed over the whole directory, unscoped** (must be scoped) | [V-C `:343`] |
| `recentAdmin` | with `view_audit_logs`: last 6 non-system audit records | [V-C `:344`] |

---

## DASH-01 Role dashboard

**Description.** The `/` Overview page: a role-specific command centre. [V-C `DashboardPage.tsx:26-77`]

**Roles.** Every signed-in user. Layout by role: `staff` → Staff, `lead` → Lead, `manager` → Manager, `cos`/`ceo` → CoS. [V-C `DashboardPage.tsx:71-74`] With several roles per user (D-8) the **highest-ranked** role picks the layout (rank: staff 0, lead 1, manager 2, cos 3, ceo 4). [V-C `constants/index.ts:14`; A]

**User actions (UI).**
- Range 7 / 30 / 90 days. [V-C `DashboardPage.tsx:63`]
- Entity select ("Department" today; relabelled "Entity", D-4), CoS/CEO only. [V-C `DashboardPage.tsx:53-62`]
- "New task" button, shown today by role ≠ staff; must use `create_tasks`. [V-C `DashboardPage.tsx:64`; FEATURE_INVENTORY final list 4]
- Tiles, health segments, funnel steps, workload rows and team links navigate to filtered lists. [V-C per FEATURE_INVENTORY "/ Overview"]
- Trend Line/Bars toggle; workload member select; attention "Show all". [V-C `widgets.tsx:90, :134, :150`]

**Expected behaviour per layout.**

| Layout | Widgets (rules in §1) | Evidence |
|---|---|---|
| **Staff** | KPIs over `mine` minus `critical`; **My day**: Already late (`mine.overdue`, 4), Due today (4), Waiting on others (`mine.awaitingReview`, 4), Update next (active, sorted by next level time, 4); Today's priorities = attention over `mine.open`; **This week**: tasks due Monday–Sunday of this week (not draft, not cancelled), ring = completed ÷ due; 7-day strip of open tasks by due day; Recent feedback (last 3 decided reviews of my submissions + last 3 comments by others on my tasks); My task timeline (6 activities on my tasks); My execution trend. | [V-C `DashboardPage.tsx:97-216`] |
| **Lead** | KPIs + attention + health over `scope`; workload (threshold `overloadThreshold`); Review queue (5); Escalation watchlist (L1+, level desc, 5); Awaiting updates (`stale`, 6); Due-date risk (open, not overdue, due within **48 h**, by due date, 6); Assignments (my open given tasks by status: assigned, in progress, submitted, changes requested, reopened); trend; activity heatmap; activity feed. | [V-C `DashboardPage.tsx:220-265`] |
| **Manager** | KPIs, health, attention (5), trend; Overdue by team; Escalations by priority × level (open tasks); **Update compliance by team** = active tasks with silence level < 0 ÷ active (0 when none), colour ≥ 0.8 good, ≥ 0.6 warning, else danger; **Delayed reviews** = submitted with `now − clockStartedAt > 24 h` (6); workload with "avg N active per person"; Team comparison (open, overdue, escalated, completion = completed ÷ non-cancelled, all time). | [V-C `DashboardPage.tsx:269-347`] |
| **CoS / CEO** | Entity filter applies to `scope` via the task's entity; KPIs + Active staff; Critical attention queue; health; escalation pyramid (§1.7); Entity workload stacked bars: on-track/at-risk = active − overdue − max(0, escalated − overdue), escalated = max(0, escalated − overdue), overdue; team drill chips with open counts; trend; escalation response (§1.9); **At-risk teams** = (overdue + escalated) ÷ open, only > 0, top 5; staff by role (active); org mini (entity → teams, members, lead, "(no manager)"); staff workload; recent admin activity (6); operational activity feed. | [V-C `DashboardPage.tsx:351-479`] |

**L3 Founder's Office banner** (top of dashboard). [WO "L3 … top of dashboard"; V-C `DashboardPage.tsx:481-512`]
- Shown when the viewer is in the Founder's Office: an active CoS, or the CEO when `l3NotifyCeo` is on. [V-C `services/core.ts:51-53`]
- Counts distinct tasks with an L3 event that is not resolved and lists the viewer as a recipient; "N not yet acknowledged" counts tasks with an `active` (unacknowledged) L3 event; lists 3 tasks with assignee, "past due" / "no update", "since …", "acknowledged". "Review all" → `/escalations?level=3`. [V-C `:486-505`]

**Data required.** Scoped TaskViews with level info; escalation events, extensions, reviews, comments, activities, users and teams **restricted to the viewer's scope** (DASH-03); settings `overloadThreshold`; rules `l3NotifyCeo`; viewer time zone.

**Backend processing.** The server runs the §1 functions (one shared module, D-9) over the scoped set and returns ready-made widget data; the browser renders only. Per-task `allowedActions` flags for review/extension decisions are computed on the server. [C-2]

**API (proposed).**

| Method | Path | Response | Adapt existing? |
|---|---|---|---|
| GET | `/api/dashboard?range=7\|30\|90&entity=<id>` | `{layout:"staff"\|"lead"\|"manager"\|"executive", scopeLabel, range, kpis:[Kpi], health:{onTrack,atRisk,escalated,overdue}, attention:[{key,severity,taskId,taskTitle,level,reason,detail,action}], trend:[TrendPoint], workload:[WorkloadRow], funnel:[…], heatmap:number[7][8], escalationResponse:[…], teams:[…], entities:[{id,name,active,overdue,escalated}], atRiskTeams:[…], staffByRole:{role:count}, orgMini:[…], recentAdmin:[…], activity:[…], mine:{…}, l3Banner:{taskCount,unacked,tasks:[…3]}\|null}` (fields per layout only) | Partly: `GET /dashboard?days=7\|30\|90` exists with the same range validation [V-S `routes/dashboard.ts:11-17`] but returns FR-11 accountability; that payload moves to `GET /api/reports/accountability` (RPT-05/06). |

**Validation.** `range` ∈ {7, 30, 90} → else 422 `{fields:{range:"Choose 7, 30 or 90 days."}}` [V-S `routes/dashboard.ts:11`; message A]. `entity` must be a known entity id → else 422 [A].

**Authorization.** C-1. `entity` is accepted only from a viewer whose scope is organisation-wide (CoS, or CEO per D-40); from anyone else → 403 "You don't have permission to filter by entity." [A] Every count is computed over the viewer's scope only (DASH-03).

**Success / failure.** 200; 401; 403; 422.

**Dependencies.** DASH-03, ESC-01..09 (levels, events), EXT-03, WF-10 (`allowedActions`), SET-01 (`overloadThreshold`), POL-01 (`l3NotifyCeo`), STAFF/ORG (entity, teams), D-4, D-5, D-9.

**Acceptance criteria.**
1. DASH-01-AC-1: For a fixed dataset and clock, each KPI, health bucket, attention item, trend bucket, workload row, funnel row and response bucket returned by the API equals the value defined in §1.
2. DASH-01-AC-2: A task with level 0 and due in 30 h is "At risk"; the same task with level −1 and due in 23 h is "At risk"; with level −1 and due in 25 h it is "On track".
3. DASH-01-AC-3: An overdue Normal task at L1 yields one **high** "Overdue" item; an overdue Normal task at L2 yields one **critical** item; never both.
4. DASH-01-AC-4: A task whose next level is due in 119 min yields a high item; at 121 min it does not.
5. DASH-01-AC-5: An unacknowledged active task created 2 h 1 min ago yields a medium "Not acknowledged" item; at 1 h 59 min it does not.
6. DASH-01-AC-6: The L3 banner appears for a Founder's Office recipient of an unresolved L3 event and not for anyone else; with `l3NotifyCeo` off, the CEO does not see it.
7. DASH-01-AC-7 (WO AC-8): For one entity, open / overdue / escalated counts on the executive dashboard match a manual count on a sample of 20 tasks.
8. DASH-01-AC-8: "New task" is shown exactly when the viewer holds `create_tasks`.
9. DASH-01-AC-9: Day-based figures ("Due today", "This week", heatmap) use the viewer's time zone: the same task shows as due today for an IST viewer and tomorrow for a PT viewer when appropriate (WO AC-9 context).

**Test scenarios.** Each layout per role · multi-role layout choice · every §1 boundary (2 h, 24 h, 48 h, overload threshold, compliance colour 0.8/0.6, delayed review 24 h) · range 7/30/90 bucket counts (7/10/13 and 7/6/13) · completion "—" with no due tasks · entity filter by CoS · entity param from a lead → 403 · L3 banner with D7 on/off · IST vs PT day boundaries · empty states.

---

## DASH-02 Team overview

**Description.** `/team`: a reporting-line summary with stats, workload, teams and people. [V-C `features/staff/TeamPage.tsx:11-104`]

**Roles.** Route gate `supervises` = `view_tasks` and (CoS or at least one report). [V-C `app/routes.tsx:36-39` per FEATURE_INVENTORY]

**User actions (UI).** Stat tiles link to `/tasks/team`, `?due=overdue`, `/escalations`, `?status=open`. [V-C `TeamPage.tsx:24-28`] Names link to `/admin/staff/:id` (STAFF-04).

**Expected behaviour.**
- Header: "N people in your reporting line, M reporting directly to you." [V-C `TeamPage.tsx:22`]
- Stats: Open team tasks (`scope.open`), Overdue, Escalated (L1+), Awaiting update (`scope.stale`), On-time completion (`scope.onTimeRate`). [V-C `TeamPage.tsx:24-28`]
- Workload: top 14 people by open tasks with "N overdue, M escalated". [V-C `TeamPage.tsx:32`]
- Teams in scope: open, overdue, escalated, completion. [V-C `TeamPage.tsx:34-…`]
- People: CoS → everyone except self; others → transitive reports; "Reports to" name. Today computed in the browser from the raw store (`TeamPage.tsx:18-19`); must come from the API. [V-C]

**Data required.** Same scope as DASH-01 plus scoped people (`canViewUser`) with manager name, team, role, title, per-person open/overdue/escalated.

**Backend processing.** Same shared functions as DASH-01; people list from the reporting tree (recursive CTE, NFR Performance).

**API (proposed).** `GET /api/team/overview` → `{reportCount, directCount, stats:{open,overdue,escalated,awaitingUpdate,onTimeRate}, workload:[{id,name,open,overdue,escalated}], teams:[{id,name,open,overdue,escalated,completionRate}], people:[{id,name,title,roles,teamName,managerId,managerName,open,overdue,escalated}]}`. New; no server equivalent. [V-S none]

**Validation.** None.

**Authorization.** Without `view_tasks`, or with no reports and not CoS → 403 "You don't have permission to view your team." [A]

**Success / failure.** 200; 401; 403.

**Dependencies.** DASH-03, STAFF-01, ORG-01.

**Acceptance criteria.**
1. DASH-02-AC-1: A lead's response lists exactly their transitive reports, and every count covers only those people's tasks.
2. DASH-02-AC-2: A staff member with no reports gets 403.
3. DASH-02-AC-3: Workload has at most 14 rows, sorted by open tasks descending.
4. DASH-02-AC-4: The UI makes no `getDb()` call.

**Test scenarios.** Lead / manager / CoS scope · no-reports 403 · inactive report shown or hidden (inactive people are excluded from workload, `misc.ts:301`) · orphan team member.

---

## DASH-03 Server-side scoping of every aggregate

**Description.** Every dashboard and team figure is computed on the server over the viewer's visible data. No widget may read unscoped data. [PRD DASH-03; WO "Access control enforced on the server for every request"; WO AC-6]

**Roles.** All.

**User actions.** None.

**Expected behaviour.** The following client reads must be replaced by server data:

| Today (client) | Problem | Evidence |
|---|---|---|
| `staffStats` total / active / without manager | whole directory | [V-C `misc.ts:343`] |
| CoS layout staff list, staff-by-role, org mini, active-staff tile | raw `db.users` / `db.departments` / `db.teams` | [V-C `DashboardPage.tsx:358, :422, :452-479`] |
| Staff layout "This week", feedback, comments, timeline | raw `db.tasks`, `db.reviews`, `db.comments`, `db.activities` | [V-C `DashboardPage.tsx:107-119`] |
| Lead/CoS activity feeds and heatmap | raw `db.activities` filtered client-side | [V-C `DashboardPage.tsx:260-262, :447`] |
| Escalation response and funnel | raw `db.escalations` | [V-C `DashboardPage.tsx:372, :382`] |
| Attention extensions | raw `db.extensions` | [V-C `DashboardPage.tsx:105, :233, :290, :378`] |
| Reviewer set | `allowedActions(getDb(), …)` | [V-C `DashboardPage.tsx:79-93`] |
| L3 banner | raw `db.escalations`, `db.tasks` | [V-C `DashboardPage.tsx:484-501`] |
| Overload threshold, org name | raw `db.settings` | [V-C `DashboardPage.tsx:36, :237`] |

**Data / processing.** One scope resolver used by DASH, RPT, SRCH and the task list (`visibilityFilter`). [V-S `services/access.ts:20-26`]

**API.** Covered by DASH-01 / DASH-02.

**Authorization.** C-2; WO AC-6.

**Dependencies.** STAFF-01 (`canViewUser`), TASK-04/05 (`canViewTask`), D-40, D-51.

**Acceptance criteria.**
1. DASH-03-AC-1: For a staff user, no dashboard response contains a task id, person, comment or activity outside their own and assigned-by-them tasks.
2. DASH-03-AC-2: For a lead, `staffByRole`, `orgMini` and active-staff counts are absent, or computed only over their reporting line. [A]
3. DASH-03-AC-3 (WO AC-6): a scripted API call as a staff member returns no other team's task in any dashboard field.
4. DASH-03-AC-4: A static check finds no `getDb()` import in `features/dashboard/*` or `features/staff/TeamPage.tsx`.

**Test scenarios.** Per role, diff dashboard ids against the task-list API for the same user · orphan subtree not leaking to a lead · deactivated user's tasks · CEO sees organisation-wide data (D-33).

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-4](../../01-discovery/OPEN_QUESTIONS.md) | Decided: Department = Entity; the CoS filter and stacked chart are by entity; a task's entity comes from its team, else its assignee. |
| [D-5](../../01-discovery/OPEN_QUESTIONS.md) | Day boundaries (due today, week start, heatmap) in the viewer's zone. |
| [D-8](../../01-discovery/OPEN_QUESTIONS.md) | Multi-role users: layout chosen by highest-ranked role [A]. |
| [D-9](../../01-discovery/OPEN_QUESTIONS.md) | `insights.ts` as a shared module executed on the server. |
| [D-10](../../01-discovery/OPEN_QUESTIONS.md) | Server computes aggregates; no full task lists shipped for dashboards. |
| [D-20](../../01-discovery/OPEN_QUESTIONS.md) | `blocked` counts as active (open) in every rule above. |
| D-40 (decided) | CEO scope: all tasks (WO) vs reporting line (prototype). |
| D-49 (decided) | FR-11 amber/red vs the prototype's health buckets. |
| D-51 (decided) | Whether "team scope" includes the viewer's own and assigned-by-them tasks. |
