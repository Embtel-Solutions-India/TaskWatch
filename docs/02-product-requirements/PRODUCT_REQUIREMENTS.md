# Product Requirements (index & cross-cutting requirements)

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 (wins over the prototype) · **[V-C]** verified in client code · **[V-S]** verified in server code · **[A]** assumption · **[OPEN]** see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md). Per-module detail lives in [features/](features/). Discovery: [../01-discovery/](../01-discovery/PROJECT_OVERVIEW.md).

## 2. Functional requirements

Common rules that apply to **every** feature unless a feature says otherwise:
- **C-1 Auth.** Every endpoint except the signed-out auth endpoints requires a valid server session for an **active** user. Otherwise it returns 401.
- **C-2 Authorization.** Authorization is server-side. A UI guard is never the control. The rules live in `client/src/services/authz/permissions.ts` and `services/engine/workflow.ts:allowedActions`, which together are the reference spec.
- **C-3 Validation.** Validation is server-side. It returns `422 {error, fields:{name: message}}`, and the UI shows the field messages inline (`client/src/hooks/index.ts:37`). The other errors are:
  - 403: not allowed
  - 404: not found or not visible
  - 409: state conflict
  - 400: bad token or request
- **C-4 Server time.** All event timestamps are server time in UTC. [WO]
- **C-5 Logging.** Every state change appends to the task activity log, and to the admin audit log where noted. The logs are append-only and hash-chained. [V-S `activity.ts`]
- **C-6 Sensitive-ID guard.** Free text is rejected when it contains A-numbers, SSNs, USCIS receipt, passport or I-94 numbers. [V-S `sensitive.ts`; WO] The new client has no such guard and no UI message for it. **[D-11, decided — OPEN_QUESTIONS §7.1]**
- **C-7 Escalation re-evaluation.** Any mutation that can change escalation state (progress, review, extension, reassign, cancel, edit, rules change, org change) re-evaluates escalation for the affected tasks immediately. [V-C: every such mock API call ends with `processEscalations`]

### 2.1 Authentication & session (AUTH)

| ID | Feature | Spec |
|---|---|---|
| AUTH-01 | Sign in | **UI:** email + password form (`AuthPages.tsx:47`). **Server today:** Google Workspace OAuth plus a dev-only directory login, and no passwords (`routes/auth.ts`). **[D-2, decided — OPEN_QUESTIONS §7.1]** The work order calls for Google sign-in, with 2FA enforced by Workspace (`README.md:93-98`). Account must be active, otherwise 403 "This account is deactivated…" (`misc.ts:22`). Unknown email or bad password returns 401 with a generic message, so accounts can't be enumerated. **Acceptance:** valid → session cookie set and redirect to `from`; invalid → 401 with no user enumeration; inactive → 403; brute force is throttled (NFR-SEC-3). |
| AUTH-02 | Sign out | Destroys the server session and clears the cookie. |
| AUTH-03 | Session timeout | Idle timeout = `settings.sessionTimeoutMinutes` (5–480, default from settings). Today it is enforced only in the client (`App.tsx:20-34`); the server has a fixed 12 h rolling timeout. **Acceptance:** after the idle time the next API call returns 401 `SESSION_EXPIRED` and the UI routes to `/session-expired`. |
| AUTH-04 | Forgot / reset password | Only exists if D-2 keeps passwords. Request: same response whether or not the account exists (`misc.ts:52`). Token is single-use and expires in 1 h (`misc.ts:65`). New password: ≥10 characters, with letters and at least one number; confirm must match. |
| AUTH-05 | Admin "reset access" | `manage_staff` only. Issues a reset link for another user and audits `staff.access_reset` (`admin.ts:155`). Depends on D-2. |
| AUTH-06 | Current user / capabilities | Returns the user, their effective permissions, integration status and server time. The UI needs this to replace the direct `getDb()` reads ([EXISTING_SYSTEM_ANALYSIS §2.2](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)). |

### 2.2 Tasks (TASK)

