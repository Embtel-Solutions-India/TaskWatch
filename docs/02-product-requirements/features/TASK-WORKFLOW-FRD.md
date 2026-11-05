# FRD: Task Workflow and Due-Date Changes (WF, EXT)

> Module index: [PRODUCT_REQUIREMENTS §2.3–2.4](../PRODUCT_REQUIREMENTS.md#23-task-workflow-wf). State machine and clock rules: [BUSINESS_RULES §1–2, §7–9](../BUSINESS_RULES.md). Per-action authorization matrix: [USER_ROLES_AND_PERMISSIONS §5](../USER_ROLES_AND_PERMISSIONS.md#5-per-task-action-matrix). Tags: **[WO]** · **[V-C]** `client/src/…` · **[V-S]** `server/src/…` · **[A]** · **[OPEN D-n]**. All endpoints are **PROPOSED**. C-1..C-7 apply.
>
> **Shared conventions for every action below.**
> - Action endpoints are `POST /api/tasks/:id/<action>` and return 200 `{task: TaskView, actions: string[]}`.
> - The task row is locked for the transaction, as the server already does with `lockTask`, `select … for update` [V-S `services/tasks.ts:36-43`].
> - Visibility failure → 403 `You are not authorized to view <id>.` (see D-35 (decided)). Action not in `allowedActions` → 403 `You can't <label> on <id> in its current state.` [V-C `services/engine/workflow.ts:75-78`].
> - An invalid transition → 409 (BR-02). A missing task → 404 `Task <id> was not found.`
> - Every action appends to the activity log and the audit log (C-5) and re-evaluates escalation (C-7, BR-27).
> - All free text passes the sensitive-ID guard (BR-80).
> - The server currently returns 400 for validation; that must become 422 (C-3).

Features: WF-01 … WF-11 · EXT-01 … EXT-03 · **EXT-04 (new, from WO)**

**Built 2026-11-05 (T-4.3…T-4.9).** Every action runs through one guard (`services/tasks.ts` `act`) on the shared `allowedActions` and answers `{task, actions}`. Deviations from the conventions above, on purpose:
- A task the caller cannot see answers **404, the same as a missing one** (T-1.12, tested), not 403, so ids never leak.
- Task actions are recorded in the hash-chained **activity log**; `admin_log` keeps rule, directory and admin changes (DATABASE_DESIGN §3.10). The audit view (AUD-01, T-4.13) reads both. Nothing is written twice.
- Edit cannot bypass other rules: an assignee change through Edit also needs the `reassign` action (D-29), and a due change through Edit follows FR-5's authority (BR-56).
- Notifications for the new events (progress, review, completed, cancelled, reopened, extensions) are in-app until the Notifications phase.
- `POST /tasks/:id/updates` and `POST /tasks/:id/status` stay as thin legacy routes over these actions until the client moves over (T-4.14).
- WF-04-AC-3 (past-due floor while submitted, D-25) needs the engine change in T-5.1.

---

## WF-01 Acknowledge task

**Description.** The assignee confirms receipt of the task.

**Roles.** The assignee with `update_assigned_tasks`.

**User actions (UI).**
- "Acknowledge" button: `features/tasks/TaskDetailPage.tsx:48`.
- Assignee banner.
- Row menu: `features/tasks/shared.tsx:58-73`.
- Bulk: TASK-07.

**Behaviour.**
- Sets `acknowledgedAt` and sets `snoozeUntil` = now + `ackSnoozeHours`.
- Logs `acknowledged` and audits `task.acknowledged`.
- Never changes the level or the clock (BR-45). [V-C `services/api/tasks.ts:207-217`]

**Data.** `tasks.acknowledgedAt`, `tasks.snoozeUntil`.

**API.** `POST /api/tasks/:id/acknowledge`, empty body. New: the server's only "ack" is for escalations.

**Validation.** None.

**Authorization.** `acknowledge` ∈ allowedActions: assignee, active status, not yet acknowledged.

**Scenarios.**

| Scenario | Status |
|---|---|
| First acknowledgement | 200 |
| Second acknowledgement | 403 |
| Non-assignee | 403 |
| Completed task | 403 |

**Dependencies.** ESC-05 (repeat suppression).

**Acceptance criteria.**
- WF-01-AC-1: After acknowledging, `clockStartedAt` and `level` are unchanged.
- WF-01-AC-2: No repeat alert is sent for the task until `snoozeUntil`.
- WF-01-AC-3: A second acknowledgement returns 403.

**Test scenarios.**
- Acknowledge then advance the clock past the window: the level still climbs, and repeats are suppressed for 12 h.
- Non-assignee attempt.

---

## WF-02 Start work

**Description.** The assignee moves the task to In progress.

**Roles.** The assignee.

**User actions (UI).** "Start work": `TaskDetailPage.tsx:49`.

**Behaviour.**
- → `in_progress`.
- Sets `acknowledgedAt` if it was not set.
- Does **not** reset the clock (BR-11). [V-C `tasks.ts:219-226`]
- Logs `status_changed` and audits it.

**Data.** `tasks.status`, `acknowledgedAt`.

**API.** `POST /api/tasks/:id/start`. Adapt the server's status-carrying update (`POST /tasks/:id/updates` with `status=in_progress`, `routes/tasks.ts:75-97`). That route requires a body and resets the clock, so a separate endpoint is proposed. [A]

**Validation.** Transition per BR-02.

**Authorization.** `start` ∈ allowedActions: assignee, status ∈ {assigned, changes_requested, reopened} (+ blocked per D-20 [A]).

**Scenarios.** From Open → 200. From in_progress → 403.

**Dependencies.** None.

**Acceptance criteria.**
- WF-02-AC-1: Start moves Open → In progress and leaves `clockStartedAt` unchanged.
- WF-02-AC-2: An unacknowledged task becomes acknowledged by Start.

**Test scenarios.**
- Start from each allowed status.
- Start from a disallowed status.

---

## WF-03 Post progress update

**Description.** The assignee posts a text update, optionally with files and a percentage. This is the **only** routine way to reset the silence clock. [WO FR-3]

**Roles.** The assignee.

**User actions (UI).**
- "Post update" `TaskDetailPage.tsx:50`.
- ProgressDialog `features/tasks/TaskDialogs.tsx:31`: "What changed?", 0–100 step 5, files.

**Behaviour.**
- Adds an update row.
- Moves the task to `in_progress` if it was assigned, reopened or changes_requested (and from blocked, per WF-11).
- Sets `progress`.
- Sets `clockStartedAt` = now.
- Implicitly acknowledges.
- Logs `progress`.
- Notifies the giver (`progress`).
- Re-evaluates escalation, so silence levels drop and their events resolve (BR-12).
- On the server it also sets `last_update_at` and the assignment's `first_update_at`, which feeds FR-11's average first response. [V-C `tasks.ts:228-247`; V-S `services/tasks.ts:111-161`]

**Data.** `updates(id, taskId, authorId, message, percent, at, attachmentIds)`, `tasks.progress/clockStartedAt/lastUpdateAt`, `assignments.first_update_at`, `attachments`.

**API.** `POST /api/tasks/:id/progress` (multipart) `{message, percent, files[]}`. Adapt `POST /tasks/:id/updates` (`routes/tasks.ts:75-97`: one file, body ≤ 5000).

**Validation.** [V-C `tasks.ts:233-234`]
- message trimmed length < 5 → 422 `fields.message = "Describe what changed (at least 5 characters)."`
- percent outside 0–100 → 422 `fields.percent = "Progress must be between 0 and 100."`
- File size per **D-13**.
- Sensitive-ID guard.

**Authorization.** `progress` ∈ allowedActions: assignee, active status. The server message for a non-assignee is `Only the assignee can post updates` [V-S `services/tasks.ts:118`].

**Scenarios.**

| Scenario | Status |
|---|---|
| Assignee posts | 200 |
| Lead tries to post | 403 |
| 4-character message | 422 |
| Completed task | 403 |

**Dependencies.** ESC-01, ATT-01, RPT (first response).

**Acceptance criteria.**
- WF-03-AC-1 (AC-4): After an assignee update, `clockStartedAt` = server time of the update, and the silence level returns to −1.
- WF-03-AC-2 (AC-2): On a task 30 h past due, an assignee update leaves the level at ≥ L2.
- WF-03-AC-3: The first update on an assignment records `first_update_at`; later updates do not change it.
- WF-03-AC-4: A non-assignee gets 403 and the clock is unchanged.

**Test scenarios.**
- Critical task updated at 5 h: L0 resolves and the next L0 is due at 9 h.
- Past-due floor holds after an update.
- Message and percent boundaries.
- File attached.
- Non-assignee.

---

## WF-04 Submit for review

**Description.** The assignee hands the work to the reviewer. This is a prototype extra kept by D-20.

**Roles.** The assignee, on an `in_progress` task with `reviewRequired`.

**User actions (UI).** "Submit for review" `TaskDetailPage.tsx:51`; SubmitDialog `TaskDialogs.tsx:53`.

**Behaviour.**
- Opens review round n+1 → `submitted`.
- `clockStartedAt` = now.
- Logs `review_submitted`.
- Notifies the reviewer and the giver (`review_required`), except the submitter.
- Silence escalation pauses while submitted (BR-08). [V-C `tasks.ts:249-264`]

**Data.** `reviews(id, taskId, round, submittedBy, submittedAt, note, reviewerId, decision, decidedAt, comment)`.

**API.** `POST /api/tasks/:id/submit` (multipart) `{note, files[]}`. New (no review on the server).

**Validation.** note trimmed length < 5 → 422 `fields.note = "Summarize what you are submitting."` [V-C `tasks.ts:253`]

**Authorization.** `submit` ∈ allowedActions.

**Scenarios.** Valid → 200. Review not required → 403. Status not in_progress → 403.

**Dependencies.** WF-06.

**Acceptance criteria.**
- WF-04-AC-1: Each submission creates a round numbered one more than the previous.
- WF-04-AC-2: A submitted task does not climb on silence.
- WF-04-AC-3: While submitted, silence escalation pauses but the past-due floor still applies: an overdue submitted task sits at L1/L2/L3 per the offsets (D-25, decided).

**Test scenarios.**
- Two rounds.
- Silence while submitted.
- Past due while submitted (D-25).

---

## WF-05 Mark complete (Done)

**Description.** The assignee closes the task when no review is required. [WO FR-2 "Done"; Staff "mark Done"]

**Roles.** The assignee.

**User actions (UI).** "Mark complete" `TaskDetailPage.tsx:52`; CompleteDialog `TaskDialogs.tsx:72` (note optional).

**Behaviour.**
- → `completed`, `progress` = 100, `completedAt` = now.
- Logs `completed`.
- Notifies the giver (`completed`).
- All escalation events resolve (BR-04). [V-C `tasks.ts:266-278`]

**Data.** `tasks.status/progress/completedAt`.

**API.** `POST /api/tasks/:id/complete` `{note?}`. Adapt `POST /tasks/:id/updates` with `status=done` (`routes/tasks.ts:80`).

**Validation.** Optional note, sensitive-ID guard.

**Authorization.** `complete` ∈ allowedActions: assignee, `in_progress`, no review required. With review required → 409 `This task requires review approval before it can be completed.` [V-C `tasks.ts:270`] **Decided (R-2, 2026-11-04):** Done is also allowed directly from Open (`assigned`) and Blocked when no review is required (shared rules, T-1.3).

**Scenarios.**

| Scenario | Status |
|---|---|
| Valid | 200 |
| Review required | 409 (or 403 when not in allowed actions) |
| Non-assignee | 403 |

**Dependencies.** ESC.

**Acceptance criteria.**
- WF-05-AC-1: Completing resolves every active escalation event on the task in the same request.
- WF-05-AC-2: A completed task never escalates.
- WF-05-AC-3: On-time status is computed as `completedAt ≤ dueAt`.

**Test scenarios.**
- Complete an escalated task.
- Complete with review required.
- Complete from Open or Blocked (R-2).

---

## WF-06 Review decision

**Description.** An overseer approves or sends back a submission. (D-20 extra.)

**Roles.** An overseer, not the assignee, with `review_tasks`.

**User actions (UI).**
- "Review submission" `TaskDetailPage.tsx:53`.
- ReviewDialog `TaskDialogs.tsx:87`.
- Reviews queue `features/work/QueuePages.tsx:10` (API `listReviewQueue`, `services/api/admin.ts:305-312`).

**Behaviour.**
- Approved → `completed`, progress 100, `completedAt`.
- Changes requested or rejected → `changes_requested`, `clockStartedAt` = now.
- The round is recorded.
- The assignee is notified (`review_decision`). [V-C `tasks.ts:280-304`]

**Data.** `reviews`, `tasks`.

**API.**
- `POST /api/tasks/:id/review` `{decision: "approved"|"changes_requested"|"rejected", comment}`.
- `GET /api/reviews` (queue): `[{task, submission}]`.

Both are new.

**Validation.** [V-C `tasks.ts:284-287`]
- Not approved and comment trimmed length < 5 → 422 `fields.comment = "Explain what needs to change."`
- No pending round → 409 `There is no pending submission to review.`

**Authorization.**
- `review` ∈ allowedActions.
- Self-review → 403 `You cannot review your own work.`
- Queue without `review_tasks` → 403 `You don't have permission to review tasks.`

**Scenarios.**

| Scenario | Status |
|---|---|
| Approve | 200 |
| Reject without a comment | 422 |
| Assignee reviews own work | 403 |
| Two reviewers race | second gets 409 |

**Dependencies.** WF-04.

**Acceptance criteria.**
- WF-06-AC-1: A send-back restarts the clock at decision time.
- WF-06-AC-2: Concurrent decisions on one round result in exactly one decision recorded.
- WF-06-AC-3: The queue lists only submitted tasks the caller may review.

**Test scenarios.**
- Approve.
- Send back.
- Reject.
- Race.
- Self-review.
- Queue scope.

---

## WF-07 Reassign

**Description.** Move the task to another person with a reason. The clock restarts for the new assignee. [WO FR-6]

**Roles.** An overseer with `reassign_tasks`: Manager and CoS by default. Leads do **not** have it by default (D-29, decided; WO roles table).

**User actions (UI).** More menu "Reassign" `TaskDetailPage.tsx:81`; ReassignDialog `TaskDialogs.tsx:213`.

**Behaviour.** BR-63, BR-64:
- assignment record
- the reassigner becomes the giver
- acknowledgement and snooze cleared
- `clockStartedAt` = now
- the team follows the new assignee
- both people notified (new: mandatory `reassignment`)
- audit `task.reassigned`
- a blocked task returns to Open (BR-07)

**Data.** `tasks.assigneeId/assignedBy/teamId/clockStartedAt`, `assignments(fromId, toId, byId, at, reason)`.

**API.** `POST /api/tasks/:id/reassign` `{toId, reason}`. Adapt the existing `POST /tasks/:id/reassign` (`routes/tasks.ts:113-118`, `services/tasks.ts:214-248`).

**Validation.** [V-C `tasks.ts:352-355`]
- No `toId` → 422 `fields.toId = "Choose the new assignee."`
- Same person → 422 `fields.toId = "Choose someone other than the current assignee."`
- Out of scope → 422 `fields.toId = "That person is outside your assignment scope."`
- reason < 5 → 422 `fields.reason = "Give a reason for the reassignment."`

**Authorization.** `reassign` ∈ allowedActions (not closed, not draft).

**Scenarios.**

| Scenario | Status |
|---|---|
| Manager reassigns within the line | 200 |
| Lead reassigns | 403 (D-29: not in the lead default) |
| Completed task | 403 |

**Dependencies.** ESC-04 (re-routing), NTF-02.

**Acceptance criteria.**
- WF-07-AC-1: After reassignment, `clockStartedAt` = reassignment time, and the new assignee gets an assignment notification on every channel.
- WF-07-AC-2: A task 30 h past due stays at ≥ L2 after reassignment.
- WF-07-AC-3: On reassignment, active escalation events are cleared and the applicable levels re-fire to the new assignee's chain (D-30, decided; current server behaviour).
- WF-07-AC-4: The log row holds the before and after assignee and the reason.

**Test scenarios.**
- Reassign a silent Critical task.
- Reassign a past-due task.
- Reassign a blocked task.
- Out-of-scope target.
- Each validation message.

---

## WF-08 Cancel

**Description.** Close a task without completing it. (D-20 extra.)

**Roles.** The giver or an overseer with `assign_tasks`.

**User actions (UI).** More menu "Cancel task" `TaskDetailPage.tsx:83`; CancelDialog `TaskDialogs.tsx:243`; bulk TASK-07.

**Behaviour.**
- → `cancelled`, `cancelReason` set.
- Escalations resolve.
- The assignee is notified.
- Audited. [V-C `tasks.ts:372-383`]
- **[A]** Use a dedicated notification type `cancelled`. The mock uses the mandatory `reassignment` type (`tasks.ts:380`), which forces WhatsApp with the "new task" template.

**Data.** `tasks.status/cancelReason`.

**API.** `POST /api/tasks/:id/cancel` `{reason}`. New (the server has no cancel).

**Validation.** reason < 5 → 422 `fields.reason = "A cancellation reason is required."` [V-C `tasks.ts:376`]

**Authorization.** `cancel` ∈ allowedActions (not closed).

**Scenarios.** Valid → 200. Already closed → 403. Short reason → 422.

**Dependencies.** None.

**Acceptance criteria.**
- WF-08-AC-1: Cancelling resolves every active event, and the task can never be reopened.
- WF-08-AC-2: The cancel reason is visible in the activity log.

**Test scenarios.**
- Cancel an escalated task.
- Attempt to reopen it.
- Reason boundary.

---

## WF-09 Reopen

**Description.** Return a completed task to work with a new due date.

**Roles.** The giver or an overseer with `assign_tasks`.

**User actions (UI).** More menu "Reopen" `TaskDetailPage.tsx:82`; ReopenDialog `TaskDialogs.tsx:258`.

**Behaviour.**
- → `reopened`.
- `completedAt` cleared, `clockStartedAt` = now, acknowledgement cleared.
- The due date is set to the new date at 17:00 if it changed (logged `due_changed`).
- The assignee is notified.
- Escalation is re-evaluated (the mock omits this, BR-27). [V-C `tasks.ts:385-405`]

**Data.** `tasks`.

**API.** `POST /api/tasks/:id/reopen` `{reason, dueDate}`. Adapt `POST /tasks/:id/status` `{status:"open", note}` (`routes/tasks.ts:120-125`, `services/tasks.ts:251-275`).

**Validation.** [V-C `tasks.ts:391-392`]
- reason < 5 → 422 `fields.reason = "Explain why the task is being reopened."`
- Missing, invalid or past due date → 422 `fields.dueDate = "Set a new due date in the future."`

**Authorization.** `reopen` ∈ allowedActions (status `completed`).

**Scenarios.** Completed → 200. Cancelled → 403. Past date → 422.

**Dependencies.** ESC.

**Acceptance criteria.**
- WF-09-AC-1: After reopening, the task is in an active status with a fresh clock and a future due date.
- WF-09-AC-2: Escalation is evaluated in the same request.
- WF-09-AC-3: A cancelled task cannot be reopened.

**Test scenarios.**
- Reopen, then let it go silent.
- Reopen a cancelled task.
- Date boundary.

---

## WF-10 Allowed actions

**Description.** The server computes the action set per user and task. The UI only renders it.

**Roles.** All.

**User actions (UI).** `TaskDetailPage.tsx:32, 46-55, 76-85`; the row menu `shared.tsx:62` (it calls `allowedActions(getDb())` directly today).

**Behaviour.**
- Set = `allowedActions` [V-C `workflow.ts:45-73`], extended with `block` (WF-11) and `change_due` (EXT-04).
- Under D-8, permission checks use effective permissions.
- Returned on the detail view and on every list row. [A] List rows need it for the row menu.

**Data.** As inputs to `allowedActions`.

**API.** `actions: string[]` on `GET /api/tasks/:id` and on each list row (TASK-04). Adapt the server's `permissions` on the detail view (`services/access.ts:67-79`).

**Validation.** None.

**Authorization.** The same rules are enforced again on every action endpoint (C-2).

**Scenarios.** See the matrix in [USER_ROLES_AND_PERMISSIONS §5](../USER_ROLES_AND_PERMISSIONS.md#5-per-task-action-matrix).

**Dependencies.** ROLE-02.

**Acceptance criteria.**
- WF-10-AC-1: For each cell of the §5 matrix, the returned `actions` matches it.
- WF-10-AC-2: Calling an action endpoint for an action not in `actions` returns 403, even when the request is crafted by hand.
- WF-10-AC-3: Removing a permission from a role changes `actions` on the holder's next request.

**Test scenarios.**
- Matrix sweep (role × relationship × status).
- Crafted request.
- Permission change.

---

## WF-11 Mark Blocked

**Description.** The assignee marks the task Blocked with a reason. The team lead is alerted. [WO FR-2; AC-3; D-3]

**Roles.** The assignee.

**User actions (UI).** No UI yet. D-3 adds a "Mark blocked" action and dialog (reason) next to "Post update", a Blocked banner, and a Blocked status label.

**Behaviour.**
- → `blocked`; `blockedReason` stored.
- This counts as an assignee update: `clockStartedAt` = now [V-S `services/tasks.ts:143`].
- The lead route (L1 "to", BR-36) receives the `taskwatch_task_blocked` alert on every channel [V-S `services/tasks.ts:152-158`].
- Logged and audited.
- Unblock: the assignee posts progress or starts work (→ `in_progress`, reason cleared). Reassignment returns the task to Open (BR-07).
- While blocked, the clock and the past-due floor keep running (BR-04 [A]).
- Blocked lifts the task to at least L1: **resolved by WO** (ladder graphic, WO p.2: L1 = "Silent 1.5x, past due, or marked Blocked"); see D-24.
- Quiet hours: the in-app alert to the lead is sent at once; email and WhatsApp follow quiet hours like L1 (D-23, decided).

**Data.** `tasks.status`, `tasks.blockedReason`, a notification set.

**API.** `POST /api/tasks/:id/block` `{reason}`. Adapt `POST /tasks/:id/updates` with `status=blocked` (`routes/tasks.ts:75-97`). The rule `blockedAlertsLead` is in the rules config [V-S `domain.ts:43`].

**Validation.**
- reason trimmed length < 5 → 422 `fields.reason = "Say what is blocking the task (at least 5 characters)."` [A]. The server's message for an empty reason: `Marking a task Blocked requires a reason` [V-S `services/tasks.ts:113`].
- Sensitive-ID guard.

**Authorization.** `block` ∈ allowedActions: assignee, active status, not already blocked [A].

**Scenarios.**

| Scenario | Status |
|---|---|
| Assignee blocks | 200; lead alerted |
| Already blocked | 403 |
| Lead tries | 403 |
| No reason | 422 |

**Dependencies.** ESC-04 (lead lookup), NTF-02/03, TASK-09 (Blocked view).

**Acceptance criteria.**
- WF-11-AC-1 (AC-3): Marking Blocked creates the lead's in-app, email and WhatsApp alert rows, and they are sent within 5 minutes, during the lead's quiet hours only the in-app alert is immediate (D-23) for quiet hours.
- WF-11-AC-2: With no lead in the chain, the alert goes to the manager, or else to the Founder's Office.
- WF-11-AC-3: The reason appears in the log, on the task and in the Blocked view.
- WF-11-AC-4: A progress update on a blocked task returns it to In progress and clears the reason.

**Test scenarios.**
- Block during the day and at night (IST and PT leads).
- No-lead chain.
- Unblock by update.
- Reassign while blocked.
- Sensitive-ID in the reason.

---

## EXT-01 Request extension

**Description.** The assignee asks for a later due date. Kept by D-6.

**Roles.** The assignee on an active task with no pending request.

**User actions (UI).** More menu "Request extension" `TaskDetailPage.tsx:79`; ExtensionDialog `TaskDialogs.tsx:125`.

**Behaviour.**
- Creates a pending request (`currentDue`, `requestedDue`, reason, info).
- Logs `extension_requested` and audits `extension.requested`.
- Notifies the approvers: overseers with `approve_extensions` who are the giver or the requester's manager. [V-C `tasks.ts:306-323`]

**Data.** `extensions(id, taskId, requestedBy, at, currentDue, requestedDue, reason, info, status, decidedBy, decidedAt, decisionNote)`.

**API.** `POST /api/tasks/:id/extensions` `{requestedDate, requestedTime?, reason, info?}` → 201 `{extension}`. New.

**Validation.** [V-C `tasks.ts:312-315`]
- Missing or invalid date → 422 `fields.requestedDate = "Choose the new due date."`
- Not later than the current due → `The new date must be later than the current due date.`
- Not in the future → `The new date must be in the future.`
- reason < 10 → `fields.reason = "Explain why (at least 10 characters)."`

**Authorization.** `request_extension` ∈ allowedActions.

**Scenarios.** Valid → 201. A request already pending → 403. Short reason → 422.

**Dependencies.** EXT-02.

**Acceptance criteria.**
- EXT-01-AC-1: A second request while one is pending returns 403.
- EXT-01-AC-2: Requesting does not change `dueAt` or the level.
- EXT-01-AC-3: The approvers listed above are notified, and the requester is not.

**Test scenarios.**
- Valid request.
- Date and reason boundaries.
- Duplicate pending request.
- Approver set.

---

## EXT-02 Decide extension

**Description.** An overseer approves or rejects a pending request.

**Roles.** An overseer with `approve_extensions`, not the requester. The lead's limit is subject to D-27 (decided).

**User actions (UI).** "Decide extension" `TaskDetailPage.tsx:54`; DecideExtensionDialog `TaskDialogs.tsx:158`; Extensions queue `QueuePages.tsx:77`.

**Behaviour.**
- Sets status, decider and note.
- On approval: `dueAt` = `requestedDue`, logs `due_changed` (old → new).
- Notifies the requester.
- Audits `extension.approved` or `extension.rejected`.
- Escalation is re-evaluated, so a past-due floor that no longer applies resolves (BR-59). [V-C `tasks.ts:325-345`]

**Data.** `extensions`, `tasks.dueAt`.

**API.** `POST /api/extensions/:extId/decision` `{approve: bool, note}`. New.

**Validation.** [V-C `tasks.ts:328-333`]
- Unknown → 404 `Extension request not found.`
- Already decided → 409 `This request has already been decided.`
- Rejection with note < 5 → 422 `fields.note = "Give the assignee a reason."`

**Authorization.** `decide_extension` ∈ allowedActions. Own request → 403 `You cannot approve your own extension request.`

**Scenarios.** Approve → 200. Second decision → 409. Requester decides → 403.

**Dependencies.** EXT-01, ESC-02.

**Acceptance criteria.**
- EXT-02-AC-1: Approving a request on a task at the L1 past-due floor, with a future date, drops the level to the silence level in the same request.
- EXT-02-AC-2: The log row holds the old and new due dates.
- EXT-02-AC-3: Two concurrent decisions result in exactly one.

**Test scenarios.**
- Approve a past-due task.
- Reject with and without a note.
- Race.
- Self-decision.

---

## EXT-03 Extensions queue

**Description.** Lists extension requests on visible tasks, pending first.

**Roles.** Supervisors (the UI gate is `supervises`). The API returns rows for visible tasks.

**User actions (UI).** `features/work/QueuePages.tsx:77` (Pending, Decided, All).

**Behaviour.** Returns `[{ext, task, canDecide}]`, sorted pending first and then newest first. [V-C `services/api/admin.ts:314-326`]

**API.** `GET /api/extensions?status=pending|decided|all`. New.

**Validation.** Unknown status → 422 [A].

**Authorization.** C-1. Rows are limited to visible tasks.

**Scenarios.** A lead sees requests from their line only.

**Dependencies.** EXT-01/02.

**Acceptance criteria.**
- EXT-03-AC-1: No row refers to a task the caller cannot view.
- EXT-03-AC-2: `canDecide` is true exactly when EXT-02 would accept the caller's decision.

**Test scenarios.**
- Scope.
- `canDecide` parity.
- Ordering.

---

## EXT-04 Direct due-date change (FR-5) (new, from WO)

**Description.** An overseer moves the due date directly. A lead may do this **once** per task; a manager or the CoS any number of times. Old date, new date and reason are logged. [WO FR-5; D-6]

**Roles.** CoS; manager over the assignee or giver; lead over the assignee or giver while the lead flag is unused. [V-S `services/access.ts:37-44, 74`]

**User actions (UI).** No UI yet. D-6 adds a "Change due date" item to the More menu (`TaskDetailPage.tsx:76-85`) with a dialog (date, time, reason).

**Behaviour.**
- Requires a new due later than the current one (FR-5 says "extend").
- Logs `due_change` with before, after, reason and the actor's capacity (lead, manager or cos).
- Sets `leadExtensionUsed` when the actor acts as a lead.
- Notifies the assignee.
- Re-evaluates escalation. [V-S `services/tasks.ts:181-211`]
- A pending extension request is left pending [A].

**Data.** `tasks.dueAt`, `tasks.leadExtensionUsed`, `tasks.originalDueAt` [V-S `tasks.original_due_at`].

**API.** `POST /api/tasks/:id/due` `{dueDate, dueTime?, reason}`. Adapt the existing `POST /tasks/:id/due` `{dueLocal, reason}` (`routes/tasks.ts:106-111`).

**Validation.**
- Not later than the current due → 422 `fields.dueDate = "The new due date must be later than the current one"` [V-S `services/tasks.ts:190`, today a 400].
- Not in the future → 422 [A].
- reason empty → 422 `fields.reason = "Give a reason for the new due date"` [V-S `:182`].
- reason ≤ 1000 characters [V-S `routes/tasks.ts:108`].
- Sensitive-ID guard.

**Authorization.**
- `change_due` ∈ allowedActions.
- A lead's second attempt → 403 `A team lead can extend a task only once`.
- Others → 403 `You cannot change this due date`. [V-S `services/tasks.ts:187-189`]
- With multiple roles (D-8), a user holding both lead and manager acts as manager [V-S `access.ts:41-42` checks manager first].
- Whether approving an EXT-02 request also uses the lead's once: D-27 (decided).

**Scenarios.**

| Scenario | Status |
|---|---|
| Lead, first change | 200 |
| Lead, second change | 403 |
| Manager, repeat changes | 200 |
| Earlier date | 422 |
| Staff | 403 |

**Dependencies.** ESC-02, TASK-03 (an Edit due change uses the same authority, BR-56).

**Acceptance criteria.**
- EXT-04-AC-1: A lead's first change succeeds; their second returns 403 with the exact message.
- EXT-04-AC-2: A manager can change the same task's due date after the lead has used theirs.
- EXT-04-AC-3: Each change writes one log row with the old date, new date, reason and capacity.
- EXT-04-AC-4 (AC-2): Moving the due date beyond now clears the past-due floor in the same request.

**Test scenarios.**
- Lead once.
- Manager after lead.
- CoS on any task.
- Earlier date.
- Multi-role actor.
- Floor clears.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

- **D-3, D-6, D-20** (decided). The Blocked transitions are defined in [ADR-0003](../../03-architecture/decisions/ADR-0003.md); Done directly from Open or Blocked: decided by R-2 (allowed when no review is required).
- **D-13**: the file size on progress and submit.
- **D-23 (decided)**: a Blocked alert during quiet hours vs AC-3's 5 minutes.
- **D-24 resolved by WO**: the ladder graphic on WO p.2 lists "marked Blocked" under L1. The server does not implement this yet (gap).
- **D-25 (decided)**: the past-due floor while In review.
- **D-27 (decided)**: whether an approved extension uses up the lead's once.
- **D-29 (decided)**: whether leads may reassign by default.
- **D-30 (decided)**: which chain receives the escalations after a reassignment.
