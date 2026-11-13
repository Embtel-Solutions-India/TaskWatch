// PERF (PERFORMANCE-FRD §3, §5): team leaderboards, person breakdowns and workload, computed on the server from the
// shared formulas. Scope: one's own team for everyone; teams in one's reporting line with view_team_reports; every team
// in the organization with view_org_reports. A team or person outside that scope is reported as missing (404).
import {
  averageScore,
  baselineDue,
  isEligible,
  isOnTime,
  periodBounds,
  personScore,
  rankRows,
  taskOutcome,
  taskQuality,
  taskTimeliness,
  workload,
  type Priority,
  type ScoredTask,
} from '@taskwatch/shared/performance';
import { LADDER_STATUSES, type Status } from '@taskwatch/shared/workflow';
import { zonedInstant } from '@taskwatch/shared/levels';
import { labelDepartments } from '@taskwatch/shared/permissions';
import * as clock from '../clock.js';
import { pool } from '../db/pool.js';
import { invalid, notFound } from '../http/errors.js';
import { can } from './access.js';
import type { Directory, DirUser } from './directory.js';
import { getSettings } from './settings.js';

export type PeriodQuery = { period: 'week' | 'month' | 'custom'; from?: string; to?: string };

/** [from, to) in the organization's zone; custom dates are inclusive days. */
export async function resolvePeriod(organizationId: number, q: PeriodQuery): Promise<{ from: Date; to: Date; zone: string }> {
  const zone = (await getSettings(organizationId)).timezone;
  if (q.period !== 'custom') return { ...periodBounds(q.period, clock.now(), zone), zone };
  const day = (s: string | undefined, field: 'from' | 'to') => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
    if (!m) throw invalid({ [field]: 'Choose a date.' });
    return [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  };
  const [fy, fm, fd] = day(q.from, 'from');
  const [ty, tm, td] = day(q.to, 'to');
  const from = new Date(zonedInstant(zone, fy, fm, fd, 0, 0));
  const to = new Date(zonedInstant(zone, ty, tm, td, 0, 0) + 86_400_000); // end of the "to" day (approximate across DST)
  if (to <= from) throw invalid({ to: 'The end date must be on or after the start date.' });
  return { from, to, zone };
}

/** Team ids the viewer may see boards for. */
export function visibleTeamIds(viewer: DirUser, dir: Directory): Set<number> | 'all' {
  if (can(viewer, dir, 'view_org_reports')) return 'all';
  const out = new Set<number>();
  if (viewer.teamId !== null) out.add(viewer.teamId);
  if (can(viewer, dir, 'view_team_reports')) {
    for (const id of dir.descendants(viewer.id)) {
      const t = dir.get(id)?.teamId;
      if (t != null) out.add(t);
    }
  }
  return out;
}

/** GET /api/performance/teams: the boards the viewer may open, for the team picker. */
export async function visibleTeams(viewer: DirUser, dir: Directory) {
  const visible = visibleTeamIds(viewer, dir);
  const { rows } = await pool.query<{ id: number; name: string; entity_id: string }>(
    'select id, name, entity_id from teams where organization_id = $1 and archived_at is null order by name',
    [viewer.organizationId],
  );
  return labelDepartments(rows.filter((t) => visible === 'all' || visible.has(t.id)), (t) => t.entity_id).map((t) => ({ id: t.id, name: t.name }));
}

async function loadTeam(viewer: DirUser, dir: Directory, teamId: number) {
  const visible = visibleTeamIds(viewer, dir);
  if (visible !== 'all' && !visible.has(teamId)) throw notFound('Team not found.');
  const { rows } = await pool.query<{ id: number; name: string }>(
    'select id, name from teams where id = $1 and organization_id = $2 and archived_at is null',
    [teamId, viewer.organizationId],
  );
  if (!rows[0]) throw notFound('Team not found.');
  const members = dir.all().filter((u) => u.active && u.teamId === teamId);
  return { team: rows[0], members };
}