| ID | Feature | Spec (reference: `services/api/tasks.ts`) |
|---|---|---|
| TASK-01 | Create task | Needs `create_tasks`, and also `assign_tasks` unless saved as a draft. **Fields and validation (`tasks.ts:156-174`):**<br>• title: trimmed, 4–140 characters<br>• description, instructions: free text<br>• category: must be in `settings.categories`<br>• priority: critical, high, normal or low<br>• assignee: must be in the actor's assignable set (CoS: any active user except self; others: active transitive reports)<br>• dueDate + dueTime (default 17:00): must be in the future<br>• startDate ≤ dueDate<br>• parent: an existing task the actor can see, not the task itself<br>• reviewRequired: boolean<br>• team: defaults to the assignee's team<br>• files: optional<br>**Effects:** server-generated ID `TW-<n>`; status `assigned`, or `draft` when saved as a draft; `clockStartedAt` = now; reviewer = creator; activity `created` + `assigned`; assignment record; `assignment` notification to the assignee (mandatory); audit `task.created` / `task.draft_created`.<br>**[D-5, decided]** The due time is interpreted in the browser's zone today; the work order requires the person's home time zone, converted on the server (`README.md:149`). |
| TASK-02 | Save as draft / publish | A draft is not assigned and sends no notification. Publish requires `allowedActions.publish` (the task giver with `assign_tasks`), an assignee still in scope, and a due date in the future. Publishing sets status `assigned`, restarts the clock, records the assignment and notifies the assignee. |
| TASK-03 | Edit task | Allowed when `edit` is in the allowed actions: task not closed, actor is giver or overseer, with `create_tasks`. Same validation as create. A past due date is allowed only if it is unchanged. Changing the assignee counts as a reassignment: the clock restarts and the acknowledgement is cleared. Changing the due date logs `due_changed` and audits it. **[D-6, decided — OPEN_QUESTIONS §7.1]** The giver can change the due date freely here, which conflicts with the work order's FR-5 ("lead once, manager, CoS"). |
| TASK-04 | List tasks by scope | Scopes:<br>• `mine`: assignee = me, excluding drafts<br>• `assigned_by_me`: created or assigned by me; needs `create_tasks`<br>• `team`: assignee in my reports (CoS: everyone except me); needs `view_tasks`<br>• `all`: everything visible (used by the Calendar)<br>Each row is a TaskView: the task plus `level`, `levelInfo`, `assignee`, `giver`, `team`, `overdue`, `lastUpdateAt`, `escalationAcked`.<br>The UI filters, sorts, pages and exports CSV on the client over the whole list. **[D-10, decided]** |
| TASK-05 | Task detail | Visible to the assignee, giver, reviewer, anyone above the assignee with `view_tasks`, and the CoS (`canViewTask`). Returns the task view plus activities, comments, updates, attachments, reviews, extensions, assignments, escalation events, the **allowed actions**, a visible parent, visible children, and the recurrence.<br>**Defect in the reference:** it returns `users: db.users`, which is the whole directory including emails and phone numbers (`tasks.ts:54`). The backend must return only the people referenced on the task. |
| TASK-06 | Calendar | Month grid built from TASK-04 `mine` or `all`. Draft tasks are excluded. Closed tasks are optional. |
| TASK-07 | Bulk cancel / bulk acknowledge | Takes a list of IDs. Each task is checked on its own against `allowedActions`; tasks that fail the check are returned as `skipped` and the rest still go through. Bulk cancel needs a reason of at least 5 characters. Result: `{done[], skipped[]}`. |
| TASK-08 | Picker data | `assigneeOptions`: the assignable set. `parentOptions`: visible tasks that are active or drafts. |

### 2.3 Task workflow (WF)

State machine [V-C `workflow.ts:6-15`]:
```
draft → assigned | cancelled
assigned → in_progress | cancelled
in_progress → submitted | completed | cancelled
submitted → completed | changes_requested | cancelled
changes_requested → in_progress | cancelled
reopened → in_progress | cancelled
completed → reopened
cancelled → (none)
```
- Active statuses, where the escalation clock runs: `assigned`, `in_progress`, `changes_requested`, `reopened`.
- `submitted` pauses silence escalation (`ASSUMPTIONS.md:9`).
- **[D-3, decided — OPEN_QUESTIONS §7.1]** The work order's FR-2 requires a **Blocked** state with a reason that alerts the lead immediately (`README.md:61, 160`). The server implements it; the new client has no Blocked state.

