import { ROLE_LABEL, ROLES } from '@taskwatch/shared/permissions';
import { buildReport, type ReportFilters } from '@taskwatch/shared/reports';
import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { pool } from '../db/pool.js';
import { openSql } from '../domain.js';
import { forbidden, invalid } from '../http/errors.js';
import { can, scopeIds, visibilityFilter } from './access.js';
import type { Directory, DirUser } from './directory.js';
import { dashboardTasks } from './queries.js';

export type ReportScope = 'org' | 'team';

/** RPT-01: org with view_org_reports, else team with view_team_reports, else 403 (every /api/reports* endpoint). */
export function reportScope(viewer: DirUser, dir: Directory): ReportScope {
  if (can(viewer, dir, 'view_org_reports')) return 'org';
  if (can(viewer, dir, 'view_team_reports')) return 'team';
  throw forbidden('You do not have access to reports.');
}

const teamsOf = (organizationId: number) =>
  pool.query<{ id: number; name: string; entity_id: string }>('select id, name, entity_id from teams where organization_id = $1 and archived_at is null order by name', [organizationId]);

/** RPT-04: filter options inside the report scope. Names and ids only (SEC-9). */
export async function reportOptions(viewer: DirUser, dir: Directory) {
  const scope = reportScope(viewer, dir);
  const line = dir.descendants(viewer.id);
  const people = dir.all().filter((u) => u.active && (scope === 'org' || line.has(u.id)));
  const { rows } = await teamsOf(viewer.organizationId);
  const teamIds = new Set(people.map((u) => u.teamId));
  const givers = scope === 'org' ? people : [viewer, ...people];
  const brief = (u: DirUser) => ({ id: u.id, name: u.name });
  return {
    scope,
    teams: rows.filter((t) => scope === 'org' || teamIds.has(t.id)).map((t) => ({ id: t.id, name: t.name, entityId: t.entity_id })),
    people: people.map(brief),
    givers: givers.filter((u) => u.roles.some((r) => r !== 'staff')).map(brief),
  };
}

