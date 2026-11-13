# Requirement Traceability Matrix

> Last updated: 2026-11-12 (§5 ADR-0014 stories and decisions; AC-2 row). Before that: 2026-11-03. Traces Work Order FO-2026-OPS-01 → feature IDs ([PRD](../02-product-requirements/PRODUCT_REQUIREMENTS.md)) → FRD section → ADR → tasks ([TASK_BREAKDOWN](TASK_BREAKDOWN.md)) → test cases ([TEST_CASE_INVENTORY](../05-testing-and-qa/TEST_CASE_INVENTORY.md)) → status ([IMPLEMENTATION_TRACKER](IMPLEMENTATION_TRACKER.md)).
> **Status column:** the feature statuses (ANALYSIS, READY or BLOCKED). No requirement is implemented or tested. Every test case is either *planned* or *existing, not run*.

**FRD files** (all in [../02-product-requirements/features/](../02-product-requirements/features/)): AUTH = [AUTH-FRD](../02-product-requirements/features/AUTH-FRD.md) · TASKS = [TASKS-FRD](../02-product-requirements/features/TASKS-FRD.md) · WF = [TASK-WORKFLOW-FRD](../02-product-requirements/features/TASK-WORKFLOW-FRD.md) · COLLAB = [COLLABORATION-FRD](../02-product-requirements/features/COLLABORATION-FRD.md) · ESC = [ESCALATION-FRD](../02-product-requirements/features/ESCALATION-FRD.md) · NTF = [NOTIFICATIONS-FRD](../02-product-requirements/features/NOTIFICATIONS-FRD.md) · REC = [RECURRING-FRD](../02-product-requirements/features/RECURRING-FRD.md) · DASH = [DASHBOARD-FRD](../02-product-requirements/features/DASHBOARD-FRD.md) · RPT = [REPORTS-FRD](../02-product-requirements/features/REPORTS-FRD.md) · STAFF = [STAFF-AND-ORG-FRD](../02-product-requirements/features/STAFF-AND-ORG-FRD.md) · ADMIN = [ADMINISTRATION-FRD](../02-product-requirements/features/ADMINISTRATION-FRD.md) · SRCH = [SEARCH-FRD](../02-product-requirements/features/SEARCH-FRD.md) · DEMO = [DEMO-TOOLS-FRD](../02-product-requirements/features/DEMO-TOOLS-FRD.md). Each FRD section is headed by its feature ID. Its acceptance criteria are `<ID>-AC-n`.

**ADRs:** [decisions/README](../03-architecture/decisions/README.md). ADR-0007 and ADR-0009 are **Proposed**.

## 1. WO functional requirements (FR-1…FR-12)