| ID | Action | Who (`allowedActions`) | Validation | Effects |
|---|---|---|---|---|
| WF-01 | Acknowledge task | Assignee with `update_assigned_tasks`, active, not yet acknowledged | — | Sets `acknowledgedAt`. Snoozes **repeat** notifications for `ackSnoozeHours`. Never resets the clock. Audited. |
| WF-02 | Start work | Assignee; status is `assigned`, `changes_requested` or `reopened` | transition | → `in_progress`. Acknowledges the task if it wasn't already. |
| WF-03 | Post progress | Assignee; active | message ≥5 characters; percent 0–100; files | Adds an update. Moves to `in_progress` if needed. **Resets the silence clock.** Sets progress. Notifies the giver (`progress`). |
| WF-04 | Submit for review | Assignee; `in_progress`; `reviewRequired` | note ≥5 characters; files | Opens review round n+1 → `submitted`. Resets the clock. Notifies the reviewer and the giver (`review_required`). |
| WF-05 | Mark complete | Assignee; `in_progress`; `!reviewRequired` | optional note | → `completed`, progress 100, `completedAt`. Notifies the giver. |
| WF-06 | Review decision | Overseer (not the assignee) with `review_tasks`; status `submitted` | Not approved → comment ≥5 characters. You cannot review your own work. A pending round must exist (409 otherwise). | Approved → `completed`. Changes requested or rejected → `changes_requested` and the clock restarts. Notifies the assignee (`review_decision`). |
| WF-07 | Reassign | Overseer with `reassign_tasks`; not closed and not a draft | new assignee ≠ current and in scope; reason ≥5 characters | Assignment record. Giver becomes the actor. Acknowledgement and snooze are cleared. Clock restarts; past-due levels still hold. Team follows the new assignee. Notifies both people. Audited. |
| WF-08 | Cancel | Giver or overseer with `assign_tasks`; not closed | reason ≥5 characters | → `cancelled` with `cancelReason`. Escalations resolved. Assignee notified. |
| WF-09 | Reopen | Giver or overseer with `assign_tasks`; status `completed` | reason ≥5 characters; new due date in the future (17:00) | → `reopened`. Clears `completedAt`. Clock restarts. Acknowledgement cleared. Assignee notified. |
| WF-11 | Mark blocked [WO FR-2] | Assignee; active | reason required (≥5 chars, sensitive-ID guard) | → `blocked`. Alerts the team lead **within 5 minutes** (AC-3) on all channels, subject to quiet hours as for L1. Blocked counts toward L1 on the ladder (WO page 2). Unblocking happens through progress or start. Exact transitions per D-20. |
| WF-10 | Allowed actions | — | — | The server computes the action set per task and user, and returns it on detail and list rows. The UI shows only those buttons. |

### 2.4 Due-date extensions (EXT)

| ID | Feature | Spec |
|---|---|---|
| EXT-01 | Request extension | Who: the assignee, on an active task with no extension already pending. Validation:<br>• the requested date and time is later than the current due date and in the future<br>• reason ≥10 characters<br>• info is optional<br>Effects: a pending request is created and audited. Approvers are notified: overseers with `approve_extensions` who are the giver or the requester's manager (`tasks.ts:398`). |
| EXT-02 | Decide extension | Who: an overseer with `approve_extensions`, who is not the requester. The request must still be pending (409 otherwise). A rejection needs a note ≥5 characters. On approval, `dueAt` takes the new date and due-based escalation is recalculated. The requester is notified. Audited `extension.approved` or `extension.rejected`. |
| EXT-03 | Extensions queue | Lists extensions on visible tasks, pending first, each with a per-row `canDecide`. |

**[D-6, decided — OPEN_QUESTIONS §7.1]** The server implements the work order's FR-5 as a direct due-date change: a lead can change it once, then a manager, then the CoS. The client replaced that with this request/approve flow.

