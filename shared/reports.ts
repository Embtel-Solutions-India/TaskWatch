// The nine accountability reports (RPT-02, REPORTS-FRD) and their CSV columns (RPT-03) — the one implementation used
// by the server and the mock (ADR-0007, D-9). Pure. Instants are epoch ms in, ISO strings out; date filters and week
// buckets use the viewer's zone (D-5). Callers pass only tasks in report scope (RPT-01) and names, never contacts.
import { brief, isOpenNow, PRIORITIES, type DashTask, type Id, type Priority } from '@taskwatch/shared/insights';
import { wallClock, zonedInstant } from '@taskwatch/shared/levels';
import { ACTIVE_STATUSES, type Status } from '@taskwatch/shared/workflow';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const REPORT_IDS = ['completion', 'overdue', 'escalations', 'accountability', 'teams', 'assignments', 'compliance', 'reviews', 'extensions'] as const;
export type ReportId = (typeof REPORT_IDS)[number];
export const isReportId = (id: string): id is ReportId => (REPORT_IDS as readonly string[]).includes(id);

/** Statuses a report can filter on and count (drafts are never reported). */
export const REPORT_STATUSES: readonly Status[] = ['assigned', 'in_progress', 'blocked', 'submitted', 'changes_requested', 'reopened', 'completed', 'cancelled'];

export interface ReportFilters {
  /** YYYY-MM-DD in the viewer's zone; empty = unbounded. */
  from: string;
  to: string;
  teamId: string;
  userId: string;
  giverId: string;
  priority: Priority | '';
  status: Status | '';
  /** 'none' = on track (level < 0), '0'…'3', or empty. */
  level: string;
}

export interface ReportPerson {
  id: Id;
  name: string;
  team: string;
  role: string;
}

export interface ReportInput {
  now: number;
  zone: string;
  scope: 'org' | 'team';
  /** Non-draft tasks in report scope. */
  tasks: DashTask[];
  /** Every escalation event on those tasks. */
  events: { taskId: Id; level: number; at: number; resolved: boolean }[];
  /** Decided reviews on those tasks. */
  reviews: { taskId: Id; round: number; reviewer: string; decision: string; submittedAt: number; decidedAt: number }[];
  extensions: { id: Id; taskId: Id; taskTitle: string; requester: string; decider: string | null; currentDue: number; requestedDue: number; at: number; reason: string; status: string }[];
  /** One task id per assignment record that has a previous assignee. */
  reassignments: Id[];
  teams: { id: Id; name: string }[];
  /** Assignees and givers of those tasks. */
  people: ReportPerson[];
}

/** Epoch-ms bounds of a YYYY-MM-DD range in `zone`: from 00:00 to 23:59:59.999. */
export function rangeBounds(f: Pick<ReportFilters, 'from' | 'to'>, zone: string): { fromMs: number; toMs: number } {
  const at = (d: string, plus: number) => {
    const [y, m, day] = d.split('-').map(Number);
    return zonedInstant(zone, y!, m!, day! + plus, 0, 0);
  };
  return { fromMs: f.from ? at(f.from, 0) : 0, toMs: f.to ? at(f.to, 1) - 1 : Infinity };
}

const iso = (t: number) => new Date(t).toISOString();
const same = (a: Id | null, b: string) => a !== null && String(a) === b;
const rate = (n: number, d: number) => (d ? n / d : null);
const onTime = (done: DashTask[]) => rate(done.filter((t) => t.completedAt! <= t.dueAt).length, done.length);

