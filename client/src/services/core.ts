// Low-level mutations on the in-memory database. No authorization here: callers (the API
// layer, the seed, the background ticks) are responsible for checking permissions first.
import { HOUR, LEVEL_LABEL, PRIORITY_LABEL } from '../constants';
import type { Activity, ActivityType, AuditRecord, Db, NotificationType, Priority, Task } from '../types';
import { ACTIVE_STATUSES } from '../types';
import { ancestorsOf } from './authz/permissions';
import { dispatch, MANDATORY_TYPES, processDigests, releaseHeld, type DispatchContext } from './channels';
import { computeLevel, levelApplies } from './engine/escalation';
import { isoDay, occurrencesBetween } from './engine/recurrence';

export const iso = (ms: number) => new Date(ms).toISOString();
export const ms = (s: string) => Date.parse(s);

export function nextId(db: Db, prefix: string): string {
  db.seq += 1;
  return `${prefix}${db.seq}`;
}

export function nextTaskId(db: Db): string {
  const max = db.tasks.reduce((m, t) => Math.max(m, Number(t.id.split('-')[1]) || 0), 1000);
  return `TW-${max + 1}`;
}

export function logActivity(db: Db, taskId: string, type: ActivityType, actorId: string | null, text: string, at: string, data?: Activity['data']): void {
  db.activities.push({ id: nextId(db, 'act'), taskId, type, actorId, at, text, data });
}

export function audit(db: Db, rec: Omit<AuditRecord, 'id'>): void {
  db.audit.push({ id: nextId(db, 'aud'), ...rec });
}

export function notify(db: Db, userIds: string[], type: NotificationType, title: string, body: string, taskId: string | null, at: string, ctx: DispatchContext = {}): void {
  for (const userId of new Set(userIds)) {
    const prefs = db.prefs[userId];
    // Work-order events (assignment, L0–L3) always go in-app; preferences can't switch them off.
    if (prefs && prefs.inApp[type] === false && !MANDATORY_TYPES.includes(type)) continue;
    const user = db.users.find((u) => u.id === userId);
    if (!user || user.status !== 'active') continue;
    const n = { id: nextId(db, 'ntf'), userId, type, title, body, taskId, at, read: false, emailSimulated: false };
    db.notifications.push(n);
    // Simulated email + WhatsApp, with quiet hours and skip rules (services/channels.ts).
    dispatch(db, n, ctx, (p) => nextId(db, p));
  }
}

export function userName(db: Db, id: string | null | undefined): string {
  return db.users.find((u) => u.id === id)?.name ?? 'Unknown';
}

/** The Founder's Office: every active Chief of Staff, plus the CEO when decision D7 is on. */
export function foundersOffice(db: Db): string[] {
  return db.users.filter((u) => u.status === 'active' && (u.role === 'cos' || (db.rules.l3NotifyCeo && u.role === 'ceo'))).map((u) => u.id);
}

/**
 * Work-order routing. To: L0 the assignee, L1 the team lead, L2 the manager, L3 the Founder's Office
 * (Chief of Staff and CEO). Copied: L1 the assignee; L2 the lead and assignee; L3 the manager.
 * A missing role in the reporting line skips to the next existing level up.
 */
export function escalationRecipients(db: Db, task: Task, level: number): { to: string[]; cc: string[] } {
  const chain = ancestorsOf(db, task.assigneeId).filter((u) => u.status === 'active');
  const holder = (k: number): string[] => {
    if (k === 0) return [task.assigneeId];
    if (k === 3) return foundersOffice(db);
    const need = k === 1 ? ['lead', 'manager', 'cos'] : ['manager', 'cos'];
    const hit = chain.find((u) => need.includes(u.role));
    return hit ? [hit.id] : foundersOffice(db);
  };
  const to = holder(level);
  const ccRaw = level === 1 ? [task.assigneeId] : level === 2 ? [...holder(1), task.assigneeId] : level === 3 ? holder(2) : [];
  const cc = [...new Set(ccRaw)].filter((id) => !to.includes(id));
  return { to, cc };
}

export interface NewTask {
  title: string;
  description: string;
  instructions?: string;
  category: string;
  priority: Priority;
  assigneeId: string;
  teamId: string | null;
  dueAt: string;
  startAt?: string | null;
  reviewRequired: boolean;
  reviewerId?: string;
  parentId?: string | null;
  recurrenceId?: string | null;
  occurrenceDate?: string | null;
  draft?: boolean;
}