### 2.5 Comments & attachments (CMT / ATT)

| ID | Feature | Spec |
|---|---|---|
| CMT-01 | Add comment / reply | Anyone who can view the task, including the assignee. Body 1–4000 characters. Replies go one level deep. Optional files. A comment **never resets the clock** [WO FR-4]. Each `@Full Name` mention notifies that user, if they can view the task. |
| CMT-02 | Edit comment | Author only. Body must not be empty. Sets `editedAt`. |
| CMT-03 | Delete comment | Author or CoS. A soft delete: the body is blanked and the deletion is audited. **[D-12, decided — OPEN_QUESTIONS §7.1]** A delete conflicts with the work order's append-only audit expectation. Both the edit and the delete must leave the original text recoverable in the log. |
| ATT-01 | Upload | Who: the assignee, an overseer, or the giver, on a task that is not closed. Each file ≤25 MB in the client; the server allows 15 MiB today. **[D-13, decided]** Context is one of `task`, `progress`, `comment`, `review`. Each file is stored with its SHA-256 and logged. |
| ATT-02 | Download / preview | Needs `canViewTask`. The download is sent as `Content-Disposition: attachment` with nosniff. Inline preview only for safe types (image, PDF, plain text). |
| ATT-03 | Remove | Uploader or overseer. The activity is logged. The stored file is kept (append-only evidence). **[A]** |

### 2.6 Escalation engine (ESC)

Reference: `client/src/services/engine/escalation.ts`, `services/core.ts:processEscalations`, `server/src/engine/*`.

| ID | Feature | Spec |
|---|---|---|
| ESC-01 | Silence ladder | Level k is reached when `now − clockStartedAt ≥ window[priority] × multiples[k]`. Defaults:<br>• windows 4/24/48/72 h<br>• multiples 1/1.5/2/3<br>Only an **assignee** progress update, a submission, a review send-back, a reassignment or a reopen resets the clock. |
| ESC-02 | Past-due floor | L1 at the due time, L2 at due +24 h, L3 at due +72 h (offsets are configurable). These levels hold while updates continue, until the task closes or the due date moves. |
| ESC-03 | Highest rule wins; each level fires once per cycle | One event per (task, level, cycle). An event resolves when its level no longer applies. |
| ESC-04 | Routing [WO] | • L0 → assignee.<br>• L1 → team lead, cc the assignee.<br>• L2 → manager, cc the lead and the assignee.<br>• L3 → Founder's Office (every active CoS, plus the CEO if D7 is on), cc the manager.<br>If a role is missing, the alert goes straight to the next existing level up. |
| ESC-05 | Repeat alerts | The top active level re-alerts every `window` hours unless snoozed. |
| ESC-06 | Acknowledge escalation | Who: a recipient, or an overseer. Marks the active events acknowledged and snoozes repeats for `ackSnoozeHours`. The level and the clock do not change. Notifies the assignee and the giver. Audited. **Gap:** the work order's FR-9 asks for an acknowledgement **note**; the server takes one, the client doesn't. |
| ESC-07 | Due-soon / overdue notices | Due-soon goes to the assignee `dueSoonHours` before the due time. Overdue goes to the assignee and the giver. Each fires once per due date. |
| ESC-08 | Scheduler | Runs at least every 5 minutes [WO] (the server runs every minute). **It must run on the server, not in a browser tab** (today it runs in the client every 30 s, `App.tsx:62-72`). |
| ESC-09 | Escalations workspace | Groups escalation events per visible task (CoS sees all; others see tasks not assigned to themselves). For each task it shows the top level, status, since, recipients, next level and `canAck`. |

### 2.7 Notifications (NTF)