/** RPT-02: one payload for every report. Metric definitions: REPORTS-FRD RPT-02 table. */
export function buildReport(i: ReportInput, f: ReportFilters) {
  const { fromMs, toMs } = rangeBounds(f, i.zone);
  const inRange = (t: number) => t >= fromMs && t <= toMs;
  const person = new Map(i.people.map((p) => [String(p.id), p]));
  const name = (id: Id) => person.get(String(id))?.name ?? '—';

  const views = i.tasks.filter(
    (t) =>
      (!f.teamId || same(t.teamId, f.teamId)) &&
      (!f.userId || same(t.assigneeId, f.userId)) &&
      (!f.giverId || same(t.assignedBy, f.giverId)) &&
      (!f.priority || t.priority === f.priority) &&
      (!f.status || t.status === f.status) &&
      (!f.level || (f.level === 'none' ? t.level < 0 : t.level === Number(f.level))),
  );
  const byId = new Map(views.map((t) => [String(t.id), t]));
  const hist = views.filter((t) => inRange(t.createdAt));
  const open = views.filter(isOpenNow);
  const running = open.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const completed = hist.filter((t) => t.status === 'completed' && t.completedAt !== null);
  const events = i.events.filter((e) => byId.has(String(e.taskId)) && inRange(e.at));
  const l1 = events.filter((e) => e.level >= 1);
  const compliance = (ts: DashTask[]) => rate(ts.filter((t) => t.silenceLevel < 0).length, ts.length);

  // Weekly buckets from `from` (or 8 weeks back) to min(to, now), over all matching tasks.
  const endMs = Math.min(toMs, i.now);
  const label = new Intl.DateTimeFormat('en-US', { timeZone: i.zone, month: 'short', day: 'numeric' });
  const weeks: { label: string; created: number; completed: number }[] = [];
  for (let w = fromMs || endMs - 8 * 7 * DAY; w <= endMs; w += 7 * DAY) {
    const e = w + 7 * DAY;
    weeks.push({
      label: label.format(w),
      created: views.filter((t) => t.createdAt >= w && t.createdAt < e).length,
      completed: views.filter((t) => t.completedAt !== null && t.completedAt >= w && t.completedAt < e).length,
    });
  }

  const staffRows = [...new Set(views.map((t) => String(t.assigneeId)))]
    .map((id) => {
      const mine = (ts: DashTask[]) => ts.filter((t) => String(t.assigneeId) === id);
      const done = mine(completed);
      const openNow = mine(open);
      return {
        id: person.get(id)?.id ?? id,
        name: name(id),
        team: person.get(id)?.team ?? '—',
        assigned: mine(hist).length,
        completed: done.length,
        onTimeRate: onTime(done),
        openNow: openNow.length,
        overdueNow: openNow.filter((t) => t.overdue).length,
        compliance: compliance(mine(running)),
        escalations: l1.filter((e) => String(byId.get(String(e.taskId))!.assigneeId) === id).length,
      };
    })
    .sort((a, b) => b.openNow - a.openNow);

  const teamRows = i.teams
    .map((tm) => {
      const of = (ts: DashTask[]) => ts.filter((t) => same(t.teamId, String(tm.id)));
      const created = of(hist);
      const done = of(completed);
      const openNow = of(open);
      return {
        id: tm.id,
        name: tm.name,
        assigned: created.length,
        completed: done.length,
        completionRate: rate(done.length, created.length),
        onTimeRate: onTime(done),
        openNow: openNow.length,
        overdueNow: openNow.filter((t) => t.overdue).length,
        escalations: l1.filter((e) => same(byId.get(String(e.taskId))!.teamId, String(tm.id))).length,
      };
    })
    .filter((r) => r.assigned || r.openNow);

  const giverRows = [...new Set(hist.map((t) => String(t.assignedBy)))].map((id) => {
    const g = hist.filter((t) => String(t.assignedBy) === id);
    const ids = new Set(g.map((t) => String(t.id)));
    return {
      id: person.get(id)?.id ?? id,
      name: name(id),
      role: person.get(id)?.role ?? '—',
      assigned: g.length,
      open: g.filter(isOpenNow).length,
      completed: g.filter((t) => t.status === 'completed').length,
      overdue: g.filter((t) => t.overdue).length,
      reassigned: i.reassignments.filter((tid) => ids.has(String(tid))).length,
    };
  });

  const turnaround = i.reviews
    .filter((r) => byId.has(String(r.taskId)) && inRange(r.submittedAt))
    .map((r) => ({ taskId: r.taskId, round: r.round, reviewer: r.reviewer, decision: r.decision, hours: (r.decidedAt - r.submittedAt) / HOUR, submittedAt: iso(r.submittedAt) }));
  const reviewers = [...new Set(turnaround.map((r) => r.reviewer))].map((n) => {
    const rs = turnaround.filter((r) => r.reviewer === n);
    return { reviewer: n, reviews: rs.length, avgHours: rs.reduce((s, r) => s + r.hours, 0) / rs.length, changesRate: rs.filter((r) => r.decision !== 'approved').length / rs.length };
  });
  const extensions = i.extensions
    .filter((e) => byId.has(String(e.taskId)) && inRange(e.at))
    .map((e) => ({ ...e, decider: e.decider ?? '—', currentDue: iso(e.currentDue), requestedDue: iso(e.requestedDue), at: iso(e.at), days: (e.requestedDue - e.currentDue) / DAY }));

  return {
    scope: i.scope,
    summary: {
      created: hist.length,
      completed: completed.length,
      completionRate: rate(completed.length, hist.length),
      onTimeRate: onTime(completed),
      openNow: open.length,
      overdueNow: open.filter((t) => t.overdue).length,
      escalations: l1.length,
      compliance: compliance(running),
      avgReviewHours: turnaround.length ? turnaround.reduce((s, r) => s + r.hours, 0) / turnaround.length : null,
      extensions: extensions.length,
    },
    weeks,
    byStatus: REPORT_STATUSES.map((s) => ({ key: s, value: hist.filter((t) => t.status === s).length })),
    byPriority: PRIORITIES.map((p) => ({
      key: p,
      value: hist.filter((t) => t.priority === p).length,
      open: open.filter((t) => t.priority === p).length,
      overdue: open.filter((t) => t.priority === p && t.overdue).length,
    })),
    overdueByTeam: i.teams.map((tm) => ({ key: tm.name, value: open.filter((t) => same(t.teamId, String(tm.id)) && t.overdue).length })).filter((x) => x.value || !f.teamId),
    escalationsByLevel: [0, 1, 2, 3].map((l) => ({
      key: l,
      value: events.filter((e) => e.level === l).length,
      active: i.events.filter((e) => byId.has(String(e.taskId)) && e.level === l && !e.resolved).length,
    })),
    staffRows,
    teamRows,
    giverRows,
    reviewers,
    turnaround,
    extensions,
    overdue: open
      .filter((t) => t.overdue)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map(brief),
  };
}

