// Who may see and do what — one implementation for server and client (ADR-0004 org model, ADR-0007 sharing).
// Pure: callers pass a small view of their directory; ids may be numbers (server) or strings (client).

export const ROLES = ['ceo', 'cos', 'manager', 'lead', 'staff'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { ceo: 'CEO', cos: 'Chief of Staff', manager: 'Manager', lead: 'Team Lead', staff: 'Staff' };

export const PERMISSIONS = [
  'view_tasks',
  'create_tasks',
  'assign_tasks',
  'reassign_tasks',
  'update_assigned_tasks',
  'review_tasks',
  'approve_extensions',
  'manage_team',
  'view_team_reports',
  'view_org_reports',
  'manage_staff',
  'manage_roles',
  'manage_escalation_policies',
  'view_audit_logs',
  'manage_system_settings',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The seeded role matrix. Editable at run time (ROLE-02) except the CoS, who always holds everything. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // CEO: sees everything (D-33), read-only by default; receives L3.
  ceo: ['view_tasks', 'view_team_reports', 'view_org_reports', 'view_audit_logs'],
  cos: PERMISSIONS,
  manager: ['view_tasks', 'create_tasks', 'assign_tasks', 'reassign_tasks', 'update_assigned_tasks', 'review_tasks', 'approve_extensions', 'manage_team', 'view_team_reports'],
  // D-29: leads do not reassign by default (WO: Manager and CoS only).
  lead: ['view_tasks', 'create_tasks', 'assign_tasks', 'update_assigned_tasks', 'review_tasks', 'approve_extensions', 'view_team_reports'],
  staff: ['update_assigned_tasks'],
};

export interface Person<Id = string> {
  id: Id;
  /** D-8: anyone may hold a second role. Effective permissions are the union. */
  roles: readonly Role[];
  managerId: Id | null;
  active: boolean;
}

export interface Org<Id = string> {
  people: readonly Person<Id>[];
  rolePermissions: Record<Role, readonly Permission[]>;
}

export interface TaskParties<Id = string> {
  assigneeId: Id;
  createdBy: Id;
  assignedBy: Id;
  reviewerId: Id;
}

export const isCoS = <Id>(p: Person<Id>): boolean => p.roles.includes('cos');
/** The Founder's Office (CoS and CEO) sees every entity and task (WO roles table, D-33). */
export const isFoundersOffice = <Id>(p: Person<Id>): boolean => p.roles.includes('cos') || p.roles.includes('ceo');
/** Flagged "No manager": nobody above them, unless they lead the organization (CoS or CEO; owner 2026-11-11). */
export const needsManager = (p: { managerId: unknown; roles: readonly Role[] }): boolean => !p.managerId && !p.roles.includes('cos') && !p.roles.includes('ceo');

export function hasPerm<Id>(org: Org<Id>, p: Person<Id> | null | undefined, perm: Permission): boolean {
  if (!p?.active) return false;
  if (isCoS(p)) return true; // locked: the platform can never lose its administrator
  return p.roles.some((r) => org.rolePermissions[r].includes(perm));
}

/** Everyone below `id` in the reporting tree (transitive). Safe on loops. */
export function reportsOf<Id>(org: Org<Id>, id: Id): Set<Id> {
  const out = new Set<Id>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const u of org.people) {
      if (u.managerId === cur && !out.has(u.id) && u.id !== id) {
        out.add(u.id);
        stack.push(u.id);
      }
    }
  }
  return out;
}

/** The chain of managers above a person, nearest first. Stops on loops. */
export function ancestorsOf<Id>(org: Org<Id>, id: Id): Person<Id>[] {
  const out: Person<Id>[] = [];
  const seen = new Set([id]);
  let cur: Id | null = org.people.find((u) => u.id === id)?.managerId ?? null;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const u = org.people.find((x) => x.id === cur);
    if (!u) break;
    out.push(u);
    cur = u.managerId;
  }
  return out;
}