| ID | Feature | Spec |
|---|---|---|
| NTF-01 | In-app inbox | The user's own notifications: list, mark one read or unread, mark all read, unread badge. |
| NTF-02 | Email + WhatsApp dispatch | Every notification fans out to email and WhatsApp according to the user's preferences.<br>**Mandatory, always delivered:** `assignment`, `reassignment`, `escalation` (`channels.ts:80`).<br>**WhatsApp** needs an international number **and** the user's opt-in; otherwise the message is logged as `skipped`. Only the 5 approved templates may be used (`docs/whatsapp-templates.md`).<br>**Retries:** 3 attempts with backoff. Delivery state is one of sent, held, skipped, failed or simulated. |
| NTF-03 | Quiet hours | 21:00–08:00 by default, in the recipient's time zone. Holds L0/L1 email and WhatsApp until quiet hours end. L2/L3 always go out. In-app is never held. |
| NTF-04 | Preferences | A per-user matrix: notification type × {in-app, email, WhatsApp}. Mandatory types can't be switched off. WhatsApp only applies to the types that have a template. |
| NTF-05 | Weekly digest | Email only. Goes to managers (their own line) and the Founder's Office (the whole org), on `settings.digestDay`/`digestHour`. The client defaults to Monday 08:00 local; the server sends Monday 09:00 IST. **[D-14, decided — OPEN_QUESTIONS §7.1]** Sent once per recipient per week. Can also be sent manually by `manage_system_settings` (audited). |
| NTF-06 | Simulation mode | When credentials or settings are missing, delivery is rendered and logged as *simulated* instead of sent (`README.md:121-122`). |

### 2.8 Recurring tasks (REC)

| ID | Feature | Spec |
|---|---|---|
| REC-01 | List schedules | Needs `create_tasks`. CoS sees every schedule; others see the ones they own or whose assignee is in their reports. Each schedule shows a summary, the next 3 occurrences and the instance count. |
| REC-02 | Create / edit schedule | Needs `create_tasks` + `assign_tasks`. Only the owner or the CoS may edit. Validation:<br>• title ≥4 characters<br>• assignee in scope<br>• startDate required; endDate ≥ startDate<br>• interval 1–365<br>• weekly → at least one weekday<br>• dueHour 0–23<br>Frequencies: daily, weekly, monthly, every-N-days. |
| REC-03 | Pause / resume / delete | Owner or CoS. Delete keeps the instances that were already generated. Audited. |
| REC-04 | Generation | One task per (schedule, day), and never a duplicate. Runs on the server scheduler. **[D-5, decided]** The client uses UTC days (`ASSUMPTIONS.md:27`); the server uses the assignee's time zone and does not backfill missed days. |

### 2.9 Dashboards & team (DASH)

| ID | Feature | Spec |
|---|---|---|
| DASH-01 | Role dashboard | Staff, Lead, Manager and CoS/CEO layouts (`DashboardPage.tsx:71-74`). Each shows KPIs with a previous-period delta and sparkline, health buckets, an attention list with severity rules, the trend, workload/overload, the escalation funnel, team comparison, compliance, delayed reviews, escalation response time, at-risk teams, and the L3 Founder's Office banner. Rules are listed in `features/dashboard/insights.ts`. |
| DASH-02 | Team overview | Scope stats, workload, teams table and people table for the user's reporting line. |
| DASH-03 | Scoping | **Every aggregate must be computed only over data the user may see.** Today many widgets read the raw store with no scoping (`DashboardPage.tsx:107-119, 262, 358, 447, 486`). |

### 2.10 Reports (RPT)

| ID | Feature | Spec |
|---|---|---|
| RPT-01 | Report scope | `view_org_reports` → the whole organisation. `view_team_reports` → the user's reporting line. Neither → 403. |
| RPT-02 | Nine reports | Completion, overdue, escalations, accountability, teams, assignments, compliance, reviews, extensions (`ReportsPages.tsx`). All come from one report payload (`misc.ts:getReport`). Filters: from/to (validate from ≤ to), team, staff member, task giver, priority, status, level. |
| RPT-03 | Exports | CSV per report, built on the client today. The work order's FR-11 requires **CSV and PDF**; the server has both; the new client has no PDF. **[D-15, decided — OPEN_QUESTIONS §7.1]** CSV cells must be guarded against formula injection. |
| RPT-04 | Filter option lists | Must list only people and teams within the user's scope. Today the lists show everyone (`ReportsPages.tsx:85-111`). |

