# Test Case Inventory

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Feature IDs and feature acceptance come from [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md). WO acceptance criteria AC-1…AC-10 are in [PROJECT_OVERVIEW §1.7](../01-discovery/PROJECT_OVERVIEW.md). Levels, fixtures and clock control are in [TESTING_STRATEGY.md](TESTING_STRATEGY.md).

## How to read this

- **ID**: `TC-<FEATURE-ID>-NN`. Cross-cutting rules use `TC-C<n>-NN` (PRD C-1…C-7) and `TC-SEC<n>-NN` (NFR SEC-n).
- **Level**: U = unit (no DB), I = integration (real HTTP + isolated DB), E = e2e through the UI, M = manual or pilot.
- **Pre**: preconditions. Unless stated, integration cases use fixture **F-ORG** (`api.test.ts:42-79`): CEO(1), CoS(2), MgrA(3)→LeadA(4)→StaffA1(5, IST), StaffA2(6, PT) in BAIS; MgrB(7)→LeadB(8)→StaffB1(9) in EMB. "now" is pinned with `clock.setFixed`.
- **Status**:
  - `existing test: "<title>"` means a test in `server/test` already asserts this. **All 38 existing tests were executed on 2026-11-04 and passed** (`npm test`: 43/43 including the 5 new error-envelope tests).
  - `planned` means no automated test exists yet.
  - Existing tests target the current server model. They will need fixture changes under D-4/D-20, without weakening the assertion.
- Where today's server returns a different status code from the target, the expected column shows the target and notes the open decision.

## AC coverage summary

| WO AC | Criterion (short) | Test cases |
|---|---|---|
| AC-1 | Critical silent: L0/L1/L2/L3 at 4/6/8/12 h, each within 5 min | TC-ESC-01-05, TC-ESC-01-06, TC-ESC-08-02 |
| AC-2 | Past due: L1 at due, L2 +24 h, L3 +72 h whatever updates | TC-ESC-02-01, -02, -04 |
| AC-3 | Blocked alerts the team lead within 5 min | TC-WF-11-01, -02, -03, -04 |
| AC-4 | Lead/manager comment does not reset; assignee update does | TC-CMT-01-01, TC-WF-03-01 |
| AC-5 | Each alert reaches the right person on WhatsApp and email, logged | TC-ESC-04-01…06, TC-NTF-02-01, -02, -06, TC-DLV-01-02 |
| AC-6 | Staff cannot see another team’s tasks, through the API | TC-TASK-04-01, -02, TC-TASK-05-01, TC-DASH-03-01, -02, TC-SRCH-01-01, TC-SEC1-01 |
| AC-7 | No log row editable/deletable via any endpoint; nightly hash check flags direct DB edits | TC-AUD-01-01, -02, -03, -04 |
| AC-8 | Entity dashboard figures match a manual count of 20 tasks | TC-DASH-01-01, -02 |
| AC-9 | Times display correctly in IST and PT for the same task | TC-TASK-01-06, TC-TASK-05-04, TC-NTF-03-01 |
| AC-10 | BAIS pilot: ≥90 % of staff post updates through TaskWatch | TC-WF-03-06 (pilot, M) |

---

## AUTH: Authentication and session

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-AUTH-01-01 | I | Google enabled with a stubbed token verifier | Callback with `email_verified=false` | No session; error page; nothing logged in. [V-S] `auth.ts:60` | AUTH-01 | planned |
| TC-AUTH-01-02 | I | `GOOGLE_ALLOWED_DOMAINS` set | Callback with an email from another domain | Refused; no session. [V-S] `auth.ts:64` | AUTH-01 | planned |
| TC-AUTH-01-03 | I | Archived user; then an active user | Google callback for each | Archived → refused. Active → session id differs from the pre-login one (regenerated). [V-S] `auth.ts:69` | AUTH-01, SEC-6 | planned |
| TC-AUTH-01-04 | I | Password user (D-2) | Sign in with correct password; then wrong password; then unknown email | 200 + cookie; the two failures return the **same** 401 body and similar timing | AUTH-01 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-01-AC-2"; same body, decoy hash for timing |
| TC-AUTH-01-05 | I | Deactivated password user | Sign in with correct password | 403 "This account is deactivated…" | AUTH-01 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-01-AC-3" |
| TC-AUTH-01-06 | I | Manager with TOTP enrolled (D-21) | Password step, then no code / wrong code / right code | No session until a valid code; wrong code 401; staff user gets no TOTP step | AUTH-01, WO "2FA" | void: D-94 removed 2FA |
| TC-AUTH-01-07 | I | — | 11 wrong passwords for one account within a minute [A] | Throttled (429, D-82); the right password is also refused until the window passes | AUTH-01, SEC-3 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-01-AC-6" (5 per email per 15 min) and "SA-6" (parallel burst) |
| TC-AUTH-01-08 | I | `NODE_ENV=production` | `GET /api/auth/dev-users`, `POST /api/auth/dev-login` | Both unavailable (404) | SEC-10, S-2 | run: pass 2026-11-04 (owner, `npm test` 92/92) — gate unit test "dev login gate" (`config.test.ts`); no production-config HTTP run yet |
| TC-AUTH-02-01 | I | Signed in | `POST /api/auth/logout`, then `GET /api/me` with the old cookie | 200, `Set-Cookie` clears `tw.sid`; then 401 | AUTH-02, S-6 | run: pass 2026-11-04 (owner, `npm test` 92/92) |
| TC-AUTH-03-01 | I | `sessionTimeoutMinutes=5` | Idle 6 min (fixed clock), then any API call | 401 `SESSION_EXPIRED` | AUTH-03 | run: pass 2026-11-04 (owner, `npm test` 92/92) |
| TC-AUTH-03-02 | I | Active session refreshed every minute | Keep calling for longer than the absolute cap [A] | 401 after the cap | AUTH-03, S-6 | run: pass 2026-11-04 (owner, `npm test` 92/92) |
| TC-AUTH-04-01 | I | One existing and one unknown email | Request a reset for each | Identical response; a token row exists only for the real account | AUTH-04 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-04-AC-1/6" |
| TC-AUTH-04-02 | I | Valid token | Use after 61 min; use twice; set a 9-character or digit-free password | Expired → 400; second use → 400; weak password → 422 with `fields.password` | AUTH-04 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-04-AC-2/4/5", "AUTH-04-AC-3" |
| TC-AUTH-05-01 | I | CoS and a staff user | Each issues "reset access" for StaffA1 | CoS → 200 + `admin_log` `staff.access_reset`; staff → 403 | AUTH-05 | run: pass 2026-11-04 (owner, `npm test` 92/92) — "AUTH-05" (audit kind is `access_reset`) |
| TC-AUTH-06-01 | I | StaffA1 signed in | `GET /api/me` | Own user, effective permissions, server time; no other user's email or phone. [V-S] `auth.ts:104` | AUTH-06, SEC-9 | run: pass 2026-11-04 (owner, `npm test` 92/92) |
| TC-AUTH-06-02 | I | StaffA1 signed in | CoS grants StaffA1 the lead role; StaffA1 calls `GET /api/me` and creates a task for a report | New permissions apply on the **next** request without re-login | AUTH-06, ROLE-02, S-9 | run: pass 2026-11-04 (owner, `npm test` 92/92) — through a role-matrix change (`PUT /api/roles/staff`), not a role grant |
| TC-AUTH-07-01 | I | MgrA (manager role) with a password, not enrolled | Password sign-in | Session is limited to TOTP enrolment; every other endpoint returns 401/403 until enrolled; enrolment accepts a valid RFC 6238 code and rejects an invalid one | AUTH-07, WO 2FA | void: D-94 removed 2FA |
| TC-AUTH-07-02 | I | StaffA1 (staff only) | Password sign-in | No TOTP step required | AUTH-07 | void: D-94 removed 2FA |
| TC-AUTH-07-03 | I | MgrA enrolled, lost device (D-65) | CoS resets MgrA TOTP | Reset is audited; MgrA must re-enrol at next sign-in; a non-CoS cannot reset (403) | AUTH-07 | void: D-94 removed 2FA |
| TC-AUTH-08-01 | I | MgrA enrolled | Password, then a wrong code 5×, then the correct code | Wrong codes rejected and rate-limited (D-82); correct code within the ±1 step window signs in; a replayed code is rejected | AUTH-08 | void: D-94 removed 2FA |

