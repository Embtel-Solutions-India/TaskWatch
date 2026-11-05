import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { pool } from '../db/pool.js';
import { openSql } from '../domain.js';
import { scopeIds, visibilityFilter } from './access.js';
import type { Directory, DirUser } from './directory.js';
import { isFounderOffice } from './directory.js';

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
  const now = clock.now();
  const from = new Date(now.getTime() - days * 24 * HOUR);
  const vis = visibilityFilter(viewer, dir, 't', 1);

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
    .filter((r) => isFounderOffice(viewer) || r.open > 0);

  const people = isFounderOffice(viewer) ? dir.all().map((u) => u.id) : scopeIds(viewer, dir);
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

  const scope = isFounderOffice(viewer) ? 'All entities' : `${viewer.name} and their team`;
  return { generatedAt: now, from, days, scope, byEntity, byPerson };
}
