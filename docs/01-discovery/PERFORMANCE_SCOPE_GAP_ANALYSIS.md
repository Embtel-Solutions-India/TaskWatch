# Gap analysis: current TaskWatch vs the "Work Management, Efficiency & Outcome Tracking" brief

_Written 2026-11-06. Inputs: the brief pasted by the owner on 2026-11-06 ("AI Product Analyst — Organizational Task Management, Efficiency & Outcome Tracking System"), the BAIS Team Task Tracker spreadsheet (`BAIS_Team_Task_Tracker.xlsx`, owner's Downloads, read-only), the code as of migration 013, and Work Order FO-2026-OPS-01._

> **Evidence tags:** [WO] work order · [XLS] spreadsheet, sheet!cell · [CODE] repository · [BRIEF] the new brief, by section number · [A] assumption · [Q] needs a stakeholder decision (D-numbers in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) §13).
> Nothing here changes a decision or the plan. It is input for the owner and the Founder's Office.

## 1. Summary

1. **The brief is a new scope, not a refinement of the current one.** The work order lists as out of scope "time tracking by the hour, payroll or HR appraisal workflows … These may follow in a later order" [WO p.1]. The brief's centre of gravity is estimated vs actual working time (§6, §9), individual performance scoring (§11) and leaderboards (§12). Those need a new or amended work order before they are built (D-110). AGENTS.md: the work order wins over every other source.
2. **What TaskWatch already does well matches the brief's foundations:** org hierarchy with role-based, server-enforced scope; assignment with due dates and reasons; a 9-state workflow with review, rework, reopen and cancel; a tamper-evident, server-timestamped activity log; escalation and notifications (which the brief barely mentions but the WO is built around).
3. **What is missing is the "measurement layer":** expected outcome, target/unit/achieved, measurement type, estimated duration, actual working time, revenue/support classification, department-specific templates, efficiency/workload/performance calculations, leaderboard.
4. **The spreadsheet confirms the need but is not a reliable data source.** It is one week old (3–6 Nov 2026), has two disconnected task systems, and shows the classification and unit problems the brief warns about (§3 below). Migrate its lists and open assignments, not its history.
5. **Timing matters:** Phases 8 (dashboards) and 9 (reports) are next. If any of the measurement layer is approved, its data model should be decided **before** those phases, or the dashboards and reports get built twice.

## 2. Coverage by brief section

Legend: ✅ built · 🟡 partly built · ⏳ planned in the current roadmap · ❌ not built, not planned · ⛔ conflicts with the work order as written.

