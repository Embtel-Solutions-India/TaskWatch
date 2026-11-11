import { HOUR, ROLE_LABEL } from '../../constants';
import type { Db, Notification, NotificationPrefs, Status, Task, User } from '../../types';
import { ApiError, canViewUser, hasPerm, reportsOf } from '../authz/permissions';
import { buildReport, reportCsv, type Report, type ReportFilters, type ReportId } from '@taskwatch/shared/reports';
import { downloadCsv } from '../../utils/format';
import { needsManager } from '@taskwatch/shared/permissions';
import { buildDashboard, buildTeamOverview, layoutFor, type DashActivity, type DashboardExtras, type DashboardPayload, type DashTask, type Range, type TeamOverview } from '@taskwatch/shared/insights';
import { departmentOf } from '../../features/dashboard/insights';
import { audit, foundersOffice, ms } from '../core';
import { allowedActions } from '../engine/workflow';
import { defaultPrefs } from '../mock/seed';
import { getDb, getSession, now, setSession } from '../mock/store';
import { me, mutate, read, toView, visibleTasks, type TaskView } from './base';
import { notificationsServer } from './notificationsServer';
import { BACKEND, http } from '../http';

/* ---------------- Auth (simulated) ---------------- */

export const DEMO_PASSWORD = 'taskwatch';

export function login(email: string, password: string): User {
  const db = getDb();
  const f: Record<string, string> = {};
  if (!email.trim()) f.email = 'Enter your work email.';
  if (!password) f.password = 'Enter your password.';
  if (Object.keys(f).length) throw new ApiError(422, Object.values(f)[0]!, f);
  const u = db.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  if (!u || password !== DEMO_PASSWORD) throw new ApiError(401, 'That email and password combination is not recognized.');
  if (u.status !== 'active') throw new ApiError(403, 'This account is deactivated. Contact your Chief of Staff.');
  setSession({ userId: u.id, startedAt: Date.now(), lastActive: Date.now() });
  return u;
}

export function switchUser(userId: string): void {
  const u = getDb().users.find((x) => x.id === userId);
  if (!u || u.status !== 'active') throw new ApiError(403, 'That demo user is not active.');
  setSession({ userId, startedAt: Date.now(), lastActive: Date.now() });
}

export function logout(): void {
  setSession(null);
}

export function expireSession(): void {
  const s = getSession();
  if (s) setSession({ ...s, lastActive: 0 });
}

export function currentUser(): User | null {
  try {
    return me();
  } catch {
    return null;
  }
}

export function requestPasswordReset(email: string): string | null {
  const db = getDb();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new ApiError(422, 'Enter a valid email address.', { email: 'Enter a valid email address.' });
  const u = db.users.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
  if (!u) return null; // Same response either way, so accounts can't be enumerated.
  const token = Math.random().toString(36).slice(2, 10);
  db.passwordResets.push({ email: u.email, token, at: new Date().toISOString() });
  return token;
}

export function resetPassword(token: string, password: string, confirm: string): void {
  const db = getDb();
  const f: Record<string, string> = {};
  if (password.length < 10) f.password = 'Use at least 10 characters.';
  else if (!/[0-9]/.test(password) || !/[A-Za-z]/.test(password)) f.password = 'Use letters and at least one number.';
  if (confirm !== password) f.confirm = 'The passwords do not match.';
  if (Object.keys(f).length) throw new ApiError(422, Object.values(f)[0]!, f);
  const r = db.passwordResets.find((x) => x.token === token);
  if (!r || Date.now() - ms(r.at) > HOUR) throw new ApiError(400, 'This reset link is invalid or has expired. Request a new one.');
  db.passwordResets = db.passwordResets.filter((x) => x.token !== token);
}

/* ---------------- Notifications ---------------- */

export function listNotifications(): Notification[] | Promise<Notification[]> {
  if (BACKEND === 'server') return notificationsServer.list();
  return read((db, user) => db.notifications.filter((n) => n.userId === user.id).sort((a, b) => b.at.localeCompare(a.at)));
}

export function markRead(id: string, read = true): void | Promise<void> {
  if (BACKEND === 'server') return notificationsServer.markRead(id, read);
  mutate((db, user) => {
    const n = db.notifications.find((x) => x.id === id && x.userId === user.id);
    if (!n) throw new ApiError(404, 'Notification not found.');
    n.read = read;
  });
}

