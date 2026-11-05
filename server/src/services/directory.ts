import { DEFAULT_ROLE_PERMISSIONS, type Org, type Permission } from '@taskwatch/shared/permissions';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import type { Role } from '../domain.js';
import { getRoleMatrix } from './permissions.js';

export interface DirUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  /** WhatsApp number (STAFF-02); alerts go here, never to `phone`. */
  whatsapp: string | null;
  title: string | null;
  entityId: string;
  roles: Role[];
  managerId: number | null;
  timeZone: string;
  /** D-105: own quiet window (HH:MM, recipient's zone); null = the organization's. */
  quietStart: string | null;
  quietEnd: string | null;
  whatsappOptIn: boolean;
  active: boolean;
  teamId: number | null;
  organizationId: number;
}

/** In-memory view of one organization's people, reporting lines and role matrix (`org`, for the shared rules). */
export class Directory {
  readonly byId = new Map<number, DirUser>();
  private readonly reports = new Map<number, number[]>();
  readonly org: Org<number>;

  constructor(users: DirUser[], matrix: Record<Role, readonly Permission[]> = DEFAULT_ROLE_PERMISSIONS) {
    this.org = { people: users, rolePermissions: matrix };
    for (const u of users) this.byId.set(u.id, u);
    for (const u of users) {
      if (u.managerId == null) continue;
      const list = this.reports.get(u.managerId) ?? [];
      list.push(u.id);
      this.reports.set(u.managerId, list);
    }
  }

  get(id: number): DirUser | undefined {
    return this.byId.get(id);
  }

  must(id: number): DirUser {
    const u = this.byId.get(id);
    if (!u) throw new Error(`Unknown user ${id}`);
    return u;
  }

  all(): DirUser[] {
    return [...this.byId.values()];
  }

  /** Managers above this person, nearest first (inactive people included). */
  ancestors(id: number): DirUser[] {
    const out: DirUser[] = [];
    const seen = new Set<number>([id]);
    let cur = this.byId.get(id)?.managerId ?? null;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const u = this.byId.get(cur);
      if (!u) break;
      out.push(u);
      cur = u.managerId;
    }
    return out;
  }

  /** Everyone below this person in the reporting tree. */
  descendants(id: number): Set<number> {
    const out = new Set<number>();
    const stack = [...(this.reports.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (out.has(next) || next === id) continue;
      out.add(next);
      stack.push(...(this.reports.get(next) ?? []));
    }
    return out;
  }

  supervises(supervisorId: number, userId: number): boolean {
    return this.ancestors(userId).some((u) => u.id === supervisorId);
  }

  withRole(role: Role): DirUser[] {
    return this.all().filter((u) => u.active && u.roles.includes(role));
  }
}

export function hasRole(u: Pick<DirUser, 'roles'>, ...roles: Role[]): boolean {
  return roles.some((r) => u.roles.includes(r));
}

/** CEO and Chief of Staff see everything. */
export function isFounderOffice(u: Pick<DirUser, 'roles'>): boolean {
  return hasRole(u, 'ceo', 'cos');
}

export function toDirUser(r: Record<string, any>): DirUser {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    whatsapp: r.whatsapp ?? null,
    title: r.title,
    entityId: r.entity_id,
    roles: r.roles,
    managerId: r.manager_id,
    timeZone: r.time_zone,
    quietStart: r.quiet_start ?? null,
    quietEnd: r.quiet_end ?? null,
    whatsappOptIn: r.whatsapp_opt_in,
    active: r.active,
    teamId: r.team_id ?? null,
    organizationId: r.organization_id,
  };
}

// ponytail: per-process cache. People and matrix changes clear it on this instance at once; another instance sees
// them within TTL_MS. Fine for the single-instance deployment; use a version row (or LISTEN/NOTIFY) beyond that.
const cached = new Map<number, { at: number; dir: Directory }>();
const TTL_MS = 30_000;

/** One organization's people (ADR-0010): a directory never holds anyone from another organization. */
export async function getDirectory(organizationId: number, db: Db = pool): Promise<Directory> {
  const hit = cached.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.dir;
  const [{ rows }, matrix] = await Promise.all([
    db.query('select * from users where organization_id = $1 order by id', [organizationId]),
    getRoleMatrix(organizationId, db),
  ]);
  const dir = new Directory(rows.map(toDirUser), matrix);
  cached.set(organizationId, { at: Date.now(), dir });
  return dir;
}

export function invalidateDirectory(): void {
  cached.clear();
}
