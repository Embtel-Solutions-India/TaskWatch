import type { TaskAction } from '../engine/workflow';
import { HOUR } from '../../constants';
import type { Db, Task, Team, User } from '../../types';
import { ACTIVE_STATUSES } from '../../types';
import { ApiError, canViewTask } from '../authz/permissions';
import { ms } from '../core';
import { computeLevel, type LevelResult } from '../engine/escalation';
import { commit, getDb, getSession, now, setSession } from '../mock/store';

export { ApiError };

/** The signed-in user, or a 401. Also enforces the session timeout. */
export function me(): User {
  const s = getSession();
  if (!s) throw new ApiError(401, 'Please sign in.');
  const db = getDb();
  const u = db.users.find((x) => x.id === s.userId);
  if (!u) throw new ApiError(401, 'Your account no longer exists.');
  if (u.status !== 'active') throw new ApiError(401, 'Your account has been deactivated.');
  const timeout = db.settings.sessionTimeoutMinutes * 60_000;
  if (Date.now() - s.lastActive > timeout) {
    setSession(null);
    throw new ApiError(401, 'SESSION_EXPIRED');
  }
  if (Date.now() - s.lastActive > 30_000) setSession({ ...s, lastActive: Date.now() });
  return u;
}

export function nowIso(): string {
  return new Date(now()).toISOString();
}

/** Run a mutation for the signed-in user; commits only when it returns without throwing. */
export function mutate<T>(fn: (db: Db, user: User, at: string) => T): T {
  const db = getDb();
  const user = me();
  const result = fn(db, user, nowIso());
  commit();
  return result;
}

export function read<T>(fn: (db: Db, user: User) => T): T {
  return fn(getDb(), me());
}

export function findTask(db: Db, id: string): Task {
  const t = db.tasks.find((x) => x.id === id);
  if (!t) throw new ApiError(404, `Task ${id} was not found.`);
  return t;
}

export function findUser(db: Db, id: string): User {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw new ApiError(404, 'Person not found.');
  return u;
}

export interface TaskView extends Task {
  /** PERF (server): a finished task waiting for the giver's Rate step. */
  awaitingRating?: boolean;
  level: number;
  levelInfo: LevelResult | null;
  assignee: User | undefined;
  giver: User | undefined;
  team: Team | undefined;
  overdue: boolean;
  lastUpdateAt: string;
  escalationAcked: boolean;
  /** Server mode: the viewer's allowed actions, computed by the server with the shared rules (WF-10). */
  actions?: TaskAction[];
  /** Why the task is Blocked (WF-11). */
  blockedReason?: string | null;
  /** TASK-09 "Escalated to me": an unresolved L1+ escalation names the viewer as a "to" recipient. Lists only. */
  escalatedToMe?: boolean;
}

export function toView(db: Db, t: Task): TaskView {
  const running = ACTIVE_STATUSES.includes(t.status);
  const info = running ? computeLevel({ priority: t.priority, clockStartedAt: ms(t.clockStartedAt), dueAt: ms(t.dueAt) }, db.rules, now()) : null;
  const top = db.escalations.filter((e) => e.taskId === t.id && e.status !== 'resolved').sort((a, b) => b.level - a.level)[0];
  return {
    ...t,
    level: info?.level ?? -1,
    levelInfo: info,
    assignee: db.users.find((u) => u.id === t.assigneeId),
    giver: db.users.find((u) => u.id === t.assignedBy),
    team: db.teams.find((x) => x.id === t.teamId),
    overdue: running && ms(t.dueAt) < now(),
    lastUpdateAt: t.clockStartedAt,
    escalationAcked: top?.status === 'acknowledged',
  };
}

export function visibleTasks(db: Db, user: User): Task[] {
  return db.tasks.filter((t) => canViewTask(db, user, t));
}

/** Tiny helpers for validation errors. */
export function invalid(fields: Record<string, string>): never {
  throw new ApiError(422, Object.values(fields)[0] ?? 'Please fix the highlighted fields.', fields);
}

export function hoursFromNow(iso: string): number {
  return (ms(iso) - now()) / HOUR;
}