export function markAllRead(): number | Promise<number> {
  if (BACKEND === 'server') return notificationsServer.markAllRead();
  return mutate((db, user) => {
    let c = 0;
    for (const n of db.notifications) if (n.userId === user.id && !n.read) (n.read = true), c++;
    return c;
  });
}

export function getPrefs(): NotificationPrefs | Promise<NotificationPrefs> {
  if (BACKEND === 'server') return notificationsServer.prefs();
  return read((db, user) => db.prefs[user.id] ?? defaultPrefs());
}

export function setPrefs(prefs: NotificationPrefs): void | Promise<void> {
  if (BACKEND === 'server') return notificationsServer.setPrefs(prefs);
  mutate((db, user, at) => {
    db.prefs[user.id] = structuredClone(prefs);
    audit(db, { at, actorId: user.id, action: 'preferences.updated', targetType: 'user', targetId: user.id, taskId: null, prev: null, next: 'Notification preferences', source: 'ui', context: '' });
  });
}

/* ---------------- Search (SRCH-01, permission-aware) ---------------- */

export interface SearchResult {
  tasks: { id: string | number; title: string; status: Status; level: number; assignee: { id: string | number; name: string }; giver: { id: string | number; name: string }; team: { id: string | number; name: string } | null }[];
  people: { id: string | number; name: string; title: string | null; roles: string[]; active: boolean }[];
  teams: { id: string | number; name: string }[];
}

export async function search(q: string): Promise<SearchResult> {
  if (BACKEND === 'server') return http<SearchResult>('GET', `/search?q=${encodeURIComponent(q.trim())}`);
  return read((db, user) => {
    const s = q.trim().toLowerCase();
    if (!s) return { tasks: [], people: [], teams: [] };
    const named = (u: User | undefined) => ({ id: u?.id ?? '', name: u?.name ?? '' });
    const tasks = visibleTasks(db, user)
      .map((t) => toView(db, t))
      .filter((t) => t.id.toLowerCase().includes(s) || t.title.toLowerCase().includes(s) || t.assignee?.name.toLowerCase().includes(s) || t.giver?.name.toLowerCase().includes(s) || t.team?.name.toLowerCase().includes(s))
      .slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, level: t.level, assignee: named(t.assignee), giver: named(t.giver), team: t.team ? { id: t.team.id, name: t.team.name } : null }));
    const visible = db.users.filter((u) => canViewUser(db, user, u));
    const people = visible
      .filter((u) => u.name.toLowerCase().includes(s) || u.email.includes(s) || u.title.toLowerCase().includes(s))
      .slice(0, 6)
      .map((u) => ({ id: u.id, name: u.name, title: u.title, roles: [u.role], active: u.status === 'active' }));
    // Teams only for those who can open the team task list (route gate `supervises`).
    const supervises = hasPerm(db, user, 'view_tasks') && (user.role === 'cos' || reportsOf(db, user.id).size > 0);
    const teamIds = new Set(visible.map((u) => u.teamId));
    const teams = supervises ? db.teams.filter((t) => teamIds.has(t.id) && t.name.toLowerCase().includes(s)).map((t) => ({ id: t.id, name: t.name })) : [];
    return { tasks, people, teams };
  });
}


/* ---------------- Reports & dashboards ---------------- */

export type { Report, ReportFilters };

/** RPT-01: org with view_org_reports, else team with view_team_reports, else 403. */
function mockScope(db: Db, user: User): 'org' | 'team' {
  if (hasPerm(db, user, 'view_org_reports')) return 'org';
  if (hasPerm(db, user, 'view_team_reports')) return 'team';
  throw new ApiError(403, 'You do not have access to reports.');
}

export async function reportScope(): Promise<'org' | 'team'> {
  if (BACKEND === 'server') return (await http<{ scope: 'org' | 'team' }>('GET', '/reports/scope')).scope;
  return read(mockScope);
}

export interface ReportOptions {
  scope: 'org' | 'team';
  teams: { id: string | number; name: string }[];
  people: { id: string | number; name: string }[];
  givers: { id: string | number; name: string }[];
}

