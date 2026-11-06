import { LEVEL_LABEL, PERMISSION_LABEL, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import type { Permission, Priority, Recurrence, Role, RulesConfig, Settings, User } from '../../types';
import { ACTIVE_STATUSES, PERMISSIONS, PRIORITIES, ROLES } from '../../types';
import { ApiError, ancestorsOf, assertPerm, canAssignTo, canViewTask, canViewUser, hasPerm, isOverseer, reportsOf, wouldCreateLoop } from '../authz/permissions';
import { audit, iso, ms, nextId, processEscalations, processRecurrences, userName } from '../core';
import { describeRecurrence, isoDay, occurrencesBetween, scheduleErrors } from '../engine/recurrence';
import { sendDigestNow } from '../channels';
import { allowedActions } from '../engine/workflow';
import { defaultPrefs } from '../mock/seed';
import { now } from '../mock/store';
import { BACKEND } from '../http';
import { adminServer, primaryRole } from './adminServer';
import { tasksServer } from './tasksServer';
import { notificationsServer, type Integrations } from './notificationsServer';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import type { AuditRecord, Delivery, Extension, Review } from '../../types';
import type { TaskView } from './base';
import { findUser, invalid, mutate, read, toView, visibleTasks } from './base';
import type { Department, Team } from '../../types';

/* ---------------- Staff ---------------- */

export interface StaffRow extends User {
  /** Every role held (STAFF-05); `role` is the highest of them. */
  roles: Role[];
  /** The person's entity (D-4). The prototype derives it from the team. */
  entityId: string;
  managerName: string | null;
  teamName: string | null;
  openTasks: number;
  overdueTasks: number;
}

export function listStaff(): StaffRow[] | Promise<StaffRow[]> {
  if (BACKEND === 'server') return adminServer.listStaff();
  return read((db, user) => {
    const visible = db.users.filter((u) => canViewUser(db, user, u));
    return visible.map((u) => {
      const open = db.tasks.filter((t) => t.assigneeId === u.id && ACTIVE_STATUSES.includes(t.status));
      return {
        ...u,
        roles: [u.role],
        entityId: db.teams.find((t) => t.id === u.teamId)?.departmentId ?? '',
        managerName: u.managerId ? userName(db, u.managerId) : null,
        teamName: db.teams.find((t) => t.id === u.teamId)?.name ?? null,
        openTasks: open.length,
        overdueTasks: open.filter((t) => ms(t.dueAt) < now()).length,
      };
    });
  });
}

export type StaffProfile = ReturnType<typeof mockStaffProfile>;

export function getStaffProfile(id: string): StaffProfile | Promise<StaffProfile> {
  return BACKEND === 'server' ? adminServer.staffProfile(id) : mockStaffProfile(id);
}

function mockStaffProfile(id: string) {
  return read((db, user) => {
    const target = findUser(db, id);
    if (!canViewUser(db, user, target)) throw new ApiError(403, 'You are not authorized to view this profile.');
    const tasksVisible = (pred: (t: (typeof db.tasks)[number]) => boolean) => db.tasks.filter((t) => pred(t) && canViewTask(db, user, t)).map((t) => toView(db, t));
    const assigned = tasksVisible((t) => t.assigneeId === id);
    const created = tasksVisible((t) => t.createdBy === id || t.assignedBy === id);
    const closed = assigned.filter((t) => t.status === 'completed');
    const onTime = closed.filter((t) => t.completedAt && t.completedAt <= t.dueAt).length;
    const assignedIds = new Set(assigned.map((t) => t.id));
    return {
      user: target,
      manager: target.managerId ? db.users.find((u) => u.id === target.managerId) ?? null : null,
      reports: db.users.filter((u) => u.managerId === id),
      chain: ancestorsOf(db, id),
      team: db.teams.find((t) => t.id === target.teamId) ?? null,
      permissions: target.role === 'cos' ? [...PERMISSIONS] : db.rolePermissions[target.role],
      assigned,
      created,
      stats: {
        open: assigned.filter((t) => ACTIVE_STATUSES.includes(t.status)).length,
        overdue: assigned.filter((t) => t.overdue).length,
        completed: closed.length,
        onTimeRate: closed.length ? onTime / closed.length : null,
      },
      escalations: db.escalations.filter((e) => assignedIds.has(e.taskId)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
      activity: db.activities.filter((a) => a.actorId === id && canViewTask(db, user, db.tasks.find((t) => t.id === a.taskId)!)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15),
    };
  });
}

export interface StaffInput {
  name: string;
  email: string;
  title: string;
  /** At least one (STAFF-05). The prototype keeps the highest; the server keeps them all. */
  roles: Role[];
  /** Required by the server (D-4); the prototype ignores it. */
  entityId: string;
  managerId: string | null;
  teamId: string | null;
  location: string;
  phone: string;
  whatsapp: string;
  whatsappOptIn: boolean;
  timezone: string;
  /** D-105: own quiet hours (HH:MM); both empty = the organization's. Server only. */
  quietStart?: string;
  quietEnd?: string;
}

/** "+1 555 010 12" → "+155501012"; empty → null. */
export function normalizeWhatsApp(v: string): string | null {
  const s = v.replace(/[\s()-]/g, '');
  return s ? s : null;
}

function validateStaff(input: StaffInput, existingId?: string): void {
  return read((db) => {
    const f: Record<string, string> = {};
    if (input.name.trim().split(/\s+/).length < 2) f.name = 'Enter a first and last name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) f.email = 'Enter a valid email address.';
    else if (db.users.some((u) => u.email.toLowerCase() === input.email.trim().toLowerCase() && u.id !== existingId)) f.email = 'Another account already uses this email.';
    if (!input.title.trim()) f.title = 'Enter a job title.';
    const wa = normalizeWhatsApp(input.whatsapp);
    if (wa && !/^\+[1-9]\d{7,14}$/.test(wa)) f.whatsapp = 'Use international format, e.g. +14155550123.';
    if (input.whatsappOptIn && !wa) f.whatsapp = 'Add a WhatsApp number before opting in.';
    if (!input.roles.length || !input.roles.every((r) => ROLES.includes(r))) f.roles = 'Choose a role.';
    if (input.managerId) {
      const m = db.users.find((u) => u.id === input.managerId);
      if (!m) f.managerId = 'Manager not found.';
      else if (existingId && wouldCreateLoop(db, existingId, input.managerId)) f.managerId = 'That would create a reporting loop.';
    }
    if (Object.keys(f).length) invalid(f);
  });
}

export function createStaff(input: StaffInput): User | Promise<User> {
  if (BACKEND === 'server') return adminServer.createStaff(input);
  return mutate((db, user, at) => {
    assertPerm(db, user, 'manage_staff', 'manage staff');
    if (input.roles.includes('cos')) assertPerm(db, user, 'manage_roles', 'grant Chief of Staff');
    validateStaff(input);
    const u: User = { id: nextId(db, 'u-'), name: input.name.trim(), email: input.email.trim().toLowerCase(), title: input.title.trim(), role: primaryRole(input.roles), managerId: input.managerId, teamId: input.teamId, status: 'active', joinedAt: at, location: input.location.trim() || 'Remote', phone: input.phone.trim(), whatsapp: normalizeWhatsApp(input.whatsapp), whatsappOptIn: input.whatsappOptIn && !!normalizeWhatsApp(input.whatsapp), timezone: input.timezone || db.settings.timezone };
    db.users.push(u);
    db.prefs[u.id] = defaultPrefs();
    audit(db, { at, actorId: user.id, action: 'staff.created', targetType: 'user', targetId: u.id, taskId: null, prev: null, next: `${u.name} (${ROLE_LABEL[u.role]})`, source: 'ui', context: u.email });
    return u;
  });
}

export function updateStaff(id: string, input: StaffInput): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.updateStaff(id, input);
  const role = primaryRole(input.roles); // the prototype holds one role per person
  mutate((db, user, at) => {
    assertPerm(db, user, 'manage_staff', 'manage staff');
    const u = findUser(db, id);
    validateStaff(input, id);
    if (role !== u.role) {
      assertPerm(db, user, 'manage_roles', 'change roles');
      if (u.id === user.id) throw new ApiError(403, 'You cannot change your own role.');
      if (u.role === 'cos' && db.users.filter((x) => x.role === 'cos' && x.status === 'active').length === 1) throw new ApiError(409, 'The organization must keep at least one active Chief of Staff.');
      audit(db, { at, actorId: user.id, action: 'staff.role_changed', targetType: 'user', targetId: id, taskId: null, prev: ROLE_LABEL[u.role], next: ROLE_LABEL[role], source: 'ui', context: u.name });
    }
    if (input.managerId !== u.managerId) audit(db, { at, actorId: user.id, action: 'staff.manager_changed', targetType: 'user', targetId: id, taskId: null, prev: u.managerId ? userName(db, u.managerId) : 'No manager', next: input.managerId ? userName(db, input.managerId) : 'No manager', source: 'ui', context: u.name });
    if (input.teamId !== u.teamId) audit(db, { at, actorId: user.id, action: 'staff.team_changed', targetType: 'user', targetId: id, taskId: null, prev: db.teams.find((t) => t.id === u.teamId)?.name ?? 'None', next: db.teams.find((t) => t.id === input.teamId)?.name ?? 'None', source: 'ui', context: u.name });
    const wa = normalizeWhatsApp(input.whatsapp);
    if (wa !== u.whatsapp || (input.whatsappOptIn && !!wa) !== u.whatsappOptIn) audit(db, { at, actorId: user.id, action: 'staff.whatsapp_changed', targetType: 'user', targetId: id, taskId: null, prev: `${u.whatsapp ?? 'none'}${u.whatsappOptIn ? ' (opted in)' : ''}`, next: `${wa ?? 'none'}${input.whatsappOptIn && wa ? ' (opted in)' : ''}`, source: 'ui', context: u.name });
    Object.assign(u, { whatsapp: wa, whatsappOptIn: input.whatsappOptIn && !!wa, timezone: input.timezone || u.timezone, name: input.name.trim(), email: input.email.trim().toLowerCase(), title: input.title.trim(), role, managerId: input.managerId, teamId: input.teamId, location: input.location.trim(), phone: input.phone.trim() });
    audit(db, { at, actorId: user.id, action: 'staff.updated', targetType: 'user', targetId: id, taskId: null, prev: null, next: u.name, source: 'ui', context: 'Profile details' });
  });
}

export function setStaffStatus(id: string, status: 'active' | 'inactive'): { openTasks: number } | Promise<{ openTasks: number }> {
  if (BACKEND === 'server') return adminServer.setStaffStatus(id, status);
  return mutate((db, user, at) => {
    assertPerm(db, user, 'manage_staff', 'manage staff');
    const u = findUser(db, id);
    if (u.id === user.id) throw new ApiError(403, 'You cannot deactivate your own account.');
    if (status === 'inactive' && u.role === 'cos' && db.users.filter((x) => x.role === 'cos' && x.status === 'active').length === 1) throw new ApiError(409, 'The organization must keep at least one active Chief of Staff.');
    const prev = u.status;
    u.status = status;
    audit(db, { at, actorId: user.id, action: status === 'active' ? 'staff.activated' : 'staff.deactivated', targetType: 'user', targetId: id, taskId: null, prev, next: status, source: 'ui', context: u.name });
    return { openTasks: db.tasks.filter((t) => t.assigneeId === id && ACTIVE_STATUSES.includes(t.status)).length };
  });
}

export function resetAccess(id: string): string | Promise<string> {
  if (BACKEND === 'server') return adminServer.resetAccess(id);
  return mutate((db, user, at) => {
    assertPerm(db, user, 'manage_staff', 'manage staff');
    const u = findUser(db, id);
    // Same rules as the server: a CoS only by a CoS; D-98: otherwise only oneself or people below.
    if (u.role === 'cos' && user.role !== 'cos') throw new ApiError(403, 'Only a Chief of Staff can reset another Chief of Staff.');
    if (user.role !== 'cos' && u.id !== user.id && !reportsOf(db, user.id).has(u.id)) throw new ApiError(403, 'You can only reset access for yourself or people below you in the reporting line.');
    const token = Math.random().toString(36).slice(2, 10);
    db.passwordResets.push({ email: u.email, token, at });
    audit(db, { at, actorId: user.id, action: 'staff.access_reset', targetType: 'user', targetId: id, taskId: null, prev: null, next: 'Reset link issued (simulated)', source: 'ui', context: u.email });
    return token;
  });
}

/* ---------------- Organization ---------------- */

/** What the staff and org screens look people, teams and entities up in (ORG-01): the directory rows with load. */
export interface OrgData {
  users: StaffRow[];
  teams: Team[];
  departments: Department[];
  overloadThreshold: number;
  /** Default time zone for new people. */
  timezone: string;
}

export function getOrg(): OrgData | Promise<OrgData> {
  if (BACKEND === 'server') return adminServer.org();
  const users = listStaff() as StaffRow[];
  return read((db) => ({ users, teams: db.teams, departments: db.departments, overloadThreshold: db.settings.overloadThreshold, timezone: db.settings.timezone }));
}

/** ORG-02: manager and team together, committed as one change (or neither). */
export function setPlacement(userId: string, managerId: string | null, teamId: string | null): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.setPlacement(userId, managerId, teamId);
  mutate((db) => {
    const u = findUser(db, userId);
    if (managerId !== u.managerId) setManager(userId, managerId);
    if (teamId !== u.teamId) setTeam(userId, teamId);
  });
}