/** Scored, non-draft, non-cancelled tasks of these people due in [from, to), as the shared formulas take them. */
async function scoredTasks(organizationId: number, userIds: number[], from: Date, to: Date) {
  const { rows } = await pool.query(
    `select t.id, t.title, t.assignee_id, t.status, t.due_at, t.completed_at, t.target, t.achieved, t.outcome_score, t.quality_score,
            t.shortfall_accepted, t.scored, t.priority, t.estimated_hours,
            -- D-173: Quality comes from the review history, so "reviewed" = it went through review and was approved.
            t.review_required and exists (select 1 from reviews r where r.task_id = t.id and r.decision = 'approved') as reviewed,
            coalesce((select max(a.assigned_at) from assignments a where a.task_id = t.id and a.assignee_id = t.assignee_id), t.assigned_at) > t.due_at
              as reassigned_after_due,
            (select count(*)::int from reviews r where r.task_id = t.id and r.decision in ('changes_requested', 'rejected')) as rework,
            -- D-173 fairness: every deadline change in order; 'extension' = the assignee's own approved request.
            (select coalesce(json_agg(json_build_object('before', l.before->>'dueAt', 'after', l.after->>'dueAt', 'as', l.after->>'as') order by l.seq), '[]')
               from activity_log l where l.task_id = t.id and l.kind = 'due_change') as due_changes,
            (select r.submitted_at from reviews r where r.task_id = t.id and (r.decision = 'approved' or (r.decision is null and t.status = 'submitted'))
              order by r.round desc limit 1) as submitted_at
       from tasks t
      where t.organization_id = $1 and t.assignee_id = any($2) and t.scored and t.status not in ('draft', 'cancelled')
        and t.due_at >= $3 and t.due_at < $4`,
    [organizationId, userIds, from, to],
  );
  return rows.map((r) => {
    // Entries missing a date (hand-made history) are skipped; with no usable original the current due date stands.
    const changes = (r.due_changes as { before: string | null; after: string | null; as: string | null }[]).filter((c) => c.after);
    const baselineDueAt = changes.length && changes[0]!.before
      ? baselineDue(new Date(changes[0]!.before), changes.map((c) => ({ dueAt: new Date(c.after!), own: c.as === 'extension' })))
      : null;
    return {
    title: r.title as string,
    assigneeId: r.assignee_id as number,
    task: {
      id: r.id,
      status: r.status as Status,
      dueAt: r.due_at,
      completedAt: r.completed_at,
      target: r.target,
      achieved: r.achieved,
      outcomeScore: r.outcome_score,
      qualityScore: r.quality_score,
      reviewed: r.reviewed === true,
      shortfallAccepted: r.shortfall_accepted,
      reassignedAfterDue: r.reassigned_after_due === true,
      scored: r.scored,
      priority: r.priority as Priority,
      reworkCount: r.rework,
      submittedAt: r.submitted_at ?? null,
      estimatedHours: r.estimated_hours === null ? null : Number(r.estimated_hours),
      baselineDueAt,
    } satisfies ScoredTask,
    };
  });
}

/** GET /api/performance/leaderboard */
export async function leaderboard(viewer: DirUser, dir: Directory, teamId: number, q: PeriodQuery) {
  const { team, members } = await loadTeam(viewer, dir, teamId);
  const { from, to } = await resolvePeriod(viewer.organizationId, q);
  const rows = await scoredTasks(viewer.organizationId, members.map((m) => m.id), from, to);
  const now = clock.now();
  const weights = (await getSettings(viewer.organizationId)).priorityWeights; // D-124
  const scored = members.map((m) => {
    const s = personScore(rows.filter((r) => r.assigneeId === m.id).map((r) => r.task), from, to, now, weights);
    return { userId: m.id, name: m.name, ...s };
  });
  return { team, from, to, weights, rows: rankRows(scored) };
}

/** GET /api/performance/people/:id — the tasks behind a person's score, with why any is left out. */
export async function personBreakdown(viewer: DirUser, dir: Directory, personId: number, q: PeriodQuery) {
  const person = dir.get(personId);
  // Employees open only themselves; supervisors with team reports open people below them; org reports open anyone.
  const allowed =
    !!person &&
    (personId === viewer.id || can(viewer, dir, 'view_org_reports') || (can(viewer, dir, 'view_team_reports') && dir.descendants(viewer.id).has(personId)));
  if (!person || !allowed) throw notFound('Person not found.');
  const { from, to } = await resolvePeriod(viewer.organizationId, q);
  const now = clock.now();
  const rows = await scoredTasks(viewer.organizationId, [personId], from, to);
  const weights = (await getSettings(viewer.organizationId)).priorityWeights; // D-124
  const tasks = rows.map(({ title, task }) => {
    const outcome = taskOutcome(task, now);
    const excluded = !isEligible(task, from, to, now)
      ? 'not_due'
      : task.shortfallAccepted === true
        ? 'accepted'
        : outcome === null
          ? 'not_rated'
          : task.reassignedAfterDue
            ? 'reassigned_after_due'
            : !task.reviewed
              ? 'pending_review'
              : null;
    return {
      id: task.id,
      title,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
      outcome,
      onTime: isOnTime(task, now),
      timeliness: taskTimeliness(task, now),
      quality: taskQuality(task),
      reviewed: task.reviewed,
      reworkCount: task.reworkCount,
      weight: weights[task.priority],
      excluded,
    };
  });
  return { person: { id: person.id, name: person.name, teamId: person.teamId }, from, to, weights, score: personScore(rows.map((r) => r.task), from, to, now, weights), tasks };
}

