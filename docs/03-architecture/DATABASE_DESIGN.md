# Database Design

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> **Everything in §3–§5 is Proposed — needs approval.** No migration was written or run. Running any migration on `taskwatch` (or `npm test`, which drops `taskwatch_test`) needs the D-18 OK [D-18, decided].

Related: [ADR-0001](decisions/ADR-0001.md) (evolve via migrations) · [ADR-0003](decisions/ADR-0003.md) (statuses) · [ADR-0004](decisions/ADR-0004.md) (org/authz) · [ADR-0005](decisions/ADR-0005.md) (due dates) · [ADR-0006](decisions/ADR-0006.md) (SLA overrides) · [API_CONTRACTS.md](API_CONTRACTS.md) · [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md)

## 1. Current schema (existing, observed in code)

One migration, `server/src/db/migrations/001_init.sql`, applied by a forward-only runner that records file names in `schema_migrations` [V-S `server/src/db/migrate.ts:8-32`]. Table-by-table summary: [EXISTING_SYSTEM_ANALYSIS.md §3.2](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md). Facts this design relies on:

| Fact | Evidence |
|---|---|
| Enums are `text` + `CHECK`; timestamps `timestamptz`; integer `serial`/`bigserial` keys | [V-S `001_init.sql`] |
| `users.email` is `unique` but case-sensitive, while Google sign-in looks users up by `lower(email)` | [V-S `001_init.sql:13`; `routes/auth.ts:67`] |
| `users.roles text[]` ⊆ {ceo, cos, manager, lead, staff}, at least one | [V-S `001_init.sql:17-19`] |
| `tasks.status` ∈ {open, in_progress, blocked, done} | [V-S `001_init.sql:55`] |
| `activity_log`: per-task SHA-256 chain (`seq`, `prev_hash`, `hash`), head kept on `tasks.log_seq/log_head`; UPDATE/DELETE/TRUNCATE rejected by trigger `taskwatch_forbid_change()` | [V-S `001_init.sql:70-71, 89-112`; `services/activity.ts:42-89`] |
| `attachments.log_id` is NOT NULL: every file hangs off a log row | [V-S `001_init.sql:117`] |
| `escalations`: one active row per (task, level) via partial unique index | [V-S `001_init.sql:141`] |
| `notifications`: one row per (recipient, channel) incl. in-app; doubles as delivery log | [V-S `001_init.sql:151-174`; `notify/notify.ts:39-72`] |
| `sla_rules(scope, config jsonb)`: `'default'` or an entity id | [V-S `001_init.sql:177-182`] |
| `admin_log` append-only by trigger, **not** hash-chained | [V-S `001_init.sql:185-198`] |
| `app_state(key, value jsonb)` holds the demo clock offset | [V-S `001_init.sql:218-221`; `index.ts:12-14`] |

## 2. Conventions kept for 002+
- Keep integer primary keys. The API renders task IDs as `TW-<id>` and every other ID as a decimal string (client types use `string` IDs [V-C `client/src/types/index.ts:41, 74`]) — see [API_CONTRACTS.md §1](API_CONTRACTS.md). **Proposed.**
- Keep `text` + `CHECK` for enums (existing convention), `timestamptz` in UTC, server-supplied times only [WO p.5].
- Forward-only migrations, one transaction per file (existing runner).
- Split (revised 2026-11-04): `002_model.sql` (additive), `003_teams.sql` (team reference data), then auth and audit chain (next numbers), then `NNN_cutover.sql` (row mapping plus tightening, shipped with the server switch, T-4.0). Filenames set the apply order. See §6.

## 3. Proposed target schema (migration 002+)

### 3.0 Client type → storage map

