# Notifications & Delivery Log FRD (NTF / DLV)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (paths relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 (auth, server-side authz, 422 envelope, server time, logging, sensitive-ID guard, escalation re-evaluation) are defined once in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md) and are not repeated here.
> WhatsApp template names, bodies and variable order are authoritative in [docs/whatsapp-templates.md](../../whatsapp-templates.md). This FRD only says **when** each template is used.
> Nothing here has been executed. No test has been run.

## 0. Scope and source of truth

| Item | Authority |
|---|---|
| Who gets what, on which channel | WO "Notifications and integrations" table: new task and L0–L3 go on WhatsApp, email and in-app; the weekly digest is email only; L3 also sits "top of dashboard" (see [DASHBOARD-FRD DASH-01 §L3 banner](DASHBOARD-FRD.md#dash-01-role-dashboard)). [WO] |
| Recipient routing per level | ESC-04 in [PRODUCT_REQUIREMENTS.md §2.6](../PRODUCT_REQUIREMENTS.md). Not repeated here. |
| Delivery mechanics (rows per channel, retries, holds, simulation) | Existing server `notify/*` is kept (D-1). [V-S `notify/notify.ts:18-75`, `notify/dispatcher.ts:35-80`] |
| Notification types and preferences | Client model `types/index.ts:225-238`, `services/channels.ts:80`. [V-C] |

Notification types (13 today, [V-C `types/index.ts:225-238`]): `assignment`, `reassignment`, `due_soon`, `overdue`, `escalation`, `escalation_ack`, `progress`, `review_required`, `review_decision`, `extension_request`, `extension_decision`, `mention`, `completed`. This FRD adds `blocked` (NTF-07) and `system_alert` (NTF-08).

**Built 2026-11-05 (T-6.1…T-6.4, Phase 6 Batch A; server only, client in T-6.9).**
- Types, mandatory types (assignment, reassignment, escalation, blocked per D-42, system_alert), default preferences and the event → type map live in `shared/notifications.ts`. Stored `notifications.event` values are unchanged (evidence); the type is derived when read (`typeOfEvent`), as the activity log does. This replaces the "map events in a migration" plan in DATABASE_DESIGN §3.9. Unmapped server notices: D-107.
- **D-106 applied:** `WHATSAPP_ENABLED = false`. The notifier writes no WhatsApp rows, the dispatcher claims email only, preferences report `whatsappTypes: []` and `whatsappAvailable: false`. Old WhatsApp rows stay as they are (8 legacy `held` rows in dev are never sent).
- NTF-04: `GET/PUT /api/me/notification-prefs` (`services/prefs.ts`, table `notification_prefs`, audit `preferences.updated`). Each channel is independent (D-43). Server notices that used to be in-app only now follow the preferences, so e.g. review requests also email by default, as in the prototype.
- NTF-01: `GET /api/notifications?unread&type&limit(1–100, default 50)&before`, `PATCH /api/notifications/:id {read}` (404 when not own), `POST /api/notifications/read-all → {count}`. Delivery tags come from rows linked by `parent_id` (new rows only; older rows show none). The old `POST /api/notifications/read` is replaced.
- NTF-02: rows left in `sending` for over 10 min are claimed again (`claimed_at`, migration 012). Skip text is "Has not opted in to WhatsApp alerts".
- **Batch B (T-6.5…T-6.9, 2026-11-05).** DLV-01: `GET /api/deliveries` (`view_audit_logs`; a CoS sees the organization, anyone else their own rows, D-52; last 30 days, newest 2000, filters and counts on the page per D-10; `copied` from the escalation's cc list; `integrations` = email live/simulated, WhatsApp off). DLV-02: `GET /api/me/deliveries` (30). `/api/outbox` is replaced. NTF-05: digest sent per organization on its Settings day/hour in IST (D-44; job key `<week>:<org>`); `POST /api/admin/digest` `all` needs `manage_system_settings` and audits `digest.sent_manually`, `me` needs the caller to be a recipient. NTF-06: no new code (T-3.7 already derives the flags); Settings shows "Email: simulated/live". NTF-08: already built (T-1.9/T-4.13). Client (T-6.9): bell, inbox, Account preferences and "Messages sent to you", Delivery Log and staff dialog quiet hours run on the server; WhatsApp UI hidden in both modes (D-106); the bell, the badges and every open screen refresh every 60 s while the tab is visible, and at once when it becomes visible again (2026-11-10, owner request); CSV cells starting with = + - @ are quoted.
- NTF-03 + D-105: `users.quiet_start/quiet_end` (migration 012), set through `POST/PUT /api/people` (`quietStart`, `quietEnd`; both or neither; omitted on edit = unchanged). Held rows store the reason "Quiet hours HH:MM–HH:MM (zone)". The organization's switch governs personal windows too (D-108).

---

## NTF-01 In-app inbox

**Description.** Each user's own in-app notifications: full page, bell popover with the 8 newest, unread badge, mark one read/unread, mark all read.

**Roles.** Every signed-in active user, for their own notifications only. [V-C `services/api/misc.ts:74-92`]

**User actions (UI).**
- Open `/notifications`; filter All/Unread and by type (client-side). [V-C `features/notifications/NotificationsPage.tsx:12-15`]
- Click a row: marks it read and opens `/tasks/:taskId`. [V-C `NotificationsPage.tsx:62`]
- Toggle read/unread per row. [V-C `NotificationsPage.tsx:19, :87`]
- "Mark all read" → toast `Marked N as read` or `Nothing unread`. [V-C `NotificationsPage.tsx:18, :33`]
- "Preferences" → `/settings/account#notifications`. [V-C `NotificationsPage.tsx:30`]
- Bell: 8 newest, "Mark all read", click row → mark read + open task; empty text "You're all caught up." [V-C `app/Shell.tsx:240-304`]
- Unread badge on nav and bell. [V-C `Shell.tsx:25`]

**Expected behaviour.**
- List is newest first. [V-C `misc.ts:75`]
- Each row shows its email/WhatsApp delivery tags (sent / held / skipped). Today they are read from the raw store (`NotificationsPage.tsx:73-82`); the API must return them per row. [V-C]
- The bell and badge must refresh without a page reload. Today they only refresh on store change and the 30 s browser tick (`App.tsx:62-72`). Proposed: refetch every 60 s while the tab is visible. [A]

**Data required.** Server `notifications` row with `channel='inapp'` is the inbox item; sibling `email`/`whatsapp` rows for the same event give the delivery tags. [V-S `notify/notify.ts:39-44`] Fields: id, type, title/subject, body, taskId, createdAt, readAt. A `read=false` toggle needs `read_at` to be settable back to null. [A]

**Backend processing.** Pure reads and an own-row `read_at` update. Server time for `read_at` (C-4).

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/notifications?unread=true\|false&type=<type>&limit=50&before=<id>` | — | `{unread:number, items:[{id,type,title,body,taskId,at,read,deliveries:[{channel,status}]}], next:<id>\|null}` | Yes: `GET /notifications` (latest 40 in-app + unread count) [V-S `routes/notifications.ts:11-33`]. Add type filter, paging, delivery tags. |
| PATCH | `/api/notifications/:id` | `{read:boolean}` | `204` | Partly: `POST /notifications/read {ids?}` only marks read [V-S `routes/notifications.ts:35-43`]. Add unread. |
| POST | `/api/notifications/read-all` | `{}` | `{count:number}` | Yes: same route with no `ids`. Must return the count (UI toast). [V-C `NotificationsPage.tsx:18`] |

**Validation.** `read` must be boolean; `type` must be a known type; `limit` 1–100 [A]; unknown body fields rejected (SEC-7).

**Authorization.** Only rows with `user_id = session user` (C-2). Another user's id → **404 "Notification not found."** (not 403, so ids can't be probed). [V-C `misc.ts:80-81`]

**Success / failure.** 200/204 on success; 401 signed out (C-1); 404 not found or not own; 422 bad `read`.

**Dependencies.** AUTH-06 (session), NTF-02 (delivery rows), every module that calls `notify()`.

**Acceptance criteria.**
1. NTF-01-AC-1: `GET /api/notifications` returns only the caller's in-app rows, newest first, and `unread` equals the count of their rows with `read=false`.
2. NTF-01-AC-2: `PATCH /api/notifications/:id` on another user's notification returns 404 and changes nothing.
3. NTF-01-AC-3: `POST /api/notifications/read-all` returns the number of rows it changed; a second call returns 0.
4. NTF-01-AC-4: Each item carries the delivery status of its email and WhatsApp siblings; no other user's delivery data is returned.
5. NTF-01-AC-5: The UI no longer reads `getDb().deliveries` or `getDb().notifications` (`NotificationsPage.tsx:73`, `Shell.tsx:24, :245-248`).

**Test scenarios.** List own only · unread count after mark one / mark all / mark unread · cross-user id → 404 · type filter · paging boundary · deliveries tags present for email and WhatsApp, absent for in-app-only notices · signed out → 401.

---

## NTF-02 Email + WhatsApp dispatch

**Description.** Every alert fans out to in-app, email and WhatsApp per the WO ("WhatsApp first, email always, in-app always") and the user's preferences (NTF-04), through a server dispatcher with retries. [WO; V-S `notify/notify.ts:13-17`]

**Roles.** System (engine, workflow actions). Recipients are any active user. Inactive recipients are skipped. [V-C `services/core.ts:38`; V-S `notify/notify.ts:31`]

**User actions (UI).** None directly. Results are visible in NTF-01, DLV-01 and DLV-02.

**Expected behaviour.**
- **Mandatory types** `assignment`, `reassignment`, `escalation` always go to in-app, email and WhatsApp regardless of preferences. [V-C `services/channels.ts:79-80`; WO event table] Whether `blocked` is also mandatory: [D-42, decided].
- Recipients are de-duplicated per call. [V-C `core.ts:33`; V-S `notify.ts:27-29`]
- **Template choice** (WhatsApp only; bodies in [whatsapp-templates.md](../../whatsapp-templates.md)):

  | Event | Template | Evidence |
  |---|---|---|
  | `assignment` / `reassignment` to the **new** assignee | `taskwatch_task_assigned` | [V-C `channels.ts:86-87`; V-S `notify/messages.ts:39-52`] |
  | `escalation` L0 (and its repeats) | `taskwatch_update_reminder` | [V-C `channels.ts:88`; V-S `messages.ts:71-80`] |
  | `escalation` L1–L3, to and cc, and repeats | `taskwatch_escalation`; `{{1}}` gets "(copy)" for cc and "(still open)" for repeats | [V-C `channels.ts:89-90`; V-S `messages.ts:82-92`] |
  | `blocked` | `taskwatch_task_blocked` (NTF-07) | [V-S `messages.ts:95-105`] |
  | system alert | `taskwatch_system_alert` (NTF-08) | [V-S `messages.ts:111-121`] |
  | anything else | no WhatsApp | [V-C `channels.ts:91`] |
- Template variable `{{4}}` of `taskwatch_escalation` is the **entity**, per the template doc and server (`messages.ts:89`). The client passes the team name (`channels.ts:90`). WO wins and D-4 makes Department = Entity, so use the entity name. [WO; V-S; D-4]
- The previous assignee on a reassignment gets in-app and email but **no WhatsApp**, because the assigned template only fits the new assignee (`channels.ts:86`). Keep that. [V-C; A]
- **WhatsApp skip rules** (logged as `skipped` with a reason): no number → "No WhatsApp number on file"; not opted in → "Has not opted in to WhatsApp alerts". [V-C `channels.ts:125`] Server text for the second is "Opted out of WhatsApp" (`notify.ts:40`). Use the client text. [A]
- Every WhatsApp message links to the task (`https://<APP_URL>/tasks/<id>`). [WO; V-S `messages.ts:35-37`]
- Email is sent through the Google Workspace domain with sender name "TaskWatch". [WO; V-S `notify/channels.ts:73-90`]
- **Retries:** up to 3 attempts; after a failure the row returns to `pending` with `send_after = now + 5 min × attempts`; after the 3rd failure it is `failed` with the provider error (first 500 chars). [V-S `dispatcher.ts:6, :67-76`]
- Rows stuck in `sending` (process crash) must be recovered: a row in `sending` older than 10 min goes back to `pending`. [A; fixes S-14 in EXISTING_SYSTEM_ANALYSIS §3.8]
- Delivery states: `pending`, `held`, `sending`, `sent`, `simulated`, `failed`, `skipped`. [V-S `001_init.sql` notifications CHECK, per EXISTING_SYSTEM_ANALYSIS §3.2] The client only knows `sent/held/skipped` (`types/index.ts:277`); the UI must render all seven. [A]
- Dispatch runs on the server every 15 s and is also kicked 250 ms after a notifying transaction commits. [V-S `dispatcher.ts:17-23`; config `dispatchIntervalMs` per EXISTING_SYSTEM_ANALYSIS §3.1]
- AC-5: each alert reaches the right person on WhatsApp and email, and is logged. [WO]

**Data required.** Recipient email, WhatsApp number (E.164), opt-in flag, time zone, active flag; task id/title/priority/due/entity/assignee; escalation level/reason; template params. One `notifications` row per channel. [V-S `notify.ts:47-69`]

**Backend processing.** `notify()` inside the caller's transaction writes rows; the dispatcher claims due rows with `FOR UPDATE SKIP LOCKED`, sends, then records `sent/simulated/failed`, `sent_at`, `provider_id`, `error`. [V-S `dispatcher.ts:39-77`] Scheduler leadership across instances: see NFR "Scalability" in [PRODUCT_REQUIREMENTS.md §4](../PRODUCT_REQUIREMENTS.md).

**API (proposed).** No public endpoint. Internal service `notify(recipients, message)` reused from the server. A CoS "retry failed delivery" endpoint is **not** required by the WO and is skipped. [A]

**Validation.** WhatsApp numbers must match `^\+[1-9]\d{7,14}$` at entry (STAFF-02). Template params are plain text; the sensitive-ID guard (C-6) already applies to the task text they come from. [V-C `services/api/admin.ts:97`]

**Authorization.** Not user-callable.

**Success / failure.** Provider error → retry then `failed`; missing number/opt-in → `skipped`; missing credentials → `simulated` (NTF-06).

**Dependencies.** STAFF-02 (contact data), ESC-04 (routing), NTF-03, NTF-04, NTF-06, DLV-01.

**Acceptance criteria.**
1. NTF-02-AC-1: A new assignment creates exactly one in-app, one email and one WhatsApp row for the assignee, even when their preferences turn email and WhatsApp off.
2. NTF-02-AC-2: An L2 escalation creates rows for the manager (to) and the lead and assignee (cc), each WhatsApp row using `taskwatch_escalation` with "(copy)" for cc recipients and the entity name in `{{4}}`.
3. NTF-02-AC-3: A recipient with no number gets a WhatsApp row with status `skipped` and reason "No WhatsApp number on file"; email and in-app still go.
4. NTF-02-AC-4: A provider failure is retried at +5 min and +10 min, then marked `failed` after the 3rd attempt with the error stored.
5. NTF-02-AC-5: A row left in `sending` for more than 10 min is picked up again.
6. NTF-02-AC-6: An inactive recipient gets no rows.
7. NTF-02-AC-7 (WO AC-5): for a seeded task reaching L1, the lead's WhatsApp and email rows exist with the lead's address and phone.

**Test scenarios.** Mandatory types ignore prefs · non-mandatory honour prefs · each template mapping · "(copy)" and "(still open)" tags · entity in `{{4}}` · old assignee gets no WhatsApp on reassign · skip reasons · retry/backoff/failed · stuck `sending` recovery · inactive recipient · duplicate recipient in to and cc gets one set (cc filtered, `core.ts:71`).

---

## NTF-03 Quiet hours

**Description.** L0 and L1 alerts on email and WhatsApp are held during quiet hours in the **recipient's** time zone; L2 and L3 always go out; in-app is never held. [WO; V-C `channels.ts:100-102`; V-S `notify.ts:35-37, :44`]

**Roles.** System. Configured by `manage_escalation_policies` (POL-01). [V-C `services/api/admin.ts:228`]

**User actions (UI).** Policies page: "Enable quiet hours", start and end times. [V-C `features/admin/AdminPages.tsx:239-245`] Account page shows held messages in "Messages sent to you" (DLV-02).

**Expected behaviour.**
- Defaults: enabled, 21:00–08:00. [V-C `constants/index.ts:99`; WO]
- Holdable: escalation L0 and L1, including their repeats and the cc copies at L1. [V-C `channels.ts:101`; V-S `messages.ts:79, :91`] Blocked alerts are holdable on the server (`messages.ts:103`), which conflicts with WO AC-3 "within 5 minutes" — D-23 (decided) ([ESCALATION-FRD.md](ESCALATION-FRD.md)).
- Not holdable: assignment, reassignment, L2, L3, digest, system alert. [V-S `messages.ts:50, :91, :119`]
- Quiet window wraps midnight when start > end; start = end means never quiet. [V-C `services/engine/escalation.ts:81-90`]
- Held rows get `status='held'`, `send_after = end of quiet time` and the reason "Quiet hours 21:00–08:00 (IST)" (zone abbreviation of the recipient). [V-C `channels.ts:116-119`; V-S `notify.ts:36-37`]
- Release: the dispatcher sends held rows once `send_after ≤ now`. [V-S `dispatcher.ts:44`]
- WO decision **WO-D4** (hold vs alert around the clock) is not yet confirmed by the Founder's Office; the `enabled` switch covers both answers. [WO]

**Data required.** `users.time_zone` (IANA), rules `quietHours {enabled,start,end}`.

**Backend processing.** Computed at enqueue time per recipient (`isQuietTime`, `quietEndsAt`). [V-S `engine/levels.ts` per EXISTING_SYSTEM_ANALYSIS §3.6]

**API.** None of its own; configured via POL-01.

**Validation.** `start`, `end` must match `^([01]\d|2[0-3]):[0-5]\d$` → 422 "Use HH:MM (24-hour)". [V-S `services/rules.ts:8`] The mock does not validate these (`admin.ts:226-236`). [V-C]

**Authorization.** See POL-01.

**Success / failure.** n/a (background).

**Dependencies.** POL-01, STAFF-02 (time zone), NTF-02.

**Acceptance criteria.**
1. NTF-03-AC-1: An L1 alert raised at 22:30 IST for an IST recipient is stored `held` until 08:00 IST and is sent by the first dispatcher run after 08:00.
2. NTF-03-AC-2: The same alert for a PT recipient at 09:30 PT goes immediately (recipient zone, not server zone).
3. NTF-03-AC-3: An L2 alert at 23:00 local is never held.
4. NTF-03-AC-4: The in-app row is created immediately in every case.
5. NTF-03-AC-5: With quiet hours disabled, nothing is held.

**Test scenarios.** Boundary minutes 20:59/21:00/07:59/08:00 · wrap-around window · start = end · L0 vs L1 vs L2 · cc copy at L1 held · repeat held · recipients in IST and PT on the same event (AC-9 context) · disabled switch.

---

## NTF-04 Notification preferences

**Description.** A per-user matrix: notification type × {in-app, email, WhatsApp}. Mandatory types are locked on. WhatsApp only applies to types that have a template. [V-C `features/account/AccountPages.tsx:107-140`]

**Roles.** Every active user, for themselves. [V-C `misc.ts:94-104`]

**User actions (UI).** `/settings/account#notifications`: tick boxes, Save → toast "Notification preferences saved". [V-C `AccountPages.tsx:79, :102`] Mandatory rows show "Required by the work order" and are disabled. [V-C `AccountPages.tsx:122-128`] WhatsApp column only for `WA_TYPES = assignment, reassignment, escalation` (hard-coded, `AccountPages.tsx:154`), disabled without a number or opt-in, with a warning banner. [V-C `AccountPages.tsx:131, :141-146`]

**Expected behaviour.**
- Defaults for a new user: in-app all on; email on for `escalation`, `assignment`, `review_required`, `extension_request`; WhatsApp on for `escalation`, `assignment`, `reassignment`. [V-C `services/mock/seed.ts:75-97`]
- The server ignores any attempt to switch a mandatory type off. [A; mirrors `channels.ts:106-107`]
- The list of WhatsApp-capable types must come from the server (`WA_TYPES` is a UI constant). Add `blocked` once NTF-07 lands. [A]
- **Channel independence:** today turning **in-app** off also suppresses email and WhatsApp for that type, because `notify()` skips the whole notification (`core.ts:36`). Proposed: each channel is independent. [D-43, decided]
- Saving is audited `preferences.updated`. [V-C `misc.ts:101`]

**Data required.** New table `notification_prefs(user_id, type, channel, enabled)` or a JSONB column on users. The server has no preferences today. [V-S `notify/notify.ts` writes all channels unconditionally]

**Backend processing.** `notify()` consults prefs per recipient and channel, except mandatory types.

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/me/notification-prefs` | — | `{prefs:{inApp:{type:bool},email:{…},whatsapp:{…}}, mandatory:[type], whatsappTypes:[type], whatsappAvailable:boolean}` | New. |
| PUT | `/api/me/notification-prefs` | `{inApp:{…},email:{…},whatsapp:{…}}` | `204` | New. |

**Validation.** Keys must be known types; values boolean; whatsapp keys outside `whatsappTypes` rejected → 422 `{fields:{whatsapp:"No approved WhatsApp template for this event"}}` [A — message from UI tooltip `AccountPages.tsx:134`]. The mock does no validation (`misc.ts:98-104`). [V-C]

**Authorization.** Own preferences only; no path parameter, so no IDOR surface.

**Success / failure.** 204; 401; 422 invalid shape.

**Dependencies.** NTF-02, STAFF-02 (number, opt-in).

**Acceptance criteria.**
1. NTF-04-AC-1: Saving `email.assignment=false` returns 204 but assignment emails are still sent (mandatory).
2. NTF-04-AC-2: Saving `email.progress=false` stops progress emails for that user only.
3. NTF-04-AC-3: A WhatsApp key for `progress` is rejected with 422.
4. NTF-04-AC-4: The save writes an audit record `preferences.updated` with the actor.
5. NTF-04-AC-5: GET returns `whatsappAvailable=false` when the user has no number or no opt-in.

**Test scenarios.** Defaults for a new user · mandatory override ignored · per-channel opt-out · unknown type → 422 · WhatsApp on non-template type → 422 · in-app off with email on (per D-43 answer) · audit row.

---

## NTF-05 Weekly digest

**Description.** Email to each manager and the Founder's Office summarising **red items, repeat offenders and on-time trend**, Monday 09:00 IST. [WO FR-12; D-14]

**Roles.** Recipients: active users holding `manager`, `cos` or `ceo` (any of their roles, D-8). [V-S `services/digest.ts:89`; V-C `channels.ts:175-177`] Manual send: `manage_system_settings`. [V-C `services/api/admin.ts:426-433`]

**User actions (UI).** Delivery Log "Send weekly digest now" (shown only with `manage_system_settings`) → toast "Weekly digest sent to N recipients (simulated email)." [V-C `features/admin/DeliveryLogPage.tsx:110-111, :135`] The "(simulated email)" wording is prototype-only. [A]

**Expected behaviour.**
- **Content (WO wins over the prototype):** the server's three sections are the spec [V-S `digest.ts:24-51`]:
  - Red items: visible tasks not done with level ≥ 2, highest level first, then longest silent; max 25; columns task, entity, assignee, level, silent hours.
  - Repeat offenders: assignees with ≥ 2 L1+ escalations fired in the last 7 days, max 10.
  - On-time trend: the last 4 weekly buckets of tasks closed and % closed on or before due.
  - The prototype digest (open/overdue counts, created/completed, escalations raised, still at L3, 5 most overdue — `channels.ts:180-207`) does not meet FR-12. Its counts may be appended. [A]
- **Scope:** CoS and CEO get the whole organisation; a manager gets their reporting line (visibility filter). [V-S `digest.ts:23`; V-C `channels.ts:182-184`]
- **Schedule:** sent once per ISO week at or after Monday 09:00 Asia/Kolkata, deduplicated by `job_runs('weekly_digest', '<year>-W<nn>')`. [V-S `digest.ts:109-118`] Whether the Settings fields `digestDay`/`digestHour` stay editable: [D-44, decided].
- **Manual send:** `manage_system_settings` sends to all recipients now, audited `digest.sent_manually`. [V-C `admin.ts:426-433`] The server also lets a manager send it to themselves (`routes/admin.ts:47-53`); keep that as "send me a preview". [V-S; A]
- Email only; HTML with a plain-text fallback. [V-S `notify.ts:47`, `dispatcher.ts:25-32, :53`]
- Not subject to quiet hours. [V-S `digest.ts:98`]

**Data required.** Visible tasks, escalation events (fired_at, level, assignee), closed_at, due_at, recipient time zone (for week labels). [V-S `digest.ts:24-51`]

**Backend processing.** Scheduler checks every 60 s. [V-S `jobs/scheduler.ts:72`] Each recipient's digest is built and queued in its own transaction.

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| POST | `/api/admin/digest` | `{scope:"all"\|"me"}` | `{sent:number}` | Yes: `POST /admin/digest` [V-S `routes/admin.ts:47-53`]. Replace `requireRole('cos','ceo','manager')` with: `all` needs `manage_system_settings`; `me` needs the caller to be a digest recipient. |

**Validation.** `scope` ∈ {all, me} → otherwise 422.

**Authorization.** `scope=all` without `manage_system_settings` → 403 "You don't have permission to send the weekly digest." [V-C `admin.ts:428` via `assertPerm`]. `scope=me` for a non-recipient → 403. [A]

**Success / failure.** 200 `{sent}`; 401; 403; 422.

**Dependencies.** NTF-02, NTF-06, DLV-01, RPT-05/06 (same visibility filter), SET-01 (D-44).

**Acceptance criteria.**
1. NTF-05-AC-1: On Monday 09:00 IST each active manager, CoS and CEO gets exactly one digest email row; running the job again that week creates none.
2. NTF-05-AC-2: A manager's digest lists only tasks within their reporting line.
3. NTF-05-AC-3: The digest has the three WO sections: red items, repeat offenders, on-time trend.
4. NTF-05-AC-4: A user with only `staff` gets no digest.
5. NTF-05-AC-5: `scope=all` by a user without `manage_system_settings` returns 403; with it, returns the recipient count and writes audit `digest.sent_manually`.

**Test scenarios.** Monday 08:59 vs 09:00 IST · second run same week · ISO week rollover at year end · multi-role user (lead+manager) gets one digest · manager scope · repeat offender threshold 1 vs 2 escalations · empty sections text · manual all / me · 403 paths.

---

## NTF-06 Simulation mode

**Description.** When a channel has no credentials, messages are rendered and logged as `simulated` instead of sent. [V-S `notify/channels.ts:26, :75`; README per PRD NTF-06]

**Roles.** System. Visible to `view_audit_logs` in DLV-01.

**User actions (UI).** Delivery Log "Simulated delivery" banner (mentions `SMTP_*`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`). [V-C `DeliveryLogPage.tsx`, per FEATURE_INVENTORY] Settings checkboxes "Email (simulated)" / "WhatsApp Business (simulated)". [V-C `AdminPages.tsx:361-362`]

**Expected behaviour.**
- Channel live ⇔ its server credentials are present; otherwise every row for it ends `simulated`. [V-S `notify/channels.ts:26, :75`]
- In the prototype, turning the Settings simulation checkbox **off stops all email/WhatsApp deliveries and the digest** (`channels.ts:107, :123, :218`). In production that would break "email always". [WO] [D-41, decided]
- The UI shows per-channel status Live / Simulated from the server (`/me` integrations or DLV-01 payload). [V-S `routes/admin.ts:28-33`]

**Data required.** Server config flags only. No secret values are ever returned. [WO Secrets]

**Backend processing.** Decided in `sendEmail` / `sendWhatsApp`.

**API (proposed).** Integration status is returned inside DLV-01 (`integrations:{email:"live"|"simulated", whatsapp:"live"|"simulated"}`). Adapt `GET /admin/audit` integrations block. [V-S `routes/admin.ts:28-33`]

**Validation / Authorization.** Read-only; status visible to `view_audit_logs`.

**Dependencies.** SET-01 (D-41), DLV-01.

**Acceptance criteria.**
1. NTF-06-AC-1: With no `WHATSAPP_TOKEN`, a WhatsApp alert ends `simulated` with the rendered template body stored.
2. NTF-06-AC-2: No API response contains a credential value.
3. NTF-06-AC-3: Email delivery cannot be switched off from System Settings in production (subject to D-41).

**Test scenarios.** Each channel with/without credentials · status block content · settings toggle has no effect on live sending (per D-41).

---

## NTF-07 Blocked alert (new, from WO)

**Description.** When an assignee marks a task Blocked (WF-11), the team lead is alerted on all channels with template `taskwatch_task_blocked`. [WO FR-2, AC-3; V-S `messages.ts:95-105`] The state change itself is WF-11; this feature is only its delivery.

**Roles.** Sender: system on WF-11. Recipient: the assignee's lead, per ESC-04 L1 routing (lead, else manager, else Founder's Office). [V-S `engine/routing.ts` per EXISTING_SYSTEM_ANALYSIS §3.6; A that the same fallback applies]

**User actions (UI).** None beyond WF-11. The new type needs a label in `NOTIFICATION_LABEL` and a preferences row. [V-C `constants/index.ts:77-91`]

**Expected behaviour.** In-app, email and WhatsApp to the lead; template params `[assignee name, task title, reason]`; link to the task. Delivery within 5 minutes (AC-3). Quiet-hours treatment: D-23 (decided); whether it is mandatory: D-42 (decided). The server rule flag `blockedAlertsLead` switches it (POL-01, [D-48, decided]). [V-S `services/rules.ts:19`]

**Data required.** Task, assignee, reason (already guarded by C-6), lead resolution.

**Backend processing.** `notify()` in the WF-11 transaction; dispatcher kick.

**API.** None of its own.

**Validation / Authorization.** Inherited from WF-11.

**Dependencies.** WF-11, ESC-04, NTF-02, NTF-03.

**Acceptance criteria.**
1. NTF-07-AC-1 (WO AC-3): marking a task Blocked at 11:00 recipient time creates the lead's WhatsApp, email and in-app rows, and the dispatcher sends WhatsApp and email within 5 minutes.
2. NTF-07-AC-2: The WhatsApp row uses `taskwatch_task_blocked` with params in the order assignee, title, reason.
3. NTF-07-AC-3: With no lead in the chain, the manager receives it.

**Test scenarios.** Lead present / missing / inactive · night-time behaviour per D-23 (decided) · sensitive ID in reason rejected before any notification.

---

## NTF-08 System alert (new, from WO)

**Description.** Platform alerts to the Chief of Staff, starting with the audit-log integrity alert ("a nightly job verifies the chain and alerts the Chief of Staff on any break"). Template `taskwatch_system_alert`, no button. [WO; V-S `jobs/scheduler.ts:22-35`, `messages.ts:111-121`]

**Roles.** Recipients: every active user with the `cos` role. [V-S `scheduler.ts:32`]

**User actions (UI).** None. Trigger is AUD-02.

**Expected behaviour.** In-app, email and WhatsApp; not held by quiet hours; text names the trigger (nightly/manual), the number of problems and the task ids. [V-S `scheduler.ts:25-26`]

**Data / processing.** Chain-check result (AUD-02). `taskId` null.

**API.** None.

**Dependencies.** AUD-02, NTF-02.

**Acceptance criteria.**
1. NTF-08-AC-1 (WO AC-7): after a log row is altered directly in the DB, the next chain check creates a system alert for every active CoS on all three channels.
2. NTF-08-AC-2: A clean check sends nothing.

**Test scenarios.** Break found nightly · break found manually · no CoS active (alert still logged, no recipient) [A] · quiet hours ignored.

---

## DLV-01 Delivery log

**Description.** Every outbound email and WhatsApp message with status, rendered preview, template, and counts; plus "Send weekly digest now" (NTF-05). [V-C `features/admin/DeliveryLogPage.tsx:102-215`]

**Roles.** `view_audit_logs` today in the prototype (`services/api/admin.ts:413-417`); the server lets only CoS see everyone's rows and others see their own (`routes/notifications.ts:61`). [D-52, decided]

**User actions (UI).**
- Channel segment All / Weekly digest / Email / WhatsApp; status filter; recipient filter; free text over subject, template, body, task, address (all client-side today). [V-C per FEATURE_INVENTORY "/admin/deliveries"]
- Row click / eye button → PreviewDialog (email or WhatsApp mock). [V-C `DeliveryLogPage.tsx:53-100, :189`]
- CSV export. [V-C `DeliveryLogPage.tsx:139`]
- WhatsApp templates table with per-template "sent here" counts. [V-C per FEATURE_INVENTORY]

**Expected behaviour.**
- Newest first; page size 50. [V-C per FEATURE_INVENTORY]
- "Copied recipient" label must come from the API (`copied:boolean`), not from a notification title starting "Copy:" (`DeliveryLogPage.tsx:185`). [V-C; A]
- Address and phone are personal data: masked (e.g. `+91•••••1234`) unless the viewer may see them (D-52). Provider errors are shown only to the same audience. [PRD DLV-01; S-16]
- Statuses shown: the seven of NTF-02.

**Data required.** `notifications` rows for channel email/whatsapp, recipient name, task id, level, template + params, `send_after`, `sent_at`, `attempts`, `error`, `kind` (alert/digest). [V-S `routes/notifications.ts:64-71`]

**Backend processing.** Server-side filter, sort and paging (D-10 cap). Stats via `group by channel, status`. [V-S `routes/notifications.ts:73-76`]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/deliveries?channel=email\|whatsapp\|digest&status=&userId=&q=&before=&limit=50` | — | `{items:[{id,at,channel,kind,status,recipient:{id,name},address,subject,body,template,templateParams,taskId,level,copied,heldUntil,sentAt,attempts,reason}], counts:[{channel,status,n}], templates:[{name,sent}], integrations:{email,whatsapp}, next}` | Yes: `GET /outbox` [V-S `routes/notifications.ts:46-77`] (limit 1–500, default 150). |
| GET | `/api/deliveries/export.csv?<same filters>` | — | CSV (guard per RPT-03) | New. [A] |

**Validation.** `channel`, `status` from the enums; `limit` 1–500 [V-S `notifications.ts:52`]; `q` ≤ 100 chars [A].

**Authorization.** Without `view_audit_logs` → 403 "You don't have permission to view the delivery log." [V-C `admin.ts:415`]. Visibility of others' rows and of raw addresses per D-52.

**Success / failure.** 200; 401; 403; 422 bad filter.

**Dependencies.** NTF-02..08, ROLE-01 (permission), D-10.

**Acceptance criteria.**
1. DLV-01-AC-1: A user without `view_audit_logs` gets 403 from `/api/deliveries`.
2. DLV-01-AC-2: Every alert row in NTF-02 appears with its final status and attempts.
3. DLV-01-AC-3: Filters and paging are applied on the server; `counts` reflect the filter.
4. DLV-01-AC-4: Addresses and provider errors follow the D-52 rule.
5. DLV-01-AC-5: The `copied` flag is true exactly for cc recipients.

**Test scenarios.** 403 path · each filter · free-text search · paging · held/skipped/failed/simulated rendering · CSV export injection guard · masked vs unmasked address.

---

## DLV-02 My deliveries

**Description.** The signed-in user's own last 30 email/WhatsApp messages, shown on Account settings as "Messages sent to you" (the UI shows the first 10). [V-C `services/api/admin.ts:420-423`; `AccountPages.tsx:156-165`]

**Roles.** Every active user, own rows only.

**User actions (UI).** View list; eye button opens the same preview as DLV-01. [V-C `DeliveryLogPage.tsx:30-50`]

**Expected behaviour.** Newest first; includes held and skipped rows with reasons so a user can see why WhatsApp did not arrive. Copy text "Nothing actually left this browser" is prototype-only. [V-C `AccountPages.tsx:162`; A]

**API (proposed).** `GET /api/me/deliveries?limit=30` → `{items:[…same item shape as DLV-01…]}`. Adapt `GET /outbox` non-CoS branch (own rows only). [V-S `routes/notifications.ts:61`]

**Validation.** `limit` 1–30. [A]

**Authorization.** `user_id = session user` only; no path id.

**Acceptance criteria.**
1. DLV-02-AC-1: Returns at most 30 rows, all for the caller.
2. DLV-02-AC-2: A skipped WhatsApp row shows its reason.

**Test scenarios.** Own only · limit · held/skipped reasons visible.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-14](../../01-discovery/OPEN_QUESTIONS.md) | Decided: Monday 09:00 IST. Editable digest settings → D-44 (decided). |
| WO-D4 | Quiet hours hold vs alert around the clock (Founder's Office decision; default hold). |
| WO-D6 | Which WhatsApp business number and Meta account (go-live dependency, [whatsapp-templates.md](../../whatsapp-templates.md) "Turning it on"). |
| WO-D7 | CEO on L3: drives `l3NotifyCeo` and Founder's Office membership. |
| [D-8](../../01-discovery/OPEN_QUESTIONS.md) | Digest recipients use "holds the role", since users can have several roles. |
| [D-10](../../01-discovery/OPEN_QUESTIONS.md) | Server paging for inbox and delivery log. |
| D-41 (decided) | Simulation toggles in System Settings vs "email always". |
| D-23 (decided) | (raised in [ESCALATION-FRD.md](ESCALATION-FRD.md)) Blocked alert during quiet hours vs AC-3 "within 5 minutes". |
| D-42 (decided) | Whether `blocked` is a mandatory notification type (cannot be switched off in preferences). |
| D-43 (decided) | Preference channels independent (in-app off currently suppresses email/WhatsApp). |
| D-52 (decided) | Who may see every recipient's address and body in the delivery log. |
