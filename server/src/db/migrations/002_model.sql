-- 002: additive schema for the new client model (T-1.5; docs/03-architecture/DATABASE_DESIGN.md §3).
-- New tables and nullable/defaulted columns only, so the existing server and its tests keep working.
-- Data mapping is 003, tightening (NOT NULL, final CHECKs, new defaults, no-delete triggers) is 004,
-- auth tables 005, the audit-log chain 006.

-- §3.1 Entities (= Departments, ADR-0004) and teams
alter table entities add column head_id int references users(id);

create table teams (
  id          serial primary key,
  name        text not null,
  entity_id   text not null references entities(id),
  lead_id     int references users(id),
  archived_at timestamptz,
  unique (id, entity_id)                                  -- target of the users composite FK
);
create unique index teams_entity_name_uq on teams (entity_id, lower(name));

-- §3.2 Users
alter table users
  add column team_id  int,
  add column location text not null default '',
  add column whatsapp text check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  add constraint users_team_entity_fk foreign key (team_id, entity_id) references teams (id, entity_id);
alter table users alter column whatsapp_opt_in set default false;            -- D-75: consent must be explicit
alter table users drop constraint users_email_key;
create unique index users_email_lower_uq on users (lower(email));            -- case-insensitive (S-8)
create index users_team_idx on users (team_id);

-- §3.3 Role permissions ('cos' holds everything and is never stored). Rows are seeded in 003.
create table role_permissions (
  role       text not null check (role in ('ceo','manager','lead','staff')),
  permission text not null check (permission in (
    'view_tasks','create_tasks','assign_tasks','reassign_tasks','update_assigned_tasks','review_tasks',
    'approve_extensions','manage_team','view_team_reports','view_org_reports','manage_staff',
    'manage_roles','manage_escalation_policies','view_audit_logs','manage_system_settings')),
  primary key (role, permission)
);

-- §3.4 Tasks. The status CHECK accepts old and new values until 004; the default stays 'open' until then,
-- because the current server creates tasks without naming a status.
alter table tasks drop constraint tasks_status_check;
alter table tasks
  add constraint tasks_status_check check (status in
    ('open','done','draft','assigned','in_progress','blocked','submitted','changes_requested','reopened','completed','cancelled')),
  add column description       text not null default '',
  add column category          text,
  add column team_id           int references teams(id),
  add column created_by        int references users(id),
  add column reviewer_id       int references users(id),
  add column start_at          timestamptz,
  add column acknowledged_at   timestamptz,
  add column snooze_until      timestamptz,
  add column progress          smallint not null default 0 check (progress between 0 and 100),
  add column review_required   boolean not null default false,
  add column parent_id         int references tasks(id),
  add column occurrence_date   date,
  add column cancel_reason     text,
  add column completed_at      timestamptz,
  add column updated_at        timestamptz,
  add column due_soon_sent_for timestamptz,
  add column overdue_sent_for  timestamptz,
  add constraint tasks_parent_not_self check (parent_id <> id);
create unique index tasks_recurrence_day_uq on tasks (recurring_id, occurrence_date) where recurring_id is not null;
create index tasks_active_idx   on tasks (status) where status not in ('completed','cancelled','draft','done');
create index tasks_assigner_idx on tasks (assigner_id);
create index tasks_team_idx     on tasks (team_id);
create index tasks_parent_idx   on tasks (parent_id);

-- §3.6 Reviews and extensions
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
create unique index reviews_one_pending_uq on reviews (task_id) where decision is null;

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
create unique index extensions_one_pending_uq on extensions (task_id) where status = 'pending';
create index extensions_task_idx on extensions (task_id);

-- §3.7 Comments (originals stay in the chained activity_log, D-12), attachments, assignments, preferences
create table comments (
  id         serial primary key,
  task_id    int  not null references tasks(id),
  author_id  int  not null references users(id),
  parent_id  int  references comments(id),
  body       text not null,
  created_at timestamptz not null,
  edited_at  timestamptz,
  deleted_at timestamptz,
  deleted_by int references users(id),
  log_id     bigint not null references activity_log(id)
);
create index comments_task_idx on comments (task_id, created_at);

alter table attachments
  add column context    text not null default 'progress' check (context in ('task','progress','comment','review')),
  add column comment_id int references comments(id),
  add column review_id  int references reviews(id),
  add column removed_at timestamptz,
  add column removed_by int references users(id);
create index attachments_task_idx on attachments (task_id);

alter table assignments
  add column from_id int references users(id),
  add column reason  text not null default '';

create table notification_prefs (
  user_id    int primary key references users(id),
  prefs      jsonb not null,
  updated_at timestamptz not null
);

-- §3.8 Escalation events
alter table escalations
  add column reached_at       timestamptz,
  add column cycle_started_at timestamptz;
create index escalations_task_idx on escalations (task_id);

-- §3.9 Notifications and deliveries
alter table notifications
  add column parent_id   bigint references notifications(id),
  add column level       smallint check (level between 0 and 3),
  add column digest_week date;
create index notifications_created_idx on notifications (created_at desc);
create index notifications_task_idx    on notifications (task_id);

-- §3.10 Audit log fields (the hash chain columns come in 006)
alter table admin_log
  add column target_type text check (target_type in ('task','user','role','policy','settings','team','recurrence','demo','auth')),
  add column task_id     int references tasks(id),
  add column source      text not null default 'ui' check (source in ('ui','system','demo')),
  add column context     text not null default '';
create index admin_log_at_idx   on admin_log (at desc);
create index admin_log_task_idx on admin_log (task_id);

-- §3.12 Recurring schedules
alter table recurring_tasks drop constraint recurring_tasks_frequency_check;
alter table recurring_tasks
  add constraint recurring_tasks_frequency_check check (frequency in ('daily','weekly','monthly','interval')),
  add column description     text not null default '',
  add column category        text,
  add column team_id         int references teams(id),
  add column review_required boolean not null default false,
  add column "interval"      int not null default 1 check ("interval" between 1 and 365),
  add column weekdays        smallint[] not null default '{}' check (weekdays <@ array[0,1,2,3,4,5,6]::smallint[]),
  add column start_date      date,
  add column end_date        date,
  add column due_hour        smallint check (due_hour between 0 and 23),
  add column deleted_at      timestamptz,
  add constraint recurring_tasks_dates_ordered check (end_date is null or start_date is null or end_date >= start_date);