| Client type [V-C `types/index.ts`] | Storage | Notes |
|---|---|---|
| `User` (:40-58) | `users` (extended) + `user_credentials` | `role` → `roles[]` (ADR-0004); `status` ↔ `active`/`archived_at` |
| `Department` (:60-64) | `entities` (+ `head_id`) | Department = Entity (ADR-0004) |
| `Team` (:66-71) | `teams` (new) | |
| `Task` (:73-102) | `tasks` (extended) | statuses per ADR-0003 |
| `Activity` (:104-134) | `activity_log` (existing, append-only) | new `kind` values; legacy kinds mapped at read time (§4.3) |
| `Comment` (:136-145) | `comments` (new) + `activity_log` rows | originals kept in the log (D-12) |
| `ProgressUpdate` (:147-155) | `activity_log` rows of kind `progress` (legacy `update`) | `percent` in `after`; `attachmentIds` = attachments with that `log_id` — no new table |
| `Attachment` (:157-166) | `attachments` (extended) | `context`, soft removal |
| `Review` (:168-179) | `reviews` (new) | |
| `Extension` (:181-194) | `extensions` (new) | |
| `Assignment` (:196-204) | `assignments` (extended) | |
| `EscalationEvent` (:206-223) | `escalations` + `escalation_recipients` (extended) | §3.8 |
| `Notification` (:240-251) | `notifications` rows with `channel='inapp'` | §3.9 |
| `Delivery` (:257-281) | `notifications` rows with `channel in ('email','whatsapp')` | §3.9 |
| `AuditRecord` (:283-295) | `admin_log` (extended, chained) | §3.10 |
| `Recurrence` (:299-318) | `recurring_tasks` (extended) | |
| `RulesConfig` (:320-329) | `sla_rules.config` | union with server fields (ADR-0006) |
| `Settings` (:331-347) | `app_state` key `settings` | §3.5 |
| `NotificationPrefs` (:349-353) | `notification_prefs` (new) | |
| `rolePermissions` (:376) | `role_permissions` (new) | |
| `passwordResets` (:380) | `password_reset_tokens` (new, hashed) | §3.11 |

