-- 008: ROLE-02 (T-3.1). Records that an organization saved its own role matrix. Until then the shared defaults
-- apply; afterwards role_permissions is the whole truth, even when a role (or every editable role) holds nothing.
-- Without this, emptying every role would silently bring the defaults (and their grants) back.
alter table organizations add column role_matrix_saved_at timestamptz;
update organizations o set role_matrix_saved_at = now()
 where exists (select 1 from role_permissions r where r.organization_id = o.id);