export function setManager(userId: string, managerId: string | null): void {
  mutate((db, user, at) => {
    assertPerm(db, user, 'manage_staff', 'change reporting lines');
    const u = findUser(db, userId);
    if (wouldCreateLoop(db, userId, managerId)) throw new ApiError(409, `${u.name} cannot report to someone in their own reporting line.`);
    const prev = u.managerId;
    u.managerId = managerId;
    audit(db, { at, actorId: user.id, action: 'staff.manager_changed', targetType: 'user', targetId: userId, taskId: null, prev: prev ? userName(db, prev) : 'No manager', next: managerId ? userName(db, managerId) : 'No manager', source: 'ui', context: u.name });
    processEscalations(db, now());
  });
}

export function setTeam(userId: string, teamId: string | null): void {
  mutate((db, user, at) => {
    if (!hasPerm(db, user, 'manage_staff') && !(hasPerm(db, user, 'manage_team') && reportsOf(db, user.id).has(userId))) throw new ApiError(403, 'You cannot move this person between teams.');
    const u = findUser(db, userId);
    const prev = db.teams.find((t) => t.id === u.teamId)?.name ?? 'None';
    u.teamId = teamId;
    audit(db, { at, actorId: user.id, action: 'staff.team_changed', targetType: 'user', targetId: userId, taskId: null, prev, next: db.teams.find((t) => t.id === teamId)?.name ?? 'None', source: 'ui', context: u.name });
  });
}