| WO req | Short text [WO p.3–4] | Feature IDs | FRD section | ADR | Tasks | Test cases | Status |
|---|---|---|---|---|---|---|---|
| FR-1 | Assign with title, entity, assignee, priority, due date, instructions; assigner and time recorded by the server | TASK-01, TASK-08, (C-4) | TASKS §TASK-01, §TASK-08 | 0004 (entity), 0001 | T-4.1, T-4.3 | TC-TASK-01-01…08, TC-TASK-08-01 | TASK-01 BLOCKED (D-5); TASK-08 ANALYSIS |
| FR-2 | States Open, In progress, Blocked, Done; Blocked needs a reason | WF-02, WF-05, WF-11, NTF-07 | WF §WF-02, §WF-05, §WF-11; NTF §NTF-07 | 0003 | T-1.3, T-4.5, T-4.6, T-4.7 | TC-WF-02-01, TC-WF-05-01, TC-WF-11-01…05 | WF-02/05 READY; WF-11, NTF-07 ANALYSIS |
| FR-3 | Assignee text update, optional file; only an assignee update resets the clock | WF-03, ATT-01, ESC-01 | WF §WF-03; COLLAB §ATT-01; ESC §ESC-01 | 0003 | T-4.5, T-4.11, T-5.1 | TC-WF-03-01…05, TC-ESC-01-07, TC-C7-01 | WF-03 ANALYSIS; ATT-01 BLOCKED (D-13) |
| FR-4 | Comments are logged and do not reset the clock | CMT-01 | COLLAB §CMT-01 | — (D-12 decided) | T-4.10 | TC-CMT-01-01, TC-CMT-01-03 | ANALYSIS |
| FR-5 | Lead (once), manager or CoS extends a due date; old date, new date and reason logged | EXT-04 (plus EXT-01…03, TASK-03) | WF §EXT-04 | 0005 | T-4.4, T-4.9 | TC-EXT-02-02…04, TC-ESC-02-03 | ANALYSIS |
| FR-6 | Reassign, logged; the clock restarts | WF-07 | WF §WF-07 | 0003 | T-4.8 | TC-WF-07-01/02 | ANALYSIS |
| FR-7 | Recurring daily, weekly, monthly tasks | REC-01…04 | REC §REC-01…04 | — (D-5 open) | T-7.1…T-7.3 | TC-REC-01-01, TC-REC-02-01/02, TC-REC-03-01, TC-REC-04-01…03 | REC-02/04 BLOCKED (D-5) |
| PERF (owner brief 2026-11-06; beyond the WO, D-110) | Outcome, timeliness, quality, score, efficiency, workload, team leaderboard | PERF-01…07 | [PERFORMANCE-FRD](../02-product-requirements/features/PERFORMANCE-FRD.md) | D-110…D-121 | [PERFORMANCE_PLAN](PERFORMANCE_PLAN.md) Tasks 1–8 | TC-PERF-01…06 | PERF-01…07 DONE (2026-11-07) |
| FR-8 | Engine at least every 5 min | ESC-01…05, ESC-08 | ESC §ESC-01…05, §ESC-08 | 0006; 0007 (Proposed) | T-1.17, T-5.1, T-5.5 | TC-ESC-01-06, TC-ESC-08-01…03 | ANALYSIS |
| FR-9 | Recipient acknowledges with a note; repeats stop 12 h; clock not reset | ESC-06, ESC-06a, ESC-05 | ESC §ESC-05, §ESC-06, §ESC-06a | — | T-5.3 | TC-ESC-06-01…04, TC-ESC-05-01 | ANALYSIS (D-26) |
| FR-10 | List with stage stripe and filters; detail with full log; summary tiles | TASK-04, TASK-05, TASK-09, TASK-10 | TASKS §TASK-04, §05, §09, §10 | 0009 (Proposed) | T-4.1, T-4.2, T-8.3 | TC-TASK-04-03, TC-TASK-05-03, TC-TASK-10-02 | DONE (2026-11-07) |
| FR-11 | By entity and by person; CSV and PDF | RPT-05, RPT-06, RPT-07, RPT-03, DASH-01 | RPT §RPT-03, §05, §06, §07; DASH §DASH-01 | — (D-15 decided) | T-8.1, T-9.2, T-9.3 | TC-DASH-01-01, TC-DASH-01-03, TC-RPT-03-01…03 | CODE_COMPLETE |
| FR-12 | Monday 09:00 IST digest to managers and the Founder's Office | NTF-05 | NTF §NTF-05 | — (D-14 decided) | T-6.8 | TC-NTF-05-01/02 | ANALYSIS |

## 2. WO non-functional, security and operating items

The labels in the first column are this matrix's own. The WO does not number these items.

