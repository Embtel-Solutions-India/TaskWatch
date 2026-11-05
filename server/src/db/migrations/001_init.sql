-- TaskWatch schema (FO-2026-OPS-01, WP-1/WP-2)
-- All timestamps are timestamptz (stored UTC). Event times are always supplied by the server.

create table entities (
  id   text primary key,
  name text not null,
  sort int  not null default 0
);

create table users (
  id              serial primary key,
  name            text not null,
  email           text not null unique,
  phone           text,
  title           text,
  entity_id       text not null references entities(id),
  roles           text[] not null check (
                    cardinality(roles) > 0 and
                    roles <@ array['ceo','cos','manager','lead','staff']::text[]),
  manager_id      int references users(id),
  time_zone       text not null default 'Asia/Kolkata',
  whatsapp_opt_in boolean not null default true,
  active          boolean not null default true,
  archived_at     timestamptz,
  created_at      timestamptz not null
);
create index users_manager_idx on users(manager_id);

create table recurring_tasks (
  id            serial primary key,
  title         text not null,
  entity_id     text not null references entities(id),
  assignee_id   int  not null references users(id),
  priority      text not null check (priority in ('critical','high','normal','low')),
  instructions  text not null default '',
  frequency     text not null check (frequency in ('daily','weekly','monthly')),
  weekday       smallint check (weekday between 1 and 7),
  month_day     smallint check (month_day between 1 and 28),
  run_time      text not null default '09:00',
  due_in_hours  int  not null check (due_in_hours > 0),
  created_by    int  not null references users(id),
  active        boolean not null default true,
  next_run_at   timestamptz not null,
  last_run_at   timestamptz,
  created_at    timestamptz not null
);

create table tasks (
  id                  serial primary key,
  title               text not null,
  entity_id           text not null references entities(id),
  assignee_id         int  not null references users(id),
  assigner_id         int  not null references users(id),
  priority            text not null check (priority in ('critical','high','normal','low')),
  status              text not null default 'open' check (status in ('open','in_progress','blocked','done')),
  instructions        text not null default '',
  blocked_reason      text,
  due_at              timestamptz not null,
  original_due_at     timestamptz not null,
  created_at          timestamptz not null,
  assigned_at         timestamptz not null,
  clock_started_at    timestamptz not null,
  last_update_at      timestamptz,
  lead_extension_used boolean not null default false,
  level               smallint not null default -1 check (level between -1 and 3),
  level_reason        text,
  closed_at           timestamptz,
  closed_by           int references users(id),
  recurring_id        int references recurring_tasks(id),
  log_seq             int  not null default 0,
  log_head            text not null default ''
);
create index tasks_assignee_idx on tasks(assignee_id);
create index tasks_open_idx on tasks(status) where status <> 'done';

-- One row per (re)assignment; drives "average first response".
create table assignments (
  id              serial primary key,
  task_id         int not null references tasks(id),
  assignee_id     int not null references users(id),
  assigned_by     int not null references users(id),
  assigned_at     timestamptz not null,
  first_update_at timestamptz,
  ended_at        timestamptz
);
create index assignments_task_idx on assignments(task_id);

-- Append-only, hash-chained evidence log (one chain per task).
create table activity_log (
  id         bigserial primary key,
  task_id    int  not null references tasks(id),
  seq        int  not null,
  at         timestamptz not null,
  actor_id   int  references users(id),
  kind       text not null,
  body       text,
  before     jsonb,
  after      jsonb,
  prev_hash  text not null,
  hash       text not null,
  unique (task_id, seq)
);

create function taskwatch_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end $$;

create trigger activity_log_no_update before update or delete on activity_log
  for each row execute function taskwatch_forbid_change();
create trigger activity_log_no_truncate before truncate on activity_log
  for each statement execute function taskwatch_forbid_change();

create table attachments (
  id          serial primary key,
  task_id     int  not null references tasks(id),
  log_id      bigint not null references activity_log(id),
  file_name   text not null,
  mime        text not null,
  size        int  not null,
  sha256      text not null,
  storage_key text not null,
  uploaded_by int  not null references users(id),
  uploaded_at timestamptz not null
);

create table escalations (
  id              serial primary key,
  task_id         int not null references tasks(id),
  level           smallint not null check (level between 0 and 3),
  reason          text not null check (reason in ('silence','overdue')),
  assignee_id     int not null references users(id),
  fired_at        timestamptz not null,
  last_alert_at   timestamptz not null,
  cleared_at      timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by int references users(id),
  ack_note        text,
  snooze_until    timestamptz
);
create unique index escalations_active_uq on escalations(task_id, level) where cleared_at is null;

create table escalation_recipients (
  escalation_id int not null references escalations(id),
  user_id       int not null references users(id),
  kind          text not null check (kind in ('to','cc')),
  primary key (escalation_id, user_id)
);

-- Delivery log for every alert on every channel.
create table notifications (
  id            bigserial primary key,
  user_id       int  not null references users(id),
  task_id       int  references tasks(id),
  escalation_id int  references escalations(id),
  event         text not null,
  channel       text not null check (channel in ('inapp','whatsapp','email')),
  status        text not null check (status in ('pending','held','sending','sent','simulated','failed','skipped')),
  address       text,
  subject       text,
  body          text not null,
  template      text,
  template_params jsonb,
  link          text,
  send_after    timestamptz not null,
  created_at    timestamptz not null,
  sent_at       timestamptz,
  read_at       timestamptz,
  attempts      int not null default 0,
  provider_id   text,
  error         text
);
create index notifications_due_idx on notifications(send_after) where status in ('pending','held');
create index notifications_user_idx on notifications(user_id, channel, created_at desc);

-- SLA windows and ladder: 'default' plus optional per-entity overrides.
create table sla_rules (
  scope      text primary key,
  config     jsonb not null,
  updated_at timestamptz not null,
  updated_by int references users(id)
);

-- Append-only log of rule, directory and admin changes.
create table admin_log (
  id       bigserial primary key,
  at       timestamptz not null,
  actor_id int references users(id),
  kind     text not null,
  target   text,
  before   jsonb,
  after    jsonb,
  note     text
);
create trigger admin_log_no_update before update or delete on admin_log
  for each row execute function taskwatch_forbid_change();
create trigger admin_log_no_truncate before truncate on admin_log
  for each statement execute function taskwatch_forbid_change();

create table chain_checks (
  id            serial primary key,
  ran_at        timestamptz not null,
  trigger       text not null,
  ok            boolean not null,
  tasks_checked int not null,
  rows_checked  int not null,
  breaks        jsonb not null default '[]'
);

create table job_runs (
  job    text not null,
  run_key text not null,
  ran_at timestamptz not null,
  detail jsonb,
  primary key (job, run_key)
);

create table app_state (
  key   text primary key,
  value jsonb not null
);

-- Session store (connect-pg-simple).
create table "session" (
  sid    varchar primary key,
  sess   json not null,
  expire timestamp(6) not null
);
create index session_expire_idx on "session"(expire);