/* ---------------- Roles ---------------- */

export function getRoles(): RolesData | Promise<RolesData> {
  if (BACKEND === 'server') return adminServer.roles();
  return read((db, user) => {
    assertPerm(db, user, 'manage_roles', 'manage roles');
    return { matrix: db.rolePermissions, counts: Object.fromEntries(ROLES.map((r) => [r, db.users.filter((u) => u.role === r && u.status === 'active').length])) as Record<Role, number> };
  });
}

export interface RolesData {
  matrix: Record<Role, readonly Permission[]>;
  counts: Record<Role, number>;
}

export function setRolePermissions(role: Role, perms: readonly Permission[]): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.setRolePermissions(role, perms);
  mutate((db, user, at) => {
    assertPerm(db, user, 'manage_roles', 'manage roles');
    if (role === 'cos') throw new ApiError(403, 'Chief of Staff always has full platform authority and cannot be edited.');
    const clean = PERMISSIONS.filter((p) => perms.includes(p));
    const prev = db.rolePermissions[role];
    const added = clean.filter((p) => !prev.includes(p)).map((p) => PERMISSION_LABEL[p]);
    const removed = prev.filter((p) => !clean.includes(p)).map((p) => PERMISSION_LABEL[p]);
    db.rolePermissions[role] = clean;
    audit(db, { at, actorId: user.id, action: 'role.permissions_changed', targetType: 'role', targetId: role, taskId: null, prev: removed.length ? `Removed: ${removed.join(', ')}` : null, next: added.length ? `Added: ${added.join(', ')}` : null, source: 'ui', context: ROLE_LABEL[role] });
  });
}

