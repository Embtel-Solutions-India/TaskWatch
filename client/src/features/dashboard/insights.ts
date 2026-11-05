// Pure analytics over task views. Everything is derived from the mock records; nothing is invented.
import { DAY, HOUR, LEVEL_LABEL } from '../../constants';
import type { TaskView } from '../../services/api/base';
import type { Activity, Db, EscalationEvent, Extension, User } from '../../types';
import { ACTIVE_STATUSES } from '../../types';

export type Range = 7 | 30 | 90;

const isOpenAt = (t: TaskView, at: number) => {
  if (t.status === 'draft' || Date.parse(t.createdAt) > at) return false;
  if (t.completedAt && Date.parse(t.completedAt) <= at) return false;
  if (t.status === 'cancelled' && Date.parse(t.updatedAt) <= at) return false;
  return true;
};
const isOpenNow = (t: TaskView) => ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted';

/** Value of a metric at N evenly spaced points ending now (reconstructed from timestamps). */
function points(now: number, range: Range, n = 10): number[] {
  return Array.from({ length: n }, (_, i) => now - range * DAY + ((i + 1) / n) * range * DAY);
}

export interface Kpi {
  key: string;
  label: string;
  value: string;
  raw: number;
  prev: number | null;
  /** 'up-good' metrics improve when rising; 'down-good' when falling. */
  polarity: 'up-good' | 'down-good';
  spark: number[];
  context: string;
  help: string;
  to: string;
  tone: 'navy' | 'amber' | 'red' | 'violet' | 'green' | 'slate';
  format: 'int' | 'pct';
}

export function kpis(scope: TaskView[], now: number, range: Range, base: string): Kpi[] {
  const ps = points(now, range);
  const prevAt = now - range * DAY;
  const openAt = (at: number) => scope.filter((t) => isOpenAt(t, at)).length;
  const overdueAt = (at: number) => scope.filter((t) => isOpenAt(t, at) && Date.parse(t.dueAt) < at).length;
  const completion = (from: number, to: number) => {
    const due = scope.filter((t) => t.status !== 'draft' && t.status !== 'cancelled' && Date.parse(t.dueAt) >= from && Date.parse(t.dueAt) < to);
    if (!due.length) return null;
    return due.filter((t) => t.completedAt && Date.parse(t.completedAt) < to).length / due.length;
  };
  const running = scope.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const compliance = running.length ? running.filter((t) => (t.levelInfo?.silenceLevel ?? -1) < 0).length / running.length : 0;
  const critical = scope.filter((t) => isOpenNow(t) && t.level >= 2).length;
  const review = scope.filter((t) => t.status === 'submitted');
  const comp = completion(now - range * DAY, now);
  const compPrev = completion(now - 2 * range * DAY, now - range * DAY);
  return [
    { key: 'open', label: 'Open tasks', value: String(scope.filter(isOpenNow).length), raw: scope.filter(isOpenNow).length, prev: openAt(prevAt), polarity: 'down-good', spark: ps.map(openAt), context: `vs ${range} days ago`, help: 'Tasks assigned and not yet completed or cancelled (includes tasks in review). Earlier values are reconstructed from created/completed timestamps.', to: `${base}?status=open`, tone: 'navy', format: 'int' },
    { key: 'overdue', label: 'Overdue', value: String(overdueAt(now)), raw: overdueAt(now), prev: overdueAt(prevAt), polarity: 'down-good', spark: ps.map(overdueAt), context: `vs ${range} days ago`, help: 'Open tasks past their current due date. History uses the current (approved) due date.', to: `${base}?due=overdue`, tone: 'red', format: 'int' },
    { key: 'critical', label: 'Critical escalations', value: String(critical), raw: critical, prev: null, polarity: 'down-good', spark: [], context: "L2 Manager or L3 Founder's Office", help: 'Open tasks currently at escalation level L2 or L3.', to: '/escalations?level=2', tone: 'amber', format: 'int' },
    { key: 'review', label: 'Awaiting review', value: String(review.length), raw: review.length, prev: null, polarity: 'down-good', spark: [], context: review.length ? `oldest ${Math.round(Math.max(...review.map((t) => (now - Date.parse(t.clockStartedAt)) / HOUR)))} h` : 'queue clear', help: 'Tasks submitted for review and not yet decided.', to: `${base}?status=submitted`, tone: 'violet', format: 'int' },
    { key: 'completion', label: 'Completion rate', value: comp === null ? '—' : `${Math.round(comp * 100)}%`, raw: comp ?? 0, prev: compPrev, polarity: 'up-good', spark: ps.map((p) => completion(p - range * DAY, p) ?? 0), context: `tasks due in last ${range} d`, help: `Share of tasks due in the last ${range} days that were completed by the end of the period. Compared with the ${range} days before.`, to: `${base}?status=closed`, tone: 'green', format: 'pct' },
    { key: 'compliance', label: 'Update compliance', value: running.length ? `${Math.round(compliance * 100)}%` : '—', raw: compliance, prev: null, polarity: 'up-good', spark: [], context: `${running.length} active tasks`, help: "Share of active tasks whose assignee posted a progress update within the priority's required window (silence below L0). Current snapshot only.", to: `${base}?status=open`, tone: 'slate', format: 'pct' },
  ];
}

