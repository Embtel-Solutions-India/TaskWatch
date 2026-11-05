# Project Overview

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 (wins over the prototype) · **[V-C]** verified in client code · **[V-S]** verified in server code · **[A]** assumption · **[OPEN]** see [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## 1. Product overview

### 1.1 Purpose
TaskWatch makes sure every task assigned across the group's entities has the following:
- a server timestamp
- a required update rhythm
- an accountable owner
- **automatic escalation** up the reporting line when work stalls or runs past due.

This is stated in [WO] and in `README.md:15-18`.

### 1.2 Business objectives
1. Every assignment is recorded with who assigned it, to whom, and when, on server time. [WO FR-1]
2. Silence is visible: assignees must post updates within a priority-based window, or the task climbs L0 → L3. [WO FR-8]
3. Leadership sees accountability by team and person, with on-time and compliance rates. [WO FR-10/11/12]
4. There is a tamper-evident, append-only audit trail with 7-year retention. [WO; `README.md:136-150`; `client/ASSUMPTIONS.md:26`]
5. Alerts are delivered in-app, by email and by WhatsApp, and respect quiet hours. [WO Notifications]

### 1.3 Target users
Internal staff of BAIS, USAIS, International Evaluations, Embtel, Bay Area Accounting Solutions and the Founder's Office (`README.md:15-17`). There is no client or external access, which is out of scope per the WO (`README.md:173-174`).

### 1.4 User roles [V-C `types/index.ts:1`, `constants/index.ts:6-13`]
| Role | Rank | Default reach (client seed) |
|---|---|---|
| CEO | 4 | Views everything and is read-only by default. Receives L3 when D7 is on. |
| Chief of Staff (CoS) | 3 | **Always holds every permission.** The role is locked so the platform can't be locked out (`permissions.ts:16`). |
| Manager | 2 | Their transitive reporting line |
| Team Lead | 1 | Their direct and transitive reports |
| Staff | 0 | Tasks assigned to them, or created by them |

A role grants a **capability** (15 permissions, `types/index.ts:4-20`). The **reporting line** limits which tasks and people that capability applies to (`ASSUMPTIONS.md:7`).

### 1.5 Major modules
1. Authentication and session
2. Tasks: create, draft, edit, list, detail, calendar
3. Task workflow: acknowledge, start, progress, review, complete, cancel, reopen, reassign
4. Due-date extensions
5. Comments and attachments
6. Escalation engine and acknowledgements
7. Notifications: in-app, email, WhatsApp, quiet hours, preferences, weekly digest
8. Recurring tasks
9. Dashboards (role-specific) and team overview
10. Accountability reports and exports
11. Staff directory, profiles and org structure
12. Roles and permissions
13. Escalation policies and system settings
14. Audit log and delivery log
15. Global search
16. Demo tools (non-production)

### 1.6 Work order vs prototype reconciliation (WO wins)

| Topic | Work order [WO] | Prototype (client) | Resolution |
|---|---|---|---|
| Org unit | **Entity** on every task (FR-1). SLA windows can be set **per entity**. Dashboard is **by entity** (FR-11). | Departments → teams, no entity | Add `entity` to users and tasks; teams sit under entities. **Decided (D-4): Department = Entity, teams under entities.** |
| Roles | "Anyone can be given a **second role**" | Single `role` | **Multiple roles per user.** Effective permissions are the union of the roles' permissions. The Staff form gets a multi-role picker (small UI change). |
| States (FR-2) | Open, In progress, **Blocked (reason required)**, Done | 8 states with a review loop, no Blocked | Blocked is added (decided). **D-20: how the extra prototype states fit** |
| Due-date change (FR-5) | Lead (once), manager or CoS can extend directly. Old date, new date and reason are logged. | Extension request → approval | **Both** (decided, D-6) |
| Acknowledge (FR-9) | "The person an escalation **reached**", **with a note**. Pauses repeats at that level for 12 h. | No note. Overseers can also acknowledge. | Add the note, required. Limit acknowledgement to recipients (to and cc) per WO. **[A]** |
| Comments (FR-4) | From leads, managers and the Founder's Office. They never reset the clock. | Anyone can comment, including the assignee. | Broader in the prototype, but not a conflict. Keep it. |
| Views (FR-10) | List with a **stage stripe** and filters **All open, Escalated to me, Red, Blocked, Closed**. Detail with the full activity log. Summary tiles. | Different quick filters | Add the missing quick filters: Escalated to me, Red, Blocked. |
| Accountability (FR-11) | **By entity:** open, on track, amber, red, longest silence. **By person:** open, **average first response**, escalations, on-time %. **CSV and PDF.** | No entity, no first-response metric, no longest-silence metric, CSV only | Add these metrics and a PDF export. The server already computes and exports them (`services/reports.ts`, `exports.ts`). D-15 resolved: PDF is required. |
| Digest (FR-12) | **Monday 09:00 IST** email to each manager and the Founder's Office: red items, repeat offenders, on-time trend | Settings default Monday 08:00 local | WO schedule is the default. D-14 resolved. |
| Login | **SSO** with the StatCommand directory. **2FA required for Manager, CoS and CEO.** | Email + password | Decided: Google **and** password (D-2). **D-21: the password path must enforce 2FA for those roles.** |
| Delivery (WO D1) | StatCommand module recommended, or standalone | Standalone | **Decided (D-22): standalone.** |
| Retention | Closed tasks and their logs kept 7 years. People are archived, never deleted. | Only stated in UI text | No hard deletes of tasks, people or log rows. Comment and attachment "delete" is a soft delete, with the original kept in the log (D-12 resolved). |
| Client data | No passport, A-number or other ID numbers in task text | No guard | Enforce on the server and show the 422 in the UI (D-11 resolved). |
| Engine (FR-8) | At least every 5 minutes, on the server | Runs in a browser tab | Server scheduler (ESC-08). |
| Phase 2 | GoHighLevel webhook, ImmigrationCRM link, mobile app | — | Out of scope. |

### 1.7 Acceptance criteria from the work order (sign-off in the pilot)
| # | Criterion | Covered by |
|---|---|---|
| AC-1 | A Critical task with no update reaches L0/L1/L2/L3 at 4/6/8/12 h, each within 5 minutes | ESC-01, ESC-08 |
| AC-2 | Past due → at least L1 at due, L2 at +24 h, L3 at +72 h, whatever updates were posted | ESC-02 |
| AC-3 | Marking Blocked alerts the team lead within 5 minutes | WF-11 |
| AC-4 | A lead or manager comment does not reset the clock; an assignee update does | CMT-01, WF-03 |
| AC-5 | Each alert reaches the right person on WhatsApp and email, and is logged | NTF-02, DLV-01 |
| AC-6 | Staff cannot see another team's tasks, **tested through the API** | C-2, TASK-04/05 |
| AC-7 | No log row is editable or deletable through any endpoint; the nightly hash check flags a row altered directly in the DB | C-5, AUD-01 |
| AC-8 | Dashboard figures for one entity match a manual count on a sample of 20 tasks | RPT, DASH |
| AC-9 | Times display correctly in IST and PT for the same task | C-4, D-5 |
| AC-10 | BAIS pilot: at least 90% of staff post updates through TaskWatch | operational, not code |

---