/* ---------------- Policies & settings ---------------- */

export function getRules(): RulesConfig {
  return read((db) => db.rules);
}

/** POL-01/03. The prototype has one policy and no entity overrides. */
export interface PolicySet {
  defaults: RulesConfig;
  overrides: Record<string, RulesConfig>;
  entities: { id: string; name: string }[];
}

export function getPolicies(): PolicySet | Promise<PolicySet> {
  if (BACKEND === 'server') return tasksServer.policies();
  return { defaults: getRules(), overrides: {}, entities: [] };
}

/** `scope`: 'default' or an entity id (server mode; an override holds windows and multiples only, D-48). */
export function setRules(next: RulesConfig, scope = 'default'): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.setPolicy(scope, next);
  mutate((db, user, at) => {
    assertPerm(db, user, 'manage_escalation_policies', 'change escalation policies');
    const f: Record<string, string> = {};
    for (const p of PRIORITIES) if (!(next.windowsHours[p] > 0 && next.windowsHours[p] <= 720)) f[`w_${p}`] = 'Between 1 and 720 hours.';
    const m = next.multiples;
    if (!(m[0] > 0 && m[0] < m[1] && m[1] < m[2] && m[2] < m[3])) f.multiples = 'Multiples must increase from L0 to L3.';
    const o = next.overdueOffsetsHours;
    if (!(o[0] >= 0 && o[0] < o[1] && o[1] < o[2])) f.offsets = 'Past-due offsets must increase from L1 to L3.';
    if (!(next.ackSnoozeHours >= 1 && next.ackSnoozeHours <= 72)) f.ackSnoozeHours = 'Between 1 and 72 hours.';
    if (Object.keys(f).length) invalid(f);
    const changes: string[] = [];
    for (const p of PRIORITIES) if (db.rules.windowsHours[p] !== next.windowsHours[p]) changes.push(`${PRIORITY_LABEL[p as Priority]} window ${db.rules.windowsHours[p]}→${next.windowsHours[p]} h`);
    if (db.rules.multiples.join() !== m.join()) changes.push(`multiples ${db.rules.multiples.join('/')}→${m.join('/')}`);
    if (db.rules.overdueOffsetsHours.join() !== o.join()) changes.push(`past-due ${db.rules.overdueOffsetsHours.join('/')}→${o.join('/')}`);
    if (db.rules.ackSnoozeHours !== next.ackSnoozeHours) changes.push(`ack snooze ${db.rules.ackSnoozeHours}→${next.ackSnoozeHours} h`);
    if (db.rules.dueSoonHours !== next.dueSoonHours) changes.push(`due-soon ${db.rules.dueSoonHours}→${next.dueSoonHours} h`);
    if (JSON.stringify(db.rules.quietHours) !== JSON.stringify(next.quietHours)) changes.push('quiet hours');
    db.rules = structuredClone(next);
    audit(db, { at, actorId: user.id, action: 'policy.updated', targetType: 'policy', targetId: 'default', taskId: null, prev: null, next: changes.join('; ') || 'No changes', source: 'ui', context: 'Escalation policy' });
    processEscalations(db, now());
  });
}

