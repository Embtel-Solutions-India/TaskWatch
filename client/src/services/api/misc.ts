import { DAY, HOUR, ROLE_LABEL } from '../../constants';
import type { Notification, NotificationPrefs, Priority, Status, Task, User } from '../../types';
import { ACTIVE_STATUSES } from '../../types';
import { ApiError, canViewUser, hasPerm, reportsOf } from '../authz/permissions';
import { audit, ms } from '../core';
import { defaultPrefs } from '../mock/seed';
import { getDb, getSession, now, setSession } from '../mock/store';
import { me, mutate, read, toView, visibleTasks, type TaskView } from './base';
import { notificationsServer } from './notificationsServer';
import { BACKEND } from '../http';

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

/* ---------------- Search (permission-aware) ---------------- */

export function search(q: string) {
  return read((db, user) => {
    const s = q.trim().toLowerCase();
    if (!s) return { tasks: [], people: [], teams: [] };
    const tasks = visibleTasks(db, user)
      .map((t) => toView(db, t))
      .filter((t) => t.id.toLowerCase().includes(s) || t.title.toLowerCase().includes(s) || t.assignee?.name.toLowerCase().includes(s) || t.giver?.name.toLowerCase().includes(s) || t.team?.name.toLowerCase().includes(s))
      .slice(0, 8);
    const people = db.users.filter((u) => canViewUser(db, user, u) && (u.name.toLowerCase().includes(s) || u.email.includes(s) || u.title.toLowerCase().includes(s))).slice(0, 6);
    const visibleTeamIds = new Set(db.users.filter((u) => canViewUser(db, user, u)).map((u) => u.teamId));
    const teams = db.teams.filter((t) => visibleTeamIds.has(t.id) && t.name.toLowerCase().includes(s));
    return { tasks, people, teams };
  });
}

/* ---------------- Reports & dashboards ---------------- */

export interface ReportFilters {
  from: string;
  to: string;
  teamId: string;
  userId: string;
  giverId: string;
  priority: Priority | '';
  status: Status | '';
  level: string;
}

export function reportScope(): 'org' | 'team' {
  return read((db, user) => {
    if (hasPerm(db, user, 'view_org_reports')) return 'org';
    if (hasPerm(db, user, 'view_team_reports')) return 'team';
    throw new ApiError(403, 'You do not have access to reports.');
  });
}

/** Tasks in report scope: whole org, or the user's reporting line. */
function scopedTasks(user: User): Task[] {
  const db = getDb();
  if (hasPerm(db, user, 'view_org_reports')) return db.tasks;
  if (!hasPerm(db, user, 'view_team_reports')) throw new ApiError(403, 'You do not have access to reports.');
  const ids = reportsOf(db, user.id);
  return db.tasks.filter((t) => ids.has(t.assigneeId));
}

