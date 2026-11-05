// Effective permissions on the server, computed with the shared rules (ADR-0004, ADR-0007).
import { DEFAULT_ROLE_PERMISSIONS, hasPerm, PERMISSIONS, ROLES, type Permission, type Role } from '@taskwatch/shared/permissions';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { appendAdmin } from './audit.js';
import { invalidateDirectory, type DirUser } from './directory.js';

/**
 * The role matrix in force. Until the organization saves one (ROLE-02, `role_matrix_saved_at`), the shared defaults
 * apply, so they are never copied into the database. 'cos' is never stored: it holds all.
 */
export async function getRoleMatrix(organizationId: number, db: Db = pool): Promise<Record<Role, readonly Permission[]>> {
  const { rows } = await db.query<{ saved: boolean; role: Role | null; permission: Permission | null }>(
    `select o.role_matrix_saved_at is not null as saved, r.role, r.permission
       from organizations o left join role_permissions r on r.organization_id = o.id
      where o.id = $1`,
    [organizationId],
  );
  if (!rows[0]?.saved) return DEFAULT_ROLE_PERMISSIONS;
  const matrix = Object.fromEntries(ROLES.map((r) => [r, [] as Permission[]])) as Record<Role, Permission[]>;
  for (const r of rows) if (r.role && r.permission) matrix[r.role].push(r.permission);
  for (const r of ROLES) matrix[r] = PERMISSIONS.filter((p) => matrix[r].includes(p)); // canonical order
  matrix.cos = [...PERMISSIONS];
  return matrix;
}

export const EDITABLE_ROLES = ROLES.filter((r) => r !== 'cos');

/**
 * ROLE-02: replace one role's permissions in the caller's organization. Unknown names are dropped; the rest of the
 * matrix is written as it stands, so saving one role never resets another to the defaults. Audited with the diff.
 */
export async function saveRolePermissions(actor: DirUser, role: Role, requested: readonly string[]): Promise<Record<Role, readonly Permission[]>> {
  const org = actor.organizationId;
  return tx(async (c) => {
    await c.query('select 1 from organizations where id = $1 for update', [org]); // one matrix writer at a time
    const current = await getRoleMatrix(org, c);
    const next = PERMISSIONS.filter((p) => requested.includes(p));
    const added = next.filter((p) => !current[role].includes(p));
    const removed = current[role].filter((p) => !next.includes(p));
    const matrix = { ...current, [role]: next };
    await c.query('delete from role_permissions where organization_id = $1', [org]);
    for (const r of EDITABLE_ROLES) {
      if (matrix[r].length) {
        await c.query('insert into role_permissions (organization_id, role, permission) select $1, $2, unnest($3::text[])', [org, r, matrix[r]]);
      }
    }
    await c.query('update organizations set role_matrix_saved_at = now() where id = $1', [org]);
    await appendAdmin(c, {
      actorId: actor.id,
      kind: 'role.permissions_changed',
      target: `role:${role}`,
      targetType: 'role',
      before: { removed },
      after: { added },
      context: role,
    });
    return matrix;
  }).finally(invalidateDirectory); // the cached directories carry the matrix
}

/** Active people holding each role, counted under every role they hold (D-8). */
export async function roleCounts(organizationId: number, db: Db = pool): Promise<Record<Role, number>> {
  const { rows } = await db.query<{ role: Role; n: number }>(
    `select unnest(roles) as role, count(*)::int as n from users where organization_id = $1 and active group by 1`,
    [organizationId],
  );
  return Object.fromEntries(ROLES.map((r) => [r, rows.find((x) => x.role === r)?.n ?? 0])) as Record<Role, number>;
}

/** Every permission the person holds: the union over their roles (D-8); none when inactive. */
export function effectivePermissions(user: DirUser, matrix: Record<Role, readonly Permission[]>): Permission[] {
  const org = { people: [], rolePermissions: matrix };
  const person = { id: user.id, roles: user.roles, managerId: user.managerId, active: user.active };
  return PERMISSIONS.filter((p) => hasPerm(org, person, p));
}