## TASK: Tasks

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-TASK-01-01 | I | — | LeadA `POST /api/tasks` for StaffA1 | 201 with id; `assigner_id`=LeadA and `assigned_at`= server now; log row `created`; assignee notifications on in-app, email, WhatsApp | TASK-01, WO FR-1 | planned (the `newTask` helper asserts only 201, `api.test.ts:137`) |
| TC-TASK-01-02 | I | — | StaffA1 creates a task for StaffA2 | 403 | TASK-01 | existing test: "only the assignee can post updates; staff cannot assign", **passed 2026-11-04** |
| TC-TASK-01-03 | I | — | Title contains `A123-456-789` | 422, message mentions A-number | TASK-01, C-6 | existing test: "rejects A-numbers and other ID numbers in task text", **passed 2026-11-04** |
| TC-TASK-01-04 | I | — | Due date 1 h in the past | 422 `fields.dueDate` (today 400, D-80). [V-S] `services/tasks.ts:69` | TASK-01 | planned |
| TC-TASK-01-05 | I | — | Titles of 3, 4, 140 and 141 characters | 3 and 141 rejected with 422; 4 and 140 accepted (PRD limits; server is 3–200 today, D-92) | TASK-01 | planned |
| TC-TASK-01-06 | I | LeadA (IST) and CoS (PT) | Each enters the same instant in local time | One UTC instant stored; formatted as `Wed 25 Nov, 5:30 PM IST` and `Wed 25 Nov, 4:00 AM PT` | TASK-01, C-4, **AC-9** | existing test: "the same due time entered in IST and PT is stored as one UTC instant and shown correctly in each zone", **passed 2026-11-04** |
| TC-TASK-01-07 | I | — | LeadA assigns to StaffB1 (other team) | 403; no row created | TASK-01, C-2 | planned |
| TC-TASK-01-08 | I | — | Body includes `createdAt`, `assignedAt`, `assignerId` | 422 unknown fields (SEC-7), or ignored; stored values are server values | TASK-01, C-4, WO "Server time only" | planned |
| TC-TASK-02-01 | I | — | Save as draft; run engine past 12 h; publish | Draft: no notification, no escalation. Publish: status `assigned`, clock = publish time, assignee notified | TASK-02 | planned |
| TC-TASK-02-02 | I | Draft with a due date now in the past | Publish | 422 | TASK-02 | planned |
| TC-TASK-03-01 | I | Open task | Giver edits the title; then changes the assignee | Title change logged with before/after; assignee change is a reassignment: clock restarts, ack cleared | TASK-03 | planned |
| TC-TASK-03-02 | I | Task with a past due date | Edit without changing the due date; then set another past date | First accepted; second 422 | TASK-03 | planned |
| TC-TASK-04-01 | I | Task LeadB → StaffB1 in EMB | StaffA1 `GET /api/tasks?view=open` | Task not in the list | TASK-04, **AC-6** | existing test: "a staff member cannot see another team’s tasks — tested through the API", **passed 2026-11-04** |
| TC-TASK-04-02 | I | Tasks across both lines | Each of the 9 users lists `mine`, `team`, `all` | Staff: own and assigned-by-me. Lead: self and direct staff. Manager: leads and their staff. CoS/CEO: all. No cross-line rows | TASK-04, **AC-6**, WO "Users, roles and visibility" | run: pass 2026-11-04 (owner) — parity of every fixture user's list with `canViewTask` |
| TC-TASK-04-03 | I | One task in each state and level | LeadA lists with the WO filters All open, Escalated to me, Red, Blocked, Closed | Each filter returns exactly the matching visible tasks. [V-S] `TASK_VIEWS` | TASK-04, WO FR-10 | planned |
| TC-TASK-04-04 | I | 501 visible tasks | List | Capped or paginated as decided (D-10); the response says it was truncated | TASK-04, S-17 | planned |
| TC-TASK-05-01 | I | EMB task | `GET /api/tasks/:id` as StaffA1, MgrA, MgrB, CoS, CEO | 404 (identical to a missing id), 404, 200, 200, 200 (D-35) | TASK-05, **AC-6** | existing test: "a staff member cannot see another team’s tasks — tested through the API", **passed 2026-11-04** |
| TC-TASK-05-02 | I | — | StaffA1 opens their task detail | Payload contains only people referenced on the task; no other users' email or phone | TASK-05, SEC-9 | planned |
| TC-TASK-05-03 | I | Untampered task | Open detail | `chain.ok = true`; log rows in `seq` order with actor and server time | TASK-05 | planned |
| TC-TASK-05-04 | E | One task; an IST user and a PT user | Each opens the detail page in a browser set to their zone | Due and log times shown in each viewer's zone, matching TC-TASK-01-06 | **AC-9** | planned |
| TC-TASK-06-01 | E | Draft, open and closed tasks | Open the calendar as LeadA | Drafts never shown; closed only when toggled; only visible tasks | TASK-06 | planned |
| TC-TASK-07-01 | I | 3 tasks, one outside LeadA's scope | LeadA bulk-cancels with reason "dup" (4 chars), then "duplicate" | Short reason → 422; second → `{done:[2 ids], skipped:[1 id]}` | TASK-07 | planned |
| TC-TASK-07-02 | I | StaffA1 has 2 unacknowledged active tasks + 1 task of another assignee | Bulk acknowledge (task acknowledgement, WF-01) all 3 | Own 2 acknowledged with snooze set; other in `skipped`; clocks unchanged | TASK-07, WF-01 | planned |
| TC-TASK-08-01 | I | — | `GET` assignee options as CoS, LeadA, StaffA1 | CoS: every active user except self; LeadA: active transitive reports; StaffA1: none or 403. No archived users | TASK-08 | planned |
| TC-TASK-09-01 | I | Tasks covering each case | `GET` list with each FR-10 view: All open, Escalated to me, Red, Blocked, Closed | Each view returns exactly the matching visible tasks; "Escalated to me" = tasks with an active escalation where the caller is a recipient | TASK-09, WO FR-10 | planned |
| TC-TASK-10-01 | E | Tasks at on-track, L0, L1, L2, L3 | Open the task list | Stage stripe colour per task = on track / amber (L0–L1) / red (L2–L3) per D-49; summary tiles equal the counts of TC-TASK-09-01 | TASK-10, WO FR-10 | planned |
| TC-TASK-10-02 | I | Tasks from earlier tests | StaffA1, LeadA, CoS `GET /api/tasks/summary` and `GET /api/tasks?scope=all&view=all` | open = onTrack + amber + red; each row's `stage` matches its level; closed/draft null | TASK-10-AC-1/2 | **passed 2026-11-07** (owner's `npm test`) |
| TC-EXT-04-01 | I | LeadA overseer of a task | LeadA changes the due date directly with a reason, then tries again | First change logged with old date, new date and reason; second → 403 (lead once); MgrA and CoS can still change it | EXT-04, WO FR-5 | planned |

