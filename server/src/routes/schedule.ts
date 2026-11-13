// ADR-0014 / US-01, US-04: one day's scheduled work, for a person or for everyone in the viewer's reporting line.
// Scope: oneself; anyone below in the reporting line; anyone with view_org_reports. Outside it: 404.
import { Router } from 'express';
import { zonedInstant } from '@taskwatch/shared/levels';
import { overlaps } from '@taskwatch/shared/schedule';
import { pool } from '../db/pool.js';
import { invalid, notFound } from '../http/errors.js';
import { me, requireUser } from '../http/middleware.js';
import { can } from '../services/access.js';

export const scheduleRouter = Router();
scheduleRouter.use(requireUser);

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** GET /api/schedule?date=YYYY-MM-DD[&userId=N | &team=1]: the day is read in each person's own zone. */
scheduleRouter.get('/schedule', async (req, res) => {
  const { user, dir } = me(req);
  const date = String(req.query.date ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw invalid({ date: 'Choose a date.' });
  const below = dir.descendants(user.id);
  let ids: number[];
  if (req.query.team) ids = [...below].filter((id) => dir.get(id)?.active);
  else if (req.query.userId) {
    const id = Number(req.query.userId);
    if (!(id === user.id || below.has(id) || can(user, dir, 'view_org_reports')) || !dir.get(id)) throw notFound('Person not found.');
    ids = [id];
  } else ids = [user.id];

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const roughFrom = new Date(Date.UTC(y, mo - 1, d) - DAY);
  const { rows } = await pool.query(
    `select t.id, t.title, t.priority, t.status, t.start_at, t.due_at, t.assignee_id,
            (select max(r.submitted_at) from reviews r where r.task_id = t.id) as submitted_at
       from tasks t
      where t.organization_id = $1 and t.assignee_id = any($2) and t.status not in ('draft', 'cancelled') and t.discarded_at is null
        and t.due_at > $3 and coalesce(t.start_at, t.due_at - interval '1 hour') < $4
      order by coalesce(t.start_at, t.due_at)`,
    [user.organizationId, ids, roughFrom, new Date(roughFrom.getTime() + 3 * DAY)],
  );
  const people = ids.map((id) => {
    const p = dir.must(id);
    const from = zonedInstant(p.timeZone, y, mo, d, 0, 0);
    const to = from + DAY;
    const mine = rows.filter((r) => r.assignee_id === id && (r.start_at?.getTime() ?? r.due_at.getTime() - HOUR) < to && r.due_at.getTime() > from);
    const clash = overlaps(mine.filter((r) => r.status !== 'completed').map((r) => ({ id: String(r.id), start: r.start_at?.getTime() ?? null, end: r.due_at.getTime() })));
    return {
      userId: id,
      name: p.name,
      timeZone: p.timeZone,
      tasks: mine.map((r) => ({
        id: r.id,
        title: r.title,
        priority: r.priority,
        status: r.status,
        startAt: r.start_at,
        dueAt: r.due_at,
        submittedAt: r.submitted_at,
        overlap: clash.has(String(r.id)),
      })),
    };
  });
  res.json({ date, people });
});
