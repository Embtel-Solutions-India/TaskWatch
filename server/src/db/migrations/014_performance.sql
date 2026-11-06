-- 014: measured tasks, ratings and scoring (PERFORMANCE-FRD; plan Task 2). Additive.
alter table tasks
  add column target               numeric check (target > 0),
  add column unit                 text check (char_length(unit) between 1 and 40),
  add column achieved             numeric check (achieved >= 0),
  add column result               text check (char_length(result) <= 1000),
  add column estimated_hours      numeric check (estimated_hours between 0.25 and 200),
  add column purpose              text check (purpose in ('revenue', 'support')),
  add column quality_score        smallint check (quality_score between 0 and 100),
  add column outcome_score        smallint check (outcome_score between 0 and 100),
  add column shortfall_reason     text check (char_length(shortfall_reason) <= 500),
  add column shortfall_accepted   boolean,
  add column shortfall_decided_by int references users(id),
  add column shortfall_decided_at timestamptz,
  -- Tasks created before this feature are never scored (FRD §4 "Existing data"); new rows default to true.
  add column scored               boolean not null default false,
  add constraint tasks_unit_with_target check (target is null or unit is not null);
alter table tasks alter column scored set default true;

alter table recurring_tasks
  add column target          numeric check (target > 0),
  add column unit            text check (char_length(unit) between 1 and 40),
  add column estimated_hours numeric check (estimated_hours between 0.25 and 200),
  add column purpose         text check (purpose in ('revenue', 'support')),
  add constraint recurring_unit_with_target check (target is null or unit is not null);