| Label | WO item [WO page] | Feature IDs / NFR | FRD section | ADR | Tasks | Test cases / gates | Status |
|---|---|---|---|---|---|---|---|
| WO-ESC | Ladder table; highest rule wins; each level fires once; CoS edits windows per entity, logged [p.2–3] | ESC-01…04, POL-01, POL-03 | ESC §ESC-01…04; ADMIN §POL-01, §POL-03 | 0006 | T-5.1, T-5.2, T-5.7 | TC-ESC-01-01…05, TC-ESC-03-01…03, TC-POL-01-01…03 | ANALYSIS |
| WO-VIS | Each person sees work they own, assigned or supervise; Founder's Office sees all; second role; reporting lines drive routing [p.1–2] | C-2, TASK-04, TASK-05, STAFF-01, STAFF-05, ORG-02, ROLE-01/02, ESC-04 | STAFF; TASKS §TASK-04/05; [USER_ROLES](../02-product-requirements/USER_ROLES_AND_PERMISSIONS.md) | 0004 | T-1.4, T-3.1…T-3.6 | TC-TASK-04-02, TC-SEC1-01, TC-STAFF-02-05, TC-ESC-04-07 | ANALYSIS (D-33) |
| WO-CHN | WhatsApp first, email always, in-app always; approved templates; link to task; Workspace sender "TaskWatch"; L3 at top of dashboard [p.4] | NTF-01, NTF-02, DASH-01 | NTF §NTF-01/02; DASH §DASH-01 | 0001 | T-6.2, T-6.3, T-8.1 | TC-NTF-02-01…06, TC-DASH-01-04; R-I1, R-I2 | ANALYSIS (WO-D6) |
| WO-QH | L0/L1 held 21:00–08:00 in the recipient's zone [p.5] | NTF-03 | NTF §NTF-03 | — | T-6.4 | TC-NTF-03-01…05 | ANALYSIS (WO-D4) |
| WO-TZ | Home zone per user; stored UTC; shown in the viewer's zone [p.5] | C-4, TASK-01, NTF-03 | TASKS §TASK-01 | — (D-5 open) | T-4.3, T-4.14 | TC-TASK-01-06, TC-TASK-05-04 | BLOCKED (D-5) |
| WO-LOG | Append-only log of every listed event; no update/delete endpoints [p.5] | C-5, AUD-01 | ADMIN §AUD-01 | 0001 | T-1.7, T-4.13 | TC-AUD-01-01, -03, -06, TC-C5-01 | ANALYSIS |
| WO-TIME | Server time only [p.5] | C-4, TASK-01 | TASKS §TASK-01 | — | T-4.3 | TC-TASK-01-01, TC-TASK-01-08 | BLOCKED (via TASK-01, D-5) |
| WO-HASH | Per-task hash chain; nightly check; alert the CoS [p.5] | AUD-02, NTF-08 | ADMIN §AUD-02; NTF §NTF-08 | — (SECURITY §9 Proposed) | T-1.9, T-4.13, T-6.6 | TC-AUD-01-02, TC-AUD-01-04 | ANALYSIS (D-16) |
| WO-LOGIN | SSO; 2FA for Manager, CoS, CEO [p.5] | AUTH-01, 01a, 01b, 07, 08 | AUTH §AUTH-01…08 | 0002, 0008 | T-2.1…T-2.4 | TC-AUTH-01-01…06; **none for AUTH-07**; R-S4 | ANALYSIS (D-65, D-89) |
| WO-AUTHZ | Access control on the server for every request [p.5] | C-1, C-2, WF-10, SEC-1 | PRD §2 | 0004 | T-1.12, T-3.2, T-4.1 | TC-C1-01, TC-SEC1-01, TC-WF-10-01 | WF-10 BLOCKED (D-9) |
| WO-SECRETS | No credentials in code or config; managed secrets store [p.5] | **no feature ID**: NFR SEC-2 | PRD §4 | — | T-11.2 | R-K1…R-K3 | not started (D-73) |
| WO-BACKUP | Daily backups, 90-day retention, quarterly restore test [p.5] | **no feature ID**: NFR Reliability | PRD §4 | — | T-11.2 | R-B1, R-B2, R-B4 | not started |
| WO-RETAIN | Closed tasks and logs kept 7 years; people archived, never deleted [p.5] | STAFF-03, CMT-03, ATT-03, REC-03 | STAFF §STAFF-03 | — (D-12 decided) | T-1.7, T-3.5 | TC-STAFF-03-02, R-B3 | READY/ANALYSIS (D-66, D-31) |
| WO-PII | No passport, A-numbers or other ID numbers in task text [p.5] | C-6 | PRD §2 C-6 | — (D-11 decided) | T-4.3, T-4.10 | TC-C6-01, TC-TASK-01-03, TC-CMT-01-05, TC-REC-02-01 | ANALYSIS |
| WO-WP6 | Pilot report, training video, go-live; weekly Friday status; WO tasks tracked in TaskWatch from WP-3 [p.6] | **no feature ID**: delivery process | — | — | T-11.5, T-11.6 | R-O6, TC-WF-03-06 | not started |
| WO-OUT | Out of scope: hourly time tracking, payroll/HR, client access; phase 2: GHL webhook, ImmigrationCRM, mobile [p.1, p.5–6] | none (excluded on purpose) | [INTEGRATION_DESIGN §7](../03-architecture/INTEGRATION_DESIGN.md) | — | — | — | n/a |

## 3. WO acceptance criteria (AC-1…AC-10)

Criteria text: [PROJECT_OVERVIEW §1.7](../01-discovery/PROJECT_OVERVIEW.md). Release gates: [RELEASE_READINESS §1](../05-testing-and-qa/RELEASE_READINESS.md).

