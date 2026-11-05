# Glossary

> Terms used across the TaskWatch docs, in the meanings this project gives them. Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md). The rules behind these terms are in [BUSINESS_RULES.md](BUSINESS_RULES.md); role and permission terms are expanded in [USER_ROLES_AND_PERMISSIONS.md](USER_ROLES_AND_PERMISSIONS.md).
>
> Client paths are relative to `client/src/`; server paths to `server/src/`.

## Organisation and people

| Term | Meaning | Source |
|---|---|---|
| **Entity** | One of the six group companies a task belongs to: BAIS, USAIS, International Evaluations, Embtel, Bay Area Accounting Solutions, Founder's Office. It is the client's "Department", relabelled (D-4). A task's entity comes from its team, or else from its assignee. Escalation policy can be overridden per entity (D-7). | [WO] FR-1, FR-11; D-4, D-7; [V-S] `entities` table, `services/rules.ts:36-38` |
| **Team** | A group of people under an entity, with an optional lead (`Team.leadId`). A task's `teamId` defaults to the assignee's team. | [V-C] `types/index.ts:66-71`, `services/api/tasks.ts:130` |
| **Reporting line** | The manager chain set on each user (`managerId`). It drives both visibility and escalation routing. | [WO] "Users, roles and visibility"; [V-C] `services/authz/permissions.ts:26-54` |
| **Reports (of a user)** | Everyone below that user in the reporting tree, transitively. | [V-C] `permissions.ts:26-39` (`reportsOf`) |
| **Ancestors / chain** | The managers above a user, nearest first. The walk stops if it meets a loop. | [V-C] `permissions.ts:42-54` |
| **Reporting loop** | A manager assignment that would make someone report, directly or indirectly, to themselves. It is always rejected. | [V-C] `permissions.ts:57-61`; [V-S] `routes/people.ts:71-76` |
| **Founder's Office (FO)** | For **visibility**: anyone holding the CEO or CoS role; they see every task. For **L3 routing**: every active CoS, plus the CEO when D7 is on. | [WO]; [V-S] `services/directory.ts:90`, `engine/routing.ts:33-37`; [V-C] `services/core.ts:51-53` |
| **D7 (`l3NotifyCeo`)** | Work-order decision: whether L3 alerts also go to the CEO directly. Default on. Not to be confused with this project's D-numbers. | [WO] D7; [V-C] `constants/index.ts:93-101` |
| **Home time zone** | Each user's IANA zone (`timezone`), e.g. IST for India staff, PT for US staff. Used for display, quiet hours and (pending D-5) due-time entry. | [WO] "Time zones"; [V-C] `types/index.ts:57` |
| **Archived user** | An inactive user (`status: 'inactive'`). People are never deleted. An archived user cannot sign in and gets no alerts. | [WO] Retention; [V-C] `services/core.ts:38` |

## Roles, scope and relationships

| Term | Meaning | Source |
|---|---|---|
| **Role** | One of `ceo`, `cos`, `manager`, `lead`, `staff`. A user may hold several (D-8). | [V-C] `types/index.ts:1`; [V-S] `users.roles text[]` |
| **Permission** | One of the 15 capabilities in the configurable role × permission matrix. | [V-C] `types/index.ts:4-20` |
| **Effective permissions** | The union of the permissions of every role a user holds. Holding `cos` grants all 15. | D-8; [V-C] `permissions.ts:15-19` |
| **Scope** | The set of people and tasks a capability applies to. It is derived from the reporting line, not from the role. | [V-C] `client/ASSUMPTIONS.md:8`, `permissions.ts:64-69` |
| **Assignee** | The person who owes the work (`assigneeId`). Only the assignee's own updates reset the silence clock. | [WO] FR-3; [V-C] `types/index.ts:81` |
| **Giver (task giver)** | The person who created or last assigned the task (`createdBy` / `assignedBy`). The CoS counts as giver on every task. Reassignment makes the reassigner the new giver. | [V-C] `engine/workflow.ts:51`, `services/api/tasks.ts:360` |
| **Reviewer** | The person who reviews submissions (`reviewerId`); it defaults to the creator. | [V-C] `services/core.ts:106` |
| **Overseer** | A person with authority over a task: the CoS, its creator, its assigner, its reviewer, or anyone with `view_tasks` who has the assignee in their reports. For actions, an overseer is never the assignee. | [V-C] `permissions.ts:72-77`, `workflow.ts:50` |
| **Allowed actions** | The per-user, per-task action set the server computes and returns. The UI shows only those buttons. | [V-C] `workflow.ts:45-73`; PRD WF-10 |
| **Assignable set** | The people a user may assign work to. For a CoS that is every active user except themselves; for anyone else with `assign_tasks`, their active transitive reports. | [V-C] `permissions.ts:89-95` |

## Task lifecycle