export type Report = ReturnType<typeof buildReport>;

/** A date-time cell in the viewer's zone, `YYYY-MM-DD HH:mm`. */
function cellTime(isoAt: string, zone: string): string {
  const w = wallClock(zone, Date.parse(isoAt));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

/** RPT-03: the CSV rows (header first) of one report. Callers apply the formula guard when writing the file. */
export function reportCsv(id: ReportId, r: Report, zone: string): (string | number | null)[][] {
  const t = (x: string) => cellTime(x, zone);
  switch (id) {
    case 'completion':
      return [['Team', 'Created', 'Completed', 'Completion rate', 'On-time rate'], ...r.teamRows.map((x) => [x.name, x.assigned, x.completed, x.completionRate, x.onTimeRate])];
    case 'overdue':
      return [['Task', 'Title', 'Assignee', 'Priority', 'Due', 'Level'], ...r.overdue.map((x) => [x.id, x.title, x.assignee.name, x.priority, t(x.dueAt), x.level])];
    case 'escalations':
      return [['Level', 'Triggered in range', 'Open now'], ...r.escalationsByLevel.map((x) => [`L${x.key}`, x.value, x.active])];
    case 'accountability':
      return [
        ['Staff', 'Team', 'Assigned', 'Completed', 'On-time rate', 'Update compliance', 'Open now', 'Overdue now', 'L1+ escalations'],
        ...r.staffRows.map((x) => [x.name, x.team, x.assigned, x.completed, x.onTimeRate, x.compliance, x.openNow, x.overdueNow, x.escalations]),
      ];
    case 'teams':
      return [
        ['Team', 'Created', 'Completed', 'Completion', 'On-time', 'Open now', 'Overdue now', 'Escalations'],
        ...r.teamRows.map((x) => [x.name, x.assigned, x.completed, x.completionRate, x.onTimeRate, x.openNow, x.overdueNow, x.escalations]),
      ];
    case 'assignments':
      return [['Task giver', 'Role', 'Assigned', 'Open', 'Completed', 'Overdue', 'Reassignments'], ...r.giverRows.map((x) => [x.name, x.role, x.assigned, x.open, x.completed, x.overdue, x.reassigned])];
    case 'compliance':
      return [['Staff', 'Active tasks', 'Compliance'], ...r.staffRows.map((x) => [x.name, x.openNow, x.compliance])];
    case 'reviews':
      return [['Task', 'Round', 'Reviewer', 'Decision', 'Hours', 'Submitted'], ...r.turnaround.map((x) => [x.taskId, x.round, x.reviewer, x.decision, x.hours.toFixed(2), t(x.submittedAt)])];
    case 'extensions':
      return [
        ['Task', 'Requested by', 'Current due', 'Requested due', 'Days', 'Reason', 'Status', 'Decided by'],
        ...r.extensions.map((x) => [x.taskId, x.requester, t(x.currentDue), t(x.requestedDue), x.days.toFixed(1), x.reason, x.status, x.decider]),
      ];
  }
}