| AC | Feature IDs | FRD section | ADR | Tasks | Test cases | Gate | Status |
|---|---|---|---|---|---|---|---|
| AC-1 | ESC-01, ESC-03, ESC-08 | ESC §ESC-01, §ESC-08 | 0007 (Proposed) | T-1.2, T-5.1, T-5.5, T-11.5 | TC-ESC-01-05, TC-ESC-01-06, TC-ESC-08-02 | R-AC1 | ANALYSIS |
| AC-2 (per approved policy, D-140) | ESC-02 | ESC §ESC-02 | 0005, 0014 | T-5.1; ADR-0014 plan Tasks 1–3 | TC-ESC-02-01, -02, -04, -05, -06 | R-AC2 | Shipped delays reproduce +24 h/+72 h; ADR-0014 rows in §5 |
| AC-3 | WF-11, NTF-07, NTF-03 | WF §WF-11; NTF §NTF-07 | 0003 | T-4.6, T-6.4 | TC-WF-11-01…05 | R-AC3 | ANALYSIS (D-23, D-24) |
| AC-4 | CMT-01, WF-03 | COLLAB §CMT-01; WF §WF-03 | — | T-4.5, T-4.10 | TC-CMT-01-01, TC-WF-03-01 | R-AC4 | ANALYSIS |
| AC-5 | NTF-02, ESC-04, DLV-01 | NTF §NTF-02, §DLV-01; ESC §ESC-04 | — | T-5.2, T-6.3, T-6.7, T-11.4 | TC-ESC-04-01…06, TC-NTF-02-01, -02, -06, TC-DLV-01-02 | R-AC5 | ANALYSIS (WO-D6) |
| AC-6 | TASK-04, TASK-05, DASH-03, SRCH-01, C-2 | TASKS §TASK-04/05; DASH §DASH-03 | 0004 | T-1.12, T-3.2, T-4.1, T-4.2, T-8.1 | TC-TASK-04-01/02, TC-TASK-05-01, TC-DASH-03-01/02, TC-SRCH-01-01, TC-SEC1-01 | R-AC6 | ANALYSIS |
| AC-7 | AUD-01, AUD-02, C-5 | ADMIN §AUD-01/02 | 0001 | T-1.7, T-1.9, T-4.13 | TC-AUD-01-01…04 | R-AC7 | ANALYSIS |
| AC-8 | DASH-01, RPT-05 | DASH §DASH-01; RPT §RPT-05 | — | T-8.1, T-9.2, T-11.5 | TC-DASH-01-01, TC-DASH-01-02 | R-AC8 | ANALYSIS |
| AC-9 | TASK-01, TASK-05, NTF-03, C-4 | TASKS §TASK-01 | — (D-5 open) | T-4.3, T-4.14 | TC-TASK-01-06, TC-TASK-05-04, TC-NTF-03-01 | R-AC9 | BLOCKED (D-5) |
| AC-10 | WF-03 (operational, not code) | WF §WF-03 | — | T-11.5 | TC-WF-03-06 (manual, pilot) | R-AC10 | not started (needs the pilot) |

## 4. Reverse check

### 4.1 Features with no test case under their own ID
The 16 IDs added at the end of the PRD have no `TC-<ID>-NN` of their own. Most are covered indirectly by cases filed under a sibling ID:

| Feature | Indirect coverage | Verdict |
|---|---|---|
| AUTH-01a | TC-AUTH-01-01…03 | covered indirectly |
| AUTH-01b | TC-AUTH-01-04, -05, -07 | covered indirectly |
| **AUTH-07** | none. TC-AUTH-01-06 tests the challenge only, not enrolment or the D-65 reset | **gap**: add in T-2.3 |
| AUTH-08 | TC-AUTH-01-06 | covered indirectly |
| TASK-09 | TC-TASK-04-03 | covered indirectly |
| **TASK-10** | TC-TASK-10-02 (written 2026-11-06, T-8.3) | closed once run |
| EXT-04 | TC-EXT-02-02…04 (filed under EXT-02) | covered indirectly; misfiled |
| ESC-06a | TC-ESC-06-01, TC-ESC-06-03 | covered indirectly |
| NTF-07 | TC-WF-11-02…04 | covered indirectly |
| NTF-08 | TC-AUD-01-02 | covered indirectly |
| RPT-05 | TC-DASH-01-01, TC-RPT-03-01 | covered indirectly |
| RPT-06 | TC-DASH-01-03 | covered indirectly |
| RPT-07 | TC-RPT-03-01 | covered indirectly |
| STAFF-05 | TC-STAFF-02-05, TC-ESC-04-07 | covered indirectly |
| POL-03 | TC-POL-01-03 | covered indirectly |
| AUD-02 | TC-AUD-01-02, TC-AUD-01-04 (nightly). The manual button (D-16) has no UI case | covered indirectly; manual part partial |