| Term | Meaning | Source |
|---|---|---|
| **Open** | The WO label for status `assigned`. | D-20 |
| **Done** | The WO label for status `completed`. | D-20 |
| **Blocked** | The status the assignee sets, with a required reason, when work cannot proceed. It alerts the team lead. | [WO] FR-2; D-3; PRD WF-11 |
| **Active statuses** | The statuses in which the assignee owes work and the escalation clock runs: `assigned`, `in_progress`, `changes_requested`, `reopened`, plus `blocked` once it is added ([A], see BR-04). | [V-C] `types/index.ts:37` |
| **Closed statuses** | `completed` and `cancelled`. | [V-C] `types/index.ts:38` |
| **Draft** | A task that has been saved but not assigned: no notification, no clock. | [V-C] `services/core.ts:102`; PRD TASK-02 |
| **Review round** | One submission and its decision. Rounds are numbered 1..n per task. | [V-C] `services/api/tasks.ts:255` |
| **Task acknowledgement** | The assignee confirming receipt (`acknowledgedAt`). It snoozes repeat alerts and never resets the clock. Not the same as escalation acknowledgement. | [V-C] `services/api/tasks.ts:207-217` |
| **Extension request** | The assignee asking for a later due date. An overseer approves or rejects it. | PRD EXT-01/02 |
| **Direct due change** | FR-5: a lead (once per task), a manager or the CoS moves the due date without a request. Old date, new date and reason are logged. | [WO] FR-5; D-6; [V-S] `services/tasks.ts:181-211` |
| **Lead extension used** | A per-task flag recording that a lead has spent their single FR-5 change. | [V-S] `services/tasks.ts:200-204` |
| **Reassignment** | Moving a task to a different assignee, with a reason. The clock restarts for the new assignee. | [WO] FR-6 |
| **Recurrence / schedule** | A rule that generates one task per occurrence day (daily, weekly, monthly; the client adds every-N-days). | [WO] FR-7; [V-C] `engine/recurrence.ts` |

## Escalation

| Term | Meaning | Source |
|---|---|---|
| **Window (update window)** | The longest an assignee may stay silent for a priority: Critical 4 h, High 24 h, Normal 48 h, Low 72 h. | [WO] escalation table, D2; [V-C] `constants/index.ts:94` |
| **Multiple** | The factor applied to the window for each level: L0 1×, L1 1.5×, L2 2×, L3 3×. | [WO] D3; [V-C] `constants/index.ts:95` |
| **Threshold** | window × multiple: the number of silent hours at which a level is reached. | [V-C] `engine/escalation.ts:25-28` |
| **Silence clock** | The time since `clockStartedAt`, which is the last clock-resetting event (see BR-10). | [V-C] `types/index.ts:90-91` |
| **Silent hours** | now − `clockStartedAt`, in hours. | [V-C] `engine/escalation.ts:31, 64` |
| **Level** | −1 means on track; 0..3 are L0..L3. A task sits at the highest level any rule gives it. | [WO]; [V-C] `engine/escalation.ts:12-13, 45` |
| **L0 Reminder** | A silence-only reminder to the assignee. | [WO]; [V-C] `engine/escalation.ts:72-74` |
| **L1 Team lead / L2 Manager / L3 Founder's Office** | The escalation rungs, named after who they reach. | [WO]; [V-C] `constants/index.ts:30` |
| **Past-due floor** | The minimum level a past-due task holds, whatever updates are posted: L1 at the due time, L2 at due + 24 h, L3 at due + 72 h (`overdueOffsetsHours` = 0/24/72). | [WO]; [V-C] `constants/index.ts:96` |
| **Escalation event** | One record per (task, level, cycle), with to-recipients, cc-recipients and a status of active, acknowledged or resolved. | [V-C] `types/index.ts:206-223` |
| **Cycle** | The silence period an event belongs to, keyed by the `clockStartedAt` in force when it fired. Each level fires once per cycle; a clock reset starts a new cycle. | [V-C] `types/index.ts:213-214`, `services/core.ts:173` |
| **Resolved (event)** | An event whose level no longer applies, or whose task left the active statuses. | [V-C] `services/core.ts:146-159` |
| **Recipient (to) / copied (cc)** | "to" is the person the level is addressed to. "cc" is the person copied: L1 copies the assignee, L2 copies the lead and the assignee, L3 copies the manager. | [WO] Notifications table; [V-C] `services/core.ts:60-73` |
| **Repeat alert** | A re-notification of the top active level to its "to" recipients, once every window, until snoozed or resolved. | [V-C] `services/core.ts:190-204`; [V-S] `engine/engine.ts:26-31, 162-177` |
| **Escalation acknowledgement** | A recipient confirming they have seen an escalation, with a note (FR-9). It pauses repeats for 12 h and changes neither the level nor the clock. | [WO] FR-9; PRD ESC-06, ESC-06a |
| **Snooze (`snoozeUntil`)** | The time until which repeat alerts are suppressed after an acknowledgement (`ackSnoozeHours`, default 12). | [V-C] `types/index.ts:93-94`, `constants/index.ts:97` |
| **Next level** | The earliest future time the task will climb if nothing changes, from either rule. | [V-C] `engine/escalation.ts:53-57` |
| **Stage / stage stripe** | The colour band shown on a task row: **on track** (level −1), **amber** (L0–L1), **red** (L2–L3). Closed tasks have no stage. | [WO] FR-10, FR-11; [V-S] `domain.ts:57-64` |
| **Escalated to me** | An open task with an unresolved event at L1 or above on which I am a "to" recipient. | [V-S] `services/queries.ts:78-81` |
| **Engine tick** | One run of the escalation evaluation over all open tasks. It must run on the server at least every 5 minutes. | [WO] FR-8; [V-S] `jobs/scheduler.ts` (60 s) |