## WF: Task workflow

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-WF-01-01 | I | Critical task, 5 h silent | StaffA1 acknowledges the task | `acknowledgedAt` set; level unchanged; second ack → 409 | WF-01 | planned |
| TC-WF-02-01 | I | `assigned` task | Assignee starts; LeadA tries to start; start again | → `in_progress`; LeadA 403; repeated start 409 | WF-02 | planned |
| TC-WF-03-01 | I | Critical task at L3 | Assignee posts an update | Level drops to −1 immediately; no active escalations; climbs to L0 again after 4 h | WF-03, ESC-01, **AC-4** | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once", **passed 2026-11-04** |
| TC-WF-03-02 | I | — | LeadA posts an "update" on StaffA1's task | 403 | WF-03 | existing test: "only the assignee can post updates; staff cannot assign", **passed 2026-11-04** |
| TC-WF-03-03 | I | — | Assignee posts an update with a PDF | 201; attachment row with SHA-256; log row references it | WF-03, ATT-01, WO FR-3 | planned |
| TC-WF-03-04 | I | Done task | Assignee posts an update | 409 (today 400 "This task is closed", `services/tasks.ts:119`) | WF-03 | planned |
| TC-WF-03-05 | I | — | Update body "ok" (<5 chars) | 422 `fields.message` | WF-03 | planned |
| TC-WF-03-06 | M | BAIS pilot, 2 weeks (WO WP-6) | Count distinct active BAIS staff with ≥1 `update` log row in the window, divided by active BAIS staff | ≥ 90 % | **AC-10** | planned |
| TC-WF-04-01 | I | `reviewRequired` task in progress | Submit with a 5-character note; run the engine past 3× window | → `submitted`; clock reset; no silence escalation while submitted | WF-04 (D-20 extra) | planned |
| TC-WF-05-01 | I | Task with active L1 | Assignee marks Done | → done, `closed_at`=now; escalations cleared; giver notified | WF-05, WO FR-2 | planned |
| TC-WF-06-01 | I | Submitted task | Reviewer = assignee tries; real reviewer rejects with no comment; then requests changes; decides again | 403; 422; → `changes_requested` + clock restarts; 409 (no pending round) | WF-06 | planned |
| TC-WF-07-01 | I | Critical task at L1 | MgrA reassigns to StaffA2; LeadA tries to reassign | Level −1; `clock_started_at`=now; assignee changed; LeadA 403 | WF-07, WO FR-6 | existing test: "reassigning restarts the clock for the new assignee", **passed 2026-11-04** |
| TC-WF-07-02 | I | Past-due task | MgrA reassigns | Past-due floor still applies; both people notified; log row `reassign` with before/after | WF-07 | planned |
| TC-WF-08-01 | I | Task with active escalations | Giver cancels with a reason | → `cancelled`; escalations resolved; assignee notified; no further engine activity | WF-08 | planned |
| TC-WF-09-01 | I | Completed task | Giver reopens with a past due date; then a future one | 422; then → `reopened`, clock restarts, ack cleared | WF-09 | planned |
| TC-WF-10-01 | I | Each F-ORG user | Compare `allowedActions` on detail with the result of calling each action | Every action not in the set returns 403/409; every listed action succeeds | WF-10, C-2 | planned |
| TC-WF-11-01 | I | — | Assignee marks Blocked with an empty reason | Rejected: 422 target (today **400**, asserted at `api.test.ts:287`; D-80) | WF-11, WO FR-2 | existing test: "marking a task Blocked alerts the team lead immediately", **passed 2026-11-04** |
| TC-WF-11-02 | I | Outside quiet hours | Assignee marks Blocked with a reason | Lead gets in-app `sent` and email queued | WF-11, **AC-3** | existing test: "marking a task Blocked alerts the team lead immediately", **passed 2026-11-04** |
| TC-WF-11-03 | I | Outside quiet hours; dispatcher enabled with a stub channel | Mark Blocked at T; run the dispatcher at its 15 s cadence until T+5 min | Lead's email and WhatsApp reach `sent` (stub) before T+5 min | **AC-3** | planned |
| TC-WF-11-04 | I | Lead in quiet hours | Mark Blocked | In-app immediate; email and WhatsApp `held` until 08:00 (D-85: does this satisfy AC-3?) | WF-11, NTF-03 | planned |
| TC-WF-11-05 | U+I | — | Mark a task Blocked; read its level | Task sits at least at L1 per the WO ladder ("L1 … or marked Blocked"). Today the server sends a one-off alert and keeps the level (`services/tasks.ts:152-156`); see D-91 | WF-11, ESC-03 | planned |

## EXT: Due-date extensions (and FR-5 direct change)

The FR-5 direct change is feature **EXT-04** (added after this inventory); its cases are filed under EXT-02 and apply to EXT-04.

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-EXT-01-01 | I | Active task | Assignee requests: earlier date; reason of 9 characters; valid request; a second request | 422; 422; 201 pending + approvers notified; 409 | EXT-01 | planned |
| TC-EXT-02-01 | I | Pending request | Requester decides; approver rejects with no note; approver approves | 403; 422; due date moves, past-due level recalculated, requester notified, audited | EXT-02 | planned |
| TC-EXT-02-02 | I | Normal task, due in 24 h | LeadA extends; LeadA extends again; MgrA extends | 200; 403; 200 | EXT-02, WO FR-5 | existing test: "a team lead can extend a due date once; a manager can extend again", **passed 2026-11-04** |
| TC-EXT-02-03 | I | Past-due task at L3 | MgrA extends with reason "Client delay" | Level −1; log row `due_change` with before.dueAt, after.dueAt and the reason | EXT-02, WO FR-5, ESC-02 | existing test: "past due reaches L1 at the due time, L2 at +24 h and L3 at +72 h whatever updates were posted; extending clears it", **passed 2026-11-04** |
| TC-EXT-02-04 | I | — | Staff calls the direct due change | 403 | EXT-02, WO FR-5 | planned |
| TC-EXT-03-01 | I | Requests on visible and invisible tasks | LeadA opens the queue | Only visible tasks; pending first; `canDecide` correct per row | EXT-03 | planned |