/** Would making `managerId` the manager of `id` create a reporting loop? */
export function wouldCreateLoop<Id>(org: Org<Id>, id: Id, managerId: Id | null): boolean {
  if (managerId === null) return false;
  return managerId === id || reportsOf(org, id).has(managerId);
}

/** Has authority over the task: its giver or reviewer, a CoS, or someone above the assignee who may view tasks. */
export function isOverseer<Id>(org: Org<Id>, p: Person<Id>, t: TaskParties<Id>): boolean {
  if (!p.active) return false;
  if (isCoS(p)) return true;
  if (t.createdBy === p.id || t.assignedBy === p.id || t.reviewerId === p.id) return true;
  return hasPerm(org, p, 'view_tasks') && reportsOf(org, p.id).has(t.assigneeId);
}

export function canViewTask<Id>(org: Org<Id>, p: Person<Id> | null | undefined, t: TaskParties<Id>): boolean {
  if (!p?.active) return false;
  return isFoundersOffice(p) || t.assigneeId === p.id || isOverseer(org, p, t);
}

/** People this person may assign work to (D-32: themselves and their reports; a CoS: anyone active). */
export function assignableUsers<Id>(org: Org<Id>, p: Person<Id>): Person<Id>[] {
  if (!hasPerm(org, p, 'assign_tasks')) return [];
  const active = org.people.filter((u) => u.active);
  if (isCoS(p)) return active;
  const reports = reportsOf(org, p.id);
  return active.filter((u) => u.id === p.id || reports.has(u.id));
}

export function canAssignTo<Id>(org: Org<Id>, p: Person<Id>, targetId: Id): boolean {
  return assignableUsers(org, p).some((u) => u.id === targetId);
}

/** May this person see another person's record (search, directory, profile)? */
export function canViewUser<Id>(org: Org<Id>, viewer: Person<Id>, target: Person<Id>): boolean {
  if (isFoundersOffice(viewer) || hasPerm(org, viewer, 'manage_staff')) return true;
  if (target.id === viewer.id) return true;
  if (reportsOf(org, viewer.id).has(target.id)) return true;
  return ancestorsOf(org, viewer.id).some((a) => a.id === target.id);
}

/** ADR-0011: the organization's senior for reporting lines: the first active Chief of Staff, else the first active CEO. */
export function seniorOf<Id>(people: readonly { id: Id; roles: readonly Role[]; active: boolean }[]): Id | null {
  const first = (r: Role) => people.find((p) => p.active && p.roles.includes(r))?.id;
  return first('cos') ?? first('ceo') ?? null;
}

/**
 * ADR-0011 / D-130: who a person reports to, automatically. A general manager reports to the senior; a department lead
 * to their vertical's general manager, else the senior; anyone else to their department's lead, else the general
 * manager, else the senior. A Chief of Staff reports to the CEO (`ctx.ceo`), the CEO to nobody (review fix #5: a promotion
 * must move the line too). Pass only active leads, heads and CEO.
 */
export function reportsTo<Id>(
  p: { id: Id; roles: readonly Role[]; entityId: string | null; teamId: Id | null },
  ctx: { entities: readonly { id: string; headId: Id | null }[]; teams: readonly { id: Id; leadId: Id | null }[]; senior: Id | null; ceo?: Id | null },
): Id | null {
  if (p.roles.includes('ceo')) return null;
  if (p.roles.includes('cos')) return ctx.ceo != null && ctx.ceo !== p.id ? ctx.ceo : null;
  const other = (x: Id | null | undefined) => (x != null && x !== p.id ? x : null);
  const gm = ctx.entities.find((e) => e.id === p.entityId)?.headId ?? null;
  const lead = ctx.teams.find((t) => t.id === p.teamId)?.leadId ?? null;
  const senior = other(ctx.senior);
  if (gm === p.id) return senior;
  if (lead === p.id) return other(gm) ?? senior;
  return other(lead) ?? other(gm) ?? senior;
}