/** Create a task record with its creation/assignment trail and notifications. */
export function createTaskRecord(db: Db, input: NewTask, actorId: string, at: string, note = ''): Task {
  const task: Task = {
    id: nextTaskId(db),
    title: input.title,
    description: input.description,
    instructions: input.instructions ?? '',
    category: input.category,
    priority: input.priority,
    status: input.draft ? 'draft' : 'assigned',
    assigneeId: input.assigneeId,
    createdBy: actorId,
    assignedBy: actorId,
    reviewerId: input.reviewerId ?? actorId,
    teamId: input.teamId,
    createdAt: at,
    updatedAt: at,
    startAt: input.startAt ?? null,
    dueAt: input.dueAt,
    clockStartedAt: at,
    acknowledgedAt: null,
    snoozeUntil: null,
    progress: 0,
    reviewRequired: input.reviewRequired,
    parentId: input.parentId ?? null,
    recurrenceId: input.recurrenceId ?? null,
    occurrenceDate: input.occurrenceDate ?? null,
    cancelReason: null,
    completedAt: null,
  };
  db.tasks.push(task);
  logActivity(db, task.id, 'created', actorId, input.recurrenceId ? 'Created from recurring schedule' : input.draft ? 'Saved as draft' : 'Created the task', at);
  if (!input.draft) recordAssignment(db, task, null, input.assigneeId, actorId, at, note || 'Initial assignment');
  return task;
}

export function recordAssignment(db: Db, task: Task, fromId: string | null, toId: string, byId: string, at: string, reason: string): void {
  db.assignments.push({ id: nextId(db, 'asg'), taskId: task.id, fromId, toId, byId, at, reason });
  if (fromId) {
    logActivity(db, task.id, 'reassigned', byId, `Reassigned from ${userName(db, fromId)} to ${userName(db, toId)}`, at, { reason });
    notify(db, [toId], 'reassignment', `${task.id} reassigned to you`, `${task.title} · ${PRIORITY_LABEL[task.priority]} priority`, task.id, at);
    notify(db, [fromId], 'reassignment', `${task.id} moved to ${userName(db, toId)}`, reason, task.id, at);
  } else {
    logActivity(db, task.id, 'assigned', byId, `Assigned to ${userName(db, toId)}`, at);
    notify(db, [toId], 'assignment', `New task: ${task.id}`, `${task.title} · ${PRIORITY_LABEL[task.priority]} priority, assigned by ${userName(db, byId)}`, task.id, at);
  }
}