export function resetPolicy(scope: string): Promise<void> {
  return tasksServer.resetPolicy(scope);
}

export function getSettings(): Settings | Promise<Settings> {
  if (BACKEND === 'server') return adminServer.settings();
  return read((db) => db.settings);
}

export function setSettings(next: Settings): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.setSettings(next);
  mutate((db, user, at) => {
    assertPerm(db, user, 'manage_system_settings', 'change system settings');
    const f: Record<string, string> = {};
    if (!next.orgName.trim()) f.orgName = 'Organization name is required.';
    if (!(next.sessionTimeoutMinutes >= 5 && next.sessionTimeoutMinutes <= 480)) f.sessionTimeoutMinutes = 'Between 5 and 480 minutes.';
    if (!next.categories.length) f.categories = 'Keep at least one category.';
    if (Object.keys(f).length) invalid(f);
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(db.settings[k]));
    db.settings = { ...structuredClone(next), retentionYears: 7 };
    audit(db, { at, actorId: user.id, action: 'settings.updated', targetType: 'settings', targetId: 'platform', taskId: null, prev: null, next: changed.join(', ') || 'No changes', source: 'ui', context: 'System settings' });
  });
}

/* ---------------- Audit ---------------- */

/** D-16: manual integrity check. Server only: the prototype's browser store has no hash chains. */
export function checkAuditChain() {
  return tasksServer.chainCheck();
}