## Notifications

| Term | Meaning | Source |
|---|---|---|
| **Channel** | in-app, email or WhatsApp. "WhatsApp first, email always, in-app always." | [WO] Notifications |
| **Mandatory types** | `assignment`, `reassignment`, `escalation`. They are delivered whatever the user's preferences say. | [V-C] `services/channels.ts:80` |
| **Quiet hours** | 21:00–08:00 in the recipient's zone. L0/L1 email and WhatsApp are held during them; L2/L3 and in-app never are. | [WO] Notifications, D4; [V-C] `services/channels.ts:100-102` |
| **Held delivery** | A delivery with status `held` and a `heldUntil` / `send_after` at the end of quiet hours, released then. | [V-C] `services/channels.ts:116-119`; [V-S] `notify/notify.ts:35-37` |
| **Skipped delivery** | A WhatsApp delivery not attempted because the user has no number or has not opted in. It is logged with the reason. | [V-C] `services/channels.ts:125`; [V-S] `notify/notify.ts:40-41` |
| **Simulated delivery** | A delivery rendered and logged but not sent, because credentials are missing. | PRD NTF-06 |
| **Approved template** | One of the 5 Meta-approved WhatsApp templates (`taskwatch_task_assigned`, `_update_reminder`, `_escalation`, `_task_blocked`, `_system_alert`). | [V-C] `services/channels.ts:9-40`; `docs/whatsapp-templates.md` |
| **Weekly digest** | The Monday 09:00 IST email to each manager and to the Founder's Office: red items, repeat offenders, on-time trend. | [WO] FR-12; D-14 |

## Reporting

| Term | Meaning | Source |
|---|---|---|
| **First response** | The time from assignment to the assignee's first update on that assignment. Averaged per person. | [WO] FR-11; [V-S] `services/reports.ts:91-92` |
| **Longest silence** | Per entity, the open task with the largest silent hours. | [WO] FR-11; [V-S] `services/reports.ts:81-82` |
| **On-time %** | The share of tasks completed at or before their due time. | [WO] FR-11; [V-S] `services/reports.ts:95` |
| **Repeat offender** | A person who appears repeatedly in escalations in the digest week. The exact threshold is not specified. **[A]** | [WO] FR-12 |

## Audit and data

| Term | Meaning | Source |
|---|---|---|
| **Activity log** | The per-task, append-only record of every assignment, update, comment, state change, due change, reassignment, escalation and acknowledgement. | [WO] "Data, security and audit trail" |
| **Audit log (admin log)** | The organisation-level, append-only record of admin changes (roles, policy, settings, staff). | [V-C] `types/index.ts:283-295`; [V-S] `admin_log` |
| **Hash chain** | Each activity row stores the hash of the previous row for that task. A nightly job verifies the chain and alerts the CoS on a break. | [WO]; [V-S] `services/activity.ts:56, 105-140` |
| **Soft delete** | Hiding a record (for example blanking a comment body) while keeping the original in the append-only log. Hard deletes are not allowed. | D-12 |
| **Sensitive ID** | A-number, SSN, USCIS receipt, passport or I-94 number. Free text containing one is rejected. | [WO] "Client data"; [V-S] `services/sensitive.ts:4-11` |
| **Retention** | Closed tasks and their logs are kept 7 years (`retentionYears` is fixed at 7). | [WO]; [V-C] `services/api/admin.ts:263` |

## Document conventions

| Term | Meaning |
|---|---|
| **WO** | Work Order FO-2026-OPS-01. It wins over the prototype. |
| **Prototype / mock API** | The React client in `client/` running on a localStorage store. `services/api/*` is the executable spec of the rules. |
| **D-n** | A decision or open question in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md). **WO-D1…WO-D7** are the work order's own decisions. |
| **BR-n** | A business rule in [BUSINESS_RULES.md](BUSINESS_RULES.md). |
| **C-n** | A common rule in [PRODUCT_REQUIREMENTS.md §2](PRODUCT_REQUIREMENTS.md#2-functional-requirements). |
| **AC-n** | A work-order acceptance criterion ([PROJECT_OVERVIEW §1.7](../01-discovery/PROJECT_OVERVIEW.md)). `<FEATURE>-AC-n` are the feature-level criteria in [features/](features/). |
