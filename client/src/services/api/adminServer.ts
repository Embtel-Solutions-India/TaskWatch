// Staff, organisation, roles and settings against the real server (T-3.8; API_CONTRACTS §2.3). Used only when
// BACKEND === 'server'. Maps the server's shapes onto the prototype's (string ids, a primary `role` beside
// `roles`) so the pages keep their design.
import { ROLE_RANK } from '../../constants';
import type { Activity, ActivityType, Department, EscalationEvent, Permission, Role, Settings, Team, User } from '../../types';
import { http } from '../http';
import type { OrgData, RecurrenceInput, RecurrenceRow, StaffInput, StaffProfile, StaffRow } from './admin';
import type { TaskView } from './base';

interface ServerPerson {
  id: number;
  name: string;
  title: string | null;
  roles: Role[];
  entityId: string;
  teamId: number | null;
  teamName: string | null;
  managerId: number | null;
  managerName: string | null;
  status: 'active' | 'inactive';
  joinedAt: string;
  location: string | null;
  timezone: string;
  whatsappOptIn: boolean;
  quietStart?: string | null;
  quietEnd?: string | null;
  /** Contact fields come only to manage_staff holders, and for oneself. */
  email?: string;
  phone?: string | null;
  whatsapp?: string | null;
  openTasks: number;
  overdueTasks: number;
}
interface Brief {
  id: number;
  name: string;
  title?: string | null;
  roles?: Role[];
}

const sid = (n: number | null | undefined): string | null => (n == null ? null : String(n));
const nid = (s: string | null): number | null => (s ? Number(s) : null);

/** The highest-ranked role stands in for the person where the screens show one role. */
export const primaryRole = (roles: readonly Role[]): Role => [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] ?? 'staff';

function person(r: ServerPerson): StaffRow {
  return {
    id: String(r.id),
    name: r.name,
    email: r.email ?? '',
    title: r.title ?? '',
    role: primaryRole(r.roles),
    roles: r.roles,
    entityId: r.entityId,
    managerId: sid(r.managerId),
    teamId: sid(r.teamId),
    status: r.status,
    joinedAt: r.joinedAt,
    location: r.location ?? '',
    phone: r.phone ?? '',
    whatsapp: r.whatsapp ?? null,
    whatsappOptIn: r.whatsappOptIn,
    timezone: r.timezone,
    quietStart: r.quietStart ?? null,
    quietEnd: r.quietEnd ?? null,
    managerName: r.managerName,
    teamName: r.teamName,
    openTasks: r.openTasks,
    overdueTasks: r.overdueTasks,
  };
}

/** People the server names by id and name only (managers, task parties, comment authors): enough for display. */
export const userStub = (b: Brief): User => ({
  id: String(b.id),
  name: b.name,
  title: b.title ?? '',
  role: primaryRole(b.roles ?? []),
  email: '',
  managerId: null,
  teamId: null,
  status: 'active',
  joinedAt: '',
  location: '',
  phone: '',
  whatsapp: null,
  whatsappOptIn: false,
  timezone: '',
});

/**
 * ponytail: the profile's task rows carry only what the profile renders (id, title, status, level, due, category,
 * recurring). Since T-4.0/T-4.1 the server sends the client's status names and a full TaskView; T-4.14 maps it whole.
 */
const profileTask = (t: { id: number; title: string; status: TaskView['status']; level: number; dueAt: string; category: string | null; recurrenceId: number | null }): TaskView =>
  ({ id: String(t.id), title: t.title, status: t.status, level: t.level, dueAt: t.dueAt, category: t.category ?? '', recurrenceId: sid(t.recurrenceId) }) as unknown as TaskView;

const escalation = (e: { id: number; taskId: number; level: number; reason: 'silence' | 'overdue'; firedAt: string; acknowledgedAt: string | null; clearedAt: string | null }): EscalationEvent => ({
  id: String(e.id),
  taskId: String(e.taskId),
  level: e.level,
  reason: e.reason,
  at: e.firedAt,
  cycle: '',
  recipientIds: [],
  ccIds: [],
  status: e.acknowledgedAt ? 'acknowledged' : e.clearedAt ? 'resolved' : 'active',
  ackBy: null,
  ackAt: e.acknowledgedAt,
  resolvedAt: e.clearedAt,
  lastNotifiedAt: e.firedAt,
});

const activity = (a: { id: number; taskId: number; kind: string; body: string | null; at: string }): Activity => ({
  id: String(a.id),
  taskId: String(a.taskId),
  type: a.kind as ActivityType,
  actorId: null,
  at: a.at,
  text: a.body ?? a.kind,
});