export function listAudit(): AuditRecord[] | Promise<(AuditRecord & { actorName?: string | null })[]> {
  if (BACKEND === 'server') return tasksServer.audit();
  return read((db, user) => {
    assertPerm(db, user, 'view_audit_logs', 'view audit logs');
    return [...db.audit].sort((a, b) => b.at.localeCompare(a.at));
  });
}

/* ---------------- Escalations, reviews, extensions workspaces ---------------- */

export type EscalationRow = ReturnType<typeof mockListEscalations>[number] & { ackEventId?: string | null };

export function listEscalations(): EscalationRow[] | Promise<EscalationRow[]> {
  if (BACKEND === 'server') return tasksServer.escalations();
  return mockListEscalations();
}

function mockListEscalations() {
  return read((db, user) => {
    assertPerm(db, user, 'view_tasks', 'view escalations');
    const tasks = visibleTasks(db, user).filter((t) => t.assigneeId !== user.id || user.role === 'cos');
    const ids = new Set(tasks.map((t) => t.id));
    const byTask = new Map<string, typeof db.escalations>();
    for (const e of db.escalations) if (ids.has(e.taskId)) byTask.set(e.taskId, [...(byTask.get(e.taskId) ?? []), e]);
    return [...byTask.entries()].map(([taskId, events]) => {
      const task = toView(db, db.tasks.find((t) => t.id === taskId)!);
      const open = events.filter((e) => e.status !== 'resolved').sort((a, b) => b.level - a.level);
      const top = open[0] ?? events.sort((a, b) => b.level - a.level)[0]!;
      const status: 'active' | 'acknowledged' | 'resolved' = open.length === 0 ? 'resolved' : open.some((e) => e.status === 'active') ? 'active' : 'acknowledged';
      return {
        task,
        level: open.length ? top.level : Math.max(...events.map((e) => e.level)),
        status,
        since: top.at,
        recipients: [...top.recipientIds.map((id) => userName(db, id)), ...(top.ccIds ?? []).map((id) => `cc ${userName(db, id)}`)],
        nextLevel: task.levelInfo?.next ? { level: task.levelInfo.next.level, at: iso(task.levelInfo.next.at), label: LEVEL_LABEL[task.levelInfo.next.level] } : null,
        canAck: allowedActions(db, user, db.tasks.find((t) => t.id === taskId)!).has('ack_escalation'),
        events: events.sort((a, b) => a.at.localeCompare(b.at)),
      };
    });
  });
}

export function listReviewQueue(): ReviewQueueRow[] | Promise<ReviewQueueRow[]> {
  if (BACKEND === 'server') return tasksServer.reviewQueue();
  return read((db, user) => {
    assertPerm(db, user, 'review_tasks', 'review tasks');
    return visibleTasks(db, user)
      .filter((t) => t.status === 'submitted' && allowedActions(db, user, t).has('review'))
      .map((t) => ({ task: toView(db, t), submission: db.reviews.filter((r) => r.taskId === t.id).at(-1)! }));
  });
}