### 2.11 Staff, org, roles (STAFF / ORG / ROLE)

| ID | Feature | Spec |
|---|---|---|
| STAFF-01 | Directory | Who appears depends on `canViewUser`: CoS or `manage_staff` see everyone; everyone else sees themselves, their reports and their managers. Each row shows manager, team, open and overdue counts. |
| STAFF-02 | Create / edit person | Needs `manage_staff`. Creating a CoS, or changing anyone's role, also needs `manage_roles`. Validation:<br>• full name has ≥2 words<br>• email is valid and unique (case-insensitive)<br>• title is required<br>• WhatsApp matches `^\+[1-9]\d{7,14}$`; opting in requires a number<br>• role is valid<br>• manager exists and does not create a reporting loop<br>• time zone is valid<br>You cannot change your own role. At least one active CoS must always remain. Audited per field group (role, manager, team, WhatsApp, details). |
| STAFF-03 | Activate / deactivate | Needs `manage_staff`. Not yourself, and not the last active CoS. Returns the count of open tasks. People are **archived, never deleted** [WO]. **A deactivated user's sessions must stop working immediately.** |
| STAFF-04 | Profile | Who can open it depends on `canViewUser`. Shows the person, manager, reports, chain, team, effective permissions, visible assigned and created tasks, stats (open, overdue, completed, on-time rate), escalations and recent activity, all filtered to what the viewer may see. |
| ORG-01 | Org tree / teams | Shows the reporting tree and team groupings, with a per-person load badge. |
| ORG-02 | Move person | Sets manager and team **in one transaction** (today it is two calls, `OrgPage.tsx:185-193`). The manager move needs `manage_staff`. A team move needs `manage_staff`, or `manage_team` when the person is in your reports. Reporting loops are rejected (409). Escalations are re-evaluated. |
| ROLE-01 | Permission matrix | Needs `manage_roles`. Shows role × permission, with active counts per role. |
| ROLE-02 | Edit role permissions | Needs `manage_roles`. The CoS column cannot be edited (403). Unknown permissions are dropped. The change is audited with what was added and removed. **The new permissions take effect on the next request.** |

### 2.12 Policies, settings, audit, delivery log (POL / SET / AUD / DLV)

| ID | Feature | Spec |
|---|---|---|
| POL-01 | Escalation policy | Needs `manage_escalation_policies`. Validation:<br>• windows 1–720 h<br>• multiples strictly increasing and >0<br>• past-due offsets ≥0 and strictly increasing<br>• ack snooze 1–72 h<br>• due-soon 1–168 h<br>• quiet hours HH:MM<br>• D7 is a boolean<br>Saving audits a diff and re-evaluates every open task. **[D-7, decided — OPEN_QUESTIONS §7.1]** The server also supports per-entity overrides; the client UI only edits the global policy. |
| POL-02 | Policy simulator | Runs on the client against unsaved values. It is a pure function, so a server endpoint is not required. Keep the shared engine module ([ADR-0007](../03-architecture/decisions/ADR-0007.md)). |
| SET-01 | System settings | Needs `manage_system_settings`. Validation:<br>• org name is required<br>• session timeout 5–480 min<br>• at least one category<br>• overload threshold 1–50<br>• digest day 0–6, hour 0–23<br>• workday start/end are HH:MM<br>• time zone is a valid IANA zone<br>`retentionYears` is fixed at 7. Audited. |
| AUD-01 | Audit log | Needs `view_audit_logs`. Filters: date range, actor, action type, team, source, task ID. CSV export. The log is append-only with 7-year retention [WO]. A tamper check (hash chain) runs nightly and on demand, and alerts the CoS (`README.md:140-144`). **The audit-log UI has no "run integrity check" button.** **[D-16, decided]** |
| DLV-01 | Delivery log | Needs `view_audit_logs`. Shows every outbound email and WhatsApp message with its status, a rendered preview and the template. "Send weekly digest now" needs `manage_system_settings`. Recipient address and phone **are personal data**: show them only to authorised roles. |
| DLV-02 | My deliveries | The user's own last 30 messages (Account settings). |