/** RPT-02: the nine-report payload over the RPT-01 scope (D-51: team scope = what the viewer may see). */
export async function report(viewer: DirUser, dir: Directory, f: ReportFilters) {
  const scope = reportScope(viewer, dir);
  const { rows: teams } = await teamsOf(viewer.organizationId);
  if (f.teamId && !teams.some((t) => String(t.id) === f.teamId)) throw invalid({ teamId: 'Choose a team from the list.' });
  if (f.userId && !dir.get(Number(f.userId))) throw invalid({ userId: 'Choose a person from the list.' });
  if (f.giverId && !dir.get(Number(f.giverId))) throw invalid({ giverId: 'Choose a person from the list.' });

  const { tasks } = await dashboardTasks(viewer, dir, undefined, scope === 'org');
  const ids = tasks.map((t) => t.id as number);
  const [events, reviews, exts, reassigned] = await Promise.all([
    pool.query('select task_id, level, fired_at, cleared_at from escalations where task_id = any($1)', [ids]),
    pool.query(
      `select r.task_id, r.round, u.name as reviewer, r.decision, r.submitted_at, r.decided_at
         from reviews r left join users u on u.id = r.reviewer_id where r.task_id = any($1) and r.decided_at is not null order by r.submitted_at`,
      [ids],
    ),
    pool.query(
      `select x.id, x.task_id, t.title, q.name as requester, d.name as decider, x.current_due, x.requested_due, x.requested_at, x.reason, x.status
         from extensions x join tasks t on t.id = x.task_id join users q on q.id = x.requested_by left join users d on d.id = x.decided_by
        where x.task_id = any($1) order by x.requested_at`,
      [ids],
    ),
    pool.query(`select task_id from activity_log where kind = 'reassign' and task_id = any($1)`, [ids]),
  ]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const peopleIds = new Set(tasks.flatMap((t) => [t.assigneeId as number, t.assignedBy as number]));
  const people = [...peopleIds].flatMap((id) => {
    const u = dir.get(id);
    return u ? [{ id, name: u.name, team: (u.teamId && teamName.get(u.teamId)) || '—', role: ROLE_LABEL[ROLES.find((r) => u.roles.includes(r))!] }] : [];
  });
  return buildReport(
    {
      now: clock.now().getTime(),
      zone: viewer.timeZone,
      scope,
      tasks,
      events: events.rows.map((e) => ({ taskId: e.task_id, level: e.level, at: e.fired_at.getTime(), resolved: e.cleared_at !== null })),
      reviews: reviews.rows.map((r) => ({ taskId: r.task_id, round: r.round, reviewer: r.reviewer ?? '—', decision: r.decision, submittedAt: r.submitted_at.getTime(), decidedAt: r.decided_at.getTime() })),
      extensions: exts.rows.map((x) => ({
        id: x.id,
        taskId: x.task_id,
        taskTitle: x.title,
        requester: x.requester,
        decider: x.decider,
        currentDue: x.current_due.getTime(),
        requestedDue: x.requested_due.getTime(),
        at: x.requested_at.getTime(),
        reason: x.reason,
        status: x.status,
      })),
      reassignments: reassigned.rows.map((r) => r.task_id),
      teams: teams.map((t) => ({ id: t.id, name: t.name })),
      people,
    },
    f,
  );
}

export interface EntityRow {
  entityId: string;
  entityName: string;
  open: number;
  onTrack: number;
  amber: number;
  red: number;
  blocked: number;
  longestSilenceHours: number | null;
  longestSilenceTask: { id: number; title: string; assignee: string } | null;
}

export interface PersonRow {
  userId: number;
  name: string;
  entityId: string;
  title: string | null;
  open: number;
  avgFirstResponseHours: number | null;
  escalations: number;
  closed: number;
  onTime: number;
  onTimePct: number | null;
}

export interface Accountability {
  generatedAt: Date;
  from: Date;
  days: number;
  scope: string;
  byEntity: EntityRow[];
  byPerson: PersonRow[];
}

/** FR-11: accountability by entity and by person, limited to what the viewer may see. */
export async function accountability(viewer: DirUser, dir: Directory, days: number): Promise<Accountability> {
  const orgWide = reportScope(viewer, dir) === 'org';
  const now = clock.now();
  const from = new Date(now.getTime() - days * 24 * HOUR);
  const vis = orgWide ? { sql: 't.organization_id = $1', params: [viewer.organizationId] } : visibilityFilter(viewer, dir, 't', 1);

  const ent = await pool.query(
    `select en.id, en.name,
       count(t.id) filter (where ${openSql('t')}) as open,
       count(t.id) filter (where ${openSql('t')} and t.level < 0) as on_track,
       count(t.id) filter (where ${openSql('t')} and t.level between 0 and 1) as amber,
       count(t.id) filter (where ${openSql('t')} and t.level >= 2) as red,
       count(t.id) filter (where t.status = 'blocked') as blocked
     from entities en
     left join tasks t on t.entity_id = en.id and ${vis.sql}
     where en.organization_id = $${vis.params.length + 1}
     group by en.id, en.name, en.sort
     order by en.sort`,
    [...vis.params, viewer.organizationId],
  );
  const silent = await pool.query(
    `select distinct on (t.entity_id) t.entity_id, t.id, t.title, t.clock_started_at, a.name as assignee
       from tasks t join users a on a.id = t.assignee_id
      where ${openSql('t')} and ${vis.sql}
      order by t.entity_id, t.clock_started_at asc`,
    vis.params,
  );
  const silentBy = new Map(silent.rows.map((r) => [r.entity_id, r]));

  const byEntity: EntityRow[] = ent.rows
    .map((r) => {
      const s = silentBy.get(r.id);
      return {
        entityId: r.id,
        entityName: r.name,
        open: r.open,
        onTrack: r.on_track,
        amber: r.amber,
        red: r.red,
        blocked: r.blocked,
        longestSilenceHours: s ? (now.getTime() - s.clock_started_at.getTime()) / HOUR : null,
        longestSilenceTask: s ? { id: s.id, title: s.title, assignee: s.assignee } : null,
      };
    })
    .filter((r) => orgWide || r.open > 0);

  const people = orgWide ? dir.all().map((u) => u.id) : scopeIds(viewer, dir);
  const per = await pool.query(
    `select u.id, u.name, u.entity_id, u.title,
       (select count(*) from tasks t where t.assignee_id = u.id and ${openSql('t')}) as open,
       (select avg(extract(epoch from (s.first_update_at - s.assigned_at)) / 3600)
          from assignments s where s.assignee_id = u.id and s.assigned_at >= $2 and s.first_update_at is not null) as avg_first_h,
       (select count(*) from escalations e where e.assignee_id = u.id and e.level >= 1 and e.fired_at >= $2) as escalations,
       (select count(*) from tasks t where t.assignee_id = u.id and t.status = 'completed' and t.closed_at >= $2) as closed,
       (select count(*) from tasks t where t.assignee_id = u.id and t.status = 'completed' and t.closed_at >= $2 and t.closed_at <= t.due_at) as on_time
     from users u where u.id = any($1)
     order by u.name`,
    [people, from],
  );
  const byPerson: PersonRow[] = per.rows
    .filter((r) => r.open > 0 || r.closed > 0 || r.escalations > 0 || r.avg_first_h != null)
    .map((r) => ({
      userId: r.id,
      name: r.name,
      entityId: r.entity_id,
      title: r.title,
      open: r.open,
      avgFirstResponseHours: r.avg_first_h == null ? null : Number(r.avg_first_h),
      escalations: r.escalations,
      closed: r.closed,
      onTime: r.on_time,
      onTimePct: r.closed > 0 ? Math.round((r.on_time / r.closed) * 100) : null,
    }));

  const scope = orgWide ? 'All entities' : `${viewer.name} and their team`;
  return { generatedAt: now, from, days, scope, byEntity, byPerson };
}