export interface ReviewQueueRow {
  task: TaskView;
  submission: Review;
}
export interface ExtensionRow {
  ext: Extension;
  task: TaskView;
  canDecide: boolean;
}

export function listExtensions(): ExtensionRow[] | Promise<ExtensionRow[]> {
  if (BACKEND === 'server') return tasksServer.extensions();
  return read((db, user) => {
    const tasks = visibleTasks(db, user);
    const ids = new Set(tasks.map((t) => t.id));
    return db.extensions
      .filter((e) => ids.has(e.taskId))
      .map((e) => {
        const task = db.tasks.find((t) => t.id === e.taskId)!;
        return { ext: e, task: toView(db, task), canDecide: e.status === 'pending' && allowedActions(db, user, task).has('decide_extension') && e.requestedBy !== user.id };
      })
      .sort((a, b) => (a.ext.status === 'pending' ? -1 : 0) - (b.ext.status === 'pending' ? -1 : 0) || b.ext.at.localeCompare(a.ext.at));
  });
}

/* ---------------- Recurring ---------------- */

export interface RecurrenceInput extends Omit<Recurrence, 'id' | 'createdBy' | 'createdAt' | 'active'> {}

export interface RecurrenceRow extends Recurrence {
  summary: string;
  assigneeName: string;
  ownerName: string;
  instances: number;
  next: string[];
  /** REC-01-AC-5: owner or CoS; the page shows row actions from this, not from the role. */
  canEdit: boolean;
}

export function listRecurrences(): RecurrenceRow[] | Promise<RecurrenceRow[]> {
  if (BACKEND === 'server') return adminServer.recurrences();
  return read((db, user) => {
    assertPerm(db, user, 'create_tasks', 'manage recurring tasks');
    const scope = user.role === 'cos' ? null : reportsOf(db, user.id);
    return db.recurrences
      .filter((r) => !scope || r.createdBy === user.id || scope.has(r.assigneeId))
      .map((r) => ({
        ...r,
        summary: describeRecurrence(r),
        assigneeName: userName(db, r.assigneeId),
        ownerName: userName(db, r.createdBy),
        instances: db.tasks.filter((t) => t.recurrenceId === r.id).length,
        next: occurrencesBetween(r, isoDay(now() + 86_400_000), isoDay(now() + 120 * 86_400_000), 3),
        canEdit: r.createdBy === user.id || user.role === 'cos',
      }));
  });
}

function validateRecurrence(input: RecurrenceInput, categories: string[]) {
  const f = scheduleErrors(input);
  if (!categories.includes(input.category)) f.category = 'Choose a category.'; // REC-02-AC-6: never defaulted
  if (Object.keys(f).length) invalid(f);
}

export function saveRecurrence(id: string | null, input: RecurrenceInput): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.saveRecurrence(id, input);
  mutate((db, user, at) => {
    assertPerm(db, user, 'create_tasks', 'manage recurring tasks');
    assertPerm(db, user, 'assign_tasks', 'assign recurring tasks');
    validateRecurrence(input, db.settings.categories);
    // The team defaults to the assignee's, as on the server.
    input = { ...input, teamId: input.teamId ?? db.users.find((u) => u.id === input.assigneeId)?.teamId ?? null };
    const existing = id ? db.recurrences.find((r) => r.id === id) : null;
    if (id && !existing) throw new ApiError(404, 'Schedule not found.');
    if ((!existing || existing.assigneeId !== input.assigneeId) && !canAssignTo(db, user, input.assigneeId)) invalid({ assigneeId: 'You can only assign to people below you in the reporting line.' });
    if (existing) {
      if (existing.createdBy !== user.id && user.role !== 'cos') throw new ApiError(403, 'Only the owner can edit this schedule.');
      Object.assign(existing, input);
      audit(db, { at, actorId: user.id, action: 'recurrence.updated', targetType: 'recurrence', targetId: existing.id, taskId: null, prev: null, next: describeRecurrence(existing), source: 'ui', context: existing.title });
    } else {
      const r: Recurrence = { ...input, id: nextId(db, 'rec-'), createdBy: user.id, createdAt: at, active: true };
      db.recurrences.push(r);
      audit(db, { at, actorId: user.id, action: 'recurrence.created', targetType: 'recurrence', targetId: r.id, taskId: null, prev: null, next: describeRecurrence(r), source: 'ui', context: r.title });
    }
    processRecurrences(db, now());
  });
}