export interface Health {
  onTrack: TaskView[];
  atRisk: TaskView[];
  overdue: TaskView[];
  escalated: TaskView[];
}

/** Mutually exclusive buckets over open tasks. */
export function health(scope: TaskView[], now: number): Health {
  const h: Health = { onTrack: [], atRisk: [], overdue: [], escalated: [] };
  for (const t of scope.filter(isOpenNow)) {
    if (t.overdue) h.overdue.push(t);
    else if (t.level >= 1) h.escalated.push(t);
    else if (t.level === 0 || Date.parse(t.dueAt) - now < 24 * HOUR) h.atRisk.push(t);
    else h.onTrack.push(t);
  }
  return h;
}
export const HEALTH_HELP = 'Open tasks in exactly one bucket, checked in order: Overdue (past due date) → Escalated (L1+ from missed updates) → At risk (L0 reminder, or due within 24 h) → On track.';

export interface AttentionItem {
  key: string;
  severity: 'critical' | 'high' | 'medium';
  task: TaskView;
  reason: string;
  detail: string;
  action: string;
}

export function attention(scope: TaskView[], extensions: Extension[], now: number, me: User, reviewerIds: Set<string>): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const t of scope.filter(isOpenNow)) {
    const hrs = (ms: number) => Math.round(Math.abs(ms) / HOUR);
    const mine = t.assigneeId === me.id;
    if (t.overdue && (t.priority === 'critical' || t.level >= 2)) out.push({ key: `${t.id}-od`, severity: 'critical', task: t, reason: `${t.priority === 'critical' ? 'Critical task' : 'Task'} overdue`, detail: `${hrs(now - Date.parse(t.dueAt))} h past due`, action: mine ? 'Post an update or request an extension' : 'Intervene: reassign or follow up' });
    else if (t.overdue) out.push({ key: `${t.id}-od`, severity: 'high', task: t, reason: 'Overdue', detail: `${hrs(now - Date.parse(t.dueAt))} h past due`, action: mine ? 'Post an update or request an extension' : 'Follow up with the assignee' });
    else if (t.levelInfo?.next && t.levelInfo.next.at - now < 2 * HOUR) out.push({ key: `${t.id}-nx`, severity: 'high', task: t, reason: `Reaches ${LEVEL_LABEL[t.levelInfo.next.level]} soon`, detail: `in ${Math.max(1, Math.round((t.levelInfo.next.at - now) / 60000))} min`, action: mine ? 'Post a progress update now' : 'Nudge the assignee' });
    else if (Date.parse(t.dueAt) - now < 24 * HOUR) out.push({ key: `${t.id}-ds`, severity: 'medium', task: t, reason: 'Due within 24 h', detail: `due in ${hrs(Date.parse(t.dueAt) - now)} h`, action: mine ? 'Finish or post an update' : 'Check progress' });
    if (ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt && now - Date.parse(t.createdAt) > 2 * HOUR) out.push({ key: `${t.id}-ack`, severity: 'medium', task: t, reason: 'Not acknowledged', detail: `assigned ${hrs(now - Date.parse(t.createdAt))} h ago`, action: mine ? 'Acknowledge the task' : 'Remind the assignee' });
    if (t.status === 'submitted' && reviewerIds.has(t.id) && now - Date.parse(t.clockStartedAt) > 24 * HOUR) out.push({ key: `${t.id}-rv`, severity: 'high', task: t, reason: 'Review waiting > 24 h', detail: `submitted ${hrs(now - Date.parse(t.clockStartedAt))} h ago`, action: 'Review the submission' });
  }
  for (const e of extensions.filter((x) => x.status === 'pending')) {
    const t = scope.find((x) => x.id === e.taskId);
    if (t && reviewerIds.has(`ext:${e.id}`)) out.push({ key: e.id, severity: 'medium', task: t, reason: 'Extension request awaiting you', detail: `asked ${Math.round((now - Date.parse(e.at)) / HOUR)} h ago`, action: 'Approve or reject' });
  }
  const rank = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.task.level - a.task.level);
}

