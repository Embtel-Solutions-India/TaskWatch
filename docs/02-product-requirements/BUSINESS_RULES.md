# Business Rules

> **Authority:** the Work Order FO-2026-OPS-01 wins over the prototype. Decisions in [OPEN_QUESTIONS.md §7.1](../01-discovery/OPEN_QUESTIONS.md) are binding. Each rule carries one tag: **[WO]** work order · **[V-C]** client code (file:line) · **[V-S]** server code (file:line) · **[A]** assumption · **[OPEN D-n]** an undecided item.
>
> Client paths are relative to `client/src/`; server paths to `server/src/`. Terms are defined in [GLOSSARY.md](GLOSSARY.md). Role and permission rules are in [USER_ROLES_AND_PERMISSIONS.md](USER_ROLES_AND_PERMISSIONS.md), not repeated here. Feature-level behaviour is in [features/](features/). Rules marked **(D-2 (decided)x)** depend on a contradiction raised for the product owner and not yet in OPEN_QUESTIONS.

Contents: [1 State machine](#1-state-machine) · [2 Silence clock](#2-silence-clock-resets) · [3 Escalation ladder](#3-escalation-ladder) · [4 Routing](#4-routing) · [5 Acknowledgement](#5-acknowledgement) · [6 Quiet hours](#6-quiet-hours) · [7 Due dates](#7-due-dates) · [8 Reassignment](#8-reassignment) · [9 Review](#9-review) · [10 Recurrence](#10-recurrence) · [11 Retention](#11-retention-and-immutability) · [12 Sensitive IDs](#12-sensitive-ids) · [13 Time zones](#13-time-zones) · [14 Last-CoS protection](#14-last-cos-protection) · [15 Reporting loops](#15-reporting-loops)

---

## 1. State machine

**BR-01 Status set.** The statuses are `draft`, `assigned` (shown as **Open**), `in_progress`, `blocked`, `submitted` (shown as "In review"), `changes_requested`, `reopened`, `completed` (shown as **Done**) and `cancelled`. FR-2's four states are the core; the others are kept as optional extras. [WO FR-2] + D-20

**BR-02 Transitions.** Only the transitions below are allowed. Any other transition returns 409 with the message `A task that is "<from>" cannot move to "<to>".` [V-C `services/engine/workflow.ts:6-15, 21-25`]. The `blocked` rows are new. [A] They follow PRD WF-11 ("unblocking happens through progress or start"); the final set is **[D-20, decided]**.

| From | To |
|---|---|
| draft | assigned, cancelled |
| assigned | in_progress, **blocked**, cancelled |
| in_progress | submitted, completed, **blocked**, cancelled |
| **blocked** | in_progress, cancelled |
| submitted | completed, changes_requested, cancelled |
| changes_requested | in_progress, **blocked**, cancelled |
| reopened | in_progress, **blocked**, cancelled |
| completed | reopened |
| cancelled | none |

**BR-03 Closed is final except for reopen.** `completed` and `cancelled` are closed. A cancelled task cannot be reopened. Only a completed task can be reopened. [V-C `types/index.ts:38`, `workflow.ts:13-14`]

**BR-04 Clock-running statuses.** Escalation is evaluated only for the active statuses `assigned`, `in_progress`, `changes_requested` and `reopened`. When a task leaves them, all its open escalation events resolve. [V-C `types/index.ts:37`, `services/core.ts:146-151`]. **`blocked` is active** (the clock runs and the past-due floor holds). [A] This matches the server, whose engine evaluates every status except `done` [V-S `engine/engine.ts:40-42`]. **Decided (D-24, WO p.2):** a Blocked task sits at L1 or higher while blocked. The Blocked alert to the lead is that task's L1 notification, not a second one [A].

**BR-05 Blocked needs a reason.** Marking a task Blocked requires a reason. [WO FR-2] The reason must be at least 5 characters [A, PRD WF-11] and passes the sensitive-ID guard (BR-60). The server stores it as `blocked_reason` and clears it on unblock, close or reassign. [V-S `services/tasks.ts:113, 143-146, 236`]

**BR-06 Blocked alerts the lead.** Marking Blocked alerts the assignee's team lead (the L1 "to" route) on every channel, using the `taskwatch_task_blocked` template. [WO acceptance; V-S `services/tasks.ts:152-158`, `notify/messages.ts:95-105`] It must arrive within 5 minutes. [WO AC-3] The server holds this alert during quiet hours (`quietable: true`, `messages.ts:103`), which can break AC-3 at night. **Decided (D-23):** the in-app alert is sent at once; email and WhatsApp follow quiet hours like L1.

**BR-07 Reassigning a blocked task.** Reassignment returns a blocked task to Open and clears the reason. [V-S `services/tasks.ts:235-236`]

**BR-08 Submitted pauses silence.** While `submitted`, silence escalation pauses because the work is with the reviewer. [V-C `client/ASSUMPTIONS.md:10`] The client also resolves **past-due** events in this state (`services/core.ts:146-151`). That conflicts with the WO rule that past-due levels apply "until the task closes or its due date is extended". **Decided (D-25):** silence pauses while submitted; the past-due floor still applies.

**BR-09 Draft has no clock.** A draft has no assignment record, sends no notification and does not escalate. Publishing restarts the clock at publish time. [V-C `services/core.ts:124-125`, `services/api/tasks.ts:195-205`]

## 2. Silence clock resets

**BR-10 What resets the clock.** `clockStartedAt` is set to "now" by exactly these events:

| Event | Evidence |
|---|---|
| Task created (non-draft) or draft published | [V-C `core.ts:112`, `tasks.ts:202`] |
| Assignee posts a progress update (including one that marks Blocked or unblocks) | [WO FR-3]; [V-C `tasks.ts:240`]; [V-S `services/tasks.ts:143`] |
| Assignee submits for review | [V-C `tasks.ts:258`] |
| Reviewer requests changes or rejects | [V-C `tasks.ts:298`] |
| Reassignment, including an assignee change made through Edit | [WO FR-6]; [V-C `tasks.ts:363, 164`]; [V-S `services/tasks.ts:235`] |
| Reopen | [V-C `tasks.ts:396`]; [V-S `services/tasks.ts:271`] |

The send-back and reopen resets are done by a non-assignee. They do not contradict FR-3's "only an assignee update resets the silence clock", because in both cases the clock was not running before (the task was `submitted` or `completed`). [A]

**BR-11 What never resets the clock.** These never reset it: comments (by anyone, including the assignee) [WO FR-4; AC-4; V-C `tasks.ts:434`]; task acknowledgement [V-C `tasks.ts:212`]; escalation acknowledgement [WO FR-9; V-C `tasks.ts:417`]; Start work [V-C `tasks.ts:219-226`]; extension approval and direct due change [V-C `tasks.ts:337-341`; V-S `services/tasks.ts:200`]; edits other than an assignee change [V-C `tasks.ts:167-179`]; attachments added outside a progress update [V-C `tasks.ts:465-472`].

**BR-12 A reset starts a new cycle.** Silence levels drop back. Events that no longer apply resolve, and the task can climb again. [WO "an assignee update drops the task back down and it can climb again later"; V-C `core.ts:154-159`]

## 3. Escalation ladder

**BR-20 Silence thresholds.** Level k (k = 0..3) is reached when silent hours ≥ `window[priority] × multiples[k]`. [WO; V-C `engine/escalation.ts:25-40`; V-S `engine/levels.ts:25-38`] With the defaults:

| Priority | Window | L0 | L1 | L2 | L3 |
|---|---|---|---|---|---|
| Critical | 4 h | 4 h | 6 h | 8 h | 12 h |
| High | 24 h | 24 h | 36 h | 48 h | 72 h |
| Normal | 48 h | 48 h | 72 h | 96 h | 144 h |
| Low | 72 h | 72 h | 108 h | 144 h | 216 h |

[WO table; V-C `constants/index.ts:93-101`]

**BR-21 Past-due floor.** Once past due, a task is at least L1 at the due time, L2 at due + 24 h and L3 at due + 72 h, whatever updates are posted, until it closes or its due date moves. [WO; AC-2; V-C `engine/escalation.ts:39-42`] **Changed 2026-11-12 (ADR-0014, D-140, D-146):** L1 stays at the due time; L2 and L3 are fixed times stored on the task (due + the vertical policy's delay for its priority), set when it is assigned and re-set when its due time, priority, assignee, vertical or status (assigned, reopened) changes. A policy change moves them only through "Apply to open tasks". The shipped delays are +24 h/+72 h for every priority, so AC-2 holds until the D-152 values are entered. [`shared/policy.ts`, `services/tasks.ts` `stampMilestones`]

**BR-22 Highest rule wins.** The level is max(silence level, past-due level). The reason is `overdue` when the past-due level is at least the silence level, otherwise `silence`. [WO; V-C `engine/escalation.ts:44-45`] **ADR-0014 (2026-11-12):** the past-due level is read from the task's stored milestones (BR-21); silence and deadline are computed independently and still share one level and one delivery, so no level fires twice (D-145). Escalation rows also record `accountable` (`assignee`, or `reviewer` when the work was handed in on time and awaits review).

**BR-23 L0 is silence-only.** L0 applies only while the silence level is ≥ 0. L1–L3 apply whenever the task's level is at or above them. [V-C `engine/escalation.ts:72-74`; V-S `engine/levels.ts:71-73`]

**BR-24 Fire once per cycle.** Each applicable level creates exactly one event per (task, level, cycle). An event resolves when its level stops applying, and it can fire again in a later cycle. [WO "Each level fires once"; V-C `core.ts:160-162`; V-S `engine/engine.ts:96-119` with a unique active (task, level) index]

**BR-25 Event time.** An event is stamped with the moment the threshold was crossed, not the moment the tick noticed it. That moment is never earlier than the cycle start or the task's creation. [V-C `core.ts:163`] The server stamps the tick time instead (`engine.ts:123-124`); the difference is at most one tick interval. [V-S]

**BR-26 Engine cadence.** The engine runs on the server at least every 5 minutes, and each level must be reached within 5 minutes of its threshold. [WO FR-8; AC-1] The server runs every 60 s [V-S `jobs/scheduler.ts:69`, EXISTING_SYSTEM_ANALYSIS §3.5]. The client tick in `App.tsx:62-72` must not be the production engine. [PRD ESC-08]

**BR-27 Immediate re-evaluation.** Any mutation that can change escalation state re-evaluates the affected tasks in the same request. [PRD C-7; V-C `tasks.ts:182, 245, 262, 276, 302, 343, 368, 381`] **Gap:** the client's `reopenTask` does not call `processEscalations` (`tasks.ts:385-405`). The backend must. [A]

**BR-28 Repeat alerts.** The top active level re-alerts its "to" recipients once per window (`windowsHours[priority]`), unless the task is snoozed. [V-C `core.ts:190-204`] On the server the interval is `repeatAfterWindows × window`, where 0 disables repeats [V-S `domain.ts:40-41`, `engine/engine.ts:26-31`]. The default of 1 gives the same behaviour. Copied people do not get repeats. [V-C `core.ts:203`; V-S `engine.ts:165-168`]

**BR-29 Per-entity rules.** Windows, multiples, offsets, quiet hours, D7 and snooze can be overridden per entity. A task uses its entity's override, or else the default. Every change is logged with before and after values. [WO "per entity without code changes; every change is logged"; D-7; V-S `services/rules.ts:36-38, 68-83`] **Changed 2026-11-12 (ADR-0014, D-141, D-142, D-150):** a vertical stores only the fields it changed, from windows, multiples, deadline delays, reviewer deadline and extra recipients; every other value is inherited from the global policy field by field. Quiet hours, D7, snooze, repeats, blocked alerts and due-soon are organization-wide. The vertical's GM (`entities.head_id`) edits their own vertical; the CoS edits all. Each save bumps a version. See [ADMINISTRATION-FRD POL-04](features/ADMINISTRATION-FRD.md).

**BR-30 Rule validation.** Each window is between 1 and 720 h. Multiples are > 0 and strictly increasing. Past-due offsets are ≥ 0 and strictly increasing. The acknowledgement snooze is 1–72 h. [V-C `services/api/admin.ts:230-235`] Saving re-evaluates every open task. [V-C `admin.ts:246`] **ADR-0014:** deadline delays are whole minutes, L2 ≥ 5 min after due, L3 > L2, ≤ 30 days; the reviewer deadline is 5 min–7 days; at most 10 extra recipients per level. Saving no longer moves open tasks' L2/L3 times (D-146).

**BR-31 Due-soon and overdue notices.** A `due_soon` notice goes to the assignee `dueSoonHours` (default 24) before the due time. An `overdue` notice goes to the assignee and the giver at the due time. Each fires once per due date. [V-C `core.ts:205-213`, `constants/index.ts:98`] **Changed 2026-11-12 (ADR-0014, D-143, D-144):** `due_soon` is sent only when the task was assigned before that moment (long tasks). There is no separate `overdue` notice: L1 at the due time copies the assignee and the giver. New: a 10-minute pre-deadline warning to the assignee (not after submission, not when assigned inside the 10 minutes) and a start notice 10 minutes before a scheduled start. Both 10-minute values are system constants. See [ESCALATION-FRD ESC-07, ESC-10](features/ESCALATION-FRD.md).

## 4. Routing

**BR-35 Recipients by level.** [WO Notifications table; V-C `core.ts:60-73`; V-S `engine/routing.ts:53-82`]

| Level | To | Copied |
|---|---|---|
| L0 | assignee | none |
| L1 | assignee's team lead | assignee |
| L2 | assignee's manager | team lead, assignee |
| L3 | Founder's Office: every active CoS, plus the CEO if D7 | manager |

**BR-36 Missing role skips up.** "A team lead or manager with no one above them escalates straight to the next existing level." If the assignee's chain has no active lead, L1 goes to the manager; if there is no manager either, it goes to the Founder's Office. [WO; V-C `core.ts:62-68`; V-S `routing.ts:66-71`]

**BR-37 Role lookups follow the chain.** The lead is the nearest active ancestor holding `lead`, searched only below the first manager, CoS or CEO. The manager is the nearest active ancestor holding `manager`, searched only below the Founder's Office. Inactive people are skipped. [V-S `engine/routing.ts:6-27`] The client looks for the first active ancestor holding any of [lead, manager, cos] for L1 and [manager, cos] for L2 [V-C `core.ts:61-67`]. With multiple roles (D-8), "holding" means any of the user's roles. [A]

**BR-38 Founder's Office below L3.** When L1 or L2 falls through to the Founder's Office, the server alerts the CoS only, and the CEO only if there is no CoS [V-S `routing.ts:33-37`]. The client includes the CEO whenever D7 is on [V-C `core.ts:51-53, 67`]. **Decided (D-28):** a fall-through routes like L3, to every CoS plus the CEO when D7 is on.

**BR-39 No one is both to and cc.** People are de-duplicated, and anyone already in "to" is removed from "cc". [V-C `core.ts:70-71`; V-S `routing.ts:77-80`]

**BR-40 Inactive recipients get nothing.** Inactive users are skipped at notification time. [V-C `core.ts:37-38`; V-S `notify/notify.ts:30-31`]

**BR-41 Mandatory notification types.** `assignment`, `reassignment` and `escalation` are delivered on every channel whatever the user's preferences say. Other types follow per-user preferences. [WO "WhatsApp first, email always, in-app always"; V-C `services/channels.ts:80, 106-107`]

**BR-42 WhatsApp skip rule.** WhatsApp is sent only to an international-format number (`^\+[1-9]\d{7,14}$`) with the user's opt-in. Otherwise the delivery is logged as `skipped` with the reason, and email and in-app still go. [V-C `channels.ts:125`, `services/api/admin.ts:97-98`; V-S `notify/notify.ts:40-42`]

## 5. Acknowledgement

**BR-45 Task acknowledgement.** Only the assignee (with `update_assigned_tasks`) can acknowledge, only on an active task that is not yet acknowledged. It sets `acknowledgedAt` and snoozes repeats for `ackSnoozeHours`. It never changes the level or the clock. It is cleared by reassignment and reopen. [V-C `workflow.ts:56`, `tasks.ts:207-217, 361, 397`] Start work and a first progress update acknowledge implicitly. [V-C `tasks.ts:224, 242`]

**BR-46 Escalation acknowledgement, who.** "The person an escalation reached" acknowledges it. [WO FR-9] The server allows "to" recipients and the CoS [V-S `services/tasks.ts:287-291`]. The client allows "to" recipients and any overseer [V-C `workflow.ts:70-71`]. PROJECT_OVERVIEW §1.6 assumes "to" and cc [A]. **Decided (R-1, 2026-11-04):** "to" recipients of that level plus any CoS; cc'd people, including the assignee, may not (this replaces D-26). Scope is that level only.

**BR-47 Escalation acknowledgement, note.** A note is required. [WO FR-9] It must not be empty and is limited to 1000 characters [V-S `routes/tasks.ts:147`, `services/tasks.ts:279`], and it passes the sensitive-ID guard [V-S `services/tasks.ts:280`]. The client takes no note (PRD ESC-06 gap); see ESC-06a.

**BR-48 Escalation acknowledgement, effect.** It stops repeat alerts at that level for 12 h (`ackSnoozeHours`). It does not reset the clock or change the level. It is logged with the note and the snooze end. [WO FR-9; V-S `services/tasks.ts:292-305`] Scope differs: the server acknowledges one event (one level) [V-S `services/tasks.ts:282-298`], while the client acknowledges every active event on the task [V-C `tasks.ts:411-416`]. **(D-26 (decided))**

**BR-49 Acknowledgement notifies.** On escalation acknowledgement the assignee and the giver are notified (`escalation_ack`), except the acknowledger. [V-C `tasks.ts:421`]

**BR-50 A later climb is not snoozed.** A new level that fires after an acknowledgement alerts its recipients normally; the snooze applies only to repeats. [V-C `core.ts:160-189` (firing ignores `snoozeUntil`); V-S `engine/engine.ts:116-160`]

## 6. Quiet hours

**BR-52 Window.** Quiet hours run 21:00–08:00 in the **recipient's** time zone and can be switched off. [WO, WO-D4; V-C `constants/index.ts:99`] If start equals end, there are no quiet hours. [V-C `engine/escalation.ts:89`]

**BR-53 What is held.** L0 and L1 email and WhatsApp deliveries are held, including copies and repeats. [WO; V-C `services/channels.ts:101-102`; V-S `notify/messages.ts:79, 91`] L2 and L3 always go out. [WO] In-app is never held. [V-C `channels.ts:100`; V-S `notify/notify.ts:44`] Blocked alerts: see BR-06 and D-23 (decided). **Changed 2026-11-12 (D-147):** a Critical task's L1 (and its repeats) is never held.

**BR-54 Release.** A held delivery is released when quiet hours end in the recipient's zone. [V-C `channels.ts:58-64`, `core.ts:255`; V-S `engine/levels.ts:91-97`, `notify/notify.ts:36`]

## 7. Due dates

**BR-55 At creation.** A due date is required. The due time defaults to 17:00. The due moment must be in the future. If a start date is given, it must be on or before the due date. [V-C `tasks.ts:87-91`] The server also requires a future due date [V-S `services/tasks.ts:69`]. Which zone the entered time is read in is **[D-5, decided]** (BR-89).

**BR-56 On edit.** A past due date is accepted only if it is unchanged. [V-C `tasks.ts:90`] A due change made through Edit is logged as `due_changed` and audited [V-C `tasks.ts:157-160`]. Under D-6 it must follow the FR-5 authority in BR-57. [A]

**BR-57 Direct change (FR-5).** A lead may extend the due date **once per task**, and a manager or the CoS may extend it any number of times. The reason is required. Old date, new date, reason and the actor's capacity are logged. [WO FR-5; D-6; V-S `services/tasks.ts:181-211`, `services/access.ts:74`] The new date must be later than the current one. [V-S `services/tasks.ts:190`] **Decided (D-27):** a lead approving an extension request uses up their single FR-5 change.

**BR-58 Extension request.** Only the assignee may request, on an active task, with no other request pending. The requested moment must be later than the current due date and in the future. The reason must be at least 10 characters. [V-C `workflow.ts:62`, `tasks.ts:310-316`] It is decided by an overseer with `approve_extensions` who is not the requester. A rejection needs a note of at least 5 characters. An approval replaces `dueAt`. [V-C `tasks.ts:325-344`]

**BR-59 Due change re-evaluates.** Any due change re-evaluates escalation, so a past-due floor that no longer applies resolves. [WO "until … its due date is extended"; V-C `tasks.ts:343`; V-S `services/tasks.ts:209`] Reopen requires a new due date in the future, set at 17:00. [V-C `tasks.ts:389-392`]

## 8. Reassignment

**BR-62 Who and to whom.** An overseer with `reassign_tasks`, on a task that is not closed and not a draft. The new assignee must differ from the current one and be in the actor's assignable set. The reason must be at least 5 characters. [V-C `workflow.ts:64`, `tasks.ts:351-356`] WO "Can do" lists reassign for Manager and CoS only; see USER_ROLES_AND_PERMISSIONS §5 and **Decided (D-29):** leads do not get `reassign_tasks` by default.

**BR-63 Effects.** An assignment record (from, to, by, reason) is created. The reassigner becomes the giver. The acknowledgement and snooze are cleared. The clock restarts. The team follows the new assignee. Both people are notified (the new assignee through the mandatory `reassignment` type). The change is audited. [WO FR-6; V-C `tasks.ts:357-368`, `core.ts:129-135`]

**BR-64 Escalations on reassignment.** Past-due levels still apply after reassignment. [V-C `tasks.ts:363` comment] The server clears every active event and re-fires the applicable levels against the new assignee's chain [V-S `services/tasks.ts:241-246`]. The client keeps existing events, so the old chain stays the recipients [V-C `core.ts:154-162`]. **Decided (D-30):** clear and re-fire to the new assignee's chain. **Added 2026-11-12 (D-148):** reassigning a task that is past due or due within 10 minutes needs a new due time, or 422 `dueDate` "This task is past due or due within 10 minutes: set a new due time for the new assignee." The new due time is logged as a `due_change` with the reassignment, and the milestones are re-stamped.

## 9. Review

**BR-66 Review is optional per task.** `reviewRequired` is set at creation or edit. When it is set, the assignee cannot complete the task directly (409 `This task requires review approval before it can be completed.`). [V-C `workflow.ts:59-60`, `tasks.ts:270`] This is a prototype extra kept by D-20.

**BR-67 Submit.** Only from `in_progress`, with a note of at least 5 characters. Each submission opens round n+1. The reviewer and giver are notified, except the submitter. [V-C `tasks.ts:249-263`]

**BR-68 Decide.** An overseer (not the assignee) with `review_tasks`. A send-back needs a comment of at least 5 characters. A pending round must exist, otherwise 409. Approved leads to `completed` with progress 100. Changes requested or rejected leads to `changes_requested` and a clock restart. [V-C `tasks.ts:280-303`]

## 10. Recurrence

**BR-70 Frequencies.** Daily, weekly and monthly [WO FR-7], plus every-N-days, which is a prototype extra [V-C `types/index.ts:297`]. The interval is 1–365. Weekly needs at least one weekday. Monthly uses the start date's day, clamped to the last day of a shorter month. [V-C `engine/recurrence.ts:20-35`, `services/api/admin.ts:351-357`]

**BR-71 One task per occurrence.** At most one task is generated per (schedule, occurrence day). Each is titled `<title> — <day>`, due at `dueHour` on that day, and created as if by the schedule's owner. [V-C `services/core.ts:219-250`]

**BR-72 Day and zone.** The client computes days in UTC and back-fills every missed day from max(start, created) [V-C `engine/recurrence.ts:3-6`, `core.ts:224-225`]. The server computes the next run in the assignee's zone and does not back-fill [V-S `services/recurring.ts:22-25`]. **[D-5, decided]**

**BR-73 Who manages schedules.** The owner or the CoS may edit, pause, resume or delete a schedule. Deleting it keeps the tasks already generated. [V-C `admin.ts:370, 386, 397-399`] The client's delete removes the schedule record (`admin.ts:398`). Under D-12 it must be a soft delete (archived). **Decided (D-31):** schedules and attachment records are soft-deleted, with the original kept in the log.

## 11. Retention and immutability

**BR-75 UTC server time.** Every stored instant is UTC and set by the server. Client devices never supply timestamps. [WO "Server time only"; C-4]

**BR-76 Append-only logs.** Every assignment, update, comment, state change, due change, reassignment, escalation and acknowledgement is a new log row with server time, actor and before/after values. No endpoint updates or deletes a log row. [WO; AC-7; V-S `activity_log` triggers, EXISTING_SYSTEM_ANALYSIS §3.2]

**BR-77 Hash chain.** Each row stores the hash of the previous row for that task (`sha256(prevHash + "\n" + canonical row)`). A nightly job verifies every chain and alerts the CoS on a break. [WO; V-S `services/activity.ts:56, 105-140`, `jobs/scheduler.ts:39-47`]

**BR-78 Seven-year retention.** Closed tasks and their logs are kept 7 years. `retentionYears` is fixed at 7 and cannot be edited. [WO; V-C `services/api/admin.ts:263`]

**BR-79 No hard deletes.** People are archived, never deleted. [WO] Comment "delete" is a soft delete that keeps the original in the log; comment edits keep the previous text in the log. [D-12] Attachment removal hides the file but keeps the stored file and its hash (PRD ATT-03 [A]). The client hard-removes the attachment record (`tasks.ts:481`); that must not be carried into the backend. [D-12]

## 12. Sensitive IDs

**BR-80 Guard.** Free text is rejected with 422 when it contains an A-number, SSN, USCIS receipt number, passport number or I-94 number. The message is: `This looks like it contains <kind>. Remove ID numbers from task text and link the case in ImmigrationCRM instead.` [WO "Client data"; D-11; V-S `services/sensitive.ts:4-11`, `services/tasks.ts:26-34`]

**BR-81 Where the guard applies.** Task title and instructions, progress updates (including Blocked reasons), comments, and every reason or note (due change, reassign, status, acknowledgement). [V-S `services/tasks.ts:67, 114, 167, 183, 216, 253, 280`] It must also cover description, extension reasons, review notes, cancel and reopen reasons, and recurrence titles, which exist only in the client model. [A] Filenames and people fields are not covered today (S-12).

## 13. Time zones

**BR-85 Display zone.** Screens show the viewer's zone. [WO; AC-9]

**BR-86 Home zone per user.** Each user has a home time zone, a valid IANA zone. [WO; V-C `types/index.ts:57`]

**BR-87 Recipient's zone.** Quiet hours and the due time in WhatsApp templates use the recipient's zone. [V-C `services/channels.ts:51-55, 102`]

**BR-88 Fixed zones.** The weekly digest is Monday 09:00 IST [WO FR-12; D-14; V-S `services/digest.ts:84, 108`]. The nightly chain check runs at 02:00 `NIGHTLY_TZ` [V-S `jobs/scheduler.ts:40-42`].

**BR-89 Due-time entry.** The server reads the entered wall-clock time in the actor's zone (`parseLocalDue`) [V-S `services/tasks.ts:20-24`]. The client uses the browser's zone [V-C `tasks.ts:88`]. **[D-5, decided]**

## 14. Last-CoS protection

**BR-92 One active CoS.** The organisation must always keep at least one active user holding the CoS role. Removing the role from, or deactivating, the last one returns 409 `The organization must keep at least one active Chief of Staff.` [V-C `services/api/admin.ts:130, 147`] The server lacks this check (S-9) and must add it. With multiple roles (D-8), the count is of active users holding `cos` among their roles. [A]

**BR-93 No self-demotion or self-deactivation.** You cannot change your own role (403 `You cannot change your own role.`) or deactivate your own account (403 `You cannot deactivate your own account.`). [V-C `admin.ts:129, 146`]

**BR-94 CoS permissions are locked.** The CoS role always holds all 15 permissions. Editing it returns 403 `Chief of Staff always has full platform authority and cannot be edited.` [V-C `permissions.ts:17`, `admin.ts:210`]

## 15. Reporting loops

**BR-96 No loops.** A manager assignment that makes someone report to themselves, directly or transitively, is rejected. On the staff form it is a 422 field error `That would create a reporting loop.`; on the org move it is 409 `<name> cannot report to someone in their own reporting line.` [V-C `permissions.ts:57-61`, `admin.ts:103, 180`] The server rejects it today with 400 [V-S `routes/people.ts:74-75`]; it must become 422 per C-3.

**BR-97 Walks are loop-safe.** Ancestor walks stop when they meet a person already visited, so a corrupt tree cannot hang routing or scope checks. [V-C `permissions.ts:42-54`]

**BR-98 Org changes re-route.** Changing a manager or team re-evaluates escalation for the affected tasks, so new events route along the new tree. [PRD C-7, ORG-02]

## ADR-0015 rules (2026-11-13)
- **BR-ATT-1:** only a vertical's GM marks its members' attendance; the CoS marks the Founder's Office. GMs, the CoS and the CEO have none. Today and past days only (D-156, D-161, D-163).
- **BR-ATT-2:** an unmarked day displays as absent and never changes escalation (D-157).
- **BR-ATT-3:** while marked away, non-Critical silence pauses. Critical silence and every deadline continue. A mark counts only from when it is saved (D-158, D-164).
- **BR-WT-1:** non-Critical silence and L2/L3 deadline steps count the vertical's working time; Critical counts clock time (D-160).
- **BR-WT-2:** a vertical's working-time change reaches open tasks' deadlines only through "Apply to open tasks" (D-165).
- **BR-GM-1:** a GM manages people and departments of their own vertical only, with roles staff/lead/manager. CoS and CEO roles, the GM post and vertical lifecycle stay with the CoS (D-162).