### 3.1 Entities and teams
```sql
alter table entities add column head_id int references users(id);          -- Department.headId

create table teams (
  id          serial primary key,
  name        text not null,
  entity_id   text not null references entities(id),
  lead_id     int references users(id),
  archived_at timestamptz,
  unique (id, entity_id)                      -- target of the users composite FK below
);
create unique index teams_entity_name_uq on teams (entity_id, lower(name));
```
The six WO entities (BAIS, USAIS, International Evaluations, Embtel, Bay Area Accounting Solutions, Founder's Office) [WO p.1] are the `entities` rows; the existing seed already inserts entities [V-S `server/src/db/seed.ts:311-313`].

### 3.2 Users
```sql
alter table users
  add column team_id   int,
  add column location  text not null default '',
  add column whatsapp  text check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),          -- STAFF-02
  add constraint users_team_entity_fk foreign key (team_id, entity_id)
      references teams (id, entity_id);                                          -- a user's team is in their entity
alter table users alter column whatsapp_opt_in set default false;              -- consent must be explicit [A]
alter table users drop constraint users_email_key;
create unique index users_email_lower_uq on users (lower(email));              -- case-insensitive email
create index users_team_idx on users (team_id);
```
- `roles text[]` stays (ADR-0004). `title`, `time_zone`, `manager_id`, `active`, `archived_at`, `created_at` (= `joinedAt`) stay.
- `phone` stays as the general phone (`User.phone`); WhatsApp moves to `whatsapp` because the client models them separately [V-C `types/index.ts:51-55`] and the server currently sends WhatsApp to `phone` [V-S `notify/notify.ts:40-42`].
- Reporting loops: rejected in the service with a recursive check (`wouldCreateLoop` [V-C `services/authz/permissions.ts:57-61`]) inside the transaction that sets `manager_id`, with the user row locked.
- The composite FK makes "team belongs to the user's entity" a database rule, not app code.

### 3.3 Role permissions
```sql
create table role_permissions (
  role       text not null check (role in ('ceo','manager','lead','staff')),     -- 'cos' = all, never stored
  permission text not null check (permission in (
    'view_tasks','create_tasks','assign_tasks','reassign_tasks','update_assigned_tasks','review_tasks',
    'approve_extensions','manage_team','view_team_reports','view_org_reports','manage_staff',
    'manage_roles','manage_escalation_policies','view_audit_logs','manage_system_settings')),
  primary key (role, permission)
);
```
Seeded from the prototype defaults [V-C `client/src/services/mock/seed.ts:47-73`]. Effective permissions = union over `users.roles`; `cos` ⇒ all 15 (ADR-0004).

### 3.4 Tasks
```sql
alter table tasks drop constraint tasks_status_check;
alter table tasks
  -- 002 allows old + new values so existing rows stay valid; 004 drops 'open' and 'done' after the backfill
  add constraint tasks_status_check check (status in
    ('open','done','draft','assigned','in_progress','blocked','submitted','changes_requested','reopened','completed','cancelled')),
  alter column status set default 'assigned',
  add column description      text not null default '',
  add column category         text,                       -- must be in settings.categories (checked in app)
  add column team_id          int references teams(id),
  add column created_by       int references users(id),   -- Task.createdBy; assigner_id = Task.assignedBy
  add column reviewer_id      int references users(id),
  add column start_at         timestamptz,
  add column acknowledged_at  timestamptz,                -- WF-01
  add column snooze_until     timestamptz,                -- task-level repeat snooze
  add column progress         smallint not null default 0 check (progress between 0 and 100),
  add column review_required  boolean not null default false,
  add column parent_id        int references tasks(id) check (parent_id <> id),
  add column occurrence_date  date,
  add column cancel_reason    text,
  add column completed_at     timestamptz,
  add column updated_at       timestamptz,
  add column due_soon_sent_for timestamptz,               -- ESC-07 dedupe: the due_at value already notified
  add column overdue_sent_for  timestamptz;
create unique index tasks_recurrence_day_uq on tasks (recurring_id, occurrence_date) where recurring_id is not null; -- REC-04
create index tasks_active_idx  on tasks (status) where status not in ('completed','cancelled','draft');
create index tasks_assigner_idx on tasks (assigner_id);
create index tasks_team_idx     on tasks (team_id);
create index tasks_parent_idx   on tasks (parent_id);
drop index tasks_open_idx;                                -- was "status <> 'done'"
```
Kept: `entity_id` (snapshot: from team, else assignee — ADR-0004; see D-63 (decided)), `assignee_id`, `assigner_id`, `priority`, `instructions`, `blocked_reason`, `due_at`, `original_due_at`, `assigned_at`, `clock_started_at`, `last_update_at`, `lead_extension_used` (ADR-0005), `level`, `level_reason`, `closed_at`, `closed_by`, `recurring_id`, `log_seq`, `log_head`. `created_by` and `reviewer_id` become NOT NULL in `004` after backfill.

### 3.5 Settings
Stored as one JSON document in the existing `app_state` table, key `settings`, validated by a zod schema matching `Settings` [V-C `types/index.ts:331-347`] and SET-01 ranges. Changes write `admin_log` with before/after. `retentionYears` is fixed at 7 and rejected if changed [WO p.5]. `digestDay`/`digestHour` conflict with the fixed Monday 09:00 IST digest (D-14) — D-62 (decided); `emailSimulation`/`whatsappSimulation` overlap the env-derived simulation [V-S `config.ts:42, 50`] — D-61 (decided).

A single JSON row (rather than a table of columns) is enough: it is read once per request batch and written rarely.

### 3.6 Reviews and extensions
```sql
create table reviews (
  id           serial primary key,
  task_id      int  not null references tasks(id),
  round        int  not null check (round > 0),
  submitted_by int  not null references users(id),
  submitted_at timestamptz not null,
  note         text not null,
  reviewer_id  int  references users(id),
  decision     text check (decision in ('approved','changes_requested','rejected')),
  decided_at   timestamptz,
  comment      text,
  unique (task_id, round),
  check ((decision is null) = (decided_at is null))
);
create unique index reviews_one_pending_uq on reviews (task_id) where decision is null;   -- WF-06 409

create table extensions (
  id            serial primary key,
  task_id       int  not null references tasks(id),
  requested_by  int  not null references users(id),
  requested_at  timestamptz not null,
  current_due   timestamptz not null,
  requested_due timestamptz not null check (requested_due > current_due),
  reason        text not null,
  info          text not null default '',
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by    int references users(id),
  decided_at    timestamptz,
  decision_note text
);
create unique index extensions_one_pending_uq on extensions (task_id) where status = 'pending';  -- EXT-01
create index extensions_task_idx on extensions (task_id);
```

### 3.7 Comments, attachments, assignments, notification prefs
```sql
create table comments (
  id          serial primary key,
  task_id     int  not null references tasks(id),
  author_id   int  not null references users(id),
  parent_id   int  references comments(id),          -- one level deep, enforced in the service
  body        text not null,                         -- blanked on soft delete
  created_at  timestamptz not null,
  edited_at   timestamptz,
  deleted_at  timestamptz,
  deleted_by  int references users(id),
  log_id      bigint not null references activity_log(id)
);
create index comments_task_idx on comments (task_id, created_at);

alter table attachments
  add column context    text not null default 'progress' check (context in ('task','progress','comment','review')),
  add column comment_id int references comments(id),
  add column review_id  int references reviews(id),
  add column removed_at timestamptz,                 -- ATT-03: hidden, file kept
  add column removed_by int references users(id);
create index attachments_task_idx on attachments (task_id);

alter table assignments
  add column from_id int references users(id),       -- Assignment.fromId
  add column reason  text not null default '';

create table notification_prefs (
  user_id    int primary key references users(id),
  prefs      jsonb not null,                          -- NotificationPrefs; missing row = defaults
  updated_at timestamptz not null
);
```
- **Comment immutability (D-12):** create, edit and delete each append an `activity_log` row carrying the body (`after`) and, for edit/delete, the previous body (`before`). The `comments` row is the editable view; the chained log keeps the originals.
- Existing comments are `activity_log` rows with `kind='comment'` [V-S `services/activity.ts:13`]; `003` copies them into `comments` with `log_id` pointing at the original row (insert-select; the log is not touched).
- `attachments.storage_key` stays a random UUID file name [V-S `routes/tasks.ts:24`].

### 3.8 Escalation events — reconciling `EscalationEvent` with `escalations`

| `EscalationEvent` field [V-C `types/index.ts:206-223`] | Server column [V-S `001_init.sql:127-148`] | Change |
|---|---|---|
| `id`, `taskId`, `level`, `reason` | `id`, `task_id`, `level`, `reason` | — |
| `at` (moment the level was reached) | `fired_at` is the tick time | **add `reached_at timestamptz`** (computed by the ladder) |
| `cycle` (silence-cycle start) | — | **add `cycle_started_at timestamptz`** = `tasks.clock_started_at` when fired |
| `recipientIds`, `ccIds` | `escalation_recipients(kind 'to'/'cc')` | — |
| `status` active/acknowledged/resolved | derived: `cleared_at` ⇒ resolved; else `acknowledged_at` ⇒ acknowledged; else active | no column |
| `ackBy`, `ackAt` | `acknowledged_by`, `acknowledged_at` | — |
| — (missing in client) | `ack_note` | **kept; required** (WO FR-9 note [WO p.4]) |
| `resolvedAt` | `cleared_at` | — |
| `lastNotifiedAt` | `last_alert_at` | — |
| — | `snooze_until`, `assignee_id` | kept |

Add `create index escalations_task_idx on escalations (task_id);`. The partial unique index on active (task, level) stays: it is the engine's idempotency key [V-S `001_init.sql:141`].

### 3.9 Notifications and deliveries — reconciling with `notifications`
One table stays (the server already writes in-app, email and WhatsApp rows together [V-S `notify/notify.ts:39-72`]). Additions:
```sql
alter table notifications
  add column parent_id   bigint references notifications(id),   -- Delivery.notificationId → the in-app row
  add column level       smallint check (level between 0 and 3),
  add column digest_week date;                                   -- Delivery.digestWeek
create index notifications_created_idx on notifications (created_at desc);
create index notifications_task_idx    on notifications (task_id);
```
- `Notification.type` ← `event`. Existing values are mapped in `003`: `assigned→assignment`, `L0..L3`/`repeat→escalation` (+`level`), `blocked→blocked`, `digest→digest`, `chain_break→system`, `comment`, `due_change` [V-S `notify/messages.ts:44-111`]. `NotificationType` in the client gains `blocked` and `system` (client change). A CHECK on `event` is added in `004`.
- `Notification.read` ← `read_at is not null`; `title` ← `subject`; `emailSimulated` ← the sibling email row's `status='simulated'`.
- `Delivery.status`: the client's `sent | held | skipped` is a subset of the server's `pending | held | sending | sent | simulated | failed | skipped` [V-S `001_init.sql:158`]; the API returns the server set and the client type is widened. `heldUntil` ← `send_after` when held; `reason` ← `error`; `kind` ← `event='digest' ? 'digest' : 'alert'`.
- `address` holds an email or phone number: personal data, returned only to callers with `view_audit_logs` and for one's own rows (S-16, DLV-01).

### 3.10 Audit log — `admin_log`
```sql
alter table admin_log
  add column target_type text check (target_type in ('task','user','role','policy','settings','team','recurrence','demo','auth')),
  add column task_id     int references tasks(id),
  add column source      text not null default 'ui' check (source in ('ui','system','demo')),
  add column context     text not null default '',
  add column seq         bigint unique,      -- global chain position (null for legacy rows)
  add column prev_hash   text,
  add column hash        text;
create index admin_log_at_idx on admin_log (at desc);
create index admin_log_task_idx on admin_log (task_id);
```
Mapping: `AuditRecord.action` ← `kind`; `targetId` ← `target`; `prev`/`next` ← rendered `before`/`after`. Task-level audit actions the prototype writes (e.g. `task.created`, `task.reassigned`, `extension.*` [V-C `api/tasks.ts:142, 159`]) are written to `admin_log` too, with `task_id`.

**Chaining (S-11) — Proposed — needs approval:** one global chain over `admin_log`, hashing exactly as `hashRow` does for tasks [V-S `services/activity.ts:42-57`]. The head is kept in `app_state` key `admin_log_head` and locked `for update` per insert, which serialises audit writes (fine at the assumed volumes, [SCALABILITY_AND_RELIABILITY.md §6](SCALABILITY_AND_RELIABILITY.md)). Legacy rows cannot be updated (trigger), so they stay unchained (`seq` null) and the chain starts at migration time; acceptable only because no production data exists yet [A]. Options and the external-anchor proposal: [SECURITY_ARCHITECTURE.md §9](SECURITY_ARCHITECTURE.md).

### 3.11 Authentication tables (ADR-0002)
```sql
create table user_credentials (                -- kept out of "users" so directory reads never load secrets
  user_id             int primary key references users(id),
  password_hash       text,                    -- 'scrypt$N$r$p$<salt b64>$<hash b64>'
  password_changed_at timestamptz,
  totp_secret_enc     bytea,                   -- AES-256-GCM: iv || tag || ciphertext; key from env
  totp_enabled_at     timestamptz,
  totp_last_step      bigint                   -- last accepted RFC 6238 time step (replay guard)
);

create table password_reset_tokens (
  token_hash bytea primary key,                -- sha256(token); the token itself is never stored
  user_id    int not null references users(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,             -- created_at + 1 h (AUTH-04)
  used_at    timestamptz,
  created_by int references users(id)          -- set when issued by an admin (AUTH-05)
);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id);

create table login_attempts (
  id          bigserial primary key,
  at          timestamptz not null,
  email_lower text,
  user_id     int references users(id),
  ip          inet,
  method      text not null check (method in ('password','totp','google','dev','reset_request','reset')),
  ok          boolean not null,
  reason      text
);
create index login_attempts_email_idx on login_attempts (email_lower, at desc);
create index login_attempts_ip_idx    on login_attempts (ip, at desc);
```
`login_attempts` doubles as the rate-limit counter for sign-in and reset ([SECURITY_ARCHITECTURE.md §6](SECURITY_ARCHITECTURE.md)). Successful sign-ins and sign-outs also go to `admin_log` (S-10).

### 3.12 Recurring tasks and rules
```sql
alter table recurring_tasks
  drop constraint recurring_tasks_frequency_check,
  add constraint recurring_tasks_frequency_check check (frequency in ('daily','weekly','monthly','interval')),
  add column description     text not null default '',
  add column category        text,
  add column team_id         int references teams(id),
  add column review_required boolean not null default false,
  add column "interval"      int not null default 1 check ("interval" between 1 and 365),
  add column weekdays        smallint[] not null default '{}' check (weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  add column start_date      date,
  add column end_date        date check (end_date is null or end_date >= start_date),
  add column due_hour        smallint check (due_hour between 0 and 23),
  add column deleted_at      timestamptz;      -- REC-03 delete = soft; generated tasks keep their FK
```
- Existing `weekday` is ISO 1–7 (luxon) [V-S `001_init.sql:37`]; client `weekdays` are 0–6 with 0 = Sunday [V-C `services/engine/recurrence.ts:25`]: backfill `weekdays = {weekday % 7}`.
- Which time zone defines a recurrence "day" and the due hour is [D-5, decided]; `next_run_at`, `run_time`, `due_in_hours` stay until D-5 is answered.
- `sla_rules.config` gains `dueSoonHours` (client default 24 [V-C `client/src/constants/index.ts:98`]); existing rows get it merged in `003` (ADR-0006).

### 3.13 Append-only and archive-only triggers
Reuse the existing `taskwatch_forbid_change()` function [V-S `001_init.sql:104-107`]:
```sql
-- evidence: no update/delete at all (existing for activity_log, admin_log)
-- records: may change, may never be deleted (retention: archive, never delete)
create trigger tasks_no_delete       before delete on tasks       for each row execute function taskwatch_forbid_change();
create trigger users_no_delete       before delete on users       for each row execute function taskwatch_forbid_change();
-- same one-liner for: comments, attachments, reviews, extensions, assignments, escalations,
-- escalation_recipients, notifications, recurring_tasks, teams, entities, chain_checks
-- plus "before truncate ... for each statement" on each of them
```
Not covered (operational, not evidence): `"session"` (expired rows pruned by connect-pg-simple [V-S `app.ts:35`]), `password_reset_tokens`, `login_attempts` (pruning proposed at 1 year [A]), `job_runs`, `app_state`.

## 4. Data migration for existing rows — needs D-18 approval

Applies to whatever is in the dev database `taskwatch` (seeded data [V-S `server/src/db/seed.ts`]). **Nothing below may run without the D-18 OK** [D-18, decided]. Remember the server auto-migrates on start [V-S `server/src/index.ts:9`].

### 4.1 Before running (read-only checks)
- `select lower(email), count(*) from users group by 1 having count(*) > 1;` — must be empty or the case-insensitive index fails.
- Take a `pg_dump` of `taskwatch` first.

### 4.2 Mapping (`003_backfill.sql`)
| Data | Mapping |
|---|---|
| `tasks.status` | `open→assigned`, `in_progress→in_progress`, `blocked→blocked`, `done→completed` (ADR-0003) |
| `tasks.created_by`, `reviewer_id` | `= assigner_id` |
| `tasks.completed_at` | `= closed_at` where old status was `done` |
| `tasks.updated_at` | `= coalesce(last_update_at, assigned_at)` |
| `tasks.acknowledged_at` | first `ack` log row time, else null |
| `tasks.team_id` | the assignee's team after teams are seeded, else null |
| Entities | unchanged rows; relabelled "Entity" in the UI; `head_id` set by hand [A] |
| Teams | **no source data exists**; one team per (entity, lead) from the current reporting lines is a proposal only [A]; needs product input (D-67 (decided)) |
| `users.roles` | unchanged (multi-role kept) |
| `users.whatsapp` | `= phone` where `phone` matches E.164; `whatsapp_opt_in` values kept |
| `role_permissions` | prototype defaults |
| Comments | copied from `activity_log` `kind='comment'` |
| `attachments.context` | `'progress'` (all existing uploads came with updates [V-S `routes/tasks.ts:75-97`]) |
| `notifications.event` | mapped as in §3.9 |
| `recurring_tasks` | `weekdays`, `start_date = created_at::date`, `due_hour` from `run_time` + `due_in_hours` [A, pending D-5] |
| `sla_rules.config` | add `dueSoonHours: 24` |

### 4.3 Rows that cannot be migrated
`activity_log` and `admin_log` rows are immutable and hashed. Their legacy `kind` values (`update`, `status`, `reassign`, `ack`, `escalation`, `deescalation` [V-S `services/activity.ts:7-16`]) and old status strings inside `before/after` are mapped **at read time** in the API (`update→progress`, `status→status_changed`, `reassign→reassigned`, `ack→escalation_acknowledged`, `escalation→escalated`, `open/done→assigned/completed`). The hash is computed over stored values, so chains keep verifying.

## 5. Retention
- Closed tasks and their logs are kept **7 years**; people who leave are **archived, never deleted** [WO p.5]. Enforced by the delete-forbidding triggers (§3.13) and by `users.archived_at`/`active` instead of deletes (existing STAFF-03 behaviour).
- v1 has **no purge job**. What happens after year 7 is not specified — D-66 (decided).
- Attachment files in `UPLOAD_DIR` follow the same rule (removal hides, never deletes, ATT-03) and must be in the backups ([SCALABILITY_AND_RELIABILITY.md §5](SCALABILITY_AND_RELIABILITY.md)).
- Volume assumptions and index rationale: [SCALABILITY_AND_RELIABILITY.md §6](SCALABILITY_AND_RELIABILITY.md).

## 6. Implementation log
- **2026-11-04, `002_model.sql` (T-1.5), applied to dev.** Implements §3.1–3.4, 3.6–3.10 (without the chain columns) and 3.12.
  - **Deferred to `004`, so 002 stays additive and the current server keeps working:**
    - the task status default (`open` → `assigned`)
    - dropping `tasks_open_idx`
    - the §3.13 triggers
  - **Moved to table level:** `parent_id <> id` and `end_date >= start_date`, because each compares two columns.
- **2026-11-04, `003_teams.sql` (T-1.6), applied to dev.** It seeds teams only: one per lead in that lead's entity, with the lead and their same-entity direct reports as members (D-67). Dev result: 6 teams, 20 of 26 people placed.
  - **The rest of the §4.2 mapping now runs in the cutover migration (T-4.0)**, in the same step as the server's switch to the new model. The current server keeps writing old-shape rows (status `open`/`done`, comments only in the log, old notification events, tasks without `created_by`), so mapping them earlier would go stale.
  - **Role permissions and `dueSoonHours` are not stored as data.** When nothing is stored, the server uses the shared `DEFAULT_ROLE_PERMISSIONS` and its default rules, so the values aren't kept in SQL as well.
- **2026-11-04, `004_auth.sql` (T-1.8), applied to dev.** As §3.11, plus two checks: `user_credentials` (TOTP enabled ⇒ secret present) and `password_reset_tokens` (`expires_at > created_at`).
- **2026-11-04, `005_audit_chain.sql` (T-1.9), applied to dev.** Adds the chain columns (all three set, or all null), initialises the head `app_state.admin_log_head`, and adds trigger `admin_log_require_chain`, which refuses rows without a chain position. Dev had no audit rows, so the chain covers all of them. Writer: `services/audit.ts`.
- **2026-11-05, migration 009 (T-4.0 cutover):** statuses `open→assigned`, `done→completed`; `created_by`, `reviewer_id` (= assigner), `updated_at`, `completed_at`, `team_id` (assignee's team) backfilled; `users.whatsapp` copied from E.164 `phone`; status CHECK without `open`/`done`, default `assigned`, `created_by`/`reviewer_id`/`updated_at` NOT NULL; `tasks_open_idx` dropped, `tasks_active_idx` rebuilt; no-delete and no-truncate triggers (`taskwatch_forbid_delete`) on the record tables (§3.13). Not in 009, moved to the task that switches their writers: comments copy (T-4.10), `notifications.event` mapping (Phase 6), recurring `weekdays`/`start_date` (Phase 7). Legacy log kinds and statuses are mapped at read time (`services/activity.ts` `presentKind`, `presentValues`). Dev: 52 tasks, open/closed state unchanged, 346 log rows and the admin chain verify with 0 breaks. Backup `backups/taskwatch-before-T-4.0-2026-11-05.dump`.
- **2026-11-05, migration 010 (T-4.10):** each `activity_log` comment row copied into `comments` (linked by `log_id`); the log rows are unchanged evidence. Dev: 4 comments. Backup `backups/taskwatch-before-T-4.10-2026-11-05.dump`.
- **2026-11-05, migration 011 (T-5.1):** `escalations.reason` check gains `blocked` (D-24). Additive; dev escalations unchanged (129 silence, 20 overdue). Backup `backups/taskwatch-before-T-5.1-2026-11-05.dump`.
- **2026-11-06, migration 013 (T-7.1, T-7.3):** existing schedules converted to the client model (`start_date`, `weekdays`, `due_hour`, `category` filled; then `not null`); `next_run_at` and `due_in_hours` made nullable and no longer read (kept, nothing deleted); new `last_occurrence date` (the assignee-zone day generation last handled). Backup `backups/taskwatch-before-T-7.1-2026-11-06.dump`.
- **2026-11-05, migration 012 (T-6.3, T-6.4):** `users.quiet_start/quiet_end` (HH:MM, both or neither; D-105) and `notifications.claimed_at` (dispatcher lease). Additive. **Change to §3.9:** `notifications.event` is *not* mapped in a migration; it keeps its stored value and the type is derived at read time (`shared/notifications.ts` `typeOfEvent`), like the activity-log kinds. New rows set `parent_id` (email → its in-app row) and `level`. Backup `backups/taskwatch-before-T-6.3-2026-11-05.dump`.
