# FRD: Escalation Engine (ESC)

> **2026-11-12: superseded in part by [ADR-0014](../../03-architecture/decisions/ADR-0014.md)** (built, uncommitted). The past-due offsets are now per-priority, per-vertical L2/L3 delays stored on each task as fixed times (ESC-02); a 10-minute warning and a start notice were added (ESC-07, ESC-10); the separate overdue notice is folded into L1, which copies the giver (ESC-04); a reviewer deadline R1/R2 was added (ESC-11); a Critical L1 is not held at night (D-147). Where this FRD and ADR-0014 differ, ADR-0014 wins.

> Module index: [PRODUCT_REQUIREMENTS §2.6](../PRODUCT_REQUIREMENTS.md#26-escalation-engine-esc). The rules themselves are authoritative in [BUSINESS_RULES §2–6](../BUSINESS_RULES.md#2-silence-clock-resets) and are referenced here, not repeated. Tags: **[WO]** · **[V-C]** `client/src/…` · **[V-S]** `server/src/…` · **[A]** · **[OPEN D-n]**. All endpoints are **PROPOSED**. C-1..C-7 apply.
>
> **Reference implementations.**
> - Client: `services/engine/escalation.ts` (ladder math), `services/core.ts:60-216` (routing, firing, repeats, notices).
> - Server: `engine/levels.ts`, `engine/routing.ts`, `engine/engine.ts`.
>
> The two are ports of each other. D-9 (one shared module) is **open**. The server engine is kept (D-1).
>
> WO acceptance criteria covered here: **AC-1, AC-2, AC-5** (with NTF), **AC-7** (log rows).

Features: ESC-01 … ESC-09 · **ESC-06a (new, from WO)** · **ESC-10, ESC-11 (new, ADR-0014)**

**Built 2026-11-05 (T-5.1…T-5.3, Phase 5 Batch A).**
- One ladder: `shared/levels.ts` `computeLevel` takes `blocked` (D-24: at least L1, reason `blocked`) and `silencePaused` (D-25: In review keeps only the past-due floor). The server reads a task row through `engine/levels.ts` `taskLevel`, used by both the engine and every TaskView; the engine evaluates `LADDER_STATUSES` (active + `submitted`).
- Events record `reached_at` (the crossing time, never later than now; BR-25) and `cycle_started_at`. Reason is `silence`, `overdue` or `blocked` (migration 011). A Blocked L1 is not notified a second time: the block action already alerted the lead with the reason (WF-11, `blockedAlertsLead`); its repeats follow ESC-05.
- Routing: a fall-through below L3 is routed like L3 (D-28).
- Repeats are stamped on the whole-window boundary, so the cadence does not drift with engine timing.
- **Batch B (T-5.4…T-5.9):** due-soon/overdue notices are in-app, one per task and due date (`job_runs`); `ENGINE_INTERVAL_MS` must be 1 s–5 min or the server refuses to start; one failing task no longer stops a run; `POST /api/admin/engine/run` (`manage_escalation_policies`, caller's organization); `GET /api/escalations` (ESC-09) with server filters and `ackEventId`. Not built: a `job_runs` row per engine run (console logging covers ESC-08-AC-3).
- Acknowledgement: `POST /api/escalations/:id/ack {note}` answers `{event, task}`; 422 `fields.note` when empty, 1000 max, unknown fields rejected; 409 when resolved or already acknowledged; 403 for anyone but a "to" recipient or a CoS; the assignee and giver are told (`escalation_ack`), except the actor. The acknowledge action is offered only while an unacknowledged event remains.

### Shared data model

- `escalation_events(id, taskId, level 0–3, reason silence|overdue, at, cycle, status active|acknowledged|resolved, ackBy, ackAt, ackNote, snoozeUntil, resolvedAt, lastNotifiedAt)`
- `escalation_recipients(eventId, userId, kind to|cc)`

The client keeps `recipientIds` and `ccIds` arrays [V-C `types/index.ts:206-223`]; the server keeps the two tables [V-S EXISTING_SYSTEM_ANALYSIS §3.2], with a unique index on the active (task, level) pair. Snooze is held per event on the server and per task on the client (see D-26).

---

## ESC-01 Silence ladder

**Description.** A task with no assignee update climbs L0 → L3 at window × multiple. [WO; BR-20]

**Roles.** System. Recipients per ESC-04.

**User actions (UI).** None to trigger it. It is visible in:
- the "Escalation clock" card `features/tasks/TaskDetailPage.tsx:284-317`
- the escalation banner `:89-115`
- the priority hint on the task form `features/tasks/TaskFormPage.tsx:137`

**Behaviour.**
- For each active task: silence level = the highest k with silent hours ≥ `window[priority] × multiples[k]`.
- `levelInfo` exposes `silentHours`, `reachedAt[]` and `next`. [V-C `services/engine/escalation.ts:30-69`; V-S `engine/levels.ts:30-65`]
- The clock resets only on BR-10 events.
- The rules used are those of the task's entity (BR-29, D-7).

**Data.** `tasks.priority/clockStartedAt/level`; the rule set (default plus per-entity override).

**Backend processing.** A pure function, run by the ESC-08 scheduler and after every relevant mutation (C-7).

**API.** No endpoint of its own. `level` and `levelInfo` appear on `TaskView` (TASK-04/05).

**Validation.** Rule values per BR-30.

**Authorization.** Not applicable.

**Scenarios.** See the acceptance criteria.

**Dependencies.** POL-01 (rules), WF-03 (reset).

**Acceptance criteria.**
- ESC-01-AC-1 (AC-1): A Critical task with no assignee update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h and L3 at 12 h, each event created within 5 minutes after the threshold.
- ESC-01-AC-2: For High, Normal and Low with defaults, the thresholds are 24/36/48/72, 48/72/96/144 and 72/108/144/216 h.
- ESC-01-AC-3: With an entity override of Critical = 2 h, a Critical task in that entity reaches L0 at 2 h and L1 at 3 h, while other entities keep 4/6.
- ESC-01-AC-4: An assignee update at 7 h on a Critical task returns the silence level to −1 and resolves the L0 and L1 events.

**Test scenarios.**
- Per-priority thresholds at exactly the threshold and 1 minute before.
- Entity override.
- Reset mid-climb.
- Climb again after a reset.

---

## ESC-02 Past-due floor (deadline milestones)

**Description.** A past-due task is at least L1 at the due time, L2 at its stored L2 time and L3 at its stored L3 time, whatever updates are posted. [WO; BR-21; ADR-0014 §4; D-140, D-146]

**Changed 2026-11-12 (ADR-0014).** Stored **deadline milestones** replace the offsets:
- L1 is always the due time. L2 = due + `deadlineDelaysMinutes[priority][0]` and L3 = due + `deadlineDelaysMinutes[priority][1]`, from the task's effective vertical policy (POL, [ADMINISTRATION-FRD](ADMINISTRATION-FRD.md)).
- They are stored on the task (`deadline_l2_at`, `deadline_l3_at`, `policy_version`; migration 018) when it is assigned. They are re-stamped when the due time, priority, assignee, vertical or status (assigned, reopened) changes (`stampMilestones` / `restampIfMoved`, `services/tasks.ts`). A later policy change does not move them until "Apply to open tasks" is used (D-146).
- Shipped delays are L2 +24 h and L3 +72 h for every priority (`SHIP_DEADLINE_DELAYS`, `shared/policy.ts`), so AC-2 reads as before until the D-152 values (Critical 30 min/2 h, High 4 h/24 h) are entered on the Policies page.
- Progress never moves them (US-07). The task DTO carries `milestones` and `policyVersion`; the task page shows the L1/L2/L3 times.
- A policy saved before ADR-0014 (offsets, no delays) keeps its offsets (`legacyDelays`).
- The Behaviour, Data and Validation text below is the pre-ADR-0014 rule, kept for history.

**Roles.** System.

**User actions (UI).** The past-due floor line in the Escalation clock card (`TaskDetailPage.tsx:284-317`).

**Behaviour.**
- Past-due level = the highest i with now − due ≥ `overdueOffsetsHours[i]`, giving L(i+1).
- The task level = max(silence, past-due) (BR-22).
- The floor holds until the task closes or the due date moves later (BR-59).
- While In review, silence escalation pauses but the past-due floor still applies (D-25, decided; WO: until closed or extended).

**Data.** `tasks.dueAt`; `overdueOffsetsHours`.

**API.** None of its own.

**Validation.** Offsets ≥ 0 and strictly increasing (BR-30).

**Authorization.** Not applicable.

**Dependencies.** EXT-02, EXT-04 (due moves), WF-03.

**Acceptance criteria.**
- ESC-02-AC-1 (AC-2, per approved policy, D-140): A task past due reaches L1 at the due time and L2/L3 at its stored milestones (+24 h/+72 h with the shipped policy), even when the assignee posts an update every hour.
- ESC-02-AC-2: Moving the due date into the future (EXT-02 or EXT-04) resolves the floor events in the same request.
- ESC-02-AC-3: The event `reason` is `overdue` when the past-due level is at least the silence level.
- ESC-02-AC-4 (D-146): A policy change leaves an open task's milestones unchanged; "Apply to open tasks" re-stamps them and is audited.

**Test scenarios.**
- Hourly updates on a past-due task.
- Extension clears the floor.
- Reason labelling when both rules apply.

---

## ESC-03 Highest rule wins; each level fires once per cycle

**Description.** Event lifecycle. [WO "Each level fires once"; BR-22..25]

**Roles.** System.

**User actions (UI).** The Escalations tab on the task (timeline grouped by cycle).

**Behaviour.**
- For each level k = 0..3 that applies (BR-23) and has no unresolved event, create one event with the "to" and cc lists from ESC-04, the reason, `at` (the crossing time, BR-25) and `cycle` = `clockStartedAt`.
- Append an `escalated` log row and an audit row `escalation.triggered`, and notify (mandatory type `escalation`). [V-C `services/core.ts:160-189`; V-S `engine/engine.ts:116-160`]
- Events whose level no longer applies resolve, and a de-escalation is logged [V-S `engine.ts:96-114`].
- A task leaving the active statuses resolves all its events [V-C `core.ts:146-151`].

**Data.** Events, recipients, log, audit.

**Backend processing.** One transaction per task under a row lock. The engine is idempotent: two concurrent runs create one event per level (unique index; NFR Reliability).

**API.** None of its own.

**Authorization.** Not applicable.

**Dependencies.** ESC-01/02/04, ESC-08.

**Acceptance criteria.**
- ESC-03-AC-1: Running the engine twice at the same instant creates no duplicate event.
- ESC-03-AC-2: A task that jumps straight to L2 (for example, 25 h past due at the first engine run after an outage) gets L1 and L2 events in one run, both with recipients. L0 is created only if silence also applies.
- ESC-03-AC-3: Each event and each resolution writes an append-only log row (AC-7).
- ESC-03-AC-4: After a reset and a new climb, L0 fires again as a new event in the new cycle.

**Test scenarios.**
- Concurrent engine runs.
- Jump levels.
- Re-climb after a reset.
- Close resolves events.

---

## ESC-04 Routing

**Description.** Who each level reaches. [WO Notifications table; BR-35..40]

**Roles.** Assignee (L0), lead (L1), manager (L2), Founder's Office (L3). cc per BR-35.

**User actions (UI).**
- The recipients and cc list in the banner (`TaskDetailPage.tsx:89-115`).
- The static "Work-order routing" table on Policies (`features/admin/AdminPages.tsx:250-264`). It is hard-coded and should come from this API [A].

**Behaviour.**
- Recipients are computed from the assignee's **active** chain at firing time.
- A missing role skips up (BR-36).
- The Founder's Office at L3 = every active CoS, plus the CEO if D7.
- Below L3, a fall-through to the Founder's Office routes like L3: every CoS, plus the CEO when D7 is on (D-28, decided).
- With multiple roles, a person holding lead + manager is resolved by role precedence (BR-37, M-4).

**Data.** `users.managerId/roles/status`, `rules.l3NotifyCeo`.

**API.** None of its own. Recipients are returned on events in TASK-05 and ESC-09.

**Validation.** Not applicable.

**Authorization.** Not applicable.

**Dependencies.** STAFF/ORG (the tree), D-8.

**Acceptance criteria.**
- ESC-04-AC-1 (AC-5): For staff S → lead L → manager M → CoS C (CEO E above, D7 on):
  - L0 to S
  - L1 to L, cc S
  - L2 to M, cc L and S
  - L3 to C and E, cc M
- ESC-04-AC-2: With no lead (S reports to M directly), L1 goes to M with cc S.
- ESC-04-AC-3: With the lead inactive, L1 goes to the next active qualifying ancestor.
- ESC-04-AC-4: With D7 off, L3 goes to C only.
- ESC-04-AC-5: No user appears in both "to" and cc on the same event.
- ESC-04-AC-6 (ADR-0014 §9, D-142): From L1 up, the giver and the vertical's extra recipients for that level are copied (active people only, never twice, never the assignee). While a task handed in on time awaits review, the reviewer is added as "to" (ESC-11).

**Test scenarios.**
- Full chain.
- Missing lead.
- Missing manager.
- Inactive lead.
- D7 on and off.
- Multi-role ancestor.
- Org change between levels.

---

## ESC-05 Repeat alerts

**Description.** The top active level re-alerts its "to" recipients once per window until acknowledged. [BR-28]

**Roles.** The "to" recipients of the top active event.

**User actions (UI).** None. Reminders appear as "Reminder: <id> still at <level>" notifications.

**Behaviour.**
- If the top active event is not snoozed and now − `lastNotifiedAt` ≥ window × `repeatAfterWindows` (default 1), notify the "to" recipients and advance `lastNotifiedAt`.
- The repeat is stamped at the whole-window boundary [V-C `services/core.ts:196-204`].
- Copied people get no repeats.
- Quiet hours apply to L0/L1 repeats (BR-53), except a Critical L1 (D-147).

**Data.** `events.lastNotifiedAt`, snooze.

**API.** None.

**Authorization.** Not applicable.

**Dependencies.** ESC-06 (snooze), NTF-03.

**Acceptance criteria.**
- ESC-05-AC-1: An unacknowledged High task at L1 re-alerts the lead every 24 h, and the cc'd assignee receives no repeat.
- ESC-05-AC-2: After an acknowledgement, no repeat is sent for 12 h, and the next one arrives at the first window boundary after the snooze ends.
- ESC-05-AC-3: With `repeatAfterWindows` = 0, no repeats are sent.

**Test scenarios.**
- Repeat cadence.
- Snooze window.
- Disabled repeats.
- Repeat during quiet hours (held for L0/L1, not for L2/L3).

---

## ESC-06 Acknowledge escalation

**Description.** "The person an escalation reached marks it acknowledged." This stops repeat alerts at that level for 12 hours but does not reset the clock. [WO FR-9; BR-46..50]

**Roles.** **Decided (R-1, 2026-11-04; replaces D-26):** the "to" recipients of that level, plus any CoS. Copied (cc) people, including the assignee, may not. WO FR-9; matches the server and its test "copied assignee cannot acknowledge". Implemented in the shared rules (T-1.3). For reference, before the decision:
- Server: "to" recipients, plus the CoS [V-S `services/tasks.ts:287-291`].
- Client: "to" recipients, or any overseer [V-C `services/engine/workflow.ts:70-71`].



**User actions (UI).**
- "Acknowledge escalation" `TaskDetailPage.tsx:55`.
- The banner button `:89-115`.
- The Escalations page button `features/work/EscalationsPage.tsx:141` (`canAck && status === 'active'`); the toast is at `:21`.

**Behaviour.**
- Marks the event acknowledged (by, at, note per ESC-06a) and sets snooze until now + `ackSnoozeHours`.
- Logs `escalation_acknowledged` (`ack` on the server) with the level, note and snooze end.
- Notifies the assignee and the giver (`escalation_ack`), except the actor.
- Audits `escalation.acknowledged`. [V-C `services/api/tasks.ts:407-424`; V-S `services/tasks.ts:278-307`]
- Level and clock are unchanged.
- Scope: the acknowledged level only (D-26, decided). Other active levels on the task keep alerting.
- The UI toast hard-codes "12 h" (`EscalationsPage.tsx:21`); it must use `ackSnoozeHours` [A].

**Data.** The event's ack fields; `snoozeUntil`.

**API.** `POST /api/escalations/:eventId/ack` `{note}` → 200 `{event, task: TaskView}`. Reuse the existing `POST /escalations/:id/ack` (`routes/tasks.ts:145-150`). The client's `ackEscalation(taskId)` must change to acknowledge one event id (level-only scope, D-26).

**Validation.**
- Event unknown → 404 `Escalation not found`.
- Already resolved → 409 [A]. The server returns 400 `This escalation is no longer active` (`services/tasks.ts:286`).
- Already acknowledged → 409 [A].
- Note per ESC-06a.

**Authorization.** Not an allowed acknowledger → 403 `Only the person this escalation reached can acknowledge it` [V-S `services/tasks.ts:291`].

**Scenarios.**

| Scenario | Status |
|---|---|
| L2 recipient (manager) acknowledges | 200 |
| cc'd lead or cc'd assignee acknowledges | 403 (R-1) |
| Resolved event | 409 |
| Missing note | 422 |

**Dependencies.** ESC-05, ESC-06a, NTF.

**Acceptance criteria.**
- ESC-06-AC-1 (FR-9): After acknowledgement, the level and `clockStartedAt` are unchanged, and the task still climbs to the next level on schedule.
- ESC-06-AC-2: No repeat for the acknowledged level is sent for `ackSnoozeHours`.
- ESC-06-AC-3: A higher level that fires during the snooze alerts its recipients normally (BR-50).
- ESC-06-AC-4: Anyone who is not a "to" recipient of that level, and not a CoS, gets 403. In particular, the cc'd assignee cannot acknowledge (existing test; R-1).
- ESC-06-AC-5: The acknowledgement is an append-only log row with actor, server time, level and note.

**Test scenarios.**
- Acknowledge then advance 11 h and 13 h.
- Acknowledge L1, then L2 fires.
- Acknowledge by a cc, a non-recipient overseer, the CoS and the CEO.
- Double acknowledgement.
- Resolved event.

---

## ESC-06a Acknowledgement note (new, from WO)

**Description.** FR-9 requires a note with every escalation acknowledgement. [WO FR-9 "marks it acknowledged, with a note"]

**Roles.** As ESC-06.

**User actions (UI).** No UI yet. The client acknowledges with one click (`TaskDetailPage.tsx:55`, `EscalationsPage.tsx:141`). This adds a note dialog in both places.

**Behaviour.**
- The note is stored on the event (`ackNote`) and as the body of the acknowledgement log row.
- It is shown in the event timeline and on the Escalations page. [V-S `services/tasks.ts:295-305`]

**Data.** `escalation_events.ackNote`.

**API.** The `note` field of ESC-06.

**Validation.**
- Trimmed empty → 422 `fields.note = "Add a note with your acknowledgement"` [V-S `services/tasks.ts:279`, today 400].
- Longer than 1000 → 422 [V-S `routes/tasks.ts:147`].
- Sensitive-ID guard (BR-80).

**Authorization.** As ESC-06.

**Scenarios.** With a note → 200. Without one → 422. With an SSN → 422.

**Dependencies.** ESC-06.

**Acceptance criteria.**
- ESC-06a-AC-1: An acknowledgement without a note is rejected with 422 and changes nothing.
- ESC-06a-AC-2: The note appears verbatim in the task's activity log and in the event returned by TASK-05.

**Test scenarios.**
- Empty note.
- Whitespace-only note.
- 1000/1001 characters.
- Sensitive ID.
- Note visible in the log.

---

## ESC-07 Due-soon and overdue notices

**Description.** Informational notices around the due time. [BR-31]

**Changed 2026-11-12 (ADR-0014 §9; D-143, D-144).** Built rule (`noticesDue`, `engine/engine.ts`); each notice is sent once per key in `job_runs`:
- **Due-soon** (`due_soon`, key task@due): `dueSoonHours` before the due time, **only when the task was assigned before that moment** (long tasks).
- **10-minute warning** (`deadline_warning`): see ESC-10.
- **Start notice** (`start_notice`, key task@start): 10 minutes before a scheduled start, to the assignee, while the task is still Open and was assigned before that moment.
- **No separate overdue notice.** L1 at the due time copies the assignee and the giver instead (ESC-04-AC-6). Stored `overdue` rows still read correctly.
- The warning and the start notice follow the `due_soon` preference type.
- The Roles and Behaviour text below is the pre-ADR-0014 rule.

**Roles.**
- Due-soon: the assignee.
- Overdue: the assignee and the giver.

**User actions (UI).** None. They appear in Notifications (types `due_soon`, `overdue`).

**Behaviour.**
- Due-soon fires once per due date, `dueSoonHours` (default 24) before the due time.
- Overdue fires once at the due time.
- A due-date change re-arms both. [V-C `services/core.ts:205-213`]
- These are not escalation events and are not mandatory types.

**Data.** `notifications` (de-duplication by task, type and due date).

**API.** None.

**Validation.** `dueSoonHours` 1–168 (PRD POL-01).

**Authorization.** Not applicable.

**Dependencies.** NTF-01/04.

**Acceptance criteria.**
- ESC-07-AC-1: Exactly one due-soon and one overdue notice per due date, even across many engine runs.
- ESC-07-AC-2: After an extension, a new due-soon notice fires for the new date.
- ESC-07-AC-3 (D-143): A task whose whole window is shorter than `dueSoonHours` gets no due-soon notice. The giver gets no separate overdue notice; L1 copies them. (ESC-07-AC-1's "one overdue notice" is superseded by this.)

**Test scenarios.**
- De-duplication.
- Re-arm after a due change.
- Task created inside the due-soon window.

---

## ESC-10 Pre-deadline warning and floating countdown (new, ADR-0014)

**Description.** The assignee is warned 10 minutes before the due time and sees a live countdown. [US-05; D-143, D-149; ADR-0014 §4, §14]

**Roles.** The assignee.

**User actions (UI).**
- The floating countdown (`features/shell/DeadlineTimer.tsx`, rendered by `Shell.tsx`), sticky at the top of the main column. One pill for the most urgent task and "+N more" for the others. A click opens the task. It collapses to a dot, except when overdue. It shows the time left, or the overdue time in the danger colour.
- The task page shows the scheduled window, a live due countdown and the L1/L2/L3 times.

**Behaviour.**
- `deadline_warning` fires at due − 10 min (system constant `PRE_DEADLINE_WARNING_MINUTES`; nobody configures it), once per task and due time (`job_runs`), to the assignee.
- It is skipped once the task is submitted, and when the task was assigned inside the 10 minutes. The assignment or reassignment notice then says "Due in N min".
- Countdown rule (`nextCountdown`, `shared/schedule.ts`): my tasks in an active status that are within 10 minutes of the due time or past it. Overdue first (oldest due), then soonest due.
- The client clock follows the server (offset recorded at every `/api/me`), not the browser clock alone.

**Data.** Task `dueAt` and status; `job_runs`.

**API.** None of its own.

**Acceptance criteria.**
- ESC-10-AC-1: One `deadline_warning` to the assignee at due − 10 min, however many engine runs.
- ESC-10-AC-2: No warning for a submitted task, or for one assigned inside the window; the assignment notice says how long is left.
- ESC-10-AC-3: The pill appears at due − 10 min and shows overdue at the due time.

**Tests.** `api.test.ts` "ADR-0014 pre-deadline warning and start notice"; `schedule.test.ts` "nextCountdown"; `e2e/escalation-v2.spec.ts`.

---

## ESC-11 Reviewer deadline and review accountability (new, ADR-0014)

**Description.** Submission does not stop escalation. A delay after an on-time submission is the reviewer's. [US-06; D-145; ADR-0014 §10]

**Roles.** The reviewer (`tasks.reviewer_id`, else the giver) and the reviewer's manager.

**Behaviour.**
- Each escalation row stores `accountable` = `assignee` or `reviewer` (migration 018). It is `reviewer` when the task is `submitted` and the pending round was submitted at or before the due time; the reviewer is then added as "to". A late submission stays the assignee's.
- The accountability report counts only `accountable = assignee` escalations against a person (`services/reports.ts`).
- **R1** (`review_r1`) at submission + `reviewSlaMinutes[priority]`, to the reviewer. **R2** (`review_r2`) at submission + 2 × SLA, to the reviewer's manager (else the Founder's Office, as the ladder falls through), reviewer copied.
- Each is sent once per review round (`job_runs` key `<task>@r<round>`) and not after the decision. Both follow the `review_required` preference type. They are notices, not L-levels.
- SLA per vertical (POL). D-152 defaults: Critical 30 min, High 4 h, Normal 24 h, Low 48 h.

**Acceptance criteria.**
- ESC-11-AC-1: Submitted on time: escalations after the due time are `accountable = reviewer` and reach the reviewer.
- ESC-11-AC-2: Submitted late: escalations stay the assignee's.
- ESC-11-AC-3: R1 once at the SLA; R2 to the reviewer's manager at twice the SLA; none once the review is decided.

**Tests.** `api.test.ts` "ADR-0014 review accountability, reviewer deadline, Critical at night, late reassignment".

---

## ESC-08 Scheduler

**Description.** The engine runs on the server at least every 5 minutes. [WO FR-8; BR-26]

**Roles.** System. A manual "run now" for the CoS is proposed (see the API below).

**User actions (UI).** None in production. The client's 30 s browser tick (`app/App.tsx:62-72`) and the demo-bar clock advance are removed or dev-only (D-17).

**Behaviour.**
- A job runs every 60 s [V-S `jobs/scheduler.ts:69`, `config.engineIntervalMs`, EXISTING_SYSTEM_ANALYSIS §3.5].
- Each run does a cheap in-memory pass and then locks only the tasks that change [V-S `engine/engine.ts:37-65`].
- Each run is recorded in `job_runs` [A].
- Only one instance runs the job at a time, using an advisory lock (NFR Scalability; S-15).

**Data.** `job_runs`.

**API.** `POST /api/admin/engine/run` → 200 `{checked, changed}`. Adapt `POST /admin/engine` (`routes/admin.ts:41`). CoS only [A].

**Validation.** None.

**Authorization.** `manage_escalation_policies` [A].

**Dependencies.** All ESC features.

**Acceptance criteria.**
- ESC-08-AC-1 (AC-1): With no browser open, the thresholds in ESC-01-AC-1 are met within 5 minutes.
- ESC-08-AC-2: With two server instances running, each event is created once.
- ESC-08-AC-3: A failed run is logged and the next run proceeds.

**Test scenarios.**
- Headless timing test (using the dev clock).
- Two instances.
- Error isolation.

---

## ESC-09 Escalations workspace

**Description.** A list of escalated tasks for supervisors, grouped per task.

**Roles.** `view_tasks`. The CoS sees all; others see visible tasks not assigned to themselves.

**User actions (UI).** `features/work/EscalationsPage.tsx:16`. Its filters (status, level, priority, team, assignee) and CSV export are client-side.

**Behaviour.** For each visible task with events it returns:
- the top unresolved level (or the highest historical level)
- status: active, acknowledged or resolved
- since
- recipients, with cc marked
- next level and when
- `canAck` (= ESC-06 authorization)
- all events, oldest first

[V-C `services/api/admin.ts:279-303`]

**Data.** Events, recipients, tasks.

**API.** `GET /api/escalations?status=open|active|acknowledged|resolved|all&level=&priority=&teamId=&assigneeId=` → 200 `{rows: [...]}`. New. Filtering is done on the server when D-10 requires it.

**Validation.** Unknown enum value → 422 [A].

**Authorization.** No `view_tasks` → 403 `You don't have permission to view escalations.` [V-C `admin.ts:281`]

**Scenarios.** A lead sees their line's escalations. Staff → 403.

**Dependencies.** ESC-03/06, TASK-09 ("Escalated to me" is the per-user counterpart).

**Acceptance criteria.**
- ESC-09-AC-1: No row refers to a task the caller cannot view, or (for non-CoS) to the caller's own task.
- ESC-09-AC-2: `canAck` is true exactly when ESC-06 would accept the caller.
- ESC-09-AC-3: Recipient names are included, but no email or phone.

**Test scenarios.**
- Scope per role.
- `canAck` parity.
- Status grouping.
- Personal-data check.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

- **D-7** (decided): per-entity overrides (ESC-01-AC-3). The Policies page needs an entity selector.
- **D-9**: one shared ladder and routing module for client and server.
- **D-10**: server-side filtering for ESC-09.
- **D-17**: the dev clock and browser tick.
- **D-23 (decided)**: Blocked alerts during quiet hours.
- **D-24 (decided)**: whether Blocked lifts the level.
- **D-25 (decided)**: the past-due floor while In review.
- **D-26 (decided)**: who may acknowledge (to only, to + cc, overseers, CoS, CEO) and the scope of an acknowledgement (one level or all levels on the task).
- **D-28 (decided)**: Founder's Office fall-through below L3 (CoS only vs CoS + CEO).
- **D-30 (decided)**: escalations after a reassignment (re-fire to the new chain vs keep the old events). **D-148 (2026-11-12):** reassigning a task that is past due or due within 10 minutes needs a new due time (422 `dueDate` otherwise), so the new person is not escalated on arrival.
- **D-140…D-153 (decided 2026-11-12, ADR-0014):** deadline milestones (ESC-02), vertical policies (POL), notices (ESC-07, ESC-10), reviewer deadline (ESC-11), a Critical L1 never held in quiet hours (D-147, BR-53).

## Changed 2026-11-13 (ADR-0015, D-158, D-160, D-164)
- **Working time.** For **non-Critical** tasks, the silence clock and the L2/L3 steps after the due time count the assignee's vertical working time (days and hours, in its zone). Existing hour values are read as working time, and each vertical tunes them. **Critical** tasks keep plain clock time.
- **Away time.** While the assignee is marked away, non-Critical silence pauses. Deadlines do not move: late is late.
- **Late marks.** A mark never undoes time already counted.
- **Code:** one clock in `shared/worktime.ts`, used by `shared/levels.ts` (`silenceClock`), `shared/policy.ts` (`deadlineMilestones`, `clock`) and the server (`services/worktime.ts`).
- **Release:** see RELEASE_READINESS R-AC2.