/** Escalate tasks whose silence or past-due thresholds have been crossed. Idempotent. */
export function processEscalations(db: Db, now: number): number {
  let created = 0;
  for (const task of db.tasks) {
    const events = db.escalations.filter((e) => e.taskId === task.id && e.status !== 'resolved');
    if (!ACTIVE_STATUSES.includes(task.status)) {
      for (const e of events) {
        e.status = 'resolved';
        e.resolvedAt = iso(now);
      }
      continue;
    }
    const r = computeLevel({ priority: task.priority, clockStartedAt: ms(task.clockStartedAt), dueAt: ms(task.dueAt) }, db.rules, now);
    for (const e of events) {
      if (!levelApplies(e.level, r)) {
        e.status = 'resolved';
        e.resolvedAt = iso(now);
      }
    }
    for (let k = 0; k <= 3; k++) {
      if (!levelApplies(k, r)) continue;
      if (db.escalations.some((e) => e.taskId === task.id && e.level === k && e.status !== 'resolved')) continue;
      const reached = Math.min(now, Math.max(r.reachedAt[k]!, ms(task.clockStartedAt), ms(task.createdAt)));
      const at = iso(reached);
      const { to: recipientIds, cc: ccIds } = escalationRecipients(db, task, k);
      const reason = k > 0 && r.overdueLevel >= k ? 'overdue' : 'silence';
      db.escalations.push({
        id: nextId(db, 'esc'),
        taskId: task.id,
        level: k,
        reason,
        at,
        cycle: task.clockStartedAt,
        recipientIds,
        ccIds,
        status: 'active',
        ackBy: null,
        ackAt: null,
        resolvedAt: null,
        lastNotifiedAt: at,
      });
      const why = reason === 'overdue' ? `past due by ${Math.floor(r.overdueHours)} h` : `no assignee update for ${Math.floor(r.silentHours)} h`;
      logActivity(db, task.id, 'escalated', null, `Escalated to ${LEVEL_LABEL[k]} (${why})`, at, { level: k });
      const silence = `${Math.floor(r.silentHours)} h`;
      notify(db, recipientIds, 'escalation', `${task.id} escalated to ${LEVEL_LABEL[k]}`, `${task.title}: ${why}.`, task.id, at, { level: k, reason: k === 0 ? silence : why });
      notify(db, ccIds, 'escalation', `Copy: ${task.id} escalated to ${LEVEL_LABEL[k]}`, `${task.title}: ${why}. You are copied on this escalation.`, task.id, at, { level: k, reason: why, copy: true });
      audit(db, { at, actorId: null, action: 'escalation.triggered', targetType: 'task', targetId: task.id, taskId: task.id, prev: null, next: LEVEL_LABEL[k]!, source: 'system', context: why });
      created++;
    }
    // Repeat alerts for the top unacknowledged level, unless an acknowledgement snoozes them.
    const top = db.escalations
      .filter((e) => e.taskId === task.id && e.status === 'active')
      .sort((a, b) => b.level - a.level)[0];
    const snoozed = task.snoozeUntil && ms(task.snoozeUntil) > now;
    const windowMs = db.rules.windowsHours[task.priority] * HOUR;
    if (top && !snoozed && now - ms(top.lastNotifiedAt) >= windowMs) {
      // Stamp the reminder when it would actually have fired (the latest whole window), not "now".
      const firedAt = ms(top.lastNotifiedAt) + Math.floor((now - ms(top.lastNotifiedAt)) / windowMs) * windowMs;
      top.lastNotifiedAt = iso(firedAt);
      const silentAt = Math.floor((firedAt - ms(task.clockStartedAt)) / HOUR);
      const overdueAt = Math.floor((firedAt - ms(task.dueAt)) / HOUR);
      const why = top.reason === 'overdue' ? `past due by ${overdueAt} h` : `no assignee update for ${silentAt} h`;
      notify(db, top.recipientIds, 'escalation', `Reminder: ${task.id} still at ${LEVEL_LABEL[top.level]}`, task.title, task.id, iso(firedAt), { level: top.level, reason: top.level === 0 ? `${silentAt} h` : `${why} (still open)` });
    }
    // Due-soon and overdue notices, once per due date.
    const due = ms(task.dueAt);
    const soonFrom = due - db.rules.dueSoonHours * HOUR;
    if (now >= soonFrom && now < due && !db.notifications.some((n) => n.taskId === task.id && n.type === 'due_soon' && ms(n.at) >= soonFrom)) {
      notify(db, [task.assigneeId], 'due_soon', `${task.id} is due soon`, task.title, task.id, iso(Math.max(soonFrom, ms(task.createdAt))));
    }
    if (now >= due && !db.notifications.some((n) => n.taskId === task.id && n.type === 'overdue' && ms(n.at) >= due)) {
      notify(db, [task.assigneeId, task.assignedBy], 'overdue', `${task.id} is overdue`, task.title, task.id, iso(due));
    }
  }
  return created;
}

/** Create any recurring task instances due up to `now`. Keyed by (recurrence, day): never duplicates. */
export function processRecurrences(db: Db, now: number): number {
  let created = 0;
  const today = isoDay(now);
  for (const r of db.recurrences) {
    if (!r.active) continue;
    const from = r.startDate > isoDay(ms(r.createdAt)) ? r.startDate : isoDay(ms(r.createdAt));
    for (const day of occurrencesBetween(r, from, today)) {
      if (db.tasks.some((t) => t.recurrenceId === r.id && t.occurrenceDate === day)) continue;
      const dayStart = Date.parse(day + 'T00:00:00Z');
      const at = iso(Math.max(dayStart, ms(r.createdAt)));
      createTaskRecord(
        db,
        {
          title: `${r.title} — ${day}`,
          description: r.description,
          category: r.category,
          priority: r.priority,
          assigneeId: r.assigneeId,
          teamId: r.teamId,
          dueAt: iso(dayStart + r.dueHour * HOUR),
          reviewRequired: r.reviewRequired,
          recurrenceId: r.id,
          occurrenceDate: day,
        },
        r.createdBy,
        at,
      );
      created++;
    }
  }
  return created;
}

export function runTicks(db: Db, now: number): void {
  processRecurrences(db, now);
  processEscalations(db, now);
  releaseHeld(db, now);
  processDigests(db, now, (p) => nextId(db, p));
}
