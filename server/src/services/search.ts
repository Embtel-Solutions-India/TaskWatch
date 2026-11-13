// SRCH-01: one search over tasks, people and teams, limited to what the caller may see. Names and titles only:
// email is matched but never returned (SEC-9).
import { canViewUser, labelDepartments } from '@taskwatch/shared/permissions';
import { pool } from '../db/pool.js';
import { taskStage } from '../domain.js';
import { can, visibilityFilter } from './access.js';
import type { Directory, DirUser } from './directory.js';

const contains = (s: string | null | undefined, q: string) => !!s && s.toLowerCase().includes(q);

export async function search(viewer: DirUser, dir: Directory, raw: string) {
  const q = raw.trim();
  if (!q) return { tasks: [], people: [], teams: [] };
  const lower = q.toLowerCase();
  const exactId = /^(?:tw-)?(\d{1,9})$/i.exec(q)?.[1];

  const vis = visibilityFilter(viewer, dir, 't', 1);
  const escaped = q.replace(/[\\%_]/g, '\\$&'); // SRCH-01-AC-4: wildcards match themselves
  const params: unknown[] = [...vis.params, `%${escaped}%`, `${escaped}%`, exactId ? Number(exactId) : null];
  const [like, prefix, id] = [params.length - 2, params.length - 1, params.length].map((n) => `$${n}`);
  const { rows } = await pool.query(
    `select t.id, t.title, t.status, t.level, t.assignee_id, a.name as assignee, t.assigner_id, g.name as giver, t.team_id, tm.name as team
       from tasks t join users a on a.id = t.assignee_id join users g on g.id = t.assigner_id left join teams tm on tm.id = t.team_id
      where ${vis.sql}
        and (t.id = ${id} or t.title ilike ${like} or a.name ilike ${like} or g.name ilike ${like} or tm.name ilike ${like})
      order by (t.id = ${id}) is true desc, t.title ilike ${prefix} desc, t.created_at desc
      limit 8`,
    params,
  );
  // Ranking (FRD): exact id, then title prefix, then the rest by recency.
  const tasks = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      level: r.level,
      stage: taskStage(r.status, r.level),
      assignee: { id: r.assignee_id, name: r.assignee },
      giver: { id: r.assigner_id, name: r.giver },
      team: r.team_id ? { id: r.team_id, name: r.team } : null,
    }));

  const visiblePeople = dir.all().filter((u) => canViewUser(dir.org, viewer, u));
  const people = visiblePeople
    .filter((u) => contains(u.name, lower) || contains(u.email, lower) || contains(u.title, lower))
    .slice(0, 6)
    .map((u) => ({ id: u.id, name: u.name, title: u.title, roles: u.roles, active: u.active }));

  // Teams only for those who can open the team task list (route gate `supervises`).
  const supervises = can(viewer, dir, 'view_tasks') && (viewer.roles.includes('cos') || dir.descendants(viewer.id).size > 0);
  let teams: { id: number; name: string }[] = [];
  if (supervises) {
    const teamIds = [...new Set(visiblePeople.map((u) => u.teamId).filter((t): t is number => t !== null))];
    const res = await pool.query(
      `select id, name, entity_id from teams where organization_id = $1 and id = any($2) and name ilike $3 order by name limit 6`,
      [viewer.organizationId, teamIds, `%${escaped}%`],
    );
    teams = labelDepartments(res.rows as { id: number; name: string; entity_id: string }[], (t) => t.entity_id).map((t) => ({ id: t.id, name: t.name }));
  }
  return { tasks, people, teams };
}