/** RPT-04: filter options inside the report scope. */
export async function getReportOptions(): Promise<ReportOptions> {
  if (BACKEND === 'server') return http<ReportOptions>('GET', '/reports/options');
  return read((db, user) => {
    const scope = mockScope(db, user);
    const line = reportsOf(db, user.id);
    const people = db.users.filter((u) => u.status === 'active' && (scope === 'org' || line.has(u.id)));
    const teamIds = new Set(people.map((u) => u.teamId));
    const brief = (u: User) => ({ id: u.id, name: u.name });
    return {
      scope,
      teams: db.teams.filter((t) => scope === 'org' || teamIds.has(t.id)).map((t) => ({ id: t.id, name: t.name })),
      people: people.map(brief),
      givers: (scope === 'org' ? people : [user, ...people]).filter((u) => u.role !== 'staff').map(brief),
    };
  });
}

const reportQuery = (f: ReportFilters) => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString();

/** RPT-02: one payload for the nine reports; the mock runs the same shared rules over its scoped records. */
export async function getReport(f: ReportFilters): Promise<Report> {
  if (BACKEND === 'server') return http<Report>('GET', `/reports?${reportQuery(f)}`);
  return read((db, user) => {
    const scope = mockScope(db, user);
    const tasks = (scope === 'org' ? db.tasks : visibleTasks(db, user)).filter((t) => t.status !== 'draft'); // D-51
    const name = (id: string | null) => (id ? (nameOf(db)(id) ?? '—') : '—');
    return buildReport(
      {
        now: now(),
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scope,
        tasks: tasks.map((t) => dashTask(db, user, t)),
        events: db.escalations.map((e) => ({ taskId: e.taskId, level: e.level, at: ms(e.at), resolved: e.status === 'resolved' })),
        reviews: db.reviews.filter((r) => r.decidedAt).map((r) => ({ taskId: r.taskId, round: r.round, reviewer: name(r.reviewerId), decision: r.decision!, submittedAt: ms(r.submittedAt), decidedAt: ms(r.decidedAt!) })),
        extensions: db.extensions.map((e) => ({
          id: e.id,
          taskId: e.taskId,
          taskTitle: db.tasks.find((t) => t.id === e.taskId)?.title ?? '',
          requester: name(e.requestedBy),
          decider: e.decidedBy ? name(e.decidedBy) : null,
          currentDue: ms(e.currentDue),
          requestedDue: ms(e.requestedDue),
          at: ms(e.at),
          reason: e.reason,
          status: e.status,
        })),
        reassignments: db.assignments.filter((a) => a.fromId).map((a) => a.taskId),
        teams: db.teams,
        people: db.users.map((u) => ({ id: u.id, name: u.name, team: db.teams.find((t) => t.id === u.teamId)?.name ?? '—', role: ROLE_LABEL[u.role] })),
      },
      f,
    );
  });
}

/** RPT-03: the server builds the file from the same filters (scope enforced there); the mock writes the same columns. */
export function exportReport(id: ReportId, f: ReportFilters, r: Report): void {
  if (BACKEND === 'server') return window.location.assign(`/api/reports/${id}/export.csv?${reportQuery(f)}`);
  downloadCsv(`taskwatch-report-${id}-${new Date().toISOString().slice(0, 10)}.csv`, reportCsv(id, r, Intl.DateTimeFormat().resolvedOptions().timeZone));
}

/** RPT-05/06 FR-11 accountability (server only: the prototype has no first-response data). */
export interface Accountability {
  generatedAt: string;
  from: string;
  days: number;
  scope: string;
  byEntity: { entityId: string; entityName: string; open: number; onTrack: number; amber: number; red: number; blocked: number; longestSilenceHours: number | null; longestSilenceTask: { id: number; title: string; assignee: string } | null }[];
  byPerson: { userId: number; name: string; entityId: string; title: string | null; open: number; avgFirstResponseHours: number | null; escalations: number; closed: number; onTime: number; onTimePct: number | null }[];
}

export const getAccountability = (days: Range) => http<Accountability>('GET', `/reports/accountability?days=${days}`);
/** RPT-07 */
export const exportAccountability = (days: Range, kind: 'csv' | 'pdf') => window.location.assign(`/api/reports/accountability/export.${kind}?days=${days}`);

/* ---------------- Dashboards (DASH-01…03, PERF-07) and team overview (DASH-02) ---------------- */
// Both backends return one shape: the server computes it; the mock calls the same shared rules (shared/insights.ts)
// over the records the viewer may see. Pages render the payload only and never read the store.