## CMT: Comments

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-CMT-01-01 | I | Critical task at L3 | LeadA comments; run the engine | 201; level stays 3 | CMT-01, **AC-4**, WO FR-4 | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once", **passed 2026-11-04** |
| TC-CMT-01-02 | I | — | StaffA2 (peer) and StaffA1 (other team) comment | 403 each | CMT-01, C-2 | existing test: "only the assignee can post updates; staff cannot assign", **passed 2026-11-04** (peer); and "a staff member cannot see another team’s tasks — tested through the API", **passed 2026-11-04** |
| TC-CMT-01-03 | I | — | Assignee comments | 201 and the clock is not reset (PRD allows assignee comments; today the server forbids them, `access.ts:73`) | CMT-01 | planned |
| TC-CMT-01-04 | I | — | Comment mentions `@Staff B1` (cannot view) and `@Manager A` | Only MgrA notified | CMT-01 | planned |
| TC-CMT-01-05 | I | — | Comment containing an SSN | 422 | CMT-01, C-6 | planned |
| TC-CMT-02-01 | I | Comment by LeadA | MgrA edits; LeadA edits | 403; 200 with `editedAt`; original text still in `activity_log` | CMT-02, D-12 | planned |
| TC-CMT-03-01 | I | Comment by LeadA | StaffA1 deletes; CoS deletes | 403; soft delete, body blanked in views, original recoverable from the log, audited | CMT-03, D-12 | planned |

## ATT: Attachments

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-ATT-01-01 | I | EMB task | StaffA1 uploads a file to it | 403, **and no new file in `UPLOAD_DIR`** | ATT-01, S-4 | planned |
| TC-ATT-01-02 | I | — | Upload limit + 1 byte | 413 with the configured limit in the message (D-13) | ATT-01 | planned |
| TC-ATT-01-03 | I | — | Upload `.html`, `.svg`, `.exe` | 422, type not allowed | ATT-01, S-5, SEC-8 | planned |
| TC-ATT-01-04 | I | — | Upload a known file | `sha256` matches; stored under a random key; log row links it | ATT-01 | planned |
| TC-ATT-02-01 | I | Attachment on a BAIS task | Download as assignee; as StaffB1; with the `aid` of another task's attachment | 200 with `Content-Disposition: attachment` and `nosniff`; 404; 404. [V-S] `routes/tasks.ts:127-143` | ATT-02 | planned |
| TC-ATT-02-02 | E | Image and PDF attachments | Preview in the UI | Inline preview only for image/PDF/text; other types download | ATT-02 | planned |
| TC-ATT-03-01 | I | Attachment by assignee | Peer removes; uploader removes | 403; removed from views; stored file and log row kept | ATT-03 | planned |

