-- 016: a never-assigned draft can be discarded by its giver (owner 2026-11-11, D-133). Rows are still never deleted
-- (009 guard, WO retention); a discarded draft is only hidden from every screen. Additive.
alter table tasks add column discarded_at timestamptz;
