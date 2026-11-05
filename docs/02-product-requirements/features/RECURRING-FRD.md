# Recurring Tasks FRD (REC)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). Task creation rules (TASK-01) and the assignment notification (NTF-02, [NOTIFICATIONS-FRD.md](NOTIFICATIONS-FRD.md)) apply to every generated task and are not repeated.
> Nothing here has been executed. No test has been run.

**Built 2026-11-06 (T-7.4, Phase 7 Batch B; client).** Phase 7 code-complete.
- `services/api/admin.ts` recurring functions call `adminServer.recurrences / saveRecurrence / setRecurrenceActive / deleteRecurrence` in server mode. Rows are typed `RecurrenceRow` and carry `canEdit`; the page shows row actions from it (the mock computes the same rule).
- `RecurringPage` no longer reads `getDb()`: categories come from `taskFormLookups`, and the team defaults on the server (and in the mock save). Category is required ("Choose…") instead of preselected. In server mode the hint says the due hour is in the assignee's time zone.
- New Task "Repeat this task" no longer sends `'Operations'` for an empty category (REC-02-AC-6). Task detail gets the full rule, so "Recurrence" is described.
- Route `/recurring` is `server: 'create_tasks'`.
- `POST/PUT /api/recurring` let a null `assigneeId` through the schema so every field message comes back at once.
- Not done: the "N tasks" link still opens Assigned by Me unfiltered, because task lists have no recurrence filter (KI-37).

