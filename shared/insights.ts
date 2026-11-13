// Dashboard metrics (DASH-01…03, DASHBOARD-FRD §1) — the one implementation used by the server and the mock
// (ADR-0007, D-9). Pure: no dependencies, no Node or DOM APIs. Instants are epoch ms in, ISO strings out; day
// boundaries use the viewer's zone (D-5).
import { wallClock, zonedInstant } from '@taskwatch/shared/levels';
import { ACTIVE_STATUSES, type Status } from '@taskwatch/shared/workflow';
import { labelDepartments } from '@taskwatch/shared/permissions';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Range = 7 | 30 | 90;
export const RANGES: readonly Range[] = [7, 30, 90];
export type Layout = 'staff' | 'lead' | 'manager' | 'executive';
export type Id = string | number;
export type Priority = 'critical' | 'high' | 'normal' | 'low';
export const PRIORITIES: readonly Priority[] = ['critical', 'high', 'normal', 'low'];
export const LEVEL_LABELS = ['L0 Reminder', 'L1 Team lead', 'L2 Manager', "L3 Founder's Office"] as const;

/** One task as the dashboard needs it. Level fields come from the shared ladder at `now`; -1 off the ladder. */
export interface DashTask {
  id: Id;
  title: string;
  status: Status;
  priority: Priority;
  assigneeId: Id;
  assigneeName: string;
  assignedBy: Id;
  teamId: Id | null;
  entityId: string | null;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  completedAt: number | null;
  clockStartedAt: number;
  acknowledgedAt: number | null;
  level: number;
  silenceLevel: number;
  next: { level: number; at: number } | null;
  /** Active (not in review) and past due (DASHBOARD-FRD §1.1). */
  overdue: boolean;
  /** The viewer may review this submission (WF-10). */
  mayReview: boolean;
}

export interface DashEvent {
  taskId: Id;
  level: number;
  at: number;
  ackAt: number | null;
}

export interface DashExtension {
  id: Id;
  taskId: Id;
  at: number;
  /** The viewer may decide it (EXT-02). */
  mayDecide: boolean;
}

export interface DashPerson {
  id: Id;
  name: string;
  title: string;
  active: boolean;
}

const isActive = (t: DashTask) => ACTIVE_STATUSES.includes(t.status);
export const isOpenNow = (t: DashTask): boolean => isActive(t) || t.status === 'submitted';
const isOpenAt = (t: DashTask, at: number) => {
  if (t.status === 'draft' || t.createdAt > at) return false;
  if (t.completedAt !== null && t.completedAt <= at) return false;
  if (t.status === 'cancelled' && t.updatedAt <= at) return false;
  return true;
};
const iso = (t: number) => new Date(t).toISOString();
const hrs = (ms: number) => Math.round(Math.abs(ms) / HOUR);

/** 10 evenly spaced instants ending now (§1.1 sample points). */
function points(now: number, range: Range, n = 10): number[] {
  return Array.from({ length: n }, (_, i) => now - range * DAY + ((i + 1) / n) * range * DAY);
}

/** Equal buckets over [now − range, now), labelled by their last instant's date in the viewer's zone. */
function buckets(now: number, range: Range, count: number, zone: string) {
  const size = (range * DAY) / count;
  const start = now - range * DAY;
  return Array.from({ length: count }, (_, i) => {
    const a = start + i * size;
    const b = a + size;
    return { a, b, label: new Date(b - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: zone }) };
  });
}

/** Local midnight of the day containing `t`, shifted by `days`, in `zone`. */
export function dayStart(zone: string, t: number, days = 0): number {
  const w = wallClock(zone, t);
  return zonedInstant(zone, w.year, w.month, w.day + days, 0, 0);
}