| Brief § | Topic | State | What exists today | Gap |
|---|---|---|---|---|
| 1 | Hierarchy and RBAC | 🟡 | Organization → entities (BAIS, USAIS, IE, Embtel, BAAS, Founder's Office) → teams → people with a reporting line; roles CEO, CoS, Manager, Lead, Staff; editable permission matrix; server checks on every request and every id [CODE `shared/permissions.ts`, ADR-0004, ADR-0010]. | Brief's "Department" level: today a team sits directly under an entity (D-111). Scope follows the reporting line, not the vertical: a vertical head without reports sees nothing extra (entity `head_id` exists but carries no visibility) [Q]. |
| 2 | Core objectives 1–14 | 🟡 | 1 assignment ✅, 2 scheduling 🟡, 3–4 execution/progress 🟡 (status + 0–100 % progress), 14 activity history ✅. | 5 estimated vs actual time ⛔, 6–7 outcomes ❌, 8 efficiency ⛔/❌, 9 workload 🟡 (count only), 10 individual performance ⛔, 11 department visibility ⏳, 12 leaderboards ⛔, 13 dashboards/reports ⏳. |
| 3 | Spreadsheet analysis | — | Not previously analysed. | See §3 and §4 below. |
| 4 | Department-specific tasks | ❌ | One organization-wide category list (8 categories) [CODE `shared/settings.ts`]. | Per-department templates: categories, units, targets, outcome types, quality criteria, expected durations. |
| 5 | Revenue vs non-revenue | ❌ | None. | A task "purpose" classification set by the manager/template, not by department and not self-reported (D-114). |
| 6 | Assignment and scheduling | 🟡 | Title, description, instructions, entity (derived), team, assignee, assigner, category, priority, optional start date, due date+time in the assignee's zone, attachments, review required, parent task [CODE `tasks` table]. | Expected outcome, measurement type, target, unit, estimated duration, dependencies (parent ≠ "blocked by"), a real **Scheduled** state (start date is informational only), separate approval rules. |
| 7 | Lifecycle | 🟡 | `draft, assigned, in_progress, blocked, submitted, changes_requested, reopened, completed, cancelled` [CODE `shared/workflow.ts`]. Partial progress, blocker reason, reassign, due change (with authority rules), priority edit, review approve / request changes, reopen. | **Scheduled** and **Paused** are missing; "Rejected" exists as `changes_requested`; "Not started" = `assigned`. Progress is one number for every task type; the brief wants quantity-based or milestone-based progress. |
| 8 | Timestamped history | ✅ | Append-only, per-task hash chain, server UTC time, actor, before/after values, nightly verification, shown in the viewer's zone [CODE `activity.ts`, `audit.ts`, audit chain, T-1.9]. | Events for start/pause/resume do not exist because the states do not exist. Working vs waiting vs blocked time is not separated (D-112). |
| 9 | Estimated duration, benchmarks | ⛔ | None. | Estimates per task/template, historical averages, manager override, elapsed vs active vs blocked time, delay. Actual time capture is "time tracking by the hour" [WO]. |
| 10 | Outcome tracking | ❌ | Review gives a qualitative pass/rework only. | Quantitative (target/achieved), qualitative (accepted, quality passed), milestone outcomes; employee submits, manager validates; achieved / partial / not achieved. |
| 11 | Individual performance | ⛔ / ⏳ | FR-11 accountability report by person (on-time, overdue, escalations) is in WO scope and planned in Phase 9 (RPT-06). | Weighted, department-aware scoring across execution, efficiency, outcome, workload, quality. A scored evaluation is close to "HR appraisal" [WO] (D-110). |
| 12 | Leaderboard | ⛔ | None. | Per-vertical ranking with filters, explained scores and drill-down; visibility rules (D-117). |
| 13 | Workload | 🟡 | `overloadThreshold` = count of open tasks per person (default 6) [CODE `shared/settings.ts`]; team view in the mock. | Effort-based load (estimates × schedule × priority), availability, overlap, at-risk prediction. The brief explicitly rejects count-only workload. |
| 14 | Dashboards by role | ⏳ | Phase 8 (DASH-01…03, TASK-09/10, SRCH-01); today's dashboard runs on mock data. | Brief adds CEO/CoS/vertical/employee content that depends on §9–§13 data. |
| 15 | Reports | ⏳ / 🟡 | Phase 9: nine reports, FR-11 by entity and person, CSV/PDF. Weekly digest (FR-12) is built. | Efficiency, outcome achievement and workload reports need the missing data. |
| 16 | 24 deliverables | 🟡 | Many already exist for the current scope (see §6). | Deliverables 10–14 (outcome, efficiency, workload, performance, leaderboard frameworks) and 23 (spreadsheet migration) are new. |

**Things TaskWatch has that the brief does not ask for (keep them):** the four-level silence/past-due escalation ladder with routing and acknowledgement [WO FR-8/9], quiet hours, email and in-app notifications, weekly digest, sensitive-ID guard on free text, recurring tasks, review and extension workflows.

## 3. The spreadsheet as it is used today

**Structure.** 15 sheets [XLS]:
- `How to Fill`: the process. Each person plans their day at shift start (blue columns) and reports at shift end (green columns), max 7 tasks a day, every task needs a number and a Service Line, 60–70 % of planned minutes should be "Revenue (Direct)", Social Media passes every DM to a BDE the same day.
- Per-person sheets (6 Sales/BDE, 2 Social Media) plus two templates. Left table "Daily Tasks": Date, Task #, Task, Service Line, Channel, Task Type (Revenue (Direct) / Support), Target, Unit, Time Block, Planned Minutes, Achieved, Status (Done / Partial / Not Done / Carried Forward), % Achieved (formula), Reason. Right table "Daily Funnel": one row per day of department-specific counts (BDE: emails, calls, connects, DMs, replies, positive replies, CRM leads, consults booked/done, proposals, retainers, revenue $; Social: posts, platforms, reach, engagements, followers, clicks, DMs, emails, replies, leads passed to BDE, consults booked).
- `Task Assignment`: manager-assigned tasks with auto ID (T-001…), Assigned On, Assignee, Role, Task, Service Line, Priority, Target, Unit, Start, Due, Est. Hours, Status (Not Started / In Progress / Blocked / Done), Achieved, Completed On, % Achieved, Days Left, Flag (On Time / Late / OVERDUE / Due Soon / BLOCKED), Manager Remarks, Team Notes.
- `Assignment Dashboard`: per person open, overdue, due soon, blocked, due this week, completed this week, on time, on-time %.
- `Weekly Summary`: per person and per department, plan/report submission days, tasks planned/done, completion %, revenue-task time %, summed funnel and conversion ratios (call connect %, reply rate, lead → consult %, consult → close %; engagement rate, leads per post).
- `Lists`: team members, role, 11 Service Lines (H-1B, EB-1A, EB-2 NIW, PERM, L-1, O-1, Family/Other, USAIS Global, Attorney Panel, Brand Awareness, Internal/Admin), 19 Channels, Task Type, Status, Assignment Status, Priority.

**Volume.** 14 manager assignments and 84 self-planned task rows, all dated 3–6 Nov 2026; 3 of 8 people filled any funnel row; one person (Tanya) has no entries [XLS].

**What it gets right (keep the business logic):**
- Every task has a measurable target and a unit, and the employee reports the achieved number: this is the brief's quantitative outcome (§10).
- Revenue (Direct) vs Support classification by time share (§5).
- Department-specific metric sets: Sales and Social Media are summarised separately (§4).
- A daily plan and a daily report give management a rhythm, the same idea as the WO's update heartbeat.
- Blocked must be declared before the deadline, with a reason (already a TaskWatch rule).

**What goes wrong in practice (evidence for the redesign):**

| Problem | Evidence [XLS] | Implication for the app |
|---|---|---|
| Two disconnected task systems | Assignments (`Task Assignment`) and daily tasks (person tabs) are linked only by typing "T-004 \| …" into a description. | One task record; the daily plan should reference real tasks. |
| Classification is left blank or self-chosen | Task Type blank on 30/30 of Simran's rows and 12/17 of Nusrat's, so her "Revenue-Task Time %" reads 0; blog writing and publishing marked "Revenue (Direct)" in Tushar's and the Social template's rows. | Purpose comes from the template or the manager (brief §5), with a default per template. |
| Units hold numbers, estimates hold free text | `Task Assignment` Unit = 1, 500, 7 instead of a unit; Est. Hours = "1 hour", "30 min", 1, 6; Simran!H4 target 100 with unit "2 campaigns". | Units from a controlled list per template; duration as a number. |
| Names and labels drift | "Nushrat" in Lists and assignments vs the tab "Nusrat"; role "BDE" vs "Sales / BDE"; two assignments without a Task ID. | People are records, not strings. |
| Summary formulas break | Weekly Summary team totals F25–F28 show #N/A. | Server-computed figures (Phase 8/9 rule DASH-03). |
| Mixed activity inflates ratios | 13,121 bulk CRM emails summed with personal outreach gives a "reply rate" of 0.02 % (Weekly Summary!U8). | Separate metrics for bulk vs personal channels, or exclude bulk from ratios (D-118). |
| Rules not enforced | Max 7 tasks/day: Simran logged 15 a day. "0 if nothing happened" in the funnel: 5 of 8 people have no funnel rows. | Enforce in the app, or drop the rule (D-116). |
| Time blocks are free text in mixed zones | "10.30-10.50 BD", "10:30 PM–12:00 AM IST". | Structured times, stored in UTC, shown in the person's zone (already how TaskWatch works). |
| On-time status depends on today's date | Flag uses `TODAY()`; "Done" without Completed On cannot be judged. | Server timestamps on completion (TaskWatch already records them). |
| Per-person revenue is tracked | Funnel "Revenue Closed ($)" and "Retainers Closed" per person. | The brief says revenue must not be the default individual measure (D-119). |

## 4. Spreadsheet fields: keep, compute, configure, drop

| Spreadsheet field | Verdict | Where it goes in TaskWatch |
|---|---|---|
| Task ID, Assigned On, Assigned To, Task text | **Exists** | Task id, `assigned_at`, assignee, title. |
| Role | **Drop** (derived) | From the person's roles and team. |
| Priority | **Exists** | Priority (4 levels; the sheet has 3 — map High/Medium/Low, D-120). |
| Start Date, Due Date | **Exists**, extend | Start date becomes a real Scheduled state (proposed). |
| Service Line | **Configurable, vertical-specific** | New dimension "service line / product" per vertical; BAIS list from `Lists`!C. Other verticals have their own or none. |
| Channel | **Configurable, department-specific** | Template attribute or a task field for Sales/Marketing only. |
| Task Type (Revenue / Support) | **Configurable**, set by template/manager | New "purpose" classification (brief §5). |
| Target, Unit, Achieved | **New, essential** | Quantitative outcome on measurable tasks. |
| % Achieved | **Computed** | achieved ÷ target. |
| Est. Hours / Planned Minutes | **New** | Estimated duration (number). Needs D-110 for anything beyond an estimate. |
| Time Block | **Proposed** | Scheduled start/end; only if day-level scheduling is approved (D-116). |
| Status (Done / Partial / Not Done / Carried Forward) | **Map** | Done → completed; Partial → outcome "partially achieved"; Not Done → not achieved; Carried Forward → due change or next-day task. |
| Assignment Status | **Exists** | Workflow statuses. |
| Completed On | **Computed** | Server timestamp. |
| Days Left, Flag | **Computed** | Already derived (due soon / overdue / escalation level). |
| Reason if missed, Team Notes | **Exists** | Updates, blocked reason, comments. |
| Manager Remarks | **Exists** | Comments and review notes. |
| Daily Funnel metrics | **New concept, department-specific** | A daily activity report with a metric set per department (D-115), not task fields. |
| Blockers / Help Needed | **Exists** | Blocked status with reason; comments. |
| Top 3 Priorities Tomorrow | **Drop or optional** | Covered by a daily plan if adopted (D-116). |
| Days Plan / Report Submitted | **Computed** | From daily plan/report submissions, if adopted. |
| Conversion ratios | **Computed**, department-specific | Report layer (Phase 9 extension). |

**Missing from the spreadsheet but needed by the brief:** expected outcome text, measurement type, outcome validation by a manager, quality result, actual start time, paused/blocked time, dependencies, estimate source (template vs override).

## 5. Fit with the current architecture

- **Fits without new architecture:** new task fields (outcome, target/unit/achieved, estimate, purpose), department templates as configuration (like categories and policies today), Scheduled state, reporting on the new fields. Statuses and transitions live in `shared/workflow.ts`, so a new state changes server and client together (ADR-0003/ADR-0007).
- **Needs an ADR before building:**
  - *Paused* and *Scheduled* states and their effect on the escalation clock (the WO ladder runs on silence; pausing must not become a way to stop escalation) — touches ADR-0003 and the engine.
  - *Time capture* (timer start/pause/resume vs reported minutes) and its privacy (D-112, D-113).
  - *Department layer* if "department" is not the existing team (D-111) — touches ADR-0004/ADR-0010.
  - *Performance scoring and leaderboard* (formulas, weights, visibility, explainability) — new module.
- **Interaction with escalation:** a template with an estimate could set the update window; today the window comes from priority and entity policy [WO FR-8]. Changing that changes WO behaviour (D-121).

## 6. The brief's 24 deliverables vs existing documents

| Deliverable | Existing document | State |
|---|---|---|
| 1 BRD | [PRODUCT_REQUIREMENTS](../02-product-requirements/PRODUCT_REQUIREMENTS.md) | Current scope only |
| 2 Hierarchy and roles, 3 RBAC matrix | ADR-0004, ADR-0010, [STAFF-AND-ORG-FRD](../02-product-requirements/features/STAFF-AND-ORG-FRD.md), [ADMINISTRATION-FRD](../02-product-requirements/features/ADMINISTRATION-FRD.md) | Current scope; department layer open |
| 4–6 Workflow analysis, current and future process maps | This document §3 (spreadsheet); none for the app | New |
| 7 Lifecycle | ADR-0003, [TASK-WORKFLOW-FRD](../02-product-requirements/features/TASK-WORKFLOW-FRD.md) | Needs Scheduled/Paused if approved |
| 8 Field definitions | [DATABASE_DESIGN](../03-architecture/DATABASE_DESIGN.md), TASK FRDs | Needs outcome/measurement fields |
| 9 Department templates, 10–14 outcome, efficiency, workload, performance, leaderboard frameworks | — | New |
| 15 Dashboards | DASH FRD (Phase 8) | Needs extension |
| 16 Notifications and escalation | [NOTIFICATIONS-FRD](../02-product-requirements/features/NOTIFICATIONS-FRD.md), [ESCALATION-FRD](../02-product-requirements/features/ESCALATION-FRD.md) | Done |
| 17 Data model | DATABASE_DESIGN | Needs extension |
| 18 Functional, 19 non-functional | FRDs, [PRODUCT_REQUIREMENTS](../02-product-requirements/PRODUCT_REQUIREMENTS.md) (non-functional section) | Current scope |
| 20 Edge cases, 21 acceptance criteria | In each FRD; [RELEASE_READINESS](../05-testing-and-qa/RELEASE_READINESS.md) | Current scope |
| 22 MVP and prioritisation | [IMPLEMENTATION_ROADMAP](../06-planning-and-tracking/IMPLEMENTATION_ROADMAP.md) | Current scope |
| 23 Spreadsheet migration | This document §4 (field map) | Approach only |
| 24 Open questions | [OPEN_QUESTIONS §13](OPEN_QUESTIONS.md) | D-110…D-121 |

## 7. Size of the difference (rough, relative)

Compared with what is built (Phases 1–7) and what is planned (Phases 8–11):

| Work package (proposed) | Contents | Relative size | Blocked by |
|---|---|---|---|
| M-1 Measured tasks | Expected outcome, measurement type, target/unit/achieved, estimate, purpose classification, outcome submit + validate; form, detail, API, migration | Like Phase 7 | D-110 (estimate only is arguably in scope), D-114 |
| M-2 Department templates | Per-department categories, units, metric sets, default estimates and purpose; service-line dimension | Smaller than Phase 7 | D-111, D-115 |
| M-3 Scheduled / Paused states | Workflow, engine, UI, tests | Smaller than Phase 7 | ADR, D-121 |
| M-4 Time capture | Actual start, active vs paused vs blocked time | Like Phase 7 | **D-110, D-112, D-113** |
| M-5 Daily plan and daily activity report | Replaces shift-start/shift-end and the funnel | Like Phase 7 | D-115, D-116 |
| M-6 Efficiency, workload, performance, leaderboard | Calculations, configuration, explanations, drill-down, visibility | Larger than Phases 8 + 9 together | **D-110, D-117**, M-1, M-4 |
| M-7 Dashboards and reports for the above | Merged into Phases 8 and 9 if approved first | Adds to 8 + 9 | M-1…M-6 |
| M-8 Spreadsheet import | Lists, people, open assignments | Small | D-120 |

In plain terms: the brief roughly **doubles the remaining work**. About half of it (M-4, M-6) needs a scope decision first.

## 8. Recommendation

1. **Take D-110 to the Founder's Office first.** Without a new or amended order, M-4 and M-6 should not be built [WO].
2. **Decide the data model before Phase 8.** Even if only M-1 and M-2 are approved, dashboards and reports should be built on them once.
3. **Suggested order if approved:** M-1 → M-2 → M-3 → Phase 8/9 with M-7 → M-5 → M-4 → M-6 → M-8. Measurement before scoring: a leaderboard is only as fair as the outcome and time data under it, and the spreadsheet shows that data is not yet reliable.
4. **Pilot the measurement layer before any ranking.** Run M-1/M-2 in BAIS for a few weeks and check data quality before scores are shown to anyone (the brief's own fairness rule, §12).

## 9. Open questions

Recorded with full text in [OPEN_QUESTIONS.md §13](OPEN_QUESTIONS.md): D-110 scope/work order · D-111 department level · D-112 time-capture method · D-113 time-data privacy · D-114 who classifies revenue vs support · D-115 daily activity metrics · D-116 daily plan and its rules · D-117 leaderboard visibility · D-118 bulk vs personal outreach in ratios · D-119 per-person revenue · D-120 priorities and migration · D-121 estimates and the escalation window.