export interface TrendPoint {
  label: string;
  created: number;
  completed: number;
  overdue: number;
}

export function trend(scope: TaskView[], now: number, range: Range): TrendPoint[] {
  const buckets = range === 7 ? 7 : range === 30 ? 10 : 13;
  const size = (range * DAY) / buckets;
  const start = now - range * DAY;
  return Array.from({ length: buckets }, (_, i) => {
    const a = start + i * size;
    const b = a + size;
    const inB = (s: string | null) => !!s && Date.parse(s) >= a && Date.parse(s) < b;
    return {
      label: new Date(b - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      created: scope.filter((t) => t.status !== 'draft' && inB(t.createdAt)).length,
      completed: scope.filter((t) => inB(t.completedAt)).length,
      // Became overdue: due date passed inside the bucket while the task was still open.
      overdue: scope.filter((t) => inB(t.dueAt) && Date.parse(t.dueAt) <= now && isOpenAt(t, Date.parse(t.dueAt))).length,
    };
  });
}

export interface WorkloadRow {
  id: string;
  name: string;
  title: string;
  assigned: number;
  active: number;
  overdue: number;
  completed: number;
  overloaded: boolean;
}

export function workload(scope: TaskView[], people: User[], now: number, range: Range, threshold: number): WorkloadRow[] {
  const from = now - range * DAY;
  return people
    .filter((u) => u.status === 'active')
    .map((u) => {
      const mine = scope.filter((t) => t.assigneeId === u.id);
      const active = mine.filter(isOpenNow);
      return {
        id: u.id,
        name: u.name,
        title: u.title,
        assigned: mine.filter((t) => t.status !== 'draft' && Date.parse(t.createdAt) >= from).length,
        active: active.length,
        overdue: active.filter((t) => t.overdue).length,
        completed: mine.filter((t) => t.completedAt && Date.parse(t.completedAt) >= from).length,
        overloaded: active.length > threshold,
      };
    })
    .filter((r) => r.assigned || r.active || r.completed)
    .sort((a, b) => b.active - a.active || b.overdue - a.overdue);
}

export function funnel(scope: TaskView[], events: EscalationEvent[], now: number, range: Range) {
  const ids = new Set(scope.map((t) => t.id));
  const evs = events.filter((e) => ids.has(e.taskId));
  const open = scope.filter(isOpenNow);
  const total = open.filter((t) => t.level >= 0).length;
  return [0, 1, 2, 3].map((l) => {
    const cur = evs.filter((e) => e.level === l && Date.parse(e.at) >= now - range * DAY).length;
    const prev = evs.filter((e) => e.level === l && Date.parse(e.at) >= now - 2 * range * DAY && Date.parse(e.at) < now - range * DAY).length;
    const count = open.filter((t) => t.level === l).length;
    return { level: l, count, share: total ? count / total : 0, triggered: cur, prevTriggered: prev };
  });
}

/** Progress updates by weekday × 3-hour block over the last 4 weeks. */
export function activityHeatmap(activities: Activity[], taskIds: Set<string>, now: number) {
  const grid = Array.from({ length: 7 }, () => Array(8).fill(0) as number[]);
  for (const a of activities) {
    if (a.type !== 'progress' || !taskIds.has(a.taskId)) continue;
    const t = Date.parse(a.at);
    if (t < now - 28 * DAY || t > now) continue;
    const d = new Date(t);
    grid[(d.getDay() + 6) % 7]![Math.floor(d.getHours() / 3)]! += 1;
  }
  return grid;
}

export function escalationResponse(events: EscalationEvent[], taskIds: Set<string>, now: number, range: Range) {
  const buckets = range === 7 ? 7 : range === 30 ? 6 : 13;
  const size = (range * DAY) / buckets;
  const start = now - range * DAY;
  return Array.from({ length: buckets }, (_, i) => {
    const a = start + i * size;
    const b = a + size;
    const acked = events.filter((e) => taskIds.has(e.taskId) && e.level >= 1 && e.ackAt && Date.parse(e.at) >= a && Date.parse(e.at) < b);
    return {
      label: new Date(b - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      hours: acked.length ? acked.reduce((s, e) => s + (Date.parse(e.ackAt!) - Date.parse(e.at)) / HOUR, 0) / acked.length : 0,
      count: acked.length,
    };
  });
}

export function departmentOf(db: Db, teamId: string | null): string | null {
  return db.teams.find((t) => t.id === teamId)?.departmentId ?? null;
}