/** Day of the week of `t` in `zone`, Monday = 0. */
export function weekday(zone: string, t: number): number {
  const w = wallClock(zone, t);
  return (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7;
}

/* ---------------- §1.2 KPI tiles ---------------- */

export interface Kpi {
  key: string;
  label: string;
  value: string;
  raw: number;
  prev: number | null;
  polarity: 'up-good' | 'down-good';
  spark: number[];
  context: string;
  help: string;
  to: string;
  tone: 'navy' | 'amber' | 'red' | 'violet' | 'green' | 'slate';
  format: 'int' | 'pct';
}

export function kpis(scope: DashTask[], now: number, range: Range, base: string): Kpi[] {
  const ps = points(now, range);
  const prevAt = now - range * DAY;
  const openAt = (at: number) => scope.filter((t) => isOpenAt(t, at)).length;
  // H3: today's figure leaves out tasks now in review, as the task view does; history cannot know past statuses.
  const overdueAt = (at: number) => scope.filter((t) => isOpenAt(t, at) && t.dueAt < at && !(at >= now && t.status === 'submitted')).length;
  const completion = (from: number, to: number) => {
    const due = scope.filter((t) => t.status !== 'draft' && t.status !== 'cancelled' && t.dueAt >= from && t.dueAt < to);
    if (!due.length) return null;
    return due.filter((t) => t.completedAt !== null && t.completedAt < to).length / due.length;
  };
  const running = scope.filter(isActive);
  const compliance = running.length ? running.filter((t) => t.silenceLevel < 0).length / running.length : 0;
  const open = scope.filter(isOpenNow).length;
  const critical = scope.filter((t) => isOpenNow(t) && t.level >= 2).length;
  const review = scope.filter((t) => t.status === 'submitted');
  const comp = completion(now - range * DAY, now);
  const compPrev = completion(now - 2 * range * DAY, now - range * DAY);
  return [
    { key: 'open', label: 'Open tasks', value: String(open), raw: open, prev: openAt(prevAt), polarity: 'down-good', spark: ps.map(openAt), context: `vs ${range} days ago`, help: 'Tasks assigned and not yet completed or cancelled (includes tasks in review). Earlier values are reconstructed from created/completed timestamps.', to: `${base}?status=open`, tone: 'navy', format: 'int' },
    { key: 'overdue', label: 'Overdue', value: String(overdueAt(now)), raw: overdueAt(now), prev: overdueAt(prevAt), polarity: 'down-good', spark: ps.map(overdueAt), context: `vs ${range} days ago`, help: 'Open tasks past their current due date. History uses the current (approved) due date.', to: `${base}?due=overdue`, tone: 'red', format: 'int' },
    { key: 'critical', label: 'Critical escalations', value: String(critical), raw: critical, prev: null, polarity: 'down-good', spark: [], context: "L2 Manager or L3 Founder's Office", help: 'Open tasks currently at escalation level L2 or L3.', to: '/escalations?level=2', tone: 'amber', format: 'int' },
    { key: 'review', label: 'Awaiting review', value: String(review.length), raw: review.length, prev: null, polarity: 'down-good', spark: [], context: review.length ? `oldest ${Math.round(Math.max(...review.map((t) => (now - t.clockStartedAt) / HOUR)))} h` : 'queue clear', help: 'Tasks submitted for review and not yet decided.', to: `${base}?status=submitted`, tone: 'violet', format: 'int' },
    { key: 'completion', label: 'Completion rate', value: comp === null ? '—' : `${Math.round(comp * 100)}%`, raw: comp ?? 0, prev: compPrev, polarity: 'up-good', spark: ps.map((p) => completion(p - range * DAY, p) ?? 0), context: `tasks due in last ${range} d`, help: `Share of tasks due in the last ${range} days that were completed by the end of the period. Compared with the ${range} days before.`, to: `${base}?status=closed`, tone: 'green', format: 'pct' },
    { key: 'compliance', label: 'Update compliance', value: running.length ? `${Math.round(compliance * 100)}%` : '—', raw: compliance, prev: null, polarity: 'up-good', spark: [], context: `${running.length} active tasks`, help: "Share of active tasks whose assignee posted a progress update within the priority's required window (silence below L0). Current snapshot only.", to: `${base}?status=open`, tone: 'slate', format: 'pct' },
  ];
}

/* ---------------- §1.3 Health buckets ---------------- */

export type HealthBucket = 'onTrack' | 'atRisk' | 'escalated' | 'overdue';

/** Exactly one bucket per open task, tested in order: overdue, escalated, at risk, on track. */
export function healthOf(t: DashTask, now: number): HealthBucket {
  if (t.overdue) return 'overdue';
  if (t.level >= 1) return 'escalated';
  if (t.level === 0 || t.dueAt - now < DAY) return 'atRisk';
  return 'onTrack';
}

export function health(scope: DashTask[], now: number): Record<HealthBucket, number> {
  const h = { onTrack: 0, atRisk: 0, escalated: 0, overdue: 0 };
  for (const t of scope.filter(isOpenNow)) h[healthOf(t, now)] += 1;
  return h;
}

/* ---------------- §1.4 Attention list ---------------- */

export interface TaskBrief {
  id: Id;
  title: string;
  priority: Priority;
  status: Status;
  assignee: { id: Id; name: string };
  dueAt: string;
  overdue: boolean;
  level: number;
  next: { level: number; at: string } | null;
}

export const brief = (t: DashTask): TaskBrief => ({
  id: t.id,
  title: t.title,
  priority: t.priority,
  status: t.status,
  assignee: { id: t.assigneeId, name: t.assigneeName },
  dueAt: iso(t.dueAt),
  overdue: t.overdue,
  level: t.level,
  next: t.next && { level: t.next.level, at: iso(t.next.at) },
});

export interface AttentionItem {
  key: string;
  severity: 'critical' | 'high' | 'medium';
  task: TaskBrief;
  reason: string;
  detail: string;
  action: string;
}

export function attention(scope: DashTask[], extensions: DashExtension[], now: number, viewerId: Id): AttentionItem[] {
  const out: (AttentionItem & { level: number })[] = [];
  const push = (t: DashTask, key: string, severity: AttentionItem['severity'], reason: string, detail: string, action: string) =>
    out.push({ key: `${t.id}-${key}`, severity, task: brief(t), reason, detail, action, level: t.level });
  for (const t of scope.filter(isOpenNow)) {
    const mine = t.assigneeId === viewerId;
    if (t.overdue && (t.priority === 'critical' || t.level >= 2))
      push(t, 'od', 'critical', `${t.priority === 'critical' ? 'Critical task' : 'Task'} overdue`, `${hrs(now - t.dueAt)} h past due`, mine ? 'Post an update or request an extension' : 'Intervene: reassign or follow up');
    else if (t.overdue) push(t, 'od', 'high', 'Overdue', `${hrs(now - t.dueAt)} h past due`, mine ? 'Post an update or request an extension' : 'Follow up with the assignee');
    else if (t.next && t.next.at - now < 2 * HOUR)
      push(t, 'nx', 'high', `Reaches ${LEVEL_LABELS[t.next.level]} soon`, `in ${Math.max(1, Math.round((t.next.at - now) / 60_000))} min`, mine ? 'Post a progress update now' : 'Nudge the assignee');
    else if (t.dueAt - now < DAY)
      // A submitted task past its due date is not "overdue" (§1.1); word it as such rather than "due in N h".
      push(t, 'ds', 'medium', t.dueAt < now ? 'Past due (in review)' : 'Due within 24 h', t.dueAt < now ? `${hrs(now - t.dueAt)} h past due` : `due in ${hrs(t.dueAt - now)} h`, mine ? 'Finish or post an update' : 'Check progress');
    if (isActive(t) && t.acknowledgedAt === null && now - t.createdAt > 2 * HOUR)
      push(t, 'ack', 'medium', 'Not acknowledged', `assigned ${hrs(now - t.createdAt)} h ago`, mine ? 'Acknowledge the task' : 'Remind the assignee');
    if (t.status === 'submitted' && t.mayReview && now - t.clockStartedAt > DAY)
      push(t, 'rv', 'high', 'Review waiting > 24 h', `submitted ${hrs(now - t.clockStartedAt)} h ago`, 'Review the submission');
  }
  for (const e of extensions) {
    const t = scope.find((x) => x.id === e.taskId);
    if (t && e.mayDecide) out.push({ key: `ext-${e.id}`, severity: 'medium', task: brief(t), reason: 'Extension request awaiting you', detail: `asked ${hrs(now - e.at)} h ago`, action: 'Approve or reject', level: t.level });
  }
  const rank = { critical: 0, high: 1, medium: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.level - a.level).map(({ level: _l, ...item }) => item);
}

/* ---------------- §1.5 Trend ---------------- */

export interface TrendPoint {
  label: string;
  created: number;
  completed: number;
  overdue: number;
}

export function trend(scope: DashTask[], now: number, range: Range, zone: string): TrendPoint[] {
  return buckets(now, range, range === 7 ? 7 : range === 30 ? 10 : 13, zone).map(({ a, b, label }) => {
    const inB = (t: number | null) => t !== null && t >= a && t < b;
    return {
      label,
      created: scope.filter((t) => t.status !== 'draft' && inB(t.createdAt)).length,
      completed: scope.filter((t) => inB(t.completedAt)).length,
      // Became overdue: due date passed inside the bucket while the task was still open.
      overdue: scope.filter((t) => inB(t.dueAt) && t.dueAt <= now && isOpenAt(t, t.dueAt)).length,
    };
  });
}

/* ---------------- §1.6 Workload ---------------- */

export interface WorkloadRow {
  id: Id;
  name: string;
  title: string;
  assigned: number;
  active: number;
  overdue: number;
  completed: number;
  overloaded: boolean;
}

export function workload(scope: DashTask[], people: DashPerson[], now: number, range: Range, threshold: number): WorkloadRow[] {
  const from = now - range * DAY;
  return people
    .filter((u) => u.active)
    .map((u) => {
      const mine = scope.filter((t) => t.assigneeId === u.id);
      const active = mine.filter(isOpenNow);
      return {
        id: u.id,
        name: u.name,
        title: u.title,
        assigned: mine.filter((t) => t.status !== 'draft' && t.createdAt >= from).length,
        active: active.length,
        overdue: active.filter((t) => t.overdue).length,
        completed: mine.filter((t) => t.completedAt !== null && t.completedAt >= from).length,
        overloaded: active.length > threshold,
      };
    })
    .filter((r) => r.assigned || r.active || r.completed)
    .sort((a, b) => b.active - a.active || b.overdue - a.overdue);
}

/* ---------------- §1.7 Funnel, §1.8 heatmap, §1.9 response ---------------- */

export function funnel(scope: DashTask[], events: DashEvent[], now: number, range: Range) {
  const open = scope.filter(isOpenNow);
  const total = open.filter((t) => t.level >= 0).length;
  return [0, 1, 2, 3].map((l) => {
    const count = open.filter((t) => t.level === l).length;
    return {
      level: l,
      count,
      share: total ? count / total : 0,
      triggered: events.filter((e) => e.level === l && e.at >= now - range * DAY).length,
      prevTriggered: events.filter((e) => e.level === l && e.at >= now - 2 * range * DAY && e.at < now - range * DAY).length,
    };
  });
}

/** Progress updates by weekday (Monday first) × 3-hour block over the last 28 days, in the viewer's zone. */
export function activityHeatmap(progressAt: number[], now: number, zone: string): number[][] {
  const grid = Array.from({ length: 7 }, () => Array(8).fill(0) as number[]);
  for (const t of progressAt) {
    if (t < now - 28 * DAY || t > now) continue;
    grid[weekday(zone, t)]![Math.floor(wallClock(zone, t).hour / 3)]! += 1;
  }
  return grid;
}

export function escalationResponse(events: DashEvent[], now: number, range: Range, zone: string) {
  return buckets(now, range, range === 7 ? 7 : range === 30 ? 6 : 13, zone).map(({ a, b, label }) => {
    const acked = events.filter((e) => e.level >= 1 && e.ackAt !== null && e.at >= a && e.at < b);
    return { label, hours: acked.length ? acked.reduce((s, e) => s + (e.ackAt! - e.at) / HOUR, 0) / acked.length : 0, count: acked.length };
  });
}

/* ---------------- §1.10 Group figures ---------------- */

export interface GroupRow {
  id: Id;
  name: string;
  open: number;
  overdue: number;
  escalated: number;
  /** Completed ÷ non-cancelled, all time; null without tasks. */
  completionRate: number | null;
}

export function groupRow(id: Id, name: string, tasks: DashTask[]): GroupRow {
  const counted = tasks.filter((t) => t.status !== 'cancelled').length;
  return {
    id,
    name,
    open: tasks.filter(isOpenNow).length,
    overdue: tasks.filter((t) => isOpenNow(t) && t.overdue).length,
    escalated: tasks.filter((t) => isOpenNow(t) && t.level >= 1).length,
    completionRate: counted ? tasks.filter((t) => t.status === 'completed').length / counted : null,
  };
}

/** Active tasks updated within the window ÷ active tasks; 0 when none (Manager "update compliance by team"). */
export const complianceOf = (tasks: DashTask[]): number => {
  const run = tasks.filter(isActive);
  return run.length ? run.filter((t) => t.silenceLevel < 0).length / run.length : 0;
};

/** Open and level ≥ 1 / active and silent past the window (`stale`, "awaiting update"). */
export const isEscalated = (t: DashTask): boolean => isOpenNow(t) && t.level >= 1;
export const isStale = (t: DashTask): boolean => isActive(t) && t.silenceLevel >= 0;

/** Completed on or before the due date ÷ completed; null when none completed. */
export function onTimeRate(scope: DashTask[]): number | null {
  const done = scope.filter((t) => t.status === 'completed' && t.completedAt !== null);
  return done.length ? done.filter((t) => t.completedAt! <= t.dueAt).length / done.length : null;
}

export type Stage = 'on_track' | 'amber' | 'red';

/** TASK-10 stage stripe (D-49): L0–L1 amber, L2–L3 red; none for closed and draft tasks. */
export function taskStage(status: Status, level: number): Stage | null {
  if (status === 'draft' || status === 'completed' || status === 'cancelled') return null;
  return level >= 2 ? 'red' : level >= 0 ? 'amber' : 'on_track';
}

/** Layout by the highest-ranked role (D-8). */
export function layoutFor(roles: readonly string[]): Layout {
  if (roles.includes('ceo') || roles.includes('cos')) return 'executive';
  if (roles.includes('manager')) return 'manager';
  if (roles.includes('lead')) return 'lead';
  return 'staff';
}

/* ---------------- DASH-01 payload by layout ---------------- */

export interface DashTeam {
  id: Id;
  name: string;
  entityId: string;
}

export interface DashboardInput {
  layout: Layout;
  now: number;
  range: Range;
  /** The viewer's zone, for day boundaries and labels (D-5). */
  zone: string;
  viewerId: Id;
  overloadThreshold: number;
  /** Non-draft tasks in the viewer's scope (D-51), already narrowed to the chosen entity. */
  scope: DashTask[];
  /** Pending extensions on scoped tasks. */
  extensions: DashExtension[];
  /** Escalation events on scoped tasks. */
  events: DashEvent[];
  /** Times of progress updates on scoped tasks (last 28 days is enough). */
  progressAt: number[];
  /** Workload rows: the viewer's reports (CoS/CEO: everyone in the entity but themselves). */
  people: DashPerson[];
  /** Teams of the organization (narrowed to the entity), and the entities shown. */
  teams: DashTeam[];
  entities: { id: string; name: string }[];
}

const top = (tasks: DashTask[], n: number) => ({ count: tasks.length, items: tasks.slice(0, n).map(brief) });
const byDue = (a: DashTask, b: DashTask) => a.dueAt - b.dueAt;
const ASSIGNMENT_STATUSES: readonly Status[] = ['assigned', 'in_progress', 'submitted', 'changes_requested', 'reopened'];

/** Every widget figure of one layout (DASHBOARD-FRD DASH-01 table). Lists are capped; no full task list is returned (D-10). */
export function buildDashboard(i: DashboardInput) {
  const { now, range, zone, scope, viewerId } = i;
  const open = scope.filter(isOpenNow);
  if (i.layout === 'staff') {
    const mine = scope.filter((t) => t.assigneeId === viewerId);
    const mineOpen = mine.filter(isOpenNow);
    const endOfToday = dayStart(zone, now, 1);
    const weekStart = dayStart(zone, now, -weekday(zone, now));
    const weekEnd = dayStart(zone, weekStart, 7);
    const dueThisWeek = mine.filter((t) => t.status !== 'cancelled' && t.dueAt >= weekStart && t.dueAt < weekEnd);
    return {
      layout: i.layout,
      kpis: kpis(mine, now, range, '/tasks/mine').filter((k) => k.key !== 'critical'),
      attention: attention(mineOpen, i.extensions, now, viewerId),
      myDay: {
        overdue: top(mineOpen.filter((t) => t.overdue), 4),
        dueToday: top(mineOpen.filter((t) => !t.overdue && t.dueAt < endOfToday), 4),
        awaitingReview: top(mine.filter((t) => t.status === 'submitted'), 4),
        updateNext: top(mineOpen.filter(isActive).sort((a, b) => (a.next?.at ?? Infinity) - (b.next?.at ?? Infinity)), 4),
      },
      week: {
        due: dueThisWeek.length,
        done: dueThisWeek.filter((t) => t.status === 'completed').length,
        days: Array.from({ length: 7 }, (_, d) => {
          const from = dayStart(zone, now, d);
          const to = dayStart(zone, now, d + 1);
          const due = mineOpen.filter((t) => t.dueAt >= from && t.dueAt < to);
          return { date: iso(from), count: due.length, priorities: due.slice(0, 3).map((t) => t.priority) };
        }),
      },
      trend: trend(mine, now, range, zone),
    };
  }

  const base = '/tasks/team';
  const common = {
    kpis: kpis(scope, now, range, base),
    health: health(scope, now),
    attention: attention(scope, i.extensions, now, viewerId),
    trend: trend(scope, now, range, zone),
    workload: workload(scope, i.people, now, range, i.overloadThreshold),
  };
  const teamsInScope = labelDepartments(i.teams.filter((tm) => scope.some((t) => t.teamId === tm.id)), (tm) => tm.entityId);
  const ofTeam = (id: Id) => scope.filter((t) => t.teamId === id);
  const teamRows = teamsInScope.map((tm) => groupRow(tm.id, tm.name, ofTeam(tm.id)));

  if (i.layout === 'lead')
    return {
      layout: i.layout,
      ...common,
      reviewQueue: top(scope.filter((t) => t.status === 'submitted'), 5),
      escalated: top(open.filter((t) => t.level >= 1).sort((a, b) => b.level - a.level), 5),
      stale: top(scope.filter(isStale), 6),
      dueSoon: top(open.filter((t) => !t.overdue && t.dueAt - now < 48 * HOUR).sort(byDue), 6),
      assignments: ASSIGNMENT_STATUSES.map((s) => ({ status: s, count: scope.filter((t) => t.assignedBy === viewerId && t.status === s).length })),
      heatmap: activityHeatmap(i.progressAt, now, zone),
    };

  if (i.layout === 'manager')
    return {
      layout: i.layout,
      ...common,
      overdueByTeam: teamRows.map((r) => ({ id: r.id, name: r.name, value: r.overdue })),
      escalationsByPriority: [0, 1, 2, 3].map((level) => ({ level, values: PRIORITIES.map((p) => open.filter((t) => t.priority === p && t.level === level).length) })),
      complianceByTeam: teamsInScope.map((tm) => ({ id: tm.id, name: tm.name, value: complianceOf(ofTeam(tm.id)) })),
      delayedReviews: top(scope.filter((t) => t.status === 'submitted' && now - t.clockStartedAt > DAY), 6),
      teams: teamRows.filter((r) => r.open || r.overdue || r.completionRate !== null),
    };

  const entityRows = i.entities.map((en) => {
    const g = groupRow(en.id, en.name, scope.filter((t) => t.entityId === en.id));
    return {
      id: en.id,
      name: en.name,
      active: g.open,
      overdue: g.overdue,
      escalated: g.escalated,
      teams: i.teams.filter((tm) => tm.entityId === en.id).map((tm) => ({ id: tm.id, name: tm.name, open: ofTeam(tm.id).filter(isOpenNow).length })),
    };
  });
  return {
    layout: i.layout,
    ...common,
    // CoS/CEO "critical attention queue": medium items only when the task has escalated.
    attention: common.attention.filter((a) => a.severity !== 'medium' || a.task.level >= 1),
    funnel: funnel(scope, i.events, now, range),
    entities: entityRows,
    escalationResponse: escalationResponse(i.events, now, range, zone),
    atRiskTeams: teamRows
      .map((r) => ({ ...r, risk: r.open ? (r.overdue + r.escalated) / r.open : 0 }))
      .filter((r) => r.risk > 0)
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 5),
  };
}

