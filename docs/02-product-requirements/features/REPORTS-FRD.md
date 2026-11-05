# Accountability Reports FRD (RPT)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). Base terms (open now, active, level, overdue) are defined once in [DASHBOARD-FRD.md §1.1](DASHBOARD-FRD.md#11-base-definitions).
> Nothing here has been executed. No test has been run.

## 0. Requirement

WO FR-11: "Accountability dashboard: by entity (open, on track, amber, red, longest silence) and by person (open tasks, average first response, escalations, on-time %). Exportable to CSV and PDF." WO AC-8: "Dashboard figures for one entity match a manual count on a sample of 20 tasks." [WO]

The prototype has nine reports with CSV only and none of the FR-11 entity / first-response / longest-silence metrics; the server has the FR-11 tables with CSV and PDF. Both are kept: RPT-02 (nine reports) and RPT-05..07 (FR-11, new from WO). [V-C `features/reports/ReportsPages.tsx:19-29`; V-S `services/reports.ts:43-117`, `services/exports.ts:19-144`; D-15]

---

## RPT-01 Report scope

**Description.** Decides which tasks every report covers.

**Roles.** `view_org_reports` → whole organisation; else `view_team_reports` → the viewer's reporting line; neither → 403. [V-C `services/api/misc.ts:135-150`]

**User actions (UI).** Index page shows "Organization-wide" or "scoped to your reporting line". [V-C `ReportsPages.tsx:41-72`] Report page banner: "Scoped to your reporting line. People outside it are not included even if selected." [V-C `ReportsPages.tsx:138`]

**Expected behaviour.**
- Team scope = tasks whose **assignee** is in the viewer's transitive reports. The viewer's own tasks and tasks they gave to people outside their line are **excluded**. [V-C `misc.ts:148-149`] The server includes both (`visibilityFilter`, `services/access.ts:20-26`). [D-51, decided]
- Drafts are always excluded. [V-C `misc.ts:154`]
- With D-8, permissions are the union over the user's roles. [D-8]

**Data required.** Reporting tree, role-permission matrix.

**Backend processing.** One scope resolver shared with DASH-03 (recursive CTE over `manager_id`).

**API.** Applied inside every RPT endpoint; plus `GET /api/reports/scope` → `{scope:"org"|"team"}` (replaces `reportScope()`, `misc.ts:135`). New. [A]

**Validation.** None.

**Authorization.** Neither permission → 403 "You do not have access to reports." [V-C `misc.ts:139, :147`]

**Success / failure.** 200; 401; 403.

**Dependencies.** ROLE-01/02, STAFF-01, ORG-02.

**Acceptance criteria.**
1. RPT-01-AC-1: A user with neither permission gets 403 from every `/api/reports*` endpoint.
2. RPT-01-AC-2: A lead with `view_team_reports` never receives a task whose assignee is outside their transitive reports, whatever filter is sent.
3. RPT-01-AC-3: A user holding both permissions gets org scope.

**Test scenarios.** 403 · team vs org · filter naming an out-of-scope user returns empty, not an error · drafts excluded · own tasks per D-51.

---

## RPT-02 Nine reports

**Description.** Completion, Overdue, Escalations, Staff Accountability, Team Performance, Task Assignment, Update Compliance, Review Turnaround and Due-Date Extensions, all computed from one report payload. [V-C `ReportsPages.tsx:19-29`; `misc.ts:152-273`]

**Roles.** RPT-01.

**User actions (UI).**
- `/reports`: 9 tiles and a metric glossary. [V-C `ReportsPages.tsx:31-39, :41-72`]
- `/reports/:reportId`: filters From, To (default last 30 days), Team, Staff member, Task giver (non-staff users), Priority, Status (no draft), Escalation (On track / L0–L3); the page refetches on every filter change. [V-C `ReportsPages.tsx:79-131`]
- Unknown report id → 404 "Unknown report." [V-C `ReportsPages.tsx:82`]
- Export CSV (RPT-03). Export PDF per RPT-07 / [D-53, decided].

