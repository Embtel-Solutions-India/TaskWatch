-- 003: seed teams from the current reporting lines (T-1.6; D-67: one team per lead within their entity; the
-- Chief of Staff renames or reorganises them in Org). Reference data only: the current server never reads or
-- writes teams, so nothing here can go stale. The status, comment, notification and other row mappings run in
-- the cutover migration together with the server's switch to the new model (DATABASE_DESIGN §6).

-- One team per person holding the lead role, in the lead's entity. Archived if the lead is.
insert into teams (name, entity_id, lead_id, archived_at)
select l.name || '''s team', l.entity_id, l.id, case when l.active then null else now() end
from users l
where 'lead' = any (l.roles)
  and not exists (select 1 from teams t where t.lead_id = l.id);

-- Each lead joins their own team.
update users u
set team_id = t.id
from teams t
where t.lead_id = u.id
  and u.team_id is null;

-- Direct reports of a lead join that lead's team when they share its entity (the composite FK requires it).
update users u
set team_id = t.id
from teams t
join users l on l.id = t.lead_id
where u.manager_id = l.id
  and u.entity_id = t.entity_id
  and u.team_id is null;