export function getReport(f: ReportFilters) {
  return read((db, user) => {
    const all = scopedTasks(user).filter((t) => t.status !== 'draft');
    const fromMs = f.from ? ms(f.from + 'T00:00:00') : 0;
    const toMs = f.to ? ms(f.to + 'T23:59:59') : Infinity;
    const match = (t: TaskView) =>
      (!f.teamId || t.teamId === f.teamId) &&
      (!f.userId || t.assigneeId === f.userId) &&
      (!f.giverId || t.assignedBy === f.giverId) &&
      (!f.priority || t.priority === f.priority) &&
      (!f.status || t.status === f.status) &&
      (!f.level || (f.level === 'none' ? t.level < 0 : t.level === Number(f.level)));
    const views = all.map((t) => toView(db, t)).filter(match);
    // Historical: tasks created in the date range. Current workload: open tasks now, ignoring dates.
    const hist = views.filter((t) => ms(t.createdAt) >= fromMs && ms(t.createdAt) <= toMs);
    const open = views.filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted');
    const completed = hist.filter((t) => t.status === 'completed');
    const onTime = completed.filter((t) => t.completedAt && t.completedAt <= t.dueAt);
    const ids = new Set(views.map((t) => t.id));
    const events = db.escalations.filter((e) => ids.has(e.taskId) && ms(e.at) >= fromMs && ms(e.at) <= toMs);
    const reviews = db.reviews.filter((r) => ids.has(r.taskId) && r.decidedAt && ms(r.submittedAt) >= fromMs && ms(r.submittedAt) <= toMs);
    const exts = db.extensions.filter((e) => ids.has(e.taskId) && ms(e.at) >= fromMs && ms(e.at) <= toMs);
    const running = open.filter((t) => ACTIVE_STATUSES.includes(t.status));
    const compliant = running.filter((t) => (t.levelInfo?.silenceLevel ?? -1) < 0);
    const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? '—';

    // Weekly buckets across the range (or the last 8 weeks).
    const endMs = Math.min(toMs, now());
    const startMs = fromMs || endMs - 8 * 7 * DAY;
    const weeks: { label: string; created: number; completed: number }[] = [];
    for (let w = startMs; w <= endMs; w += 7 * DAY) {
      const e = w + 7 * DAY;
      weeks.push({
        label: new Date(w).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        created: views.filter((t) => ms(t.createdAt) >= w && ms(t.createdAt) < e).length,
        completed: views.filter((t) => t.completedAt && ms(t.completedAt) >= w && ms(t.completedAt) < e).length,
      });
    }

    const assignees = [...new Set(views.map((t) => t.assigneeId))];
    const staffRows = assignees
      .map((id) => {
        const mine = hist.filter((t) => t.assigneeId === id);
        const done = mine.filter((t) => t.status === 'completed');
        const openNow = open.filter((t) => t.assigneeId === id);
        const run = running.filter((t) => t.assigneeId === id);
        const esc = events.filter((e) => e.level >= 1 && views.find((t) => t.id === e.taskId)?.assigneeId === id).length;
        return {
          id,
          name: name(id),
          team: db.teams.find((t) => t.id === db.users.find((u) => u.id === id)?.teamId)?.name ?? '—',
          assigned: mine.length,
          completed: done.length,
          onTimeRate: done.length ? done.filter((t) => t.completedAt! <= t.dueAt).length / done.length : null,
          openNow: openNow.length,
          overdueNow: openNow.filter((t) => t.overdue).length,
          compliance: run.length ? run.filter((t) => (t.levelInfo?.silenceLevel ?? -1) < 0).length / run.length : null,
          escalations: esc,
        };
      })
      .sort((a, b) => b.openNow - a.openNow);

    const teamRows = db.teams
      .map((tm) => {
        const tv = hist.filter((t) => t.teamId === tm.id);
        const done = tv.filter((t) => t.status === 'completed');
        const openNow = open.filter((t) => t.teamId === tm.id);
        return {
          id: tm.id,
          name: tm.name,
          assigned: tv.length,
          completed: done.length,
          completionRate: tv.length ? done.length / tv.length : null,
          onTimeRate: done.length ? done.filter((t) => t.completedAt! <= t.dueAt).length / done.length : null,
          openNow: openNow.length,
          overdueNow: openNow.filter((t) => t.overdue).length,
          escalations: events.filter((e) => e.level >= 1 && views.find((t) => t.id === e.taskId)?.teamId === tm.id).length,
        };
      })
      .filter((r) => r.assigned || r.openNow);

    const givers = [...new Set(hist.map((t) => t.assignedBy))];
    const giverRows = givers.map((id) => {
      const g = hist.filter((t) => t.assignedBy === id);
      return { id, name: name(id), role: ROLE_LABEL[db.users.find((u) => u.id === id)?.role ?? 'staff'], assigned: g.length, open: g.filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted').length, completed: g.filter((t) => t.status === 'completed').length, overdue: g.filter((t) => t.overdue).length, reassigned: db.assignments.filter((a) => a.fromId && g.some((t) => t.id === a.taskId)).length };
    });

    const turnaround = reviews.map((r) => ({ taskId: r.taskId, round: r.round, reviewer: name(r.reviewerId ?? ''), decision: r.decision!, hours: (ms(r.decidedAt!) - ms(r.submittedAt)) / HOUR, submittedAt: r.submittedAt }));
    const reviewers = [...new Set(turnaround.map((r) => r.reviewer))].map((n) => {
      const rs = turnaround.filter((r) => r.reviewer === n);
      return { reviewer: n, reviews: rs.length, avgHours: rs.reduce((s, r) => s + r.hours, 0) / rs.length, changesRate: rs.filter((r) => r.decision !== 'approved').length / rs.length };
    });

    return {
      scope: hasPerm(db, user, 'view_org_reports') ? ('org' as const) : ('team' as const),
      summary: {
        created: hist.length,
        completed: completed.length,
        completionRate: hist.length ? completed.length / hist.length : null,
        onTimeRate: completed.length ? onTime.length / completed.length : null,
        openNow: open.length,
        overdueNow: open.filter((t) => t.overdue).length,
        escalations: events.filter((e) => e.level >= 1).length,
        compliance: running.length ? compliant.length / running.length : null,
        avgReviewHours: turnaround.length ? turnaround.reduce((s, r) => s + r.hours, 0) / turnaround.length : null,
        extensions: exts.length,
      },
      weeks,
      byStatus: (['assigned', 'in_progress', 'submitted', 'changes_requested', 'reopened', 'completed', 'cancelled'] as Status[]).map((s) => ({ key: s, value: hist.filter((t) => t.status === s).length })),
      byPriority: (['critical', 'high', 'normal', 'low'] as Priority[]).map((p) => ({ key: p, value: hist.filter((t) => t.priority === p).length, open: open.filter((t) => t.priority === p).length, overdue: open.filter((t) => t.priority === p && t.overdue).length })),
      overdueByTeam: db.teams.map((tm) => ({ key: tm.name, value: open.filter((t) => t.teamId === tm.id && t.overdue).length })).filter((x) => x.value || f.teamId === ''),
      escalationsByLevel: [0, 1, 2, 3].map((l) => ({ key: l, value: events.filter((e) => e.level === l).length, active: db.escalations.filter((e) => ids.has(e.taskId) && e.level === l && e.status !== 'resolved').length })),
      staffRows,
      teamRows,
      giverRows,
      reviewers,
      turnaround,
      extensions: exts.map((e) => ({ ...e, taskTitle: db.tasks.find((t) => t.id === e.taskId)?.title ?? '', requester: name(e.requestedBy), decider: e.decidedBy ? name(e.decidedBy) : '—', days: (ms(e.requestedDue) - ms(e.currentDue)) / DAY })),
      overdue: open.filter((t) => t.overdue).sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
      tasks: hist,
    };
  });
}

export type Report = ReturnType<typeof getReport>;

export function getDashboard() {
  return read((db, user) => {
    const visible = visibleTasks(db, user).filter((t) => t.status !== 'draft').map((t) => toView(db, t));
    const mine = visible.filter((t) => t.assigneeId === user.id);
    const scope = user.role === 'cos' ? visible : visible.filter((t) => reportsOf(db, user.id).has(t.assigneeId));
    const isOpen = (t: TaskView) => ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted';
    const endOfDay = new Date(now());
    endOfDay.setHours(23, 59, 59, 999);
    const weekAgo = now() - 7 * DAY;
    const trend = Array.from({ length: 8 }, (_, i) => {
      const s = now() - (8 - i) * 7 * DAY;
      const e = s + 7 * DAY;
      const label = new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return {
        label,
        mine: mine.filter((t) => t.completedAt && ms(t.completedAt) >= s && ms(t.completedAt) < e).length,
        scope: scope.filter((t) => t.completedAt && ms(t.completedAt) >= s && ms(t.completedAt) < e).length,
        created: scope.filter((t) => ms(t.createdAt) >= s && ms(t.createdAt) < e).length,
        overdueClosed: scope.filter((t) => t.completedAt && ms(t.completedAt) >= s && ms(t.completedAt) < e && t.completedAt > t.dueAt).length,
      };
    });
    const people = user.role === 'cos' ? db.users.filter((u) => u.id !== user.id) : db.users.filter((u) => reportsOf(db, user.id).has(u.id));
    const workload = people
      .filter((u) => u.status === 'active')
      .map((u) => {
        const o = scope.filter((t) => t.assigneeId === u.id && isOpen(t));
        return { id: u.id, name: u.name, role: u.role, open: o.length, overdue: o.filter((t) => t.overdue).length, escalated: o.filter((t) => t.level >= 1).length };
      })
      .sort((a, b) => b.open - a.open);
    const scopeIds = new Set(scope.map((t) => t.id));
    const closedScope = scope.filter((t) => t.status === 'completed');
    return {
      mine: {
        all: mine,
        open: mine.filter(isOpen),
        dueToday: mine.filter((t) => isOpen(t) && ms(t.dueAt) <= endOfDay.getTime() && !t.overdue),
        overdue: mine.filter((t) => isOpen(t) && t.overdue),
        awaitingReview: mine.filter((t) => t.status === 'submitted'),
        recent: [...mine].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6),
        upcoming: mine.filter((t) => isOpen(t) && !t.overdue).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 6),
        unacknowledged: mine.filter((t) => ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt),
        completedThisWeek: mine.filter((t) => t.completedAt && ms(t.completedAt) >= weekAgo).length,
      },
      scope: {
        all: scope,
        open: scope.filter(isOpen),
        overdue: scope.filter((t) => isOpen(t) && t.overdue),
        escalated: scope.filter((t) => isOpen(t) && t.level >= 1),
        critical: scope.filter((t) => isOpen(t) && t.level >= 2),
        awaitingReview: scope.filter((t) => t.status === 'submitted'),
        stale: scope.filter((t) => ACTIVE_STATUSES.includes(t.status) && (t.levelInfo?.silenceLevel ?? -1) >= 0),
        completionRate: scope.length ? closedScope.length / scope.filter((t) => t.status !== 'cancelled').length : null,
        onTimeRate: closedScope.length ? closedScope.filter((t) => t.completedAt! <= t.dueAt).length / closedScope.length : null,
        byLevel: [0, 1, 2, 3].map((l) => scope.filter((t) => isOpen(t) && t.level === l).length),
        overdueByPriority: (['critical', 'high', 'normal', 'low'] as Priority[]).map((p) => ({ key: p, value: scope.filter((t) => isOpen(t) && t.overdue && t.priority === p).length })),
        assignedByMe: visible.filter((t) => t.assignedBy === user.id && isOpen(t)),
        pendingExtensions: db.extensions.filter((e) => e.status === 'pending' && scopeIds.has(e.taskId)).length,
      },
      trend,
      workload,
      teams: db.teams.map((tm) => {
        const tv = scope.filter((t) => t.teamId === tm.id);
        const closed = tv.filter((t) => t.status === 'completed');
        return { id: tm.id, name: tm.name, open: tv.filter(isOpen).length, overdue: tv.filter((t) => isOpen(t) && t.overdue).length, escalated: tv.filter((t) => isOpen(t) && t.level >= 1).length, completionRate: tv.length ? closed.length / tv.filter((t) => t.status !== 'cancelled').length : null };
      }).filter((t) => t.open || t.overdue || t.completionRate !== null),
      staffStats: { total: db.users.length, active: db.users.filter((u) => u.status === 'active').length, noManager: db.users.filter((u) => !u.managerId && u.role !== 'cos').length },
      recentAdmin: hasPerm(db, user, 'view_audit_logs') ? [...db.audit].filter((a) => a.source !== 'system').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6) : [],
      notifications: db.notifications.filter((n) => n.userId === user.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5),
      teamMembers: db.users.filter((u) => u.managerId === user.id),
    };
  });
}

export type Dashboard = ReturnType<typeof getDashboard>;