All 77 original feature IDs have at least one test case of their own.

### 4.2 Test cases with no feature ID
Seven cases trace to cross-cutting rules, not to a feature ID. This is intended. Each maps to a PRD rule:
- TC-C1-01 → C-1
- TC-C3-01 → C-3
- TC-C5-01 → C-5
- TC-C6-01 → C-6
- TC-C7-01 → C-7
- TC-SEC1-01 → NFR SEC-1
- TC-SEC4-01 → NFR SEC-4

TC-WF-03-06 is filed under WF-03 but measures AC-10 adoption, not WF-03 behaviour. Every other one of the 190 cases names an existing feature ID.

### 4.3 WO requirements with no feature
- **Every WO functional requirement (FR-1…FR-12) and every acceptance criterion (AC-1…AC-10) maps to at least one feature ID.** There is no orphan.
- Three WO items have **no feature ID** by nature. They are covered by NFR rows and release gates instead:
  - WO-SECRETS → NFR SEC-2, R-K1…R-K3
  - WO-BACKUP → NFR Reliability, R-B1/B2/B4
  - WO-WP6 delivery → R-O6
- No WO requirement is untraced.
- Separately, the WO's own decisions **WO-D2…WO-D7** are not recorded as answered in [OPEN_QUESTIONS](../01-discovery/OPEN_QUESTIONS.md). The WO asks for them before WP-1 [WO p.7].

## 5. Owner user stories and decisions (ADR-0014, 2026-11-12)

Beyond the WO; the owner's stories US-01…US-07 ([ADR-0014 §20](../03-architecture/decisions/ADR-0014.md)) and decisions D-140…D-153 ([OPEN_QUESTIONS §14](../01-discovery/OPEN_QUESTIONS.md)). Tasks are in [ADR-0014-IMPLEMENTATION-PLAN](ADR-0014-IMPLEMENTATION-PLAN.md). Status is the [tracker](IMPLEMENTATION_TRACKER.md)'s: **TESTING** = built and targeted runs green, full `npm test` and plan Task 14 Steps 1 and 3 open.

| Story | Feature IDs | FRD section | Decisions | Plan tasks | Test cases | Status |
|---|---|---|---|---|---|---|
| US-01 Schedule and assign | TASK-01 (ADR-0014 additions), TASK-11 | TASKS §TASK-01, §TASK-11 | D-144, D-151, D-153 | 4, 12 | TC-TASK-01-09…14, TC-TASK-11-01 | TESTING |
| US-02 Vertical policy (GM) | POL-01, POL-04 | ADMIN §POL-01, §POL-04 | D-140, D-141, D-142, D-150 | 7, 8, 9 | TC-POL-04-01…07, TC-ESC-10-03 | TESTING |
| US-03 Cross-vertical admin (CoS) | POL-04 | ADMIN §POL-04 | D-141, D-146, D-152 | 8, 9, 14 | TC-POL-04-03, -04, -06, TC-ESC-02-07 | TESTING; D-152 values entered 2026-11-12 (not applied to open tasks) |
| US-04 My schedule | TASK-11 | TASKS §TASK-11 | — | 12 | TC-TASK-11-01, TC-TASK-01-13 | TESTING |
| US-05 Warning and countdown | ESC-10, ESC-07 | ESC §ESC-07, §ESC-10 | D-143, D-149 | 5, 6, 13 | TC-ESC-07-01, -02, TC-ESC-10-01…03 | TESTING |
| US-06 Submit and track review | ESC-11, ESC-04 | ESC §ESC-04, §ESC-11 | D-145 | 10, 11 | TC-ESC-11-01, -02 | TESTING |
| US-07 Progress updates | ESC-02 | ESC §ESC-02 | D-140, D-146 | 1, 2, 3 | TC-ESC-02-05, -06 | TESTING |

