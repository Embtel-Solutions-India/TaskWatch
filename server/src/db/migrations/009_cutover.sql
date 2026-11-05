-- 009: cutover to the new task model (T-4.0; ADR-0003, DATABASE_DESIGN §3.4, §3.13, §4.2). Ships with the server
-- switch in the same change, so data and code never disagree. Only what the server now reads and writes is migrated;
-- comments (T-4.10), notification events (Phase 6) and recurring fields (Phase 7) move with the code that uses them.
-- activity_log and admin_log are immutable: their legacy kinds and statuses are mapped when read (§4.3).

-- Statuses (ADR-0003): open → assigned, done → completed; in_progress and blocked keep their names.
update tasks set status = case status when 'open' then 'assigned' when 'done' then 'completed' end
 where status in ('open', 'done');
update tasks set completed_at = closed_at where status = 'completed' and completed_at is null;

-- The people on a task: the giver created it and reviews it until someone else is named.
update tasks set created_by = assigner_id where created_by is null;
update tasks set reviewer_id = assigner_id where reviewer_id is null;
update tasks set updated_at = coalesce(last_update_at, assigned_at) where updated_at is null;
update tasks t set team_id = u.team_id from users u where u.id = t.assignee_id and t.team_id is null and u.team_id is not null;

-- WhatsApp number moves to its own column (STAFF-02); the notifier stops falling back to phone (KI-25).
update users set whatsapp = phone where whatsapp is null and phone ~ '^\+[1-9][0-9]{7,14}$';

-- Tightening (the former T-1.7): only the new statuses, and every task names its creator and reviewer.
alter table tasks
  drop constraint tasks_status_check,
  add constraint tasks_status_check check (status in
    ('draft', 'assigned', 'in_progress', 'blocked', 'submitted', 'changes_requested', 'reopened', 'completed', 'cancelled')),
  alter column status set default 'assigned',
  alter column created_by set not null,
  alter column reviewer_id set not null,
  alter column updated_at set not null;
drop index tasks_open_idx;
drop index tasks_active_idx;
create index tasks_active_idx on tasks (status) where status not in ('completed', 'cancelled', 'draft');

-- Records may change but are never deleted (WO retention: archive, never delete; §3.13).
create function taskwatch_forbid_delete() returns trigger language plpgsql as $$
begin
  raise exception '% rows are archived, never deleted: % is not allowed', tg_table_name, tg_op;
end $$;

do $$
declare t text;
begin
  foreach t in array array['organizations', 'entities', 'teams', 'users', 'tasks', 'recurring_tasks', 'assignments', 'attachments',
                           'comments', 'reviews', 'extensions', 'escalations', 'escalation_recipients', 'notifications', 'chain_checks']
  loop
    execute format('create trigger %I before delete on %I for each row execute function taskwatch_forbid_delete()', t || '_no_delete', t);
    execute format('create trigger %I before truncate on %I for each statement execute function taskwatch_forbid_delete()', t || '_no_truncate', t);
  end loop;
end $$;