### 2.13 Search & demo (SRCH / DEMO)

| ID | Feature | Spec |
|---|---|---|
| SRCH-01 | Global search | Search runs on the server and only returns what the user may see (`canViewTask`, `canViewUser`). Results: up to 8 tasks (ID, title, assignee, giver, team), 6 people (name, email, title) and matching teams. The UI should debounce input; today it calls on every keystroke. |
| DEMO-01 | Demo bar | Act-as user switching, simulated clock, scenarios, reset data and expire session. **It is shown to every user with no permission check** (`Shell.tsx:126`). It must be removed in production, and in development restricted to the CoS with `DEMO_TOOLS=true`. Server equivalent: `/api/dev/clock` (CoS + demo tools only). **[D-17, decided]** Do the 12 scripted scenarios need a backend? |

---

## 3. User workflows

**W1. Assign → do → close (no review)**
1. A lead creates a task (TASK-01). The assignee is notified on every channel.
2. The assignee acknowledges (WF-01) and starts work (WF-02).
3. The assignee posts updates within the priority window (WF-03), each resetting the clock.
4. The assignee marks it complete (WF-05). The giver is notified.

Depends on: AUTH, STAFF (reporting line), NTF, ESC.

**W2. Review loop**
1. W1 with review required. The assignee submits (WF-04); the task is now `submitted` and silence escalation pauses.
2. The reviewer approves (task `completed`) or requests changes (task `changes_requested`, clock restarts).
3. The assignee reworks, resubmits as round n+1, and the loop repeats.

**W3. Stall → escalation → acknowledgement**
1. There are no assignee updates.
2. L0 goes to the assignee at 1× the window.
3. L1 goes to the lead at 1.5× (cc the assignee).
4. L2 goes to the manager at 2×.
5. L3 goes to the Founder's Office at 3×, and the L3 banner appears on their dashboard.
6. A recipient acknowledges (ESC-06). Repeats pause for 12 h; the level holds.
7. The assignee posts an update. The silence level drops, and the events resolve.
8. If the task is past due, the overdue floor still holds.

**W4. Extension**
1. The assignee requests a new date (EXT-01). The approver is notified.
2. The approver decides (EXT-02).
3. If approved, the due date moves, the past-due floor clears and escalation recalculates.

**W5. Reassign / cancel / reopen**: WF-07, WF-08 and WF-09, each with a reason and audited.

**W6. Recurring**
1. A schedule is created (REC-02).
2. The scheduler generates one task per occurrence (REC-04).
3. Each generated task follows W1.

**W7. Org administration**
1. The CoS adds a person (STAFF-02) and sets their manager and team (ORG-02).
2. The CoS adjusts role permissions (ROLE-02).
3. Assignment scope and routing follow the new tree immediately.

**W8. Oversight**
1. A manager or CoS opens the dashboard, drills into a filtered task list, and acts on escalations, reviews and extensions.
2. Every Monday they receive the digest.
3. They pull reports and export them.

**W9. Audit**
1. The CoS reviews the audit log and the delivery log.
2. The nightly chain check alerts them if any history was altered.

Dependency order for building: **AUTH → STAFF/ORG/ROLE → TASK → WF → CMT/ATT → EXT → ESC → NTF → REC → DASH/RPT → SRCH → AUD/DLV → SET/POL → DEMO**.

---