| Decision | Feature IDs | Test cases |
|---|---|---|
| D-140 | ESC-02, POL-01 | TC-ESC-02-05, -06 |
| D-141 | POL-04 | TC-POL-04-03 |
| D-142 | POL-04, ESC-04 | TC-POL-04-01, -05, TC-ESC-04-08 |
| D-143 | ESC-07, ESC-10 | TC-ESC-07-01, -02, TC-ESC-10-01 |
| D-144 | TASK-01, ESC-07 | TC-TASK-01-09, TC-ESC-07-02 |
| D-145 | ESC-11 | TC-ESC-11-01, -02 |
| D-146 | ESC-02, POL-04 | TC-ESC-02-07 |
| D-147 | ESC-05, NTF-03 | TC-NTF-03-04 |
| D-148 | WF-07 | TC-WF-07-02 |
| D-149 | ESC-10 | TC-ESC-10-02, -03 |
| D-150 | POL-04 | TC-POL-04-03, -04 |
| D-151 | TASK-01 | TC-TASK-01-13, -14 |
| D-152 | POL-01, ESC-11 | none yet (values entered through the UI, plan Task 14 Step 1) |
| D-153 | TASK-01 | TC-TASK-01-12 |

## Features with no work-order requirement (prototype scope)

These features come from the prototype UI, not from a WO FR. They are kept because the WO says the approved behaviour is shown in the prototype and does not contradict them. Each one traces to its FRD, its tracker row, and test cases `TC-<ID>-NN` in [TEST_CASE_INVENTORY](../05-testing-and-qa/TEST_CASE_INVENTORY.md). Validation found 2026-11-04 that every one of them has at least one test case.

| Group | Feature IDs | Source |
|---|---|---|
| Session and account | AUTH-02, AUTH-03, AUTH-04, AUTH-05, AUTH-06 | [V-C] `AuthPages.tsx`, `App.tsx`, `services/api/misc.ts` |
| Task extras | TASK-02 (draft/publish), TASK-06 (calendar), TASK-07 (bulk actions) | [V-C] `TaskFormPage.tsx`, `CalendarPage.tsx`, `TaskListPage.tsx` |
| Workflow extras (D-20) | WF-01 (acknowledge task), WF-04 (submit for review), WF-06 (review decision), WF-08 (cancel), WF-09 (reopen) | [V-C] `engine/workflow.ts`, `services/api/tasks.ts` |
| Extensions and collaboration | EXT-03 (queue), CMT-02 (edit comment), ATT-02 (download/preview) | [V-C] `QueuePages.tsx`, `TaskDetailPage.tsx` |
| Escalation and notification UX | ESC-07 (due-soon/overdue notices), ESC-09 (escalations workspace), NTF-04 (preferences), NTF-06 (simulation mode), DLV-02 (my deliveries) | [V-C] `core.ts`, `EscalationsPage.tsx`, `AccountPages.tsx`, `channels.ts` |
| Views and reports | DASH-02 (team overview), RPT-01, RPT-02, RPT-04 (report scope, nine reports, scoped filter options) | [V-C] `TeamPage.tsx`, `ReportsPages.tsx` |
| Administration | STAFF-04 (profile), ORG-01 (org tree), ROLE-02 (edit permission matrix), POL-02 (policy simulator), SET-01 (system settings), DEMO-01 (demo tools) | [V-C] `StaffPages.tsx`, `OrgPage.tsx`, `AdminPages.tsx`, `DemoBar.tsx` |

## 6. Attendance and vertical working time (ADR-0015, 2026-11-13)

| Decision | Feature | Code | Tests | Status |
|---|---|---|---|---|
| D-156, D-161, D-163 | ATT-01 | `services/attendance.ts`, `routes/attendance.ts`, `features/attendance/` | TC-ATT-01…07 | TESTING |
| D-157 | ATT-01/02 | same | TC-ATT (unmarked) | TESTING |
| D-158, D-164 | ATT-03 | `services/worktime.ts`, engine, queries | TC-ATT-08, e2e | TESTING |
| D-159, D-165 | ORG-03 | `services/structure.ts` (worktime), `directory.ts`, VerticalsPage | TC-ORG-03-*, TC-WT-04 | TESTING |
| D-160 | ESC-02 | `shared/worktime.ts`, `shared/levels.ts`, `shared/policy.ts` | TC-WT-01…05 | TESTING |
| D-162 | STAFF-06 | `routes/people.ts` (`staffScope`), `services/staff.ts` | TC-STAFF-06-* | TESTING |