**Built 2026-11-06 (T-7.1…T-7.3, Phase 7 Batch A; server only, client in T-7.4).**
- One rule module, `shared/recurrence.ts` (D-9): `occursOn`, `occurrencesBetween`, `describeRecurrence`, `scheduleErrors` (the REC-02 messages). The client's `services/engine/recurrence.ts` re-exports it, and the mock validator uses `scheduleErrors`.
- Migration 013 converts existing schedules (start date, weekdays, due hour, category) and adds `last_occurrence`. The old timing columns (`weekday`, `month_day`, `run_time`, `due_in_hours`, `next_run_at`) are kept but no longer read.
- `services/recurring.ts`: `listRecurring`, `saveRecurring` (create/edit, then generates today's occurrence), `setRecurringActive`, `deleteRecurring` (soft, D-12), `runRecurring(only?)`. Every change is audited (`recurrence.created/updated/paused/resumed/deleted`, target `recurrence:<id>`).
- Generation: each schedule is claimed once per day in the assignee's zone (`last_occurrence`, `FOR UPDATE SKIP LOCKED`). A task is made only if that day is an occurrence and its due time (`dueHour` in the assignee's zone) is still ahead (D-45: no backfill, also after a pause). Tasks go through `createTask` as the owner, so TASK-01 rules, the assignment notice and the owner's scope apply. A failure is logged once as `recurring_skipped` with the reason (D-46). The unique key `(recurring_id, occurrence_date)` is the backstop.
- Deviations: the schedule title is limited to 127 characters so the generated "<title> — YYYY-MM-DD" fits the 140-character task title (D-109). The sensitive-ID message is the task one (`guardText`). Visibility follows D-40 (Founder's Office sees all), but listing needs `create_tasks`, which the CEO does not have by default.
- Routes: `GET/POST /api/recurring`, `PUT/DELETE /api/recurring/:id`, `POST /api/recurring/:id/active` (returns `generated`). Task detail returns the full rule in `recurrence`.

## 0. Requirement and model reconciliation

- WO FR-7: "daily, weekly or monthly tasks generated automatically, such as monthly payroll filings or weekly case reviews." Recurring tasks are **new** relative to the WO's view of the prototype. [WO]
- The client and server schedule models differ. The client model is the UI contract; the server's time-zone handling is kept (D-5 open). [V-C `types/index.ts:297-318`; V-S `services/recurring.ts:14-52`]

| Aspect | Client (UI contract) | Server today | This FRD |
|---|---|---|---|
| Frequencies | daily, weekly, monthly, every-N-days (`interval`) [V-C `types/index.ts:297`] | daily, weekly, monthly [V-S `routes/recurring.ts:57`] | Client set. Every-N-days is allowed: it is a daily schedule with interval N, which FR-7 covers. [A] |
| Interval | 1–365 [V-C `services/api/admin.ts:355`] | none | Client. |
| Weekly days | several weekdays (0 = Sun) [V-C `types/index.ts:312`] | one weekday 1–7 [V-S `routes/recurring.ts:58`] | Client. |
| Monthly day | day of `startDate`, clamped to month end [V-C `services/engine/recurrence.ts:29-34`] | `monthDay` 1–28 [V-S `routes/recurring.ts:59`] | Client, with month-end clamp. [D-45, decided] |
| Start / end | startDate required, endDate optional [V-C `types/index.ts:313-314`] | none | Client. |
| Due time | `dueHour` 0–23 on the occurrence day [V-C `services/core.ts:238`] | `runTime` HH:MM + `dueInHours` 1–1440 [V-S `routes/recurring.ts:60-61`] | Client `dueHour`, interpreted in the **assignee's** time zone. [D-5, decided] |
| Day boundary / zone | UTC days ("Times are interpreted in UTC in this prototype", `features/work/RecurringPage.tsx:203`) | assignee's zone via luxon [V-S `services/recurring.ts:23-39`] | Assignee's zone. [D-5, decided] |
| Missed days | backfilled from max(startDate, createdAt) to today [V-C `core.ts:224-225`] | not backfilled [V-S `services/recurring.ts:103-108`] | [D-45, decided] |
| Entity | none | `entityId` required [V-S `routes/recurring.ts:53`] | Derived from team, else assignee (D-4). |
| Category, description, reviewRequired, team | yes | no (only `instructions`) | Client. |
| Edit / delete | yes [V-C `admin.ts:361-401`] | no (toggle only) [V-S `routes/recurring.ts:68-77`] | Client; delete is soft (D-12). |

---

## REC-01 List schedules

**Description.** The Recurring Tasks page lists schedules the user may see, with a summary, the next 3 occurrences, owner, assignee and generated-instance count. [V-C `services/api/admin.ts:332-347`]

**Roles.** Needs `create_tasks`. CoS sees every schedule; anyone else sees schedules they own or whose assignee is in their transitive reports. [V-C `admin.ts:334-337`] The route also needs `assign_tasks` (`creates` AND `assign_tasks`). [V-C per FEATURE_INVENTORY "/recurring"]

**User actions (UI).** Open `/recurring` [V-C `features/work/RecurringPage.tsx:16-18`]; "New schedule" [V-C `:31`]; empty state "Create one" [V-C `:40`]; row menu Edit / Pause or Resume / Delete, shown only when `r.createdBy === user.id || user.role === 'cos'` (client-side) [V-C `:81-87`]; "N tasks" link goes to `/tasks/assigned-by-me` unfiltered [V-C `:75`].

**Expected behaviour.**
- `summary` = `describeRecurrence` text, e.g. "Weekly on Mon, Thu, until 2027-03-31". [V-C `services/engine/recurrence.ts:48-67`]
- `next` = the first 3 occurrence days from tomorrow to +120 days. [V-C `admin.ts:344`]
- `instances` = count of tasks with this `recurrenceId`. [V-C `admin.ts:343`]
- Row actions are returned by the server (`canEdit`) instead of the role check at `RecurringPage.tsx:81`. [A; C-2]
- The "N tasks" link should filter to this schedule (`/tasks/assigned-by-me?recurrence=<id>`). [A]
- Deleted (archived) schedules are hidden by default. [A; D-12]

**Data required.** `recurring_tasks` rows plus owner and assignee names, entity, generated count. [V-S `routes/recurring.ts:17-24`]

**Backend processing.** Scoped query; next occurrences computed with the shared recurrence module (D-9) in the assignee's zone.

**API (proposed).**

| Method | Path | Response | Adapt existing? |
|---|---|---|---|
| GET | `/api/recurring` | `[{id,title,description,category,priority,assigneeId,assigneeName,createdBy,ownerName,teamId,entityId,reviewRequired,frequency,interval,weekdays,startDate,endDate,dueHour,active,createdAt,summary,next:[YYYY-MM-DD×≤3],instances,canEdit}]` | Yes: `GET /recurring` [V-S `routes/recurring.ts:14-46`]. Visibility rule matches (FO all; else owner or assignee in scope). Change "FO" to "CoS" per client, or keep CEO read-only all [D-40, decided]. |

**Validation.** None (no input).

**Authorization.** No `create_tasks` → 403 "You don't have permission to manage recurring tasks." [V-C `admin.ts:334` via `assertPerm`].

**Success / failure.** 200; 401; 403.

**Dependencies.** STAFF-01 (reporting line), ROLE-01, D-9 (shared recurrence module).

**Acceptance criteria.**
1. REC-01-AC-1: A lead sees their own schedules and schedules whose assignee is in their reports, and no others.
2. REC-01-AC-2: The CoS sees all schedules.
3. REC-01-AC-3: A user without `create_tasks` gets 403.
4. REC-01-AC-4: `next` lists at most 3 dates, all after today in the assignee's zone, and none after `endDate`.
5. REC-01-AC-5: `canEdit` is true only for the owner and the CoS.

**Test scenarios.** Scope per role · 403 · `next` across month end and DST change · endDate cut-off · paused schedule still listed · archived schedule hidden.

---

## REC-02 Create / edit schedule

**Description.** Create or edit a schedule from the Recurring page dialog or from New Task ("Repeat this task"). [V-C `RecurringPage.tsx:107-206`; `features/tasks/TaskFormPage.tsx:52, :60-62, :159-192`]

**Roles.** `create_tasks` + `assign_tasks`. Edit: owner or CoS only. [V-C `admin.ts:363-364, :370`]

**User actions (UI).** Dialog fields: Title (required), Template description, Assignee (required), Priority, Category, Due at (hour, 0–23), Frequency (Daily / Weekly / Monthly / Every N days), Interval (1–365), Start date (required, default tomorrow), End date (optional), Repeat on (weekly only), Review required; live summary line. [V-C `RecurringPage.tsx:134-203`] Save → toast "Schedule created" / "Schedule updated". [V-C `:116`] From New Task: toast "Recurring schedule created; the first instance is generated on its start date." and go to `/recurring`. [V-C `TaskFormPage.tsx:52`]

**Expected behaviour.**
- On save the server generates any occurrence due now (`processRecurrences` is called). [V-C `admin.ts:378`]
- `teamId` defaults to the assignee's team **on the server** (today the client fills it, `RecurringPage.tsx:134`). [V-C; A]
- `entityId` = team's entity, else assignee's entity (D-4).
- From New Task the client forces category `'Operations'` when empty and drops due-time minutes (`TaskFormPage.tsx:62`). The server must validate category like TASK-01 and reject an empty one. [V-C; FEATURE_GAP_ANALYSIS §5.5]
- Editing changes future occurrences only; already generated tasks are untouched. [A]
- Changing the assignee on edit re-checks the assignable scope; keeping the same assignee does not (a lead can keep editing after the assignee moved). [V-C `admin.ts:368`]
- Audited `recurrence.created` / `recurrence.updated` with the summary. [V-C `admin.ts:372, :376`] The server does not audit today (S-10). [V-S]

**Data required.** All `Recurrence` fields [V-C `types/index.ts:299-318`] plus `entityId`, `deletedAt` (D-12), `lastGeneratedOn` [A].

**Backend processing.** Validate → scope check → insert/update → audit → run generation for this schedule (REC-04) in the same request. Sensitive-ID guard on title and description (C-6). [V-S `services/recurring.ts:59-60`]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| POST | `/api/recurring` | `{title,description,category,priority,assigneeId,teamId?,reviewRequired,frequency,interval,weekdays,startDate,endDate?,dueHour}` | `201 {id, generated:number}` | Yes: `POST /recurring` [V-S `routes/recurring.ts:48-66`]; replace the body schema. |
| PUT | `/api/recurring/:id` | same | `200 {id}` | New. |

**Validation (mock messages, `admin.ts:349-359`).**

| Field | Rule | 422 message |
|---|---|---|
| `title` | trimmed length ≥ 4 | "Give the schedule a title of at least 4 characters." |
| `assigneeId` | required | "Choose an assignee." |
| `assigneeId` | in assignable set (new schedule or changed assignee) | "You can only assign to people below you in the reporting line." [V-C `:368`] |
| `startDate` | required | "Choose a start date." |
| `endDate` | ≥ startDate when set | "End date must be after the start date." |
| `interval` | 1–365 | "Between 1 and 365." |
| `weekdays` | weekly → at least one | "Pick at least one weekday." |
| `dueHour` | 0–23 | "Between 0 and 23." |
| `category` | in `settings.categories` | "Choose a category." [A — same rule as TASK-01] |
| `priority` | critical/high/normal/low | "Choose a priority." [A] |
| `title`, `description` | sensitive-ID guard | "This looks like it contains <kind>. Link the case in ImmigrationCRM instead." [V-S `services/recurring.ts:60`] |
| title max | ≤ 140, as TASK-01 | [A] |

**Authorization.** Missing `create_tasks` → 403 "You don't have permission to manage recurring tasks."; missing `assign_tasks` → 403 "You don't have permission to assign recurring tasks." [V-C `admin.ts:363-364`]. Editing another owner's schedule (not CoS) → 403 "Only the owner can edit this schedule." [V-C `:370`]. Unknown id → 404 "Schedule not found." [V-C `:367`].

**Success / failure.** 201/200; 401; 403; 404; 422.

**Dependencies.** TASK-01 (field rules), REC-04, STAFF-01, SET-01 (categories), C-6.

**Acceptance criteria.**
1. REC-02-AC-1: Each validation rule above returns 422 with the exact field key and message.
2. REC-02-AC-2: A lead cannot create a schedule for someone outside their reports (422 on `assigneeId`).
3. REC-02-AC-3: A non-owner, non-CoS edit returns 403 and changes nothing.
4. REC-02-AC-4: Create and edit write audit records with the schedule summary.
5. REC-02-AC-5: A schedule whose start date is today and whose due hour has not passed generates today's task in the same request.
6. REC-02-AC-6: An empty category from the New Task path is rejected, not defaulted.

**Test scenarios.** Each 422 rule · weekly with no days · interval 0 / 366 · endDate < startDate · sensitive ID in title · edit by owner / CoS / other · assignee change out of scope · unchanged assignee now out of scope (allowed) · creation from New Task.

---

## REC-03 Pause / resume / delete

**Description.** Owner or CoS can pause, resume or delete a schedule. Delete keeps tasks already generated. [V-C `admin.ts:382-401`; `RecurringPage.tsx:21-22, :86-87, :100-102`]

**Roles.** Owner or CoS. [V-C `admin.ts:386, :397`; V-S `routes/recurring.ts:74`]

**User actions (UI).** Row menu Pause / Resume → toast "Schedule updated"; Delete → confirm "No more tasks will be created from “…”. The N tasks it already created are kept." → toast "Schedule deleted. Existing tasks are kept." [V-C `RecurringPage.tsx:21-22, :100-102`]

**Expected behaviour.**
- Resume runs generation for that schedule. [V-C `admin.ts:389`] Whether resume backfills the paused period: [D-45, decided].
- **Delete is a soft delete** (`deletedAt`, row kept): the mock removes the row (`admin.ts:398`), which conflicts with D-12 and the WO retention rule (also raised as D-31 (decided) in [COLLABORATION-FRD.md](COLLABORATION-FRD.md)). [V-C; D-12; WO Retention]
- Audited `recurrence.paused`, `recurrence.resumed`, `recurrence.deleted` (context "Existing task instances are kept"). [V-C `admin.ts:388, :399`]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| POST | `/api/recurring/:id/active` | `{active:boolean}` | `200 {ok:true, generated:number}` | Yes: same route [V-S `routes/recurring.ts:68-77`]; add audit. |
| DELETE | `/api/recurring/:id` | — | `204` | New; sets `deleted_at`, `active=false`. |

**Validation.** `active` boolean → else 422.

**Authorization.** Not owner and not CoS → 403 "Only the owner can change this schedule." / "Only the owner can delete this schedule." [V-C `admin.ts:386, :397`]. Unknown or already deleted → 404 "Schedule not found." [V-C `admin.ts:385, :396`].

**Success / failure.** 200/204; 401; 403; 404; 422.

**Dependencies.** REC-04, AUD-01, D-12.

**Acceptance criteria.**
1. REC-03-AC-1: A paused schedule generates nothing on later scheduler runs.
2. REC-03-AC-2: Delete leaves all generated tasks unchanged and the schedule row present with `deleted_at` set.
3. REC-03-AC-3: Each action writes its audit record.
4. REC-03-AC-4: A non-owner, non-CoS gets 403.

**Test scenarios.** Pause then scheduler tick · resume same day · resume after a gap (per D-45) · delete then list · delete twice → 404 · 403 paths · audit rows.

---

## REC-04 Generation

**Description.** The server scheduler creates one task per (schedule, occurrence day) and never a duplicate. [V-C `services/core.ts:218-250`; V-S `services/recurring.ts:90-135`; WO FR-7]

**Roles.** System. The generated task's creator and giver is the schedule owner. [V-C `core.ts:243`; V-S `recurring.ts:114-115`]

**User actions (UI).** None. Generated tasks appear in My Tasks / Assigned by Me with title "`<title> — <YYYY-MM-DD>`" and activity "Created from recurring schedule". [V-C `core.ts:124, :232`]

**Expected behaviour.**
- Occurrence rule per frequency [V-C `recurrence.ts:13-36`]:
  - daily / every-N-days: (day − startDate) in days is a multiple of `interval`.
  - weekly: weekday ∈ `weekdays` (or startDate's weekday if empty) and the week index since startDate is a multiple of `interval`.
  - monthly: months since startDate is a multiple of `interval`, and day-of-month = min(startDate's day, last day of month).
  - Never before `startDate` or after `endDate`.
- Due = occurrence day at `dueHour:00` in the assignee's zone (client uses UTC, `core.ts:238`). [D-5, decided]
- Generated task: status `assigned`, `recurrenceId`, `occurrenceDate`, priority/category/team/description/reviewRequired copied; assignment record and mandatory `assignment` notification as TASK-01. [V-C `core.ts:229-245`]
- **Idempotency:** a DB unique key on `(recurrence_id, occurrence_date)` guarantees "never a duplicate", even with two scheduler instances. [V-C `core.ts:226`; A for the DB constraint]
- Runs at least every 60 s on the server. [V-S `jobs/scheduler.ts:71`] Each schedule is claimed with `FOR UPDATE SKIP LOCKED`. [V-S `recurring.ts:96-99`]
- If the owner is inactive, the occurrence is skipped and logged (`recurring_skipped`) instead of created. [V-S `recurring.ts:113, :127-133`] If the owner lost `assign_tasks`, or the assignee is inactive or out of the owner's scope: [D-46, decided].
- Missed occurrences (server down, paused): [D-45, decided].
- Generation does not run in the browser (today `App.tsx:62-72` ticks every 30 s). [V-C]

**Data required.** Active, non-deleted schedules; assignee time zone; owner status and permissions; existing (schedule, day) instances.

**Backend processing.** Per schedule: compute due occurrence days up to today (assignee zone) → insert task via the TASK-01 service with `recurrenceId` → assignment notification → `C-7` escalation evaluation → audit `task.created` (source `system`).

**API.** None public. Scheduler job.

**Validation.** Same task rules as TASK-01 at generation time (e.g. a category removed from Settings since the schedule was saved). On failure: skip, log `recurring_skipped` with the reason. [V-S `recurring.ts:127-133`; A for the category case]

**Authorization.** Re-check at generation that the owner may still assign to the assignee (D-46).

**Dependencies.** TASK-01, NTF-02, ESC-01..08, D-5, D-9.

**Acceptance criteria.**
1. REC-04-AC-1: A daily schedule starting today with `dueHour` later than now produces exactly one task today; repeated scheduler runs produce no more.
2. REC-04-AC-2: Two scheduler instances running together produce one task per (schedule, day).
3. REC-04-AC-3: A weekly Mon+Thu schedule with interval 2 generates on Mon and Thu of weeks 0, 2, 4 … only.
4. REC-04-AC-4: A monthly schedule started on the 31st generates on Feb 28 (or 29) and Apr 30. (Subject to D-45.)
5. REC-04-AC-5: For an IST assignee with `dueHour` 17, the task's `dueAt` is 11:30 UTC (17:00 IST). (Subject to D-5.)
6. REC-04-AC-6: With an inactive owner, no task is created and a `recurring_skipped` admin-log row records why.
7. REC-04-AC-7: The generated task's assignee receives the assignment on in-app, email and WhatsApp.

**Test scenarios.** Each frequency and interval · weekday list empty · startDate in future · endDate passed · month-end clamp · DST boundary for a PT assignee · duplicate protection under concurrency · inactive owner · inactive assignee · removed category · paused gap and resume (D-45) · server downtime catch-up (D-45).

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-5](../../01-discovery/OPEN_QUESTIONS.md) | Day boundary and due hour in the assignee's time zone (server) vs UTC (prototype). |
| [D-9](../../01-discovery/OPEN_QUESTIONS.md) | One shared recurrence module (`recurrence.ts`) for client preview and server generation. |
| [D-12](../../01-discovery/OPEN_QUESTIONS.md) | Decided soft delete: schedule delete must not remove the row. |
| [D-4](../../01-discovery/OPEN_QUESTIONS.md) | Decided: schedule entity derived from team, else assignee. |
| D-45 (decided) | Backfill of missed occurrences and month-end handling. |
| D-46 (decided) | Behaviour when the owner loses permission or the assignee becomes inactive / out of scope. |
| D-40 (decided) | Whether the CEO sees every schedule (WO: CEO sees all tasks). |
