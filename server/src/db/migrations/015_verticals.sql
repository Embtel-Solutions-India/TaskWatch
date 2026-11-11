-- 015: verticals can be archived (ADR-0011, D-131). Additive; entities stay `entities` in the database.
alter table entities add column archived_at timestamptz;
