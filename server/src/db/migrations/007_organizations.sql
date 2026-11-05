-- 007: multiple organizations in one database (T-3.0; ADR-0010, D-95…D-97, D-100…D-104).
-- Everything that exists today becomes organization 1, "Vertical" (D-104).
-- Columns are added with "default 1" and the default is then dropped: that backfills existing rows without an
-- UPDATE, which the append-only trigger on admin_log would refuse. New rows must name their organization.

create table organizations (
  id             serial primary key,
  name           text not null check (length(trim(name)) between 2 and 120),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  google_domains text[] not null default '{}',            -- D-101: empty = fall back to GOOGLE_ALLOWED_DOMAINS
  settings       jsonb not null default '{}',             -- changed values only; shared defaults fill the rest
  audit_head     jsonb not null default '{"seq": 0, "hash": ""}'  -- this organization's admin_log chain head
);
create unique index organizations_name_uq on organizations (lower(name));

insert into organizations (id, name, settings, audit_head) values (
  1, 'Vertical',
  coalesce((select value from app_state where key = 'settings'), '{}'),
  coalesce((select value from app_state where key = 'admin_log_head'), '{"seq": 0, "hash": ""}')
);
select setval(pg_get_serial_sequence('organizations', 'id'), 1);

-- The platform chain (organization created, platform events) starts empty. The old app_state rows 'settings' and
-- 'admin_log_head' are copied above and no longer read; they are left in place (no data is deleted).
insert into app_state (key, value) values ('platform_log_head', '{"seq": 0, "hash": ""}') on conflict (key) do nothing;

-- Root tables (ADR-0010 §2). Children reach the organization through their parent.
alter table users            add column organization_id int not null default 1 references organizations(id);
alter table entities         add column organization_id int not null default 1 references organizations(id);
alter table teams            add column organization_id int not null default 1 references organizations(id);
alter table tasks            add column organization_id int not null default 1 references organizations(id);
alter table recurring_tasks  add column organization_id int not null default 1 references organizations(id);
alter table sla_rules        add column organization_id int not null default 1 references organizations(id);
alter table role_permissions add column organization_id int not null default 1 references organizations(id);
alter table notifications    add column organization_id int not null default 1 references organizations(id);
alter table escalations      add column organization_id int not null default 1 references organizations(id);
alter table admin_log        add column organization_id int default 1 references organizations(id); -- null = platform chain

alter table users            alter column organization_id drop default;
alter table entities         alter column organization_id drop default;
alter table teams            alter column organization_id drop default;
alter table tasks            alter column organization_id drop default;
alter table recurring_tasks  alter column organization_id drop default;
alter table sla_rules        alter column organization_id drop default;
alter table role_permissions alter column organization_id drop default;
alter table notifications    alter column organization_id drop default;
alter table escalations      alter column organization_id drop default;
alter table admin_log        alter column organization_id drop default;

-- Per-organization keys.
alter table sla_rules drop constraint sla_rules_pkey, add primary key (organization_id, scope);
alter table role_permissions drop constraint role_permissions_pkey, add primary key (organization_id, role, permission);
alter table admin_log drop constraint admin_log_seq_key;
create unique index admin_log_org_seq_uq on admin_log (organization_id, seq) nulls not distinct;

-- Targets for the composite foreign keys.
alter table users           add constraint users_id_org_uq           unique (id, organization_id);
alter table entities        add constraint entities_id_org_uq        unique (id, organization_id);
alter table teams           add constraint teams_id_org_uq           unique (id, organization_id);
alter table tasks           add constraint tasks_id_org_uq           unique (id, organization_id);
alter table recurring_tasks add constraint recurring_tasks_id_org_uq unique (id, organization_id);

-- No link may cross organizations (ADR-0010 §2, D-103). Nullable references are checked only when set.
alter table users
  add constraint users_entity_org_fk  foreign key (entity_id, organization_id)  references entities (id, organization_id),
  add constraint users_manager_org_fk foreign key (manager_id, organization_id) references users (id, organization_id);
alter table entities
  add constraint entities_head_org_fk foreign key (head_id, organization_id) references users (id, organization_id);
alter table teams
  add constraint teams_entity_org_fk foreign key (entity_id, organization_id) references entities (id, organization_id),
  add constraint teams_lead_org_fk   foreign key (lead_id, organization_id)   references users (id, organization_id);
alter table tasks
  add constraint tasks_entity_org_fk    foreign key (entity_id, organization_id)    references entities (id, organization_id),
  add constraint tasks_team_org_fk      foreign key (team_id, organization_id)      references teams (id, organization_id),
  add constraint tasks_assignee_org_fk  foreign key (assignee_id, organization_id)  references users (id, organization_id),
  add constraint tasks_assigner_org_fk  foreign key (assigner_id, organization_id)  references users (id, organization_id),
  add constraint tasks_created_org_fk   foreign key (created_by, organization_id)   references users (id, organization_id),
  add constraint tasks_reviewer_org_fk  foreign key (reviewer_id, organization_id)  references users (id, organization_id),
  add constraint tasks_closed_org_fk    foreign key (closed_by, organization_id)    references users (id, organization_id),
  add constraint tasks_parent_org_fk    foreign key (parent_id, organization_id)    references tasks (id, organization_id),
  add constraint tasks_recurring_org_fk foreign key (recurring_id, organization_id) references recurring_tasks (id, organization_id);
alter table recurring_tasks
  add constraint recurring_entity_org_fk   foreign key (entity_id, organization_id)   references entities (id, organization_id),
  add constraint recurring_team_org_fk     foreign key (team_id, organization_id)     references teams (id, organization_id),
  add constraint recurring_assignee_org_fk foreign key (assignee_id, organization_id) references users (id, organization_id),
  add constraint recurring_created_org_fk  foreign key (created_by, organization_id)  references users (id, organization_id);
alter table escalations
  add constraint escalations_task_org_fk     foreign key (task_id, organization_id)         references tasks (id, organization_id),
  add constraint escalations_assignee_org_fk foreign key (assignee_id, organization_id)     references users (id, organization_id),
  add constraint escalations_ack_org_fk      foreign key (acknowledged_by, organization_id) references users (id, organization_id);
alter table notifications
  add constraint notifications_user_org_fk foreign key (user_id, organization_id) references users (id, organization_id),
  add constraint notifications_task_org_fk foreign key (task_id, organization_id) references tasks (id, organization_id);
alter table sla_rules
  add constraint sla_rules_updated_org_fk foreign key (updated_by, organization_id) references users (id, organization_id);
alter table admin_log
  add constraint admin_log_actor_org_fk foreign key (actor_id, organization_id) references users (id, organization_id),
  add constraint admin_log_task_org_fk  foreign key (task_id, organization_id)  references tasks (id, organization_id);

create index users_org_idx on users (organization_id);
create index tasks_org_idx on tasks (organization_id);
