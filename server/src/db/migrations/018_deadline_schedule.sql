-- 018: fixed deadline milestones on each task, policy versions, submission requirements and escalation accountability
-- (ADR-0014 §12; D-140, D-145, D-146). Additive. Open tasks are backfilled with the offsets that applied until now
-- (L2 = due + 24 h, L3 = due + 72 h), so nothing escalates differently when this is deployed.
alter table tasks
  add column deadline_l2_at          timestamptz,   -- L1 is due_at itself
  add column deadline_l3_at          timestamptz,
  add column policy_version          text,          -- e.g. default@3,BAIS@2: the policy rows the milestones came from
  add column submission_requirements text;

alter table sla_rules add column version int not null default 1;

alter table escalations add column accountable text not null default 'assignee'
  check (accountable in ('assignee', 'reviewer'));

update tasks
   set deadline_l2_at = due_at + interval '24 hours', deadline_l3_at = due_at + interval '72 hours', policy_version = 'default@1'
 where status not in ('completed', 'cancelled', 'draft');

create index tasks_deadline_idx on tasks (deadline_l2_at);