export type Dashboard = ReturnType<typeof buildDashboard>;

/* ---------------- DASH-02 team overview ---------------- */

export interface TeamPerson extends DashPerson {
  roles: readonly string[];
  teamId: Id | null;
  managerId: Id | null;
}

/**
 * The reporting-line summary over the given people (CoS/CEO: everyone but themselves; others: transitive reports).
 * `nameOf` names managers outside the list (the viewer, or someone above them).
 */
export function buildTeamOverview(viewerId: Id, people: TeamPerson[], tasks: DashTask[], allTeams: DashTeam[], nameOf: (id: Id) => string | null) {
  const ids = new Set(people.map((u) => u.id));
  const scope = tasks.filter((t) => ids.has(t.assigneeId));
  const teams = labelDepartments(allTeams.filter((tm) => scope.some((t) => t.teamId === tm.id) || people.some((u) => u.teamId === tm.id)), (tm) => tm.entityId);
  const open = scope.filter(isOpenNow);
  const name = (id: Id | null) => (id === null ? null : nameOf(id));
  const rowOf = (u: TeamPerson) => {
    const g = groupRow(u.id, u.name, scope.filter((t) => t.assigneeId === u.id));
    return { open: g.open, overdue: g.overdue, escalated: g.escalated };
  };
  return {
    reportCount: people.length,
    directCount: people.filter((u) => u.managerId === viewerId).length,
    stats: { open: open.length, overdue: open.filter((t) => t.overdue).length, escalated: scope.filter(isEscalated).length, awaitingUpdate: scope.filter(isStale).length, onTimeRate: onTimeRate(scope) },
    workload: people
      .filter((u) => u.active)
      .map((u) => ({ id: u.id, name: u.name, ...rowOf(u) }))
      .sort((a, b) => b.open - a.open)
      .slice(0, 14),
    teams: teams.map((tm) => groupRow(tm.id, tm.name, scope.filter((t) => t.teamId === tm.id))).filter((r) => r.open || r.overdue || r.completionRate !== null),
    people: people.map((u) => ({ id: u.id, name: u.name, title: u.title, roles: u.roles, active: u.active, teamId: u.teamId, teamName: teams.find((t) => t.id === u.teamId)?.name ?? null, managerId: u.managerId, managerName: name(u.managerId), ...rowOf(u) })),
  };
}