## ESC: Escalation engine

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-ESC-01-01 | U | Default rules | `silenceThresholds('critical')`; levels just before and at each | [4,6,8,12]; −1/0/1/2 before, 0/1/2/3 at | ESC-01, WO-D2/D3 | existing test: "critical: thresholds are 4 / 6 / 8 / 12 h", **passed 2026-11-04** |
| TC-ESC-01-02 | U | Default rules | Same for high | [24,36,48,72] | ESC-01 | existing test: "high: thresholds are 24 / 36 / 48 / 72 h", **passed 2026-11-04** |
| TC-ESC-01-03 | U | Default rules | Same for normal | [48,72,96,144] | ESC-01 | existing test: "normal: thresholds are 48 / 72 / 96 / 144 h", **passed 2026-11-04** |
| TC-ESC-01-04 | U | Default rules | Same for low | [72,108,144,216] | ESC-01 | existing test: "low: thresholds are 72 / 108 / 144 / 216 h", **passed 2026-11-04** |
| TC-ESC-01-05 | U | — | Critical at 3.99/4/6/8/12/500 h silent | −1/0/1/2/3/3 | ESC-01, **AC-1** | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h", **passed 2026-11-04** |
| TC-ESC-01-06 | I | Critical task LeadA → StaffA1 | Run the engine at T−1 min and T+4 min 59 s for each threshold | Level below before, reached within 5 min; recipients per level; each level fired once; L3 to CoS on email, in-app, WhatsApp | ESC-01, ESC-03, **AC-1**, AC-5 | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once", **passed 2026-11-04** |
| TC-ESC-01-07 | I | Critical task at L1 | Separately: comment, acknowledge, extension request, submission, send-back, reassign, reopen | Only submission, send-back, reassign and reopen (plus assignee update) reset the clock | ESC-01 | planned |
| TC-ESC-02-01 | U | Low task due at T+10 h | Levels at due, +24 h, +72 h | 1, 2, 3 | ESC-02, **AC-2** | existing test: "reaches at least L1 at the due time, L2 at +24 h and L3 at +72 h", **passed 2026-11-04** |
| TC-ESC-02-02 | U | Critical, clock just reset, 30 h past due | `computeLevel` | silenceLevel −1, overdueLevel 2, level 2, reason overdue | ESC-02, **AC-2** | existing test: "applies even when updates continue (clock just reset)", **passed 2026-11-04** |
| TC-ESC-02-03 | U | High task past due | Move the due date into the future | Level 2 → −1 | ESC-02, WO FR-5 | existing test: "extending the due date drops the past-due level", **passed 2026-11-04** |
| TC-ESC-02-04 | I | Normal task due in 10 h | Assignee posts an update at due+1 min, +24 h, +72 h; run the engine after each | Levels 1, 2, 3 regardless of updates | ESC-02, **AC-2** | existing test: "past due reaches L1 at the due time, L2 at +24 h and L3 at +72 h whatever updates were posted; extending clears it", **passed 2026-11-04** |
| TC-ESC-03-01 | U | Critical 13 h silent, 1 h past due | `computeLevel` | Level 3, reason silence | ESC-03 | existing test: "a task sits at the highest level any rule gives it", **passed 2026-11-04** |
| TC-ESC-03-02 | U | Overdue-only task at L2 | `levelApplies(0..3)` | false, true, true, false | ESC-03 | existing test: "L0 applies only while the assignee is silent; L1+ whenever the task sits at or above", **passed 2026-11-04** |
| TC-ESC-03-03 | I | Engine run twice at the same instant | Count escalations | No duplicates (unique active task+level index, `001_init.sql:141`) | ESC-03, NFR Reliability | planned |
| TC-ESC-04-01 | U | F-DIR | Route L0–L3 for staff 5 | L0 {5}; L1 {4} cc {5}; L2 {3} cc {4,5}; L3 {2,1} cc {3} | ESC-04, **AC-5** | existing test: "L0 → assignee; L1 → team lead (assignee cc); L2 → manager (lead, assignee cc); L3 → CoS + CEO (manager cc)", **passed 2026-11-04** |
| TC-ESC-04-02 | U | `l3NotifyCeo=false` | Route L3 | to {2} cc {3} | ESC-04, WO-D7 | existing test: "D7 off: L3 reaches only the Chief of Staff", **passed 2026-11-04** |
| TC-ESC-04-03 | U | Lead 6 has no manager | Route L1, L2 for staff 7 | L1 {6}; L2 {2} | ESC-04 | existing test: "no manager above a lead: L2 goes straight to the Founder’s Office (Chief of Staff)", **passed 2026-11-04** |
| TC-ESC-04-04 | U | Staff 8 has no lead | Route L1 | {3} cc {8} | ESC-04 | existing test: "no team lead: L1 goes to the manager", **passed 2026-11-04** |
| TC-ESC-04-05 | U | Lead's own task | Route L1 for user 4 | {3} cc {4} | ESC-04 | existing test: "a lead’s own task skips to the next level up", **passed 2026-11-04** |
| TC-ESC-04-06 | U | Lead 4 archived | Route L1 for staff 5 | {3} | ESC-04, STAFF-03 | existing test: "archived people are skipped", **passed 2026-11-04** |
| TC-ESC-04-07 | U | User holding lead + staff (D-8) | Route that user's own task, and a report's task | Own task skips to their manager; report's task goes to them at L1 | ESC-04, D-8 | planned |
| TC-ESC-05-01 | I | Critical task at L3, not acknowledged | Advance by one window repeatedly | One `repeat` per window to the top level's recipients | ESC-05 | planned |
| TC-ESC-06-01 | I | Critical task at L3 | CoS acks L3 with a note; run the engine at +8 h, then +12 h 2 min | Level stays 3; no repeat while acknowledged; repeats resume after 12 h | ESC-06, ESC-05, WO FR-9 | existing test: "acknowledging pauses repeat alerts for 12 h but does not reset the clock", **passed 2026-11-04** |
| TC-ESC-06-02 | I | Same | Copied assignee acks L1 | 403 (who may ack: D-84) | ESC-06 | existing test: "acknowledging pauses repeat alerts for 12 h but does not reset the clock", **passed 2026-11-04** |
| TC-ESC-06-03 | I | Active escalation | Ack with an empty note | 422 (today 400, `services/tasks.ts:279`) | ESC-06, WO FR-9 | planned |
| TC-ESC-06-04 | I | Cleared escalation | Ack it | 409 (today 400, `services/tasks.ts:286`) | ESC-06 | planned |
| TC-ESC-07-01 | I | `dueSoonHours=24` | Advance to due−24 h, then past due | Due-soon to assignee once; overdue to assignee and giver once; none repeated for the same due date | ESC-07 | planned |
| TC-ESC-08-01 | I | Production config | Start the server with `ENGINE_INTERVAL_MS` unset, then 600000 | Default 60 s; 600 s refused or warned (must be ≤ 5 min) [A] | ESC-08, WO FR-8 | planned |
| TC-ESC-08-02 | M | Pilot env | Create a Critical task; watch `escalations.fired_at` against the threshold | Every level fires within 5 min of its threshold in real time | ESC-08, **AC-1** | planned |
| TC-ESC-08-03 | I | Two app instances on one DB | Run both schedulers through a threshold | One escalation per level; one digest; one chain check (S-15) | ESC-08 | planned |
| TC-ESC-09-01 | U | Critical 5 h silent | `computeLevel(...).next` | `{level:1, at:T+6h}`; null at L3 | ESC-09 | existing test: "predicts the next climb", **passed 2026-11-04** |
| TC-ESC-09-02 | I | Escalations in both lines | LeadA opens the escalations workspace | Only visible tasks, own tasks excluded (non-CoS); top level, since, recipients, next level, `canAck` | ESC-09 | planned |

## NTF: Notifications

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-NTF-01-01 | I | Notifications for 2 users | StaffA1 lists, marks one read, marks all read | Only own; unread count updates | NTF-01 | planned |
| TC-NTF-02-01 | I | Critical task reaches L3 | Read `notifications` for the CoS | email, in-app and WhatsApp rows | NTF-02, **AC-5** | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once", **passed 2026-11-04** |
| TC-NTF-02-02 | I | Stub WhatsApp and SMTP at the channel boundary | Fire L1; run the dispatcher | Lead receives both; WhatsApp uses an approved template name from `docs/whatsapp-templates.md`; message links to the task; rows `sent` | NTF-02, **AC-5** | planned |
| TC-NTF-02-03 | I | Stub that always fails | Run the dispatcher 4 times across 15 min | Attempts 1–3 with 5/10 min backoff, then `failed` | NTF-02 | planned |
| TC-NTF-02-04 | I | A row stuck in `sending` for 30 min | Run the dispatcher | Row recovered and retried (S-14) | NTF-02 | planned |
| TC-NTF-02-05 | I | StaffA2 has no phone; another user not opted in | Fire L0 for each | WhatsApp row `skipped`; email and in-app still sent | NTF-02 | planned |
| TC-NTF-02-06 | M | Pilot env, real credentials, approved templates (WO-D6) | Trigger L0–L3 and Blocked for a pilot task | Each person receives WhatsApp and email; delivery log shows `sent` per channel | NTF-02, **AC-5** | planned |
| TC-NTF-03-01 | U | 16:00 UTC | `isQuietTime` IST vs PT | IST quiet, PT not | NTF-03, AC-9 | existing test: "is quiet in IST and not in PT at the same instant", **passed 2026-11-04** |
| TC-NTF-03-02 | U | — | IST 20:59, 21:00, 07:59, 08:00 | not, quiet, quiet, not | NTF-03, WO-D4 | existing test: "boundaries: 20:59 not quiet, 21:00 quiet, 07:59 quiet, 08:00 not quiet", **passed 2026-11-04** |
| TC-NTF-03-03 | U | — | `quietEndsAt` IST and PT | 08:00 local next morning | NTF-03 | existing test: "held alerts are released at 08:00 local", **passed 2026-11-04** |
| TC-NTF-03-04 | I | Task created 17:00 IST | Run the engine through L0, L1, L2 | L0/L1 WhatsApp and email `held` until 08:00 IST; L2 email to the PT manager `pending`; in-app `sent` | NTF-03 | existing test: "holds L0/L1 WhatsApp and email during the recipient’s quiet hours; L2 always goes out", **passed 2026-11-04** |
| TC-NTF-03-05 | I | Held rows | Advance to `send_after`; run the dispatcher | Rows dispatched | NTF-03 | planned |
| TC-NTF-04-01 | I | — | StaffA1 turns off email for `escalation`, and for `progress` | Mandatory type refused (422); optional saved and honoured | NTF-04 | planned |
| TC-NTF-05-01 | I | Monday 09:00 IST | Run the digest job twice | One email per manager (own line) and per FO member (whole org); red items, repeat offenders, on-time trend; second run sends nothing (`job_runs`) | NTF-05, WO FR-12 | planned |
| TC-NTF-05-02 | I | — | StaffA1, MgrA and CoS trigger the manual digest | Staff 403; manager per D-93; CoS 200 and audited | NTF-05 | planned |
| TC-NTF-06-01 | I | No SMTP or WhatsApp credentials | Fire L0; run the dispatcher | Rows `simulated`, never `sent` | NTF-06 | planned |