## 4. Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | **SEC-1:** server-side authorization on every endpoint, with object-level checks (IDOR/BOLA) for every `:id`.<br>**SEC-2:** no secrets in code; everything comes from env or a secrets manager [WO FO-2026-CRM-01].<br>**SEC-3:** rate limiting on sign-in, password reset, search and uploads. **None exists today.**<br>**SEC-4:** CSRF protection. Today it is a custom header plus SameSite=lax; keep it and never enable CORS with credentials.<br>**SEC-5:** helmet headers and CSP.<br>**SEC-6:** session fixation protection: regenerate the session on login.<br>**SEC-7:** request schemas reject unknown fields (mass assignment).<br>**SEC-8:** upload type allowlist and size limits; files are never served inline unless the type is safe.<br>**SEC-9:** responses contain no personal data beyond what the viewer needs (see TASK-05, DLV-01).<br>**SEC-10:** dev login and demo tools are impossible in production. |
| **Performance** | • Lists paginate on the server once datasets exceed the client-side limit (D-10).<br>• No N+1 queries: use set-based scope queries (recursive CTE for the reporting tree).<br>• Task detail p95 < 300 ms at 10k tasks. **[A]** The current chain verification on every detail read must not be O(all rows). |
| **Scalability** | Scheduler jobs are safe to run on multiple instances: an advisory lock or `job_runs` leader. Today every instance runs the engine ([EXISTING_SYSTEM_ANALYSIS §3.5](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)). |
| **Reliability** | • The engine is idempotent (DB unique index on active task+level).<br>• Dispatcher retries with backoff, and stuck `sending` rows are recovered.<br>• Daily `pg_dump`, 90-day retention, quarterly restore test [WO]. |
| **Maintainability** | • One source of truth for the ladder math and the state machine, shared by client and server ([ADR-0007](../03-architecture/decisions/ADR-0007.md)) and never duplicated.<br>• Consistent error envelope.<br>• TypeScript strict on both sides. |
| **Data integrity** | • FK constraints, CHECK constraints for enums, case-insensitive unique email.<br>• Transactions around multi-row changes (reassign, review, extension, org move).<br>• Append-only triggers plus hash chain on the activity and audit logs. |
| **Observability** | • Structured request log (no personal data or secrets).<br>• Job run log (`job_runs`).<br>• Delivery log.<br>• Health endpoint for uptime checks. **[A]** |
| **Availability** | Single region; RTO/RPO not stated. **[OPEN]** |
| **Error handling** | Envelope `{error, fields?}`. Status codes as in C-3. No stack traces. The UI's `ErrorState` maps 403 to access denied, 404 to not found, and anything else to retry. |
| **Time** | All instants stored UTC. Display and entry use the person's time zone. Quiet hours use the recipient's time zone. |

---


## Feature IDs added in the module FRDs (all "new, from WO")
| ID | Feature | FRD |
|---|---|---|
| AUTH-01a / AUTH-01b | Sign-in with Google / with password | [AUTH-FRD](features/AUTH-FRD.md) |
| AUTH-07 / AUTH-08 | TOTP enrolment / TOTP sign-in challenge (Manager, CoS, CEO) | [AUTH-FRD](features/AUTH-FRD.md) |
| TASK-09 | FR-10 quick views: All open, Escalated to me, Red, Blocked, Closed | [TASKS-FRD](features/TASKS-FRD.md) |
| TASK-10 | Stage stripe and summary tiles | [TASKS-FRD](features/TASKS-FRD.md) |
| EXT-04 | FR-5 direct due-date change: lead (once), manager, CoS | [TASK-WORKFLOW-FRD](features/TASK-WORKFLOW-FRD.md) |
| ESC-06a | Acknowledgement note | [ESCALATION-FRD](features/ESCALATION-FRD.md) |
| NTF-07 | Blocked alert to the lead | [NOTIFICATIONS-FRD](features/NOTIFICATIONS-FRD.md) |
| NTF-08 | Chain-break system alert to the CoS | [NOTIFICATIONS-FRD](features/NOTIFICATIONS-FRD.md) |
| RPT-05 / RPT-06 / RPT-07 | FR-11 accountability by entity / by person / PDF export | [REPORTS-FRD](features/REPORTS-FRD.md) |
| STAFF-05 | Multiple roles per person | [STAFF-AND-ORG-FRD](features/STAFF-AND-ORG-FRD.md) |
| POL-03 | Per-entity SLA overrides, with an entity selector | [ADMINISTRATION-FRD](features/ADMINISTRATION-FRD.md) |
| AUD-02 | Integrity check: nightly per WO; manual button pending D-16 | [ADMINISTRATION-FRD](features/ADMINISTRATION-FRD.md) |
