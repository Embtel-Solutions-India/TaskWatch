-- 005: hash-chain the admin audit log (T-1.9; S-11; DATABASE_DESIGN §3.10). One global chain, hashed exactly like
-- the per-task activity chains (services/activity.ts chainHash). Rows written before this migration cannot be
-- updated (append-only trigger), so they stay unchained (seq null); the chain starts here.

alter table admin_log
  add column seq       bigint unique,
  add column prev_hash text,
  add column hash      text,
  add constraint admin_log_chain_complete check (
    (seq is null and prev_hash is null and hash is null) or (seq is not null and prev_hash is not null and hash is not null));

-- The chain head, locked "for update" by every writer so positions never race (services/audit.ts).
insert into app_state (key, value) values ('admin_log_head', '{"seq": 0, "hash": ""}') on conflict (key) do nothing;

-- From now on every audit row must be on the chain: a direct insert that bypasses services/audit.ts is rejected.
create function taskwatch_require_audit_chain() returns trigger language plpgsql as $$
begin
  if new.seq is null then
    raise exception 'admin_log rows must be written through the audit chain (services/audit.ts)';
  end if;
  return new;
end $$;
create trigger admin_log_require_chain before insert on admin_log
  for each row execute function taskwatch_require_audit_chain();
