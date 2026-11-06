// DASH-01…03 and PERF-07: the role dashboard and the team overview, computed on the server over the viewer's scope.
// Metrics are the shared rules (shared/insights.ts, ADR-0007); this file only gathers scoped data and names people.
import { buildDashboard, buildTeamOverview, layoutFor, type DashPerson, type Range } from '@taskwatch/shared/insights';
import { isCoS, isFoundersOffice } from '@taskwatch/shared/permissions';
import { taskProgress } from '@taskwatch/shared/performance';
import * as clock from '../clock.js';
import { pool } from '../db/pool.js';
import { openSql, ROLES } from '../domain.js';
import { forbidden, invalid } from '../http/errors.js';
import { can } from './access.js';
import { presentKind, presentValues } from './activity.js';
import { listAudit } from './auditView.js';
import type { Directory, DirUser } from './directory.js';
import { personBreakdown, workloadFor } from './performance.js';
import { dashboardTasks } from './queries.js';
import { getSettings } from './settings.js';

const DAY = 86_400_000;
const person = (u: DirUser): DashPerson => ({ id: u.id, name: u.name, title: u.title ?? '', active: u.active });
/** The highest-ranked role, for "staff by role" (D-8). */
const primaryRole = (u: DirUser) => ROLES.find((r) => u.roles.includes(r))!;

/** Activity rows on these tasks, newest first, with the actor's name only. */
async function activityOn(taskIds: number[], limit: number) {
  const { rows } = await pool.query(
    `select l.id, l.task_id, l.kind, l.body, l.before, l.after, l.at, l.actor_id, u.name as actor_name
       from activity_log l left join users u on u.id = l.actor_id
      where l.task_id = any($1) order by l.at desc, l.id desc limit ${limit}`,
    [taskIds],
  );
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, kind: presentKind(r.kind), body: r.body, before: presentValues(r.before), after: presentValues(r.after), at: r.at, actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null }));
}

/** WO "L3 … top of dashboard": unresolved L3 events that name this Founder's Office member as a recipient. */
async function l3Banner(viewer: DirUser) {
  const { rows } = await pool.query(
    `select distinct on (e.task_id) e.task_id, e.reason, e.fired_at, e.acknowledged_at, t.title, a.name as assignee
       from escalations e
       join escalation_recipients er on er.escalation_id = e.id and er.user_id = $1
       join tasks t on t.id = e.task_id join users a on a.id = t.assignee_id
      where e.level = 3 and e.cleared_at is null and t.organization_id = $2
      order by e.task_id, e.fired_at`,
    [viewer.id, viewer.organizationId],
  );
  if (!rows.length) return null;
  rows.sort((a, b) => a.fired_at - b.fired_at);
  return {
    taskCount: rows.length,
    unacked: rows.filter((r) => !r.acknowledged_at).length,
    tasks: rows.slice(0, 3).map((r) => ({ id: r.task_id, title: r.title, assignee: r.assignee, reason: r.reason, since: r.fired_at, acknowledged: r.acknowledged_at !== null })),
  };
}

/** PERF-07: the viewer's own score this month, progress of open measured tasks, and load. */
async function myPerformance(viewer: DirUser, dir: Directory) {
  const [breakdown, load, open] = await Promise.all([
    personBreakdown(viewer, dir, viewer.id, { period: 'month' }),
    workloadFor(viewer.organizationId, dir, [viewer.id]),
    pool.query(`select status, target, achieved, progress from tasks t where t.assignee_id = $1 and t.target is not null and ${openSql('t')}`, [viewer.id]),
  ]);
  const progress = open.rows.map((r) => taskProgress(r)).filter((p): p is number => p !== null);
  const w = load.get(viewer.id)!;
  return {
    score: breakdown.score,
    from: breakdown.from,
    to: breakdown.to,
    openProgress: progress.length ? Math.round(progress.reduce((s, p) => s + p, 0) / progress.length) : null,
    measuredOpen: progress.length,
    loadPercent: Math.round(w.loadPercent),
    band: w.band,
  };
}