/** Open load per person (FRD §5.8). */
export async function workloadFor(organizationId: number, dir: Directory, userIds: number[]) {
  const settings = await getSettings(organizationId);
  const { rows } = await pool.query(
    `select assignee_id, status, due_at, estimated_hours, priority from tasks
      where organization_id = $1 and assignee_id = any($2) and status = any($3)`,
    [organizationId, userIds, [...LADDER_STATUSES]],
  );
  const now = clock.now();
  return new Map(
    userIds.map((id) => [
      id,
      workload(
        rows.filter((r) => r.assignee_id === id).map((r) => ({ status: r.status as Status, dueAt: r.due_at, estimatedHours: r.estimated_hours, priority: r.priority as Priority })),
        { now, zone: dir.get(id)?.timeZone ?? settings.timezone, workdayStart: settings.workdayStart, workdayEnd: settings.workdayEnd },
      ),
    ]),
  );
}

/** GET /api/workload */
export async function teamWorkload(viewer: DirUser, dir: Directory, teamId: number) {
  const { team, members } = await loadTeam(viewer, dir, teamId);
  const load = await workloadFor(viewer.organizationId, dir, members.map((m) => m.id));
  return { team, rows: members.map((m) => ({ userId: m.id, name: m.name, ...load.get(m.id)! })) };
}


/**
 * GET /api/performance/analytics — the leaderboard's charts. `trend`: the team's average Outcome Score for each of the
 * 8 weeks ending with the period. `teams`: each team the viewer may see, with its average in the period; empty when the
 * viewer sees only one team (staff and leads compare within their own team, D-117).
 */
export async function analytics(viewer: DirUser, dir: Directory, teamId: number, q: PeriodQuery) {
  const { members } = await loadTeam(viewer, dir, teamId);
  const { from, to, zone } = await resolvePeriod(viewer.organizationId, q);
  const now = clock.now();
  const weights = (await getSettings(viewer.organizationId)).priorityWeights;
  // Review fix #7: rows grouped by person once, not re-filtered per person, per week and per team.
  const byPerson = (rows: Awaited<ReturnType<typeof scoredTasks>>) => {
    const m = new Map<number, ScoredTask[]>();
    for (const r of rows) m.set(r.assigneeId, [...(m.get(r.assigneeId) ?? []), r.task]);
    return m;
  };
  const teamScore = (grouped: Map<number, ScoredTask[]>, ids: number[], f: Date, t: Date) => averageScore(ids.map((id) => personScore(grouped.get(id) ?? [], f, t, now, weights).score));

  const weeks: { from: Date; to: Date }[] = [];
  for (let anchor = new Date(Math.min(to.getTime(), now.getTime()) - 1); weeks.length < 8; ) {
    const w = periodBounds('week', anchor, zone);
    weeks.unshift(w);
    anchor = new Date(w.from.getTime() - 1);
  }
  const ids = members.map((m) => m.id);
  const weekRows = byPerson(await scoredTasks(viewer.organizationId, ids, weeks[0]!.from, weeks.at(-1)!.to));
  const trend = weeks.map((w) => ({ from: w.from, to: w.to, ...teamScore(weekRows, ids, w.from, w.to) }));

  const teams = await visibleTeams(viewer, dir);
  if (teams.length < 2) return { trend, teams: [] };
  const byTeam = teams.map((t) => ({ t, ids: dir.all().filter((u) => u.active && u.teamId === t.id).map((u) => u.id) }));
  const rows = byPerson(await scoredTasks(viewer.organizationId, byTeam.flatMap((x) => x.ids), from, to));
  const compared = byTeam.map(({ t, ids: people }) => ({ id: t.id, name: t.name, people: people.length, ...teamScore(rows, people, from, to) }));
  compared.sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || a.name.localeCompare(b.name));
  return { trend, teams: compared };
}