const personBody = (i: StaffInput) => ({
  name: i.name,
  email: i.email,
  title: i.title,
  roles: i.roles,
  entityId: i.entityId,
  managerId: nid(i.managerId),
  teamId: nid(i.teamId),
  location: i.location,
  phone: i.phone || null,
  whatsapp: i.whatsapp || null,
  whatsappOptIn: i.whatsappOptIn,
  timezone: i.timezone,
  quietStart: i.quietStart || null,
  quietEnd: i.quietEnd || null,
});

export const adminServer = {
  listStaff: async (): Promise<StaffRow[]> => (await http<{ items: ServerPerson[] }>('GET', '/people')).items.map(person),

  staffProfile: async (id: string): Promise<StaffProfile> => {
    const p = await http<{
      user: ServerPerson;
      manager: Brief | null;
      reports: Brief[];
      chain: Brief[];
      team: { id: number; name: string } | null;
      permissions: Permission[];
      assigned: Parameters<typeof profileTask>[0][];
      created: Parameters<typeof profileTask>[0][];
      stats: StaffProfile['stats'];
      escalations: Parameters<typeof escalation>[0][];
      activity: Parameters<typeof activity>[0][];
    }>('GET', `/people/${id}`);
    return {
      user: person(p.user),
      manager: p.manager ? userStub(p.manager) : null,
      reports: p.reports.map(userStub),
      chain: p.chain.map(userStub),
      team: p.team ? { id: String(p.team.id), name: p.team.name, departmentId: p.user.entityId, leadId: null } : null,
      permissions: p.permissions,
      assigned: p.assigned.map(profileTask),
      created: p.created.map(profileTask),
      stats: p.stats,
      escalations: p.escalations.map(escalation),
      activity: p.activity.map(activity),
    };
  },

  createStaff: async (input: StaffInput): Promise<User> => person(await http<ServerPerson>('POST', '/people', personBody(input))),
  updateStaff: async (id: string, input: StaffInput): Promise<void> => void (await http('PUT', `/people/${id}`, personBody(input))),
  setStaffStatus: (id: string, status: 'active' | 'inactive') => http<{ openTasks: number }>('POST', `/people/${id}/status`, { status }),
  /** The link is emailed by the server; no token ever reaches the browser. */
  resetAccess: async (id: string): Promise<string> => (await http('POST', `/people/${id}/reset-access`), ''),

  org: async (): Promise<OrgData> => {
    const [o, s] = await Promise.all([
      http<{ entities: { id: string; name: string; headId: number | null }[]; teams: { id: number; name: string; entityId: string; leadId: number | null }[]; people: ServerPerson[]; overloadThreshold: number }>('GET', '/org'),
      http<{ timezone: string }>('GET', '/settings'),
    ]);
    return {
      users: o.people.map(person),
      teams: o.teams.map((t): Team => ({ id: String(t.id), name: t.name, departmentId: t.entityId, leadId: sid(t.leadId) })),
      departments: o.entities.map((e): Department => ({ id: e.id, name: e.name, headId: sid(e.headId) })),
      overloadThreshold: o.overloadThreshold,
      timezone: s.timezone,
    };
  },
  /** ORG-02: manager and team in one call, so the server commits both or neither. */
  setPlacement: async (userId: string, managerId: string | null, teamId: string | null): Promise<void> =>
    void (await http('PUT', `/people/${userId}/placement`, { managerId: nid(managerId), teamId: nid(teamId) })),

  roles: () => http<{ matrix: Record<Role, readonly Permission[]>; counts: Record<Role, number> }>('GET', '/roles'),
  setRolePermissions: async (role: Role, permissions: readonly Permission[]): Promise<void> => void (await http('PUT', `/roles/${role}`, { permissions })),

  settings: () => http<Settings>('GET', '/settings'),
  setSettings: async (next: Settings): Promise<void> => void (await http('PUT', '/settings', next)),

  // REC-01…03 (T-7.4): the server computes summary, next dates (assignee's zone) and canEdit.
  recurrences: async (): Promise<RecurrenceRow[]> =>
    (await http<any[]>('GET', '/recurring')).map((r) => ({ ...r, id: String(r.id), assigneeId: String(r.assigneeId), createdBy: String(r.createdBy), teamId: sid(r.teamId) })),
  saveRecurrence: async (id: string | null, i: RecurrenceInput): Promise<void> => {
    const body = { ...i, assigneeId: nid(i.assigneeId), teamId: nid(i.teamId) };
    await (id ? http('PUT', `/recurring/${id}`, body) : http('POST', '/recurring', body));
  },
  setRecurrenceActive: async (id: string, active: boolean): Promise<void> => void (await http('POST', `/recurring/${id}/active`, { active })),
  deleteRecurrence: async (id: string): Promise<void> => void (await http('DELETE', `/recurring/${id}`)),
};