export async function roleDashboard(viewer: DirUser, dir: Directory, q: { range: Range; entity?: string }) {
  const orgWide = isFoundersOffice(viewer);
  if (q.entity && !orgWide) throw forbidden("You don't have permission to filter by entity.");
  const [settings, ents, tms] = await Promise.all([
    getSettings(viewer.organizationId),
    pool.query('select id, name, head_id from entities where organization_id = $1 order by sort, name', [viewer.organizationId]),
    pool.query('select id, name, entity_id, lead_id from teams where organization_id = $1 and archived_at is null order by name', [viewer.organizationId]),
  ]);
  if (q.entity && !ents.rows.some((e) => e.id === q.entity)) throw invalid({ entity: 'Choose an entity from the list.' });

  const now = clock.now().getTime();
  const layout = layoutFor(viewer.roles);
  const { tasks, extensions } = await dashboardTasks(viewer, dir, q.entity);
  const ids = tasks.map((t) => t.id as number);
  const [events, progress] = await Promise.all([
    pool.query('select task_id, level, fired_at, acknowledged_at from escalations where task_id = any($1)', [ids]),
    pool.query(`select at from activity_log where task_id = any($1) and kind in ('progress', 'update') and at >= $2`, [ids, new Date(now - 28 * DAY)]),
  ]);
  const inEntity = (entityId: string) => !q.entity || entityId === q.entity;
  const staff = orgWide ? dir.all().filter((u) => inEntity(u.entityId)) : [];
  const reports = [...dir.descendants(viewer.id)].map((id) => dir.must(id));
  const teams = tms.rows.filter((t) => inEntity(t.entity_id));

  const payload = buildDashboard({
    layout,
    now,
    range: q.range,
    zone: viewer.timeZone,
    viewerId: viewer.id,
    overloadThreshold: settings.overloadThreshold,
    scope: tasks,
    extensions,
    events: events.rows.map((e) => ({ taskId: e.task_id, level: e.level, at: e.fired_at.getTime(), ackAt: e.acknowledged_at?.getTime() ?? null })),
    progressAt: progress.rows.map((r) => r.at.getTime()),
    people: (orgWide ? staff.filter((u) => u.id !== viewer.id) : reports).map(person),
    teams: teams.map((t) => ({ id: t.id, name: t.name, entityId: t.entity_id })),
    entities: ents.rows.filter((e) => inEntity(e.id)).map((e) => ({ id: e.id, name: e.name })),
  });

  const extra: Record<string, unknown> = {};
  if (layout === 'staff') {
    const mine = tasks.filter((t) => t.assigneeId === viewer.id).map((t) => t.id as number);
    const [feedback, comments, timeline] = await Promise.all([
      pool.query(
        `select id, task_id, decision, comment, decided_at from reviews where submitted_by = $1 and decided_at is not null order by decided_at desc limit 3`,
        [viewer.id],
      ),
      pool.query(
        `select c.id, c.task_id, left(c.body, 200) as body, c.created_at, c.author_id, u.name as author
           from comments c join tasks t on t.id = c.task_id join users u on u.id = c.author_id
          where t.assignee_id = $1 and c.author_id <> $1 and c.deleted_at is null order by c.created_at desc limit 3`,
        [viewer.id],
      ),
      activityOn(mine, 6),
    ]);
    extra.feedback = feedback.rows.map((r) => ({ id: r.id, taskId: r.task_id, decision: r.decision, comment: r.comment, at: r.decided_at }));
    extra.comments = comments.rows.map((r) => ({ id: r.id, taskId: r.task_id, body: r.body, at: r.created_at, author: { id: r.author_id, name: r.author } }));
    extra.activity = timeline;
  } else extra.activity = await activityOn(ids, 8);

  if (layout === 'executive') {
    const active = staff.filter((u) => u.active);
    const name = (id: number | null) => (id ? (dir.get(id)?.name ?? null) : null);
    extra.staff = { active: active.length, inactive: staff.length - active.length, noManager: staff.filter((u) => u.managerId === null && !isCoS(u)).length };
    extra.staffByRole = Object.fromEntries(ROLES.map((r) => [r, active.filter((u) => primaryRole(u) === r).length]));
    extra.orgMini = ents.rows
      .filter((e) => inEntity(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        head: name(e.head_id),
        teams: teams
          .filter((t) => t.entity_id === e.id)
          .map((t) => ({
            id: t.id,
            name: t.name,
            members: active.filter((u) => u.teamId === t.id && u.id !== viewer.id).length,
            lead: name(t.lead_id),
            leadWithoutManager: t.lead_id ? dir.get(t.lead_id)?.managerId === null : false,
          })),
      }));
    extra.recentAdmin = can(viewer, dir, 'view_audit_logs') ? (await listAudit(viewer, { source: 'ui' })).items.slice(0, 6) : [];
  }

  return {
    ...payload,
    ...extra,
    range: q.range,
    entity: q.entity ?? null,
    scopeLabel: orgWide ? `${settings.orgName} · organization-wide` : layout === 'staff' ? 'Your assigned work' : `Your reporting line · ${reports.length} people`,
    canCreate: can(viewer, dir, 'create_tasks'),
    overloadThreshold: settings.overloadThreshold,
    entityOptions: orgWide ? ents.rows.map((e) => ({ id: e.id, name: e.name })) : [],
    l3Banner: orgWide ? await l3Banner(viewer) : null, // DASH-01-AC-6: Founder's Office only, never a cc'd manager
    me: await myPerformance(viewer, dir),
  };
}

/** DASH-02: the reporting-line summary. CoS/CEO: everyone but themselves; others: their transitive reports. */
export async function teamOverview(viewer: DirUser, dir: Directory) {
  const orgWide = isFoundersOffice(viewer);
  const people = orgWide ? dir.all().filter((u) => u.id !== viewer.id) : [...dir.descendants(viewer.id)].map((id) => dir.must(id));
  if (!can(viewer, dir, 'view_tasks') || (!orgWide && !people.length)) throw forbidden("You don't have permission to view your team.");
  const [{ tasks }, { rows: teams }] = await Promise.all([
    dashboardTasks(viewer, dir),
    pool.query('select id, name from teams where organization_id = $1 and archived_at is null order by name', [viewer.organizationId]),
  ]);
  const nameOf = (id: number | string) => dir.get(id as number)?.name ?? null;
  return buildTeamOverview(viewer.id, people.map((u) => ({ ...person(u), roles: u.roles, teamId: u.teamId, managerId: u.managerId })), tasks, teams, nameOf);
}
