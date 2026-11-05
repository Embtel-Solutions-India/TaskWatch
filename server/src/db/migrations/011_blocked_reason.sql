-- 011: an escalation can be raised because the task is Blocked (T-5.1; WO ladder "L1 … or marked Blocked", D-24).
-- Additive: the reason check gains 'blocked'; no row changes.
alter table escalations drop constraint escalations_reason_check;
alter table escalations add constraint escalations_reason_check check (reason in ('silence', 'overdue', 'blocked'));
