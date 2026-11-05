# FRD: Tasks (TASK)

> Module index: [PRODUCT_REQUIREMENTS §2.2](../PRODUCT_REQUIREMENTS.md#22-tasks-task). Rules: [BUSINESS_RULES](../BUSINESS_RULES.md). Scope: [USER_ROLES_AND_PERMISSIONS §3](../USER_ROLES_AND_PERMISSIONS.md#3-scope-rules). Tags: **[WO]** · **[V-C]** `client/src/…` · **[V-S]** `server/src/…` · **[A]** · **[OPEN D-n]**. All endpoints are **PROPOSED**. Common rules C-1..C-7 apply to every feature: session, server-side authorization, 422 `{error, fields}`, UTC server time, append-only log, sensitive-ID guard, immediate escalation re-evaluation. The server currently returns 400 for schema errors (`http/middleware.ts:75`); that must become 422 per C-3.
>
> **Task view (`TaskView`)** returned by list and detail: the task fields plus `level`, `levelInfo`, `stage`, `assignee`, `giver`, `team`, `entity`, `overdue`, `lastUpdateAt`, `escalationAcked` [V-C `services/api/base.ts:57-83`]. `stage` and `entity` are added (TASK-10, D-4). People are returned as `{id, name, title}` only (SEC-9).

Features: TASK-01 … TASK-08 · **TASK-09 (new, from WO)** · **TASK-10 (new, from WO)**

---

## TASK-01 Create task

**Description.** Assigns a new task, or saves it as a draft (TASK-02). FR-1: title, entity, assignee, priority, due date and instructions. The server records the assigner and the assignment time. [WO FR-1]

**Roles.** Holders of `create_tasks`, plus `assign_tasks` unless saving a draft. Defaults: CoS, Manager, Lead.

**User actions (UI).** New task page `features/tasks/TaskFormPage.tsx:15`, form `:40`, submit `:56-64`. The priority hint shows the thresholds (`:137`). Attachments go on new tasks only.

**Expected behaviour.**
- Server-generated id `TW-<n>`.
- Status `assigned` (shown as Open).
- `clockStartedAt` = `createdAt` = now.
- The reviewer is the creator.
- Activity rows `created` and `assigned`, plus an assignment record.
- A mandatory `assignment` notification to the assignee on in-app, email and WhatsApp (`taskwatch_task_assigned`, with the due time in the assignee's zone).
- Audit `task.created`.

[V-C `services/core.ts:94-139`, `services/api/tasks.ts:115-145`; V-S `services/tasks.ts:61-102`]

The entity is taken from the team, or else from the assignee. [D-4]

**Data.**
- `tasks`: id, title, description, instructions, category, priority, status, assigneeId, createdBy, assignedBy, reviewerId, teamId, **entityId**, createdAt, startAt, dueAt, clockStartedAt, reviewRequired, parentId
- `assignments`
- `activity_log`
- `attachments`
- `notifications`

**Backend processing.**
1. Check permissions.
2. Validate.
3. Run the sensitive-ID guard over title, description and instructions.
4. Convert the due time from local to UTC (D-5).
5. In one transaction: insert the task, the assignment and the log rows, and queue the notifications.
6. Store files (ATT-01).
7. Re-evaluate escalation (C-7).

**API (PROPOSED).** `POST /api/tasks`. The request is multipart when files are attached.

Request:
```
{
  title, description, instructions, category, priority, assigneeId,
  teamId?, dueDate: "YYYY-MM-DD", dueTime?: "HH:MM",
  startDate?, reviewRequired, parentId?, draft: bool
}
```

Response: 201 `{task: TaskView}`.

Adapt `POST /tasks` (`routes/tasks.ts:48-62`), which takes `{title 3–200, entityId, assigneeId, priority, dueLocal, instructions ≤5000}` and returns `{id}`.

**Validation.** Messages are exact, from `services/api/tasks.ts:80-93, 101`; each is a 422 `fields.<key>`.

| Field | Rule | Message |
|---|---|---|
| title | trimmed length ≥ 4 | `Give the task a title of at least 4 characters.` |
| title | length ≤ 140 | `Keep the title under 140 characters.` |
| priority | one of critical, high, normal, low | `Choose a priority.` |
| category | required; **[A]** must be in `settings.categories` (the mock only checks non-empty) | `Choose a category.` |
| assigneeId | required | `Choose who will do this.` |
| assigneeId | in the assignable set | `You can only assign to people below you in the reporting line.` |
| dueDate | required | `Set a due date.` |
| dueDate | parses | `Enter a valid date.` |
| dueDate | due moment > now (default time 17:00) | `The due time must be in the future.` |
| startDate | ≤ dueDate | `Start date must be on or before the due date.` |
| parentId | visible to the actor | `Pick a parent task you can see.` |
| files | each ≤ 25 MB **[D-13, decided]** | `<name> is larger than 25 MB.` |
| any text | sensitive-ID guard | BR-80 message |

The server's title limits (3–200) differ. **Decided (D-34): 4–140** (the UI's limits); the server schema changes to match.

**Authorization.**
- 403 `You don't have permission to create tasks.`
- 403 `You don't have permission to assign tasks.` (when not a draft)

[V-C `permissions.ts:21-23`, `tasks.ts:117-118`]

**Scenarios.**

| Scenario | Status |
|---|---|
| Lead assigns to a report | 201 |
| Staff (no `create_tasks`) | 403 |
| Lead assigns outside the line | 422 `assigneeId` |
| Past due date | 422 `dueDate` |
| A-number in the title | 422 |

**Dependencies.** STAFF/ORG (reporting line), NTF-02, ATT-01, ESC (clock), SET-01 (categories).

**Acceptance criteria.**
- TASK-01-AC-1: A valid create returns 201 with status `assigned`, and `createdAt` = `clockStartedAt` = server time; any client-supplied timestamp is ignored.
- TASK-01-AC-2: The assignee receives an `assignment` notification on in-app and email, plus WhatsApp if they have opted in, regardless of preferences.
- TASK-01-AC-3: Each validation row above returns 422 with its exact field message.
- TASK-01-AC-4: A Staff-only user receives 403.
- TASK-01-AC-5: The activity log for the new task has `created` and `assigned` rows with the actor and server time, and the hash chain verifies.
- TASK-01-AC-6: The task's entity equals its team's entity, or else the assignee's entity.

**Test scenarios.**
- Create per role.
- Each validation boundary (title 3/4/140/141).
- Due exactly now.
- Out-of-line assignee.
- Sensitive-ID patterns.
- WhatsApp opt-in vs no number.
- 26 MB file.

---

## TASK-02 Save as draft and publish

**Description.** Save without assigning, then publish later.

**Roles.**
- Draft: `create_tasks`.
- Publish: the giver (creator, assigner, or CoS) with `assign_tasks`.

**User actions (UI).**
- "Save as draft" on `TaskFormPage.tsx:56-64` (hidden when repeat is on).
- "Assign now" on `features/tasks/TaskDetailPage.tsx:47`.

**Expected behaviour.**
- Draft: status `draft`, no assignment, no notification, no clock; audit `task.draft_created`.
- Publish: status `assigned`, `clockStartedAt` = now, an assignment record, and the assignee is notified.

[V-C `core.ts:124-125`, `tasks.ts:195-205`]

**Data.** As TASK-01.

**API (PROPOSED).**
- Draft: `POST /api/tasks` with `draft:true`.
- Publish: `POST /api/tasks/:id/publish` → 200 `{task: TaskView}`.

The server has no drafts; this is new.

**Validation.** [V-C `tasks.ts:199-200`]
- Due moment ≤ now → 422 `Move the due date into the future before assigning.`
- Assignee no longer in scope → 403 `The selected assignee is outside your scope.`

**Authorization.** `allowedActions.publish` (BR, [USER_ROLES §5](../USER_ROLES_AND_PERMISSIONS.md#5-per-task-action-matrix)). Otherwise 403 `You can't assign this draft on <id> in its current state.` [V-C `workflow.ts:75-78`]

**Scenarios.**

| Scenario | Status |
|---|---|
| Publish valid | 200 |
| Draft with a past due date | 422 |
| Non-giver | 403 |
| Already published | 403 |

**Dependencies.** TASK-01.

**Acceptance criteria.**
- TASK-02-AC-1: Creating a draft sends no notification and creates no assignment record.
- TASK-02-AC-2: A draft never escalates, however long it sits.
- TASK-02-AC-3: Publishing sets `clockStartedAt` to the publish time and notifies the assignee.
- TASK-02-AC-4: Drafts are excluded from the `mine` and `team` lists and from the calendar.

**Test scenarios.**
- Draft then publish.
- Publish after the due date has passed.
- Publish by a non-giver.
- Draft is invisible to the assignee.

---

## TASK-03 Edit task

**Description.** Change task fields while the task is open.

**Roles.** Giver or overseer with `create_tasks`, on a task that is not closed.

**User actions (UI).** Edit page `TaskFormPage.tsx:24` (the page-level check `actions.includes('edit')` is at `:30`); "Edit task" in the More menu `TaskDetailPage.tsx:80`; row menu `features/tasks/shared.tsx:58-73`.

**Expected behaviour.**
- Updates the fields and logs `edited` with a summary of the changes.
- A changed assignee counts as a reassignment: assignment record, clock restart, acknowledgement cleared (BR-63).
- A changed due date logs `due_changed` (old → new) and audits `task.due_changed`.
- Files can be added.
- Escalation is re-evaluated.

[V-C `tasks.ts:147-184`]

Under D-6, a due change made through Edit must satisfy FR-5 authority (BR-56/57). **[A]**

**Data.** `tasks` (all editable fields), `activity_log`, `assignments`, audit.

**API (PROPOSED).** `PUT /api/tasks/:id`, with the same body as TASK-01 (minus `draft`) → 200 `{task}`. There is no server equivalent; the partial endpoints `POST /tasks/:id/due` and `/reassign` exist (`routes/tasks.ts:106-118`).

**Validation.**
- As TASK-01, except that a past due date is accepted when it is unchanged [V-C `tasks.ts:90`], and an unchanged out-of-scope assignee is accepted [`:85`].
- `parentId` equal to the task itself → `A task cannot be its own parent.` [`:93`]

**Authorization.**
- `allowedActions.edit`, otherwise 403 `You can't edit this task on <id> in its current state.`
- A due change by a lead whose once is used → 403 `A team lead can extend a task only once` [V-S `services/tasks.ts:188`] [A].

**Scenarios.**

| Scenario | Status |
|---|---|
| Giver edits the title | 200 |
| Edit a completed task | 403 |
| Change the assignee | 200, clock restarts |
| Lead changes the due date a second time | 403 |

**Dependencies.** TASK-01, WF-07, EXT-04.

**Acceptance criteria.**
- TASK-03-AC-1: Editing only the title does not change `clockStartedAt`.
- TASK-03-AC-2: Changing the assignee resets `clockStartedAt`, clears `acknowledgedAt` and creates an assignment record.
- TASK-03-AC-3: Changing the due date writes a log row with the old and new values.
- TASK-03-AC-4: An edit attempt on a completed or cancelled task returns 403.

**Test scenarios.**
- Field edits.
- Assignee change.
- Due change by each role.
- Closed task.
- Self-parent.

---

## TASK-04 List tasks by scope

**Description.** The lists behind My tasks, Assigned by me, Team tasks and the Calendar.

**Roles.**
- `mine`: everyone.
- `assigned_by_me`: `create_tasks`.
- `team`: `view_tasks`.
- `all`: everyone (it returns only visible tasks).

**User actions (UI).** `features/tasks/TaskListPage.tsx:19` with `scope`. Filters are client-side (`shared.tsx:110-141`). Bulk actions at `TaskListPage.tsx:112-128`. CSV export at `:58-64`.

**Expected behaviour.** Returns `TaskView` rows for the scope, restricted to visible tasks [V-C `services/api/tasks.ts:18-33`]:

| Scope | Rows |
|---|---|
| `mine` | assignee = me, not draft |
| `assigned_by_me` | created or assigned by me |
| `team` | assignee in my reports (CoS: everyone but me), not draft |
| `all` | everything visible |

**Data.** `tasks` joined with users, teams, entities and active escalations.

**Backend processing.**
- One scoped query using a recursive CTE for reports (NFR Performance).
- Level is computed per row.
- Hard cap and pagination per **[D-10, decided]**.

**API (built 2026-11-05, T-4.1).** `GET /api/tasks?scope=mine|assigned_by_me|team|all&view=<TASK-09>&entity=&q=` → 200 `{items: TaskView[], truncated}` (approved API_CONTRACTS; cap 500, ADR-0009). Without `scope`, `view` defaults to `open` as before; with a scope it defaults to every status. Each row carries `actions[]` (WF-10). Proposed earlier: `{rows: TaskView[], total}`. Adapt `GET /tasks` (`routes/tasks.ts:36-46`, `services/queries.ts:71-107`), which has `view` but no `scope`, and is capped at 500.

**Validation.** Unknown `scope` or `view` → 422 [A]. `q` ≤ 100 characters [V-S `routes/tasks.ts:42`].

**Authorization.** [V-C `tasks.ts:23, 27`]
- `assigned_by_me` without `create_tasks` → 403 `You don't have permission to see tasks you assigned.`
- `team` without `view_tasks` → 403 `You don't have permission to view team tasks.`

**Scenarios.**

| Scenario | Status |
|---|---|
| Staff calls `mine` | 200 |
| Staff calls `team` | 403 |
| Lead calls `team` | 200, only their line |

**Dependencies.** C-2, ESC-01 (level).

**Acceptance criteria.**
- TASK-04-AC-1 (AC-6): A Staff user calling every list scope through the API never receives a task whose assignee is outside their own tasks, the tasks they created or assigned, or their reviews.
- TASK-04-AC-2: A Lead's `team` list contains exactly the non-draft tasks of their transitive reports.
- TASK-04-AC-3: Every row's `level` equals the level computed by the escalation rules at response time.
- TASK-04-AC-4: Rows contain no email or phone of anyone.

**Test scenarios.**
- Cross-team leakage through the API (AC-6).
- Scope × role matrix.
- Draft exclusion.
- Cap and pagination.
- Personal-data fields absent.

---

## TASK-05 Task detail

**Description.** The full workspace for one task, including the complete activity log. [WO FR-10]

**Roles.** Anyone who can view the task (`canViewTask`: assignee or overseer; FO sees all, S-1).

**User actions (UI).** `features/tasks/TaskDetailPage.tsx:18`; buttons are driven by `actions` (`:32, :46-55, :76-85`).

**Expected behaviour.**
- Returns the task view, activities (newest first), comments, updates, attachments, reviews, extensions, assignments, escalation events (with to and cc), the **allowed actions**, a visible parent, visible children and the recurrence. [V-C `tasks.ts:35-57`]
- People are referenced on the task as `{id, name, title}`. **Not** `users: db.users` (the defect at `tasks.ts:54`).
- Chain verification is not run on every read (NFR Performance) [A]. The server runs it today (`services/queries.ts:164`).

**Data.** All task-related tables.

**API (PROPOSED).** `GET /api/tasks/:id` → 200 `{task, activities, comments, updates, attachments, reviews, extensions, assignments, escalations, actions, parent, children, recurrence, people}`. Adapt `GET /tasks/:id` (`routes/tasks.ts:64-67`, `services/queries.ts:157-…`).

**Validation.** `:id` format `TW-<digits>` → otherwise 404 [A].

**Authorization.**
- Not found → 404 `Task <id> was not found.` [V-C `services/api/base.ts:47`]
- Not visible → 404, identical to a missing task (D-35, decided; implemented 2026-11-04 (T-1.12) in `server/src/services/queries.ts`). The prototype throws 403 [V-C `permissions.ts:85`]; the client fetch adapter (T-1.16) must render both the same way.

C-3 says "404: not found or not visible". **D-35 (decided).**

**Scenarios.**

| Scenario | Status |
|---|---|
| Assignee | 200 |
| Lead over the assignee | 200 |
| Other team's staff | 404 (D-35) |
| Bad id | 404 |

**Dependencies.** All WF, CMT, ATT, ESC features (their data).

**Acceptance criteria.**
- TASK-05-AC-1: `actions` equals the `allowedActions` set for that user and task.
- TASK-05-AC-2: The response contains no directory listing; every person object has only id, name and title.
- TASK-05-AC-3: Every log row has server time, actor and before/after values (where applicable).
- TASK-05-AC-4: A user outside the task's scope receives the D-35 status and no task fields.

**Test scenarios.**
- Visibility by relationship.
- `actions` per role and state.
- Personal-data leak check.
- Children filtered by visibility.

---

## TASK-06 Calendar

**Description.** A month grid of tasks by due date.

**Roles.** Everyone. The "Everything I can see" option needs `view_tasks`.

**User actions (UI).** `features/tasks/CalendarPage.tsx:13`, data `:22`; the scope toggle needs `view_tasks` (`:15`).

**Expected behaviour.**
- Uses TASK-04 `mine` or `all`.
- Drafts are excluded; closed tasks are optional.
- Days are grouped in the **viewer's** zone (BR-85) [A]; the mock uses the browser's zone.

**Data.** As TASK-04.

**API.** None new; it uses `GET /api/tasks?scope=…`. **[A]** Add `dueFrom` and `dueTo` filters for paging (D-10).

**Validation.** `dueFrom` ≤ `dueTo` → otherwise 422 [A].

**Authorization.** As TASK-04.

**Scenarios.** Month with tasks → 200. `scope=all` without `view_tasks` → only own tasks, since `all` is visibility-limited [V-C `tasks.ts:20`].

**Dependencies.** TASK-04.

**Acceptance criteria.**
- TASK-06-AC-1: A task due 2026-11-05 09:00 IST (03:30 UTC) appears on the 5th for an IST viewer and on the 4th (19:30 PST) for a PT viewer, per AC-9.
- TASK-06-AC-2: Drafts never appear.

**Test scenarios.**
- Zone boundary days (IST vs PT).
- Closed toggle.
- Month edges.

---

## TASK-07 Bulk cancel and bulk acknowledge

**Description.** Apply cancel or acknowledge to several selected tasks.

**Roles.**
- Cancel: per task, `allowedActions.cancel`.
- Acknowledge: per task, `allowedActions.acknowledge`.

**User actions (UI).** `TaskListPage.tsx:112-128`. Acknowledge is shown in the `mine` scope; Cancel is shown outside `mine` with `create_tasks`.

**Expected behaviour.**
- Each id is checked on its own. Ids that fail go to `skipped` (unknown, not visible, not allowed); the rest are applied. [V-C `tasks.ts:489-527`]
- **[A]** Each applied item has the same effects as the single action (WF-08 cancel notifies the assignee; WF-01 acknowledge audits). The mock skips those effects in bulk (`tasks.ts:500-503, 520-523`).
- The whole call is one transaction per item [A].

**Data.** As WF-01 and WF-08.

**API (PROPOSED, new).**

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/tasks/bulk/cancel` | `{ids: string[], reason}` | 200 `{done: string[], skipped: string[]}` |
| POST | `/api/tasks/bulk/acknowledge` | `{ids: string[]}` | 200 `{done: string[], skipped: string[]}` |

**Validation.**
- reason trimmed length < 5 → 422 `fields.reason = "A cancellation reason is required."` [V-C `tasks.ts:491`]
- ids: 1–200 [A]

**Authorization.** Per item. Not-visible ids are reported as skipped and never distinguished from unknown ids [A].

**Scenarios.** Mixed ids → 200 with both lists. Reason too short → 422. Empty ids → 422 [A].

**Dependencies.** WF-01, WF-08.

**Acceptance criteria.**
- TASK-07-AC-1: Given 3 cancellable and 2 non-cancellable ids, `done` has 3, `skipped` has 2, and only the 3 change status.
- TASK-07-AC-2: Each cancelled task notifies its assignee and writes an audit row, as a single cancel does.
- TASK-07-AC-3: An id of an invisible task appears in `skipped`, and the response reveals nothing else about it.

**Test scenarios.**
- Mixed permissions.
- Reason boundary (4 and 5 characters).
- Invisible id.
- Large batch.

---

## TASK-08 Picker data

**Description.** Option lists for the assignee and parent pickers.

**Roles.**
- Assignees: `assign_tasks` (others get an empty list).
- Parents: everyone.

**User actions (UI).** `TaskFormPage.tsx` (assignee `:68, :119`, parent list). Reassign dialog `features/tasks/TaskDialogs.tsx:213`.

**Expected behaviour.**
- `assignees` = the assignable set (S-4), as `{id, name, title, teamId, openCount}`. [A] `openCount` replaces the client's raw count (`TaskDialogs.tsx:230`).
- `parents` = visible tasks that are active or drafts, as `{id, title}`. [V-C `tasks.ts:530-540`]

**API (PROPOSED).**
- `GET /api/tasks/options/assignees` → 200 `[{id, name, title, teamId, entityId, timeZone, openCount}]` (built 2026-11-05; replaced `GET /users/assignable`).
- `GET /api/tasks/options/parents` → 200 `[{id, title}]`. New.

**Validation.** None.

**Authorization.** C-1.

**Scenarios.** Lead → their reports. Staff → `[]`. CoS → everyone active except self.

**Dependencies.** STAFF/ORG.

**Acceptance criteria.**
- TASK-08-AC-1: The assignee list contains only active users within the requester's transitive reports, plus the requester themselves for a lead, manager or CoS (self-assignment allowed, D-32 decided). A CoS sees every active user. Inactive users and anyone outside the line never appear.
- TASK-08-AC-2: The parent list contains only tasks the requester can view.

**Test scenarios.**
- Per role.
- Inactive user excluded.
- Moved person (ORG-02) reflected immediately.

---

## TASK-09 Quick views: All open, Escalated to me, Red, Blocked, Closed (new, from WO)

**Description.** The five FR-10 filters on the task list. [WO FR-10]

**Roles.** Everyone. Each view is applied on top of the user's visible tasks.

**User actions (UI).** No UI yet. Today's quick filters are "All / Needs attention / In review" (`TaskListPage.tsx:99-108`). This is a UI addition; keep the existing filters too (D-20 "no UI feature is removed").

**Expected behaviour.** Server-defined views [V-S `services/queries.ts:71-91`, mapped to the client statuses]:

| View | Definition |
|---|---|
| All open | status not in {completed, cancelled, draft} |
| Escalated to me | open, and an unresolved escalation event at **L1 or above** lists me as a **to** recipient (acknowledged events still count) |
| Red | open and level ≥ 2 |
| Blocked | status `blocked` |
| Closed | status in {completed, cancelled}, newest closed first |

Open views sort by level descending, then due ascending [V-S `services/queries.ts:96`].

**Data.** `tasks.status`, `tasks.level`, `escalation_events`, `escalation_recipients(kind)`.

**API (PROPOSED).** `GET /api/tasks?view=open|escalated|red|blocked|closed` (combined with TASK-04 `scope`). Reuse the server's `view` parameter (`routes/tasks.ts:40`).

**Validation.** Unknown view → 422 [A].

**Authorization.** As TASK-04.

**Scenarios.** The manager who is the L2 recipient of a task sees it in "Escalated to me". The L2 **cc** (the lead) does not. A Staff user's L0 does not count.

**Dependencies.** WF-11 (Blocked), ESC-01..04, TASK-10.

**Acceptance criteria.**
- TASK-09-AC-1: A task at L2 whose "to" is Manager M appears in M's "Escalated to me" and not in the cc'd lead's.
- TASK-09-AC-2: "Red" contains exactly the open visible tasks at level 2 or 3.
- TASK-09-AC-3: "Blocked" contains exactly the visible tasks in status `blocked`.
- TASK-09-AC-4: "Closed" contains no task in an active status.
- TASK-09-AC-5: A count shown on each view equals the row count returned for it.

**Test scenarios.**
- Each view against a seeded fixture.
- to vs cc.
- Acknowledged escalation still listed.
- Resolved escalation not listed.

---

## TASK-10 Stage stripe and summary tiles (new, from WO)

**Description.** Each task row carries a colour stage, and the list page shows summary tiles. [WO FR-10 "task list with stage stripe … summary tiles"]

**Roles.** Everyone (over visible tasks).

**User actions (UI).** No UI yet. The list table `shared.tsx:75-91` gains a stage stripe column; tiles go above the list. The dashboard health buckets (`features/dashboard/widgets.tsx:47-54`) use different buckets and stay as they are.

**Expected behaviour.**
- `stage` = `on_track` if level −1, `amber` if level 0–1, `red` if level 2–3, and `null` for closed and draft tasks. [V-S `domain.ts:57-64`]
- Tiles (over visible tasks): open, on track, amber, red, blocked, mine, escalated to me, needs my acknowledgement (escalated to me and not acknowledged), plus the L3 list for the Founder's Office banner. [V-S `services/queries.ts:114-150`]

**Data.** As TASK-09.

**API (PROPOSED).** `stage` is a field of `TaskView`. `GET /api/tasks/summary` → 200 `{open, onTrack, amber, red, blocked, mine, escalated, needsAck, l3: TaskView[]}`. Reuse `GET /tasks/summary` (`routes/tasks.ts:31-34`).

**Validation.** None.

**Authorization.** C-1; counts scoped (S-8).

**Scenarios.** A Staff user's tiles count only their own visible tasks.

**Dependencies.** ESC-01, TASK-09, FR-11 (same banding in RPT).

**Acceptance criteria.**
- TASK-10-AC-1: A task at L1 has stage `amber`, one at L2 has `red`, one at −1 has `on_track`.
- TASK-10-AC-2: open = onTrack + amber + red for the same viewer at the same instant.
- TASK-10-AC-3 (AC-8): For one entity, the summary counts match a manual count over a sample of 20 tasks.

**Test scenarios.**
- Banding boundaries.
- Tile arithmetic.
- Per-role scoping.
- Manual-count comparison.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

- **D-4 / D-7** (decided): the entity on tasks and the per-entity rules. Entity derivation is in TASK-01.
- **D-5**: which zone the due time is entered in (TASK-01, TASK-06).
- **D-10**: pagination and the server cap (TASK-04).
- **D-13**: upload size (TASK-01 files).
- **D-20**: whether drafts count in "All open" (assumed no).
- **D-32 (decided)**: self-assignment and "their staff" (TASK-08).
- **D-34 (decided)**: canonical text limits (title 4–140 in the client vs 3–200 on the server; instructions unbounded vs ≤ 5000).
- **D-35 (decided)**: 403 vs 404 for an invisible task.
