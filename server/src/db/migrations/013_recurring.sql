-- 013: recurring schedules on the client model (Phase 7: T-7.1, T-7.3; D-5, D-45).
-- Existing schedules are converted in place. The old timing columns (weekday, month_day, run_time, due_in_hours,
-- next_run_at) are kept, since nothing is deleted, but no code reads them any more.
update recurring_tasks set
  start_date = case when frequency = 'monthly' and month_day is not null
                    then make_date(extract(year from created_at)::int, extract(month from created_at)::int, month_day)
                    else created_at::date end,
  weekdays   = case when frequency = 'weekly' and weekday is not null then array[(weekday % 7)::smallint] else weekdays end,
  due_hour   = extract(hour from run_time::time + make_interval(hours => due_in_hours))::smallint
where start_date is null;

-- Schedules from before categories existed take the organization's first category, as generation used to do
-- ('Operations' is the first of the shared defaults in shared/settings.ts).
update recurring_tasks r set category = coalesce(o.settings->'categories'->>0, 'Operations')
  from organizations o where o.id = r.organization_id and r.category is null;

alter table recurring_tasks
  alter column category     set not null,
  alter column start_date   set not null,
  alter column due_hour     set not null,
  alter column next_run_at  drop not null,
  alter column due_in_hours drop not null,
  -- The occurrence day (in the assignee's zone) that generation last handled, whether it created a task or skipped.
  add column last_occurrence date;