export function toggleRecurrence(id: string, active: boolean): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.setRecurrenceActive(id, active);
  mutate((db, user, at) => {
    const r = db.recurrences.find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'Schedule not found.');
    if (r.createdBy !== user.id && user.role !== 'cos') throw new ApiError(403, 'Only the owner can change this schedule.');
    r.active = active;
    audit(db, { at, actorId: user.id, action: active ? 'recurrence.resumed' : 'recurrence.paused', targetType: 'recurrence', targetId: id, taskId: null, prev: null, next: active ? 'Active' : 'Paused', source: 'ui', context: r.title });
    if (active) processRecurrences(db, now());
  });
}

export function deleteRecurrence(id: string): void | Promise<void> {
  if (BACKEND === 'server') return adminServer.deleteRecurrence(id);
  mutate((db, user, at) => {
    const r = db.recurrences.find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'Schedule not found.');
    if (r.createdBy !== user.id && user.role !== 'cos') throw new ApiError(403, 'Only the owner can delete this schedule.');
    db.recurrences = db.recurrences.filter((x) => x.id !== id);
    audit(db, { at, actorId: user.id, action: 'recurrence.deleted', targetType: 'recurrence', targetId: id, taskId: null, prev: r.title, next: null, source: 'ui', context: 'Existing task instances are kept' });
  });
}

/** For "who can I see" sanity in the UI. */
export function isOverseerOf(taskId: string): boolean {
  return read((db, user) => {
    const t = db.tasks.find((x) => x.id === taskId);
    return !!t && isOverseer(db, user, t);
  });
}

/* ---------------- Delivery log (simulated email & WhatsApp) ---------------- */

/** Server mode also returns each channel's Live/Simulated status (NTF-06); the prototype is always simulated. */
export async function listDeliveries(): Promise<DeliveryLog> {
  const log = BACKEND === 'server' ? await notificationsServer.deliveries() : mockDeliveries();
  return { ...log, items: shownChannels(log.items) };
}

const shownChannels = (items: Delivery[]) => (WHATSAPP_ENABLED ? items : items.filter((d) => d.channel !== 'whatsapp'));

function mockDeliveries(): DeliveryLog {
  return read((db, user) => {
    assertPerm(db, user, 'view_audit_logs', 'view the delivery log');
    return { items: [...db.deliveries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), integrations: { email: 'simulated', whatsapp: 'simulated' } };
  });
}
export type DeliveryLog = { items: Delivery[]; integrations: Integrations };

/** A user's own message history, for their profile. */
export async function myDeliveries(): Promise<Delivery[]> {
  if (BACKEND === 'server') return shownChannels(await notificationsServer.myDeliveries());
  return shownChannels(mockMyDeliveries());
}

function mockMyDeliveries(): Delivery[] {
  return read((db, user) => db.deliveries.filter((d) => d.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30));
}

/** Demo: send the weekly digest to all Managers and the Founder's Office now. */
export function sendWeeklyDigestNow(): number | Promise<number> {
  if (BACKEND === 'server') return notificationsServer.sendDigest();
  return mutate((db, user, at) => {
    assertPerm(db, user, 'manage_system_settings', 'send the weekly digest');
    const n = sendDigestNow(db, Date.parse(at), (p) => nextId(db, p));
    audit(db, { at, actorId: user.id, action: 'digest.sent_manually', targetType: 'settings', targetId: 'digest', taskId: null, prev: null, next: `${n} recipients`, source: 'demo', context: 'Weekly digest (simulated email)' });
    return n;
  });
}