**Expected behaviour — metric definitions** (exact, `misc.ts:152-273`; glossary text `ReportsPages.tsx:31-39`):

| Metric | Definition |
|---|---|
| Filter match | team, assignee, giver (`assignedBy`), priority, status, and level (`none` = level < 0, else equal) all match when set. [`misc.ts:157-163`] |
| `hist` (historical set) | Matching tasks with `createdAt` in [from 00:00, to 23:59:59]. Dates are browser-local today; they must be the viewer's zone. [`misc.ts:155-156, :166`; D-5] |
| `open` | Matching tasks open now (active or `submitted`), **ignoring dates**. [`:167`] |
| Completion rate | completed in `hist` ÷ `hist`; null when `hist` is empty ("Completed ÷ tasks created in the date range"). [`:250`] |
| On-time rate | completed with `completedAt ≤ dueAt` ÷ completed, in `hist` ("…on or before the (latest approved) due date"). [`:169, :251`; D-50, decided: latest approved due date, original shown alongside] |
| Open now / Overdue now | `open` count / `open` that are task-view overdue. [`:252-253`] |
| Update compliance | active tasks in `open` with silence level < 0 ÷ active tasks in `open`. [`:174-175, :255`] |
| Escalations | escalation events at level ≥ 1 on matching tasks with `at` in range. [`:171, :254`] |
| Avg review time | mean(decidedAt − submittedAt) in hours, for decided reviews whose `submittedAt` is in range. [`:172, :239, :256`] |
| Extensions | extension requests on matching tasks with `at` in range. [`:173, :257`] |
| Weekly buckets | 7-day buckets from `from` (or end − 8 weeks if no `from`) to min(`to`, now); per bucket, created and completed counts over **all matching tasks** (not `hist`). [`:178-189`] |
| By status | `hist` count per status (7 statuses, no draft). [`:260`] |
| By priority | `hist` count, open-now count, open-overdue count per priority. [`:261`] |
| Overdue by team | open overdue tasks per team; zero rows kept only when no team filter is set. [`:262`] |
| Escalations by level | per level 0–3: events in range, and non-resolved events now. [`:263`] |
| Staff rows | per assignee of a matching task: assigned (`hist`), completed, on-time rate, open now, overdue now, compliance, L1+ escalations in range (attributed to the task's **current** assignee); sorted by open now, descending. [`:191-212`] |
| Team rows | per team: created, completed, completion rate, on-time rate, open now, overdue now, L1+ escalations; teams with nothing are dropped. [`:214-231`] |
| Giver rows | per `assignedBy` in `hist`: assigned, open, completed, overdue, reassignments (assignment records that have a previous assignee). [`:233-237`] |
| Reviewers | per reviewer: reviews, avg hours, sent-back rate = non-approved ÷ reviews. [`:240-243`] |
| Extension rows | task, requester, decider, days added = (requestedDue − currentDue) ÷ 1 day, reason, status. [`:269`] |

**Per-report body** [V-C `ReportsPages.tsx:172-258`]:

| Report | Body |
|---|---|
| Completion | created vs completed per week; tasks by status (donut); by team: created, completed, completion, on-time |
| Overdue | overdue by team; by priority; overdue task list (task, assignee, priority, due, level), oldest due first |
| Escalations | events by level (in range vs open now); escalations by person (L1+, open now, overdue now), only people with ≥ 1 |
| Staff Accountability | staff, team, assigned, completed, on-time, compliance, open now, overdue now, L1+ escalations ("Not a performance score.") |
| Team Performance | completed vs open by team chart; Team rows table |
| Task Assignment | workload by staff (open now, top 15); by priority; by task giver table |
| Update Compliance | compliance by person (people with active tasks), lowest first; detail table |
| Review Turnaround | avg review time and decisions; turnaround by reviewer; reviewers table; hours-to-decision for the last 20 submissions |
| Extensions | requests / approved / rejected / pending counts; requests table |

Every report shows six summary stats: completion rate, on-time rate, open now, overdue now, update compliance, escalations (L1+). [V-C `ReportsPages.tsx:139-146`]

**Data required.** Scoped tasks with level info, escalation events, reviews, extensions, assignments, teams, user names only.

**Backend processing.** The server computes the payload (SQL or the shared module, D-9) over the RPT-01 scope. Today `getReport` runs in the browser. [V-C]

**API (proposed).**

| Method | Path | Request (query) | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/reports` | `from, to (YYYY-MM-DD), teamId, userId, giverId, priority, status, level (none\|0..3)` | `{scope, summary, weeks, byStatus, byPriority, overdueByTeam, escalationsByLevel, staffRows, teamRows, giverRows, reviewers, turnaround, extensions, overdue:[TaskRow]}` (shape of `misc.ts:245-271`; task lists return minimal rows, not full TaskViews) | New. |
| GET | `/api/reports/:reportId` | same | the subset that report needs | Optional optimisation. [A] |

**Validation.**

| Field | Rule | 422 message |
|---|---|---|
| `from`, `to` | `YYYY-MM-DD` | "Enter a valid date." [A] |
| `from ≤ to` | checked nowhere today [FEATURE_INVENTORY final list item 12] | "The start date must be on or before the end date." [A] |
| `priority` | critical/high/normal/low or empty | [V-C `misc.ts:130`] |
| `status` | any status except `draft`, or empty | [V-C `ReportsPages.tsx:122`] |
| `level` | `none`, 0–3, or empty | [V-C `ReportsPages.tsx:127-129`] |
| `teamId`, `userId`, `giverId` | must exist; out-of-scope ids return empty results (not 403), as the UI banner says | [V-C `ReportsPages.tsx:138`; A] |

**Authorization.** RPT-01.

**Success / failure.** 200; 401; 403 (no report permission); 404 unknown report id; 422 bad filter.

**Dependencies.** RPT-01, RPT-04, ESC (events), EXT, WF-06 (reviews), DASHBOARD-FRD §1.1, D-5, D-9.

**Acceptance criteria.**
1. RPT-02-AC-1: For a fixed dataset, every metric in the table above equals its definition, for org and team scope.
2. RPT-02-AC-2: `from > to` returns 422 with field `from`.
3. RPT-02-AC-3: A task created before `from` and still open counts in Open now and not in Completion rate.
4. RPT-02-AC-4: An escalation event at L0 is not counted in "Escalations"; one at L1 is.
5. RPT-02-AC-5: `GET /api/reports/unknown` returns 404.
6. RPT-02-AC-6: The response contains no user email or phone number.

**Test scenarios.** Each metric with crafted data · each filter alone and combined · date boundaries at 00:00 and 23:59:59 for IST and PT viewers · empty range (null rates shown "—") · undecided reviews excluded · fractional extension days · own tasks under team scope (D-51) · 403 / 404 / 422.

---

## RPT-03 CSV export

**Description.** CSV per report, for the nine reports and FR-11. [V-C `ReportsPages.tsx:260-274`; V-S `services/exports.ts:19-48`]

**Roles.** RPT-01.

**User actions (UI).** "Export CSV" on each report page. [V-C `ReportsPages.tsx:88`]

**Expected behaviour.**
- Columns per report, as today [V-C `ReportsPages.tsx:262-271`]:
  - Completion: Team, Created, Completed, Completion rate, On-time rate
  - Overdue: Task, Title, Assignee, Priority, Due, Level
  - Escalations: Level, Triggered in range, Open now
  - Accountability: Staff, Team, Assigned, Completed, On-time rate, Update compliance, Open now, Overdue now, L1+ escalations
  - Teams: Team, Created, Completed, Completion, On-time, Open now, Overdue now, Escalations
  - Assignments: Task giver, Role, Assigned, Open, Completed, Overdue, Reassignments
  - Compliance: Staff, Active tasks, Compliance
  - Reviews: Task, Round, Reviewer, Decision, Hours, Submitted
  - Extensions: Task, Requested by, Current due, Requested due, Days, Reason, Status, Decided by
- Filename `taskwatch-report-<id>-<YYYY-MM-DD>.csv`. [V-C `ReportsPages.tsx:261`]
- Generated on the **server** from the same filters, so exported numbers equal the screen and scope is enforced. [A; C-2]
- **Formula-injection guard:** a cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'`. The server guard misses TAB and CR (`exports.ts:9`, S-13); the client has none (`utils/format.ts:83-88`). [V-S; V-C]
- UTF-8 with BOM; `Content-Disposition: attachment`. [V-S `routes/dashboard.ts:25-27`]
- Times in the viewer's zone. [V-S `exports.ts:24` uses `formatInZone`]

**Data required.** As RPT-02.

**Backend processing.** Reuse `csvRows` / `csvCell` (`services/exports.ts:6-15`) with the extended guard.

**API (proposed).** `GET /api/reports/:reportId/export.csv?<RPT-02 filters>` → `text/csv`. New.

**Validation / Authorization.** As RPT-02 / RPT-01.

**Success / failure.** 200 attachment; 401; 403; 404; 422.

**Dependencies.** RPT-02, D-10 (size cap).

**Acceptance criteria.**
1. RPT-03-AC-1: Each report's CSV has exactly the columns above and the same numbers as `GET /api/reports` with the same filters.
2. RPT-03-AC-2: A task title `=HYPERLINK("x")`, or one starting with a TAB, is exported as text prefixed with `'`.
3. RPT-03-AC-3: A team-scoped user's CSV contains no out-of-scope rows.

**Test scenarios.** Column set per report · prefixes `= + - @ \t \r` · commas, quotes and newlines · BOM present · scope · large export within the D-10 cap.

---

## RPT-04 Scoped filter option lists

**Description.** The Team, Staff member and Task giver dropdowns list only teams and people within the viewer's report scope. [PRD RPT-04]

**Roles.** RPT-01.

**User actions (UI).** Filter dropdowns. Today they list every team and every active user from the raw store. [V-C `ReportsPages.tsx:85, :99, :105, :111`]

**Expected behaviour.** Org scope → all teams and active people. Team scope → people in the line, their teams, and as givers the people in the line plus the viewer who hold a non-staff role. [A] Givers today = active users whose role is not `staff`. [V-C `ReportsPages.tsx:111`]

**Data required.** Names and ids only (SEC-9).

**Backend processing.** Same scope resolver as RPT-01.

**API (proposed).** `GET /api/reports/options` → `{teams:[{id,name,entityId}], people:[{id,name}], givers:[{id,name}], entities:[{id,name}]}`. New.

**Validation.** None. **Authorization.** RPT-01.

**Success / failure.** 200; 401; 403.

**Dependencies.** RPT-01, STAFF-01, ORG-01.

**Acceptance criteria.**
1. RPT-04-AC-1: A lead's options contain only people in their transitive reports (plus themselves as giver) and those people's teams.
2. RPT-04-AC-2: The UI builds no option list from `getDb()`.

**Test scenarios.** Org vs team · inactive people excluded · team with no in-scope member excluded.

---

## RPT-05 Accountability by entity (new, from WO)

**Description.** WO FR-11 by-entity table: open, on track, amber, red, longest silence. [WO; V-S `services/reports.ts:48-85`]

**Roles.** Founder's Office sees all entities; others see entities where they have visible open tasks. [V-S `reports.ts:46, :85`] Report permission per RPT-01. [A]

**User actions (UI).** None today. Needs an "Accountability" view under Reports with a 7 / 30 / 90-day period select. [V-S `routes/dashboard.ts:11`; A for placement]

**Expected behaviour** (server definitions, [V-S `reports.ts:48-85`]; amber/red boundaries [D-49, decided]):

| Column | Definition |
|---|---|
| Open | visible tasks of the entity that are not done. With D-20: not `completed`; `cancelled` and `draft` also excluded [A] |
| On track | open with level < 0 |
| Amber | open with level 0 or 1 |
| Red | open with level ≥ 2 |
| Blocked | open with status `blocked` (extra server column) |
| Longest silence | max(now − `clockStartedAt`) over the entity's open tasks, in hours, with that task's id, title and assignee |

- A task's entity is its team's entity, else its assignee's entity (D-4).
- These are **current** counts; the period only affects RPT-06. [V-S `reports.ts:48-60`]
- WO AC-8 is checked against this table. [WO]

**Data required.** Tasks (entity, status, level, clock start, assignee name), entities.

**Backend processing.** Two set-based queries under the visibility filter. [V-S `reports.ts:46-67`] Level must be current: either the engine keeps `tasks.level` up to date or level is computed at query time from the shared ladder. [V-S engine, per EXISTING_SYSTEM_ANALYSIS §3.6]

**API (proposed).** `GET /api/reports/accountability?days=7|30|90` → `{generatedAt, from, days, scope, byEntity:[{entityId, entityName, open, onTrack, amber, red, blocked, longestSilenceHours, longestSilenceTask:{id,title,assignee}|null}], byPerson:[…RPT-06…]}`. Adapt `GET /dashboard` [V-S `routes/dashboard.ts:13-17`, `reports.ts:43-117`]: move the path, map statuses per D-20, derive entity per D-4.

**Validation.** `days` ∈ {7, 30, 90}, default 30; otherwise 422. [V-S `routes/dashboard.ts:11`]

**Authorization.** RPT-01 plus the task visibility filter.

**Success / failure.** 200; 401; 403; 422.

**Dependencies.** D-4, D-20, ESC engine, RPT-01.

**Acceptance criteria.**
1. RPT-05-AC-1: open = onTrack + amber + red for every entity row.
2. RPT-05-AC-2 (WO AC-8): for one entity, open / on track / amber / red match a manual count over a sample of 20 tasks.
3. RPT-05-AC-3: Longest silence names the open task with the oldest `clockStartedAt` in that entity.
4. RPT-05-AC-4: A lead sees only entities with at least one visible open task; the Founder's Office sees all six entities, including empty ones.

**Test scenarios.** Level boundaries −1 / 0 / 1 / 2 / 3 · blocked task · completed and cancelled excluded · entity from team vs from assignee · empty entity · scope · `days` 422.

---

## RPT-06 Accountability by person (new, from WO)

**Description.** WO FR-11 by-person table: open tasks, average first response, escalations, on-time %. [WO; V-S `services/reports.ts:87-113`]

**Roles.** As RPT-05. People listed: Founder's Office → everyone; others → themselves and their transitive reports. [V-S `reports.ts:87`]

**User actions (UI).** New table beside RPT-05. [A]

**Expected behaviour** [V-S `reports.ts:88-113`]:

| Column | Definition |
|---|---|
| Open | the person's tasks not done, now |
| Avg first response (h) | mean of (first assignee update − assignment time) over the person's assignments that **started in the period** and have a first update; null if none |
| Escalations | escalation events at level ≥ 1 fired in the period where the person was the assignee at firing time |
| Closed / On time | tasks done in the period / of those, closed on or before due [D-50, decided] |
| On-time % | round(on time ÷ closed × 100); null when closed = 0 |

- Rows where every figure is zero or null are dropped. [V-S `reports.ts:101`]
- **The client model has no first-response field.** The assignment record needs `firstUpdateAt`, set by the first assignee progress update after (re)assignment. [V-S `services/tasks.ts:148`; V-C `types/index.ts:196-204`]
- Escalation events need the assignee at firing time (`escalations.assignee_id`). [V-S `reports.ts:93`]

**Data required.** Assignments with `firstUpdateAt`, escalation events with assignee, closed/due times.

**Backend processing.** One query per scope over `users`. [V-S `reports.ts:88-99`]

**API.** Part of `GET /api/reports/accountability` (RPT-05).

**Validation / Authorization.** As RPT-05.

**Success / failure.** As RPT-05.

**Dependencies.** WF-03 (sets first update), WF-07 (new assignment record), ESC (event assignee), D-50.

**Acceptance criteria.**
1. RPT-06-AC-1: A task assigned at 09:00 with the first assignee update at 13:30 contributes 4.5 h to that assignee's average.
2. RPT-06-AC-2: A lead's comment does not count as a first response (WO FR-4).
3. RPT-06-AC-3: After a reassignment, the new assignee's first response is measured from the reassignment time.
4. RPT-06-AC-4: On-time % is null for a person with no closed tasks in the period.

**Test scenarios.** Assignment outside the period excluded · no update yet · reassignment mid-period · escalation attributed to the assignee at firing time after a reassignment · on-time rounding.

---

## RPT-07 PDF export (new, from WO)

**Description.** FR-11 accountability exportable to PDF. [WO FR-11; D-15 decided: PDF required]

**Roles.** As RPT-05.

**User actions (UI).** "Export PDF" next to "Export CSV" on the accountability view. The new UI has no PDF button. [D-15; V-C `ReportsPages.tsx:88` is CSV only]

**Expected behaviour.**
- A4 landscape; title "TaskWatch — accountability report"; scope, period and generation time in the viewer's zone; by-entity and by-person tables; new page when a row would overflow. [V-S `services/exports.ts:52-144`]
- Same numbers as the screen and the CSV for the same parameters.
- Filename `taskwatch-accountability-<YYYY-MM-DD>.pdf`. [V-S `routes/dashboard.ts:35`]
- Whether the nine RPT-02 reports also need PDF: [D-53, decided].

**Data required.** RPT-05/06 payload, viewer time zone.

**Backend processing.** pdfkit stream piped to the response. [V-S `routes/dashboard.ts:36`]

**API (proposed).** `GET /api/reports/accountability/export.pdf?days=` and `GET /api/reports/accountability/export.csv?days=`. Adapt `/dashboard/export.pdf` and `/dashboard/export.csv`. [V-S `routes/dashboard.ts:21-37`]

**Validation / Authorization.** As RPT-05.

**Success / failure.** 200 `application/pdf` attachment; 401; 403; 422.

**Dependencies.** RPT-05, RPT-06, D-15, D-53.

**Acceptance criteria.**
1. RPT-07-AC-1: The PDF opens, is A4 landscape, and its entity and person tables equal the API response for the same `days`.
2. RPT-07-AC-2: The "Generated" time is in the requesting user's zone (IST and PT users get different local times for the same instant — WO AC-9 context).
3. RPT-07-AC-3: A team-scoped user's PDF contains only their scope.

**Test scenarios.** 7 / 30 / 90 days · enough rows to force page breaks · long titles truncated with an ellipsis (`exports.ts:61`) · scope · IST vs PT header.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-15](../../01-discovery/OPEN_QUESTIONS.md) | Decided: PDF required for FR-11. Scope beyond FR-11 → D-53 (decided). |
| [D-4](../../01-discovery/OPEN_QUESTIONS.md) | Decided: a task's entity comes from its team, else its assignee. |
| [D-5](../../01-discovery/OPEN_QUESTIONS.md) | Date filters and week buckets in the viewer's zone. |
| [D-10](../../01-discovery/OPEN_QUESTIONS.md) | Server-side computation; export size cap. |
| [D-20](../../01-discovery/OPEN_QUESTIONS.md) | "Done" = `completed`; cancelled and draft excluded from "open" [A]. |
| D-49 (decided) | Amber = L0–L1, red = L2–L3. |
| D-50 (decided) | On-time measured against the original or the latest due date. |
| D-51 (decided) | Team scope includes the viewer's own and assigned-by-them tasks? |
| D-53 (decided) | PDF for all nine reports or only FR-11. |