/** The mock's DashTask for a task (the server builds the same from its rows). */
function dashTask(db: Db, user: User, t: Task): DashTask {
  const v = toView(db, t);
  return {
    id: v.id,
    title: v.title,
    status: v.status,
    priority: v.priority,
    assigneeId: v.assigneeId,
    assigneeName: v.assignee?.name ?? '',
    assignedBy: v.assignedBy,
    teamId: v.teamId,
    entityId: departmentOf(db, v.teamId),
    createdAt: ms(v.createdAt),
    updatedAt: ms(v.updatedAt),
    dueAt: ms(v.dueAt),
    completedAt: v.completedAt ? ms(v.completedAt) : null,
    clockStartedAt: ms(v.clockStartedAt),
    acknowledgedAt: v.acknowledgedAt ? ms(v.acknowledgedAt) : null,
    level: v.level,
    silenceLevel: v.levelInfo?.silenceLevel ?? -1,
    next: v.levelInfo?.next ?? null,
    overdue: v.overdue,
    mayReview: allowedActions(db, user, t).has('review'),
  };
}

const isOrgWide = (u: User) => u.role === 'cos' || u.role === 'ceo';
const nameOf = (db: Db) => (id: string | number) => db.users.find((u) => u.id === id)?.name ?? null;
const brief = (db: Db, id: string | null) => (id ? { id, name: nameOf(db)(id) ?? '' } : null);
const activityRows = (db: Db, taskIds: Set<string>, limit: number): DashActivity[] =>
  db.activities
    .filter((a) => taskIds.has(a.taskId))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((a) => ({ id: a.id, taskId: a.taskId, kind: a.type, body: a.text, at: a.at, actor: brief(db, a.actorId) }));