export type TeamOverview = ReturnType<typeof buildTeamOverview>;

/* ---------------- Wire shapes of the parts each side gathers itself (instants are ISO strings) ---------------- */

export interface DashActivity {
  id: Id;
  taskId: Id;
  kind: string;
  body: string | null;
  before?: unknown;
  after?: unknown;
  at: string;
  actor: { id: Id; name: string } | null;
}

export interface DashboardExtras {
  activity: DashActivity[];
  /** Staff: decided reviews of my submissions, and others' comments on my tasks. */
  feedback?: { id: Id; taskId: Id; decision: string; comment: string | null; at: string }[];
  comments?: { id: Id; taskId: Id; body: string; at: string; author: { id: Id; name: string } }[];
  /** Executive. */
  staff?: { active: number; inactive: number; noManager: number };
  staffByRole?: Record<string, number>;
  orgMini?: { id: string; name: string; head: string | null; teams: { id: Id; name: string; members: number; lead: string | null; leadWithoutManager: boolean }[] }[];
  recentAdmin?: { id: Id; at: string; actor: { id: Id; name: string } | null; action: string; next: unknown }[];
  range: Range;
  entity: string | null;
  scopeLabel: string;
  canCreate: boolean;
  overloadThreshold: number;
  entityOptions: { id: string; name: string }[];
  l3Banner: { taskCount: number; unacked: number; tasks: { id: Id; title: string; assignee: string; reason: string; since: string; acknowledged: boolean }[] } | null;
  /** PERF-07; null where scores do not exist (the prototype). */
  me: { score: { score: number | null; outcome: number | null; timeliness: number | null; quality: number | null; ranked: boolean }; openProgress: number | null; measuredOpen: number; loadPercent: number; band: string } | null;
}

export type DashboardPayload = Dashboard & DashboardExtras;