## REC: Recurring tasks

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-REC-01-01 | I | Schedules by LeadA and LeadB | LeadA lists | Own and reports' schedules only; CoS sees all | REC-01 | planned |
| TC-REC-02-01 | I | — | Create with an unknown entity; a weekly schedule with no weekday; an I-94 number in the title | 422 each (unknown entity is a 500 today, S-8) | REC-02, C-6 | planned |
| TC-REC-02-02 | I | Schedule by LeadA | MgrB edits; LeadA edits | 403; 200 | REC-02 | planned |
| TC-REC-03-01 | I | Schedule by LeadA | StaffA1 pauses; LeadA pauses; CoS resumes | 403; 200 + audit row; 200 + audit row (S-10: no audit today) | REC-03 | planned |
| TC-REC-04-01 | I | Weekly Monday 10:00 IST schedule | Advance to `next_run_at`+1 min; run twice | One task; second run 0; next run +7 days; assigner = owner | REC-04, WO FR-7 | existing test: "weekly recurring tasks are generated on schedule", **passed 2026-11-04** |
| TC-REC-04-02 | I | Daily, and monthly on the 31st, assignee in PT | Run through a month end and a DST change | Generated on the right local day; one per occurrence | REC-04, D-5 | planned |
| TC-REC-04-03 | I | Server down for 3 days | Run | No backfill (documented behaviour); exactly one next occurrence | REC-04 | planned |