export async function getDashboard(range: Range, entity: string): Promise<DashboardPayload> {
  if (BACKEND === 'server') return http<DashboardPayload>('GET', `/dashboard?range=${range}${entity ? `&entity=${encodeURIComponent(entity)}` : ''}`);
  return read((db, user) => {
    const orgWide = isOrgWide(user);
    if (entity && !orgWide) throw new ApiError(403, "You don't have permission to filter by entity.");
    const n = now();
    const layout = layoutFor([user.role]);
    const inEntity = (id: string | null) => !entity || id === entity;
    const scope = visibleTasks(db, user)
      .filter((t) => t.status !== 'draft' && inEntity(departmentOf(db, t.teamId)))
      .map((t) => dashTask(db, user, t));
    const ids = new Set(scope.map((t) => t.id as string));
    const reports = db.users.filter((u) => reportsOf(db, user.id).has(u.id));
    const staff = orgWide ? db.users.filter((u) => inEntity(departmentOf(db, u.teamId)) || db.departments.some((d) => d.id === entity && d.headId === u.id)) : [];
    const teams = db.teams.filter((t) => inEntity(t.departmentId));
    const person = (u: User) => ({ id: u.id, name: u.name, title: u.title, active: u.status === 'active' });

    const payload = buildDashboard({
      layout,
      now: n,
      range,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewerId: user.id,
      overloadThreshold: db.settings.overloadThreshold,
      scope,
      extensions: db.extensions
        .filter((e) => e.status === 'pending' && ids.has(e.taskId))
        .map((e) => ({ id: e.id, taskId: e.taskId, at: ms(e.at), mayDecide: e.requestedBy !== user.id && allowedActions(db, user, db.tasks.find((t) => t.id === e.taskId)!).has('decide_extension') })),
      events: db.escalations.filter((e) => ids.has(e.taskId)).map((e) => ({ taskId: e.taskId, level: e.level, at: ms(e.at), ackAt: e.ackAt ? ms(e.ackAt) : null })),
      progressAt: db.activities.filter((a) => a.type === 'progress' && ids.has(a.taskId)).map((a) => ms(a.at)),
      people: (orgWide ? staff.filter((u) => u.id !== user.id) : reports).map(person),
      teams: teams.map((t) => ({ id: t.id, name: t.name, entityId: t.departmentId })),
      entities: db.departments.filter((d) => inEntity(d.id)).map((d) => ({ id: d.id, name: d.name })),
    });

    const extra: Partial<DashboardExtras> = {};
    if (layout === 'staff') {
      const mine = new Set(db.tasks.filter((t) => t.assigneeId === user.id).map((t) => t.id));
      extra.feedback = db.reviews
        .filter((r) => r.submittedBy === user.id && r.decidedAt)
        .sort((a, b) => b.decidedAt!.localeCompare(a.decidedAt!))
        .slice(0, 3)
        .map((r) => ({ id: r.id, taskId: r.taskId, decision: r.decision!, comment: r.comment, at: r.decidedAt! }));
      extra.comments = db.comments
        .filter((c) => !c.deleted && c.authorId !== user.id && mine.has(c.taskId))
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, 3)
        .map((c) => ({ id: c.id, taskId: c.taskId, body: c.body.slice(0, 200), at: c.at, author: brief(db, c.authorId)! }));
      extra.activity = activityRows(db, mine, 6);
    } else extra.activity = activityRows(db, ids, 8);

    if (layout === 'executive') {
      const active = staff.filter((u) => u.status === 'active');
      extra.staff = { active: active.length, inactive: staff.length - active.length, noManager: staff.filter((u) => needsManager({ managerId: u.managerId, roles: [u.role] })).length };
      extra.staffByRole = Object.fromEntries((['ceo', 'cos', 'manager', 'lead', 'staff'] as const).map((r) => [r, active.filter((u) => u.role === r).length]));
      extra.orgMini = db.departments
        .filter((d) => inEntity(d.id))
        .map((d) => ({
          id: d.id,
          name: d.name,
          head: d.headId ? nameOf(db)(d.headId) : null,
          teams: teams
            .filter((t) => t.departmentId === d.id)
            .map((t) => {
              const lead = db.users.find((u) => u.id === t.leadId);
              return { id: t.id, name: t.name, members: active.filter((u) => u.teamId === t.id && u.id !== user.id).length, lead: lead?.name ?? null, leadWithoutManager: !!lead && !lead.managerId };
            }),
        }));
      extra.recentAdmin = hasPerm(db, user, 'view_audit_logs')
        ? [...db.audit]
            .filter((a) => a.source !== 'system')
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 6)
            .map((a) => ({ id: a.id, at: a.at, actor: brief(db, a.actorId), action: a.action, next: a.next }))
        : [];
    }

    // WO "L3 … top of dashboard": unresolved L3 events naming a Founder's Office member.
    const l3 = foundersOffice(db).includes(user.id) ? db.escalations.filter((e) => e.level === 3 && e.status !== 'resolved' && e.recipientIds.includes(user.id)) : [];
    const l3Tasks = [...new Set(l3.map((e) => e.taskId))];
    return {
      ...payload,
      ...extra,
      activity: extra.activity,
      range,
      entity: entity || null,
      scopeLabel: orgWide ? `${db.settings.orgName} · organization-wide` : layout === 'staff' ? 'Your assigned work' : `Your reporting line · ${reports.length} people`,
      canCreate: hasPerm(db, user, 'create_tasks'),
      overloadThreshold: db.settings.overloadThreshold,
      entityOptions: orgWide ? db.departments.map((d) => ({ id: d.id, name: d.name })) : [],
      l3Banner: l3Tasks.length
        ? {
            taskCount: l3Tasks.length,
            unacked: new Set(l3.filter((e) => e.status === 'active').map((e) => e.taskId)).size,
            tasks: l3Tasks.slice(0, 3).map((id) => {
              const t = db.tasks.find((x) => x.id === id)!;
              const ev = l3.find((e) => e.taskId === id)!;
              return { id, title: t.title, assignee: nameOf(db)(t.assigneeId) ?? '', reason: ev.reason, since: ev.at, acknowledged: ev.status === 'acknowledged' };
            }),
          }
        : null,
      me: null, // PERF-07: the prototype has no scores
    } as DashboardPayload;
  });
}

export async function getTeamOverview(): Promise<TeamOverview> {
  if (BACKEND === 'server') return http<TeamOverview>('GET', '/team/overview');
  return read((db, user) => {
    const orgWide = isOrgWide(user);
    const people = orgWide ? db.users.filter((u) => u.id !== user.id) : db.users.filter((u) => reportsOf(db, user.id).has(u.id));
    if (!hasPerm(db, user, 'view_tasks') || (!orgWide && !people.length)) throw new ApiError(403, "You don't have permission to view your team.");
    const tasks = visibleTasks(db, user).filter((t) => t.status !== 'draft').map((t) => dashTask(db, user, t));
    return buildTeamOverview(
      user.id,
      people.map((u) => ({ id: u.id, name: u.name, title: u.title, active: u.status === 'active', roles: [u.role], teamId: u.teamId, managerId: u.managerId })),
      tasks,
      db.teams,
      nameOf(db),
    );
  });
}