## DASH: Dashboards and team

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-DASH-01-01 | I | Tasks from earlier tests | CoS `GET /api/reports/accountability?days=30` (was `/api/dashboard`, moved 2026-11-06); compare BAIS with SQL counts | open, red, amber and blocked equal | DASH-01, **AC-8** | existing test: "entity figures match a manual count", **passed 2026-11-04** |
| TC-DASH-01-02 | M | Pilot env | Pick 20 tasks for one entity; count by hand | Dashboard equals the hand count | **AC-8** | planned |
| TC-DASH-01-03 | I | Constructed history | Check by-person open, average first response, escalations, on-time % and by-entity longest silence | Equal to hand-computed values | DASH-01, WO FR-11 | planned |
| TC-DASH-01-04 | E | A task at L3 | CoS and CEO open the dashboard | L3 banner at the top; not shown to MgrA for other lines | DASH-01, WO notifications table | planned |
| TC-DASH-02-01 | I | — | MgrA `GET /api/team/overview`; StaffA1 the same | Exactly LeadA, StaffA1, StaffA2; open = SQL count; ≤14 workload rows sorted; no email; staff 403 | DASH-02 | **passed 2026-11-07** (owner's `npm test`) |
| TC-DASH-03-01 | I | — | StaffB1 `GET /api/reports/accountability` (moved 2026-11-06) | `byPerson` contains only StaffB1 | DASH-03, **AC-6** | existing test: "a staff member’s dashboard only covers themselves", **passed 2026-11-04** |
| TC-DASH-03-02 | I | — | LeadA `GET /api/dashboard` | Lead layout; every named task is visible to LeadA; workload only LeadA's reports; no staff/staffByRole/orgMini/recentAdmin | DASH-03, **AC-6** | **passed 2026-11-07** (owner's `npm test`) |
| TC-DASH-03-03 | I | — | StaffB1 `GET /api/dashboard?range=7` | Staff layout; every task named anywhere is StaffB1's own; no org-wide fields; `me` present (PERF-07) | DASH-03-AC-1/3, **AC-6** | **passed 2026-11-07** (owner's `npm test`) |
| TC-DASH-01-05 | I | Tasks from earlier tests | CoS `GET /api/dashboard?entity=BAIS` | BAIS active/overdue/escalated equal the list API and SQL counts | DASH-01-AC-7, **AC-8** | **passed 2026-11-07** (owner's `npm test`) |
| TC-DASH-01-06 | I | — | LeadA `?entity=BAIS`, `?range=15`; CoS `?entity=NOPE`; CEO `?entity=EMB` | 403; 422 range; 422; 200 with EMB only | DASH-01 | **passed 2026-11-07** (owner's `npm test`) |
| TC-DASH-03-04 | S | — | Search `client/src/features/dashboard/*` and `features/staff/TeamPage.tsx` for `getDb` / `mock/store` | No match | DASH-03-AC-4 | **passed 2026-11-06** |
| TC-DASH-01-07 | E | Dev data | Open `/` as CoS, manager, lead, staff (server mode) and CoS (mock mode) | Each layout renders, no console errors; manager sees no L3 banner | DASH-01 | **passed 2026-11-06** (manual browser check) |
| TC-DASH-U-01 | U | — | `server/test/insights.test.ts` | Health, attention, KPI, bucket, zone, layout boundaries (DASH-01-AC-2…5, AC-9) | DASH-01 | **passed 2026-11-06** (16/16) |

## RPT: Reports

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-RPT-01-01 | I | — | Report as CoS (org), MgrA (team), StaffA1 (neither) | Org scope; team scope; 403 | RPT-01 | planned |
| TC-RPT-02-01 | I | — | Each of the 9 reports with from > to | 422 | RPT-02 | planned |
| TC-RPT-03-01 | I | — | CoS downloads CSV and PDF | CSV contains "By entity"; PDF starts with `%PDF`, content-type `application/pdf` | RPT-03, WO FR-11 | existing test: "entity figures match a manual count", **passed 2026-11-04** |
| TC-RPT-03-02 | U | — | `csvCell` on `=1+1`, `+x`, `-x`, `@x`, `\t=x`, `\r=x` | All neutralised (tab and CR are missed today, S-13) | RPT-03 | planned |
| TC-RPT-03-03 | I | — | MgrA exports | Only MgrA's line in the file | RPT-03, DASH-03 | planned |
| TC-RPT-04-01 | I | — | LeadA loads filter options | Only people and teams in scope | RPT-04 | planned |

## STAFF / ORG / ROLE

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-STAFF-01-01 | I | — | Directory as CoS, LeadA, StaffA1 | All; self + reports + managers; self + managers | STAFF-01 | planned |
| TC-STAFF-02-01 | I | — | CoS creates a person with `USER5@EXAMPLE.COM` | 409 or 422 `fields.email`, never 500 (S-8) | STAFF-02 | planned |
| TC-STAFF-02-02 | I | — | Set LeadA's manager to StaffA1 | 409 loop | STAFF-02, ORG-02 | planned |
| TC-STAFF-02-03 | I | Exactly one active CoS | CoS removes their own `cos` role; CoS edits another's role without `manage_roles` | 403 / 409 | STAFF-02, S-9 | planned |
| TC-STAFF-02-04 | I | — | MgrA creates a person | 403 | STAFF-02 | planned |
| TC-STAFF-02-05 | I | — | Give LeadA roles `lead`+`staff`; WhatsApp `12345`; invalid time zone | Union of permissions; 422; 422 | STAFF-02, D-8 | planned |
| TC-STAFF-03-01 | I | StaffA1 signed in | CoS deactivates StaffA1; StaffA1 calls an API at once | 401 on the very next request, also on a second instance (S-7) | STAFF-03 | planned |
| TC-STAFF-03-02 | I | — | Any `DELETE` on people; check rows after archive | No delete route; user row and their tasks kept; `archived_at` set | STAFF-03, WO "Retention" | planned |
| TC-STAFF-03-03 | I | — | CoS archives self; archives the last CoS | 400/409 each | STAFF-03 | planned |
| TC-STAFF-04-01 | I | — | LeadA opens MgrB's profile | 403/404; LeadA's own profile shows only visible tasks | STAFF-04 | planned |
| TC-ORG-01-01 | E | — | CoS opens the org tree | Tree matches `manager_id`; load badges match open counts | ORG-01 | planned |
| TC-ORG-02-01 | I | — | Move StaffA1 to LeadB (manager + team) with a fault injected after the first write | All or nothing; on success routing for StaffA1's tasks follows the new line on the next engine run | ORG-02, C-7 | planned |
| TC-ROLE-01-01 | I | — | MgrA and CoS open the matrix | 403; 200 with counts | ROLE-01 | run: pass 2026-11-04 (owner, `npm test` 92/92) |
| TC-ROLE-02-01 | I | — | Edit the CoS column; add an unknown permission; remove `assign_tasks` from lead | 403; dropped; audited with added/removed; LeadA's next create returns 403 | ROLE-02 | run: pass 2026-11-04 (owner, `npm test` 92/92) — live effect shown on `/api/roles`; task actions follow after T-3.2 |

## POL / SET / AUD / DLV / SRCH / DEMO

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-POL-01-01 | U | Critical window 2 h, multiples 1/2/3/4 | `silenceThresholds`; level at 6 h | [2,4,6,8]; L2 | POL-01 | existing test: "honours edited windows and multiples (per-entity rules)", **passed 2026-11-04** |
| TC-POL-01-02 | I | — | MgrA `PUT /api/rules/default`; CoS saves non-increasing multiples; CoS saves valid rules | 403; 422; 200 + `admin_log` diff + open tasks re-evaluated | POL-01, WO "every change is logged" | planned |
| TC-POL-01-03 | I | — | CoS sets a BAIS override; check a BAIS and an EMB task; `DELETE /api/rules/BAIS` | Only BAIS uses the override; reset restores defaults | POL-01, D-7 | planned |
| TC-POL-01-04 | I | — | `PUT /api/rules/NOPE` | 422 (400 today, `rules.ts:26`) | POL-01 | planned |
| TC-POL-02-01 | U | — | Simulator output vs server `computeLevel` on 100 random inputs | Identical (shared module, D-9) | POL-02 | planned |
| TC-SET-01-01 | I | — | Save settings: timeout 4; zone `Mars/Base`; `retentionYears` 5; valid | 422; 422; ignored or 422 (fixed at 7); 200 + audit | SET-01 | planned |
| TC-AUD-01-01 | I | Task with log rows | `DELETE /api/tasks/:id`, `PUT /api/tasks/:id/log/1`; SQL update, delete, truncate on `activity_log` | 404, 404; each SQL statement rejected "append-only" | AUD-01, **AC-7** | existing test: "activity log rows cannot be edited or deleted, by any endpoint or directly", **passed 2026-11-04** |
| TC-AUD-01-02 | I | Clean chain | Chain check; alter a row with triggers bypassed; chain check again | ok, then not ok with the break; CoS notified `chain_break`; task detail `chain.ok=false` | AUD-01, **AC-7** | existing test: "the hash check flags a row altered directly in the database", **passed 2026-11-04** |
| TC-AUD-01-03 | I | App started | Enumerate every route in the Express router; call each PUT/PATCH/DELETE | None modifies or removes an `activity_log` or `admin_log` row (row counts and hashes unchanged) | AUD-01, **AC-7** | planned |
| TC-AUD-01-04 | I | `NIGHTLY_TZ` | Advance past 02:00 local twice in one day, then the next day | Exactly one `chain_check` per local day (`job_runs`) | AUD-01, **AC-7** | planned |
| TC-AUD-01-05 | I | — | `GET /api/admin/audit` as MgrA and CoS | 403; 200 | AUD-01 | planned |
| TC-AUD-01-06 | I | — | Perform each WO event: assign, update, comment, state change, due change, reassign, escalation, ack | One log row each, with server UTC time, actor and before/after | AUD-01, C-5 | planned |
| TC-DLV-01-01 | I | Mixed notifications | Outbox as StaffA1 and CoS | StaffA1: own rows only; addresses and provider errors shown only to authorised roles (S-16) | DLV-01, SEC-9 | planned |
| TC-DLV-01-02 | I | L1 fired | Read the delivery log | One row per channel per recipient with status and template | DLV-01, **AC-5** | planned |
| TC-DLV-02-01 | I | 40 deliveries for StaffA1 | My deliveries | Last 30, own only | DLV-02 | planned |
| TC-SRCH-01-01 | I | Matching tasks in both lines | StaffA1 searches a shared word | Only visible tasks (≤8) and people (≤6) | SRCH-01, **AC-6** | planned |
| TC-SRCH-01-02 | I | — | 100 searches in 10 s | Throttled (429, D-82) | SRCH-01, SEC-3 | planned (limit is 120/min) |
| TC-SRCH-01-03 | I | — | StaffB1 searches another line's task id; LeadA searches the id, "Lead B", "Manager A", "a", "%", "", 101 chars | none; exact id first; none; found; ≤8/≤6 and no email; empty; empty; 422 | SRCH-01-AC-1…5, **AC-6** | **passed 2026-11-07** (owner's `npm test`) |
| TC-DEMO-01-01 | I | `NODE_ENV=production` | `POST /api/dev/clock` as CoS | 404/403; clock unchanged | DEMO-01, SEC-10 | written 2026-11-07 (`api.test.ts` "Demo clock": 404 for CoS and manager with demo tools off; gate unit test `config.test.ts` covers `NODE_ENV=production`); not run (owner `npm test`) |
| TC-DEMO-01-02 | I | Dev, `DEMO_TOOLS=true` | `POST /api/dev/clock` as MgrA and as CoS | 403; 200 + `admin_log` `demo_clock` | DEMO-01 | written 2026-11-07 (`api.test.ts`; also 422 for -1, 721, unknown field); not run (owner `npm test`) |
| TC-DEMO-01-03 | E | Production build | Sign in as each persona | No demo bar for anyone | DEMO-01 | partial 2026-11-07: server-mode production build scanned, no "Act as", "Scenarios", "Reset data", "Expire session" or demo password; e2e sign-in pass not written |

## PERF (Performance, progress & workload)

| ID | Level | Given | When | Then | Covers | Status |
|---|---|---|---|---|---|---|
| TC-PERF-01 | U | Owner's worked example | `personScore` / `combine` | O 86.67, T 80, Q 90; scores 92.5 / 90.0 / 87.1 / 80.5; caps, exclusions, ranking floor and ties, periods, workload bands | PERF-04, PERF-06 | `server/test/performance.test.ts`, passing (agent) |
| TC-PERF-02 | I | A lead creates tasks | estimate/purpose/unit/target rules; draft then publish; schedule carries fields | 422 per field; generated task carries the measures | PERF-01 | `api.test.ts` "PERF Task 2", owner green 2026-11-06 |
| TC-PERF-03 | I | An assignee reports | achieved 70/150; complete short or late | progress 47, clock restarts; reason required | PERF-02 | "PERF Task 3", owner green |
| TC-PERF-04 | I | Review and Rate | approve without scores; giver rates; others rate; accept a blocked delay | 422 / 200 / 403 / 200 | PERF-03 | "PERF Task 4", owner green |
| TC-PERF-05 | I | Two teams | leaderboard, teams, breakdown, workload, picker | scores per formula; own team only for staff; 404 outside scope and across organizations; extended due moves period | PERF-05, PERF-06 | "PERF Task 5", owner green (teams assertions added in Batch B: re-run) |
| TC-PERF-06 | E (manual) | Maria, Priya, Sofia on dev | create → report → complete short → rate; open pages | tag, facts, activity, board, breakdown exclusions, workload; Sofia sees own team only | PERF-01…06 | browser-checked 2026-11-06 |

## Cross-cutting (PRD C-1…C-7, NFR SEC)

| ID | Lvl | Pre | Steps | Expected | AC | Status |
|---|---|---|---|---|---|---|
| TC-C1-01 | I | — | Call every non-auth route with no cookie | 401 on each | C-1, SEC-1 | planned |
| TC-SEC1-01 | I | Fixtures with one object of each kind per line | For every `:id` route, call as an out-of-scope user | 403/404 per D-81; no data in the body | SEC-1, **AC-6** | planned ([SECURITY_TEST_PLAN.md §3](SECURITY_TEST_PLAN.md)) |
| TC-C3-01 | I | — | Send an invalid create-task body | 422 `{error, fields}` with the field names the UI uses | C-3 | planned |
| TC-C5-01 | I | — | — | See TC-AUD-01-06 | C-5 | planned |
| TC-C6-01 | U | — | `findSensitiveId` on each pattern and on near-misses (dates, phone numbers, "A1 priority") | Each pattern caught; near-misses pass | C-6 | planned |
| TC-C7-01 | I | Task at L1 | Assignee posts an update; check the level **before** any engine run | Level −1 at once | C-7 | existing test: "acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once", **passed 2026-11-04** (asserts level −1 right after the update, `api.test.ts:257`) |
| TC-SEC4-01 | I | — | `POST /api/tasks` without `x-taskwatch` | 403 | SEC-4, S-3 | existing test: "rejects state-changing requests without the TaskWatch header", **passed 2026-11-04** |

## Counts

| Area | Cases | Mapped to an existing server test |
|---|---|---|
| AUTH | 16 | 0 |
| TASK | 24 | 5 |
| WF | 21 | 5 |
| EXT | 6 | 2 |
| CMT | 7 | 2 |
| ATT | 7 | 0 |
| ESC | 32 | 21 |
| NTF | 16 | 5 |
| REC | 7 | 1 |
| DASH | 7 | 2 |
| RPT | 6 | 1 |
| STAFF / ORG / ROLE | 10 / 2 / 2 | 0 / 0 / 0 |
| POL / SET / AUD / DLV / SRCH / DEMO | 5 / 1 / 6 / 3 / 2 / 3 | 1 / 0 / 2 / 0 / 0 / 0 |
| Cross-cutting (C-n, SEC-n) | 7 | 2 |
| **Total** | **190** | **49 case mappings, covering all 38 existing tests** |

All 38 existing tests appear at least once (some cover several cases). Every case marked "existing" **passed on 2026-11-04** (`npm test`, 43/43).

## Proposed D-numbers used in these docs

> **Superseded:** consolidated, de-duplicated and given defaults in [OPEN_QUESTIONS §8](../01-discovery/OPEN_QUESTIONS.md). That list is authoritative; this table is kept for traceability.

These are proposed and **not yet in** [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md). Until the owner of that file adds them, this list is where they are defined.

| # | Question |
|---|---|
| D-80 | Validation errors: 400 (server zod handler, `middleware.ts:73-76`; asserted at `api.test.ts:287`) or 422 + `fields` (PRD C-3)? |
| D-81 | An object outside the viewer's scope: 403 (`queries.ts:162`, asserted at `api.test.ts:166`) or 404 (PRD C-3; attachments `routes/tasks.ts:135`)? |
| D-82 | Rate limiting needs a status (429 + `Retry-After`) that C-3 does not list. Adopt it? |
| D-83 | The FR-5 direct due-date change (lead once / manager / CoS) has no feature ID; EXT covers only request/approve, and TASK-03 lets the giver change dates freely. Add an ID and reconcile with TASK-03? |
| D-84 | Who may acknowledge an escalation: `to` recipients only (server, `api.test.ts:310`), to + cc (PROJECT_OVERVIEW §1.6 [A]), or recipients + overseers (PRD ESC-06)? |
| D-85 | AC-3 "within 5 minutes": does an in-app alert count when the lead is in quiet hours and email/WhatsApp are held (PRD WF-11)? |
| D-87 | `npm start` loads `../.env` if present (`server/package.json:8`), against the WO secrets rule. Change the production start command? |
| D-88 | README says `npm run dev` starts API + web (README.md:30,173); it starts the client only (`package.json:11`). Fold into D-19? |
| D-89 | How is 2FA evidenced for Google sign-ins of manager/CoS/CEO (Workspace 2SV is outside the app)? Admin-console attestation, or TOTP for those roles on Google too? |
| D-91 | WO ladder: L1 includes "marked Blocked"; PRD WF-11 agrees; the server only sends a one-off lead alert and leaves the level unchanged (`services/tasks.ts:152-156`). Raise the level to L1? |
| D-92 | Task title limits: server 3–200 (`routes/tasks.ts:52`) vs PRD 4–140. Which wins? |
| D-93 | Manual digest: server lets managers send one to themselves (`admin.ts:47-52`); PRD NTF-05 restricts manual sending to `manage_system_settings`. Keep the manager self-preview? |
