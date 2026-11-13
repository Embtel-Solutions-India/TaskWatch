// ADR-0015 attendance (D-156…D-158, D-161, D-163). A vertical's GM marks its members per day; the CoS does the same
// for the Founder's Office. GMs, the CoS and the CEO have no attendance. Marks never delete: clearing writes 'unmarked'.
import { wallClock, zonedInstant } from '@taskwatch/shared/levels';
import type pg from 'pg';
import { z } from 'zod';
import * as clock from '../clock.js';
import { pool, tx } from '../db/pool.js';
import { invalid, notFound } from '../http/errors.js';
import { inAppNotice } from '../notify/messages.js';
import { notify } from '../notify/notify.js';
import { appendAdmin } from './audit.js';
import { hasRole, type Directory, type DirUser } from './directory.js';
import { getRuleSet } from './rules.js';

export const STATUSES = ['present', 'absent', 'half_day', 'leave', 'unmarked'] as const;
export type AttendanceStatus = (typeof STATUSES)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A date that exists on the calendar (2026-02-31 does not). */
const realDate = (d: string) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const day = (error: string) => z.string().regex(DAY_RE, { error }).refine(realDate, { error: 'Choose a real date.' });
const MAX_DAYS = 62;
const DAY = 86_400_000;

export const markSchema = z
  .object({
    userIds: z.array(z.number().int()).min(1, { error: 'Choose at least one person.' }).max(200),
    from: day('Choose a date.'),
    to: day('Choose a date.'),
    status: z.enum(STATUSES, { error: 'Choose a status.' }),
    /** Half day (owner, 2026-11-13): away in the morning (start of work to lunch) or the afternoon (lunch to the end). */
    half: z.enum(['first', 'second'], { error: 'Choose morning or afternoon.' }).optional(),
    /** "Mark the unmarked present": never overwrite a day that already has a mark, even from a stale page (review I-2). */
    onlyUnmarked: z.boolean().optional(),
  })
  .strict();

/** Vertical id → its GM; the Founder's Office's GM is the CoS (D-161). */
async function headsOf(organizationId: number, db: pg.PoolClient | typeof pool = pool): Promise<Map<string, number>> {
  const { rows } = await db.query<{ id: string; head_id: number | null }>('select id, head_id from entities where organization_id = $1 and archived_at is null', [organizationId]);
  return new Map(rows.filter((r) => r.head_id !== null).map((r) => [r.id, r.head_id!]));
}

/** For /api/me: does this person have attendance (and a My attendance calendar)? */
export async function attendanceApplies(u: DirUser): Promise<boolean> {
  return hasAttendance(u, await headsOf(u.organizationId));
}

/** D-161: GMs, the CoS and the CEO have no attendance. */
export function hasAttendance(u: DirUser, heads: Map<string, number>): boolean {
  return u.active && !hasRole(u, 'cos', 'ceo') && ![...heads.values()].includes(u.id);
}

/** D-156 / D-161: the person's vertical's GM, or the CoS for the Founder's Office. */
function canMark(actor: DirUser, target: DirUser, heads: Map<string, number>): boolean {
  if (target.entityId === 'FO') return hasRole(actor, 'cos');
  return heads.get(target.entityId) === actor.id;
}

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const hhmmOf = (m: number) => (m === 1440 ? '24:00' : `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
/** The away range of a half day in this person's working hours: morning = start to lunch, afternoon = lunch to end. */
export function halfDayRange(work: DirUser['work'], half: 'first' | 'second'): [string, string] {
  const start = mins(work.start);
  let end = mins(work.end);
  if (end <= start) end += 1440; // overnight (or all day)
  const lunch = start + Math.round((end - start) / 2 / 5) * 5;
  return half === 'first' ? [hhmmOf(start), hhmmOf(lunch)] : [hhmmOf(lunch), hhmmOf(end > 1440 ? end - 1440 : end)];
}

/** "YYYY-MM-DD" of instant `t` in `zone`. */
export function dayIn(zone: string, t: number): string {
  const w = wallClock(zone, t);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** Every calendar day from `from` to `to`, inclusive. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** The instant `day` + `plusDays` shows `hhmm` in `zone` ('24:00' = the next midnight). */
const at = (zone: string, day: string, hhmm: string, plusDays = 0) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date(Date.parse(`${day}T00:00:00Z`) + (plusDays + (h === 24 ? 1 : 0)) * DAY);
  return zonedInstant(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h === 24 ? 0 : h, m);
};

/** Mark people for a range of today or past days (D-163). Returns the number of day rows written. */
export async function markAttendance(actor: DirUser, dir: Directory, input: z.infer<typeof markSchema>): Promise<{ updated: number }> {
  const heads = await headsOf(actor.organizationId);
  const now = clock.now();
  const targets = [...new Set(input.userIds)].map((id) => dir.get(id));
  if (targets.some((t) => !t)) throw notFound('Person not found.');
  if (targets.some((t) => !hasAttendance(t!, heads))) throw invalid({ userIds: 'General managers, the Chief of Staff and the CEO have no attendance.' });
  if (targets.some((t) => !canMark(actor, t!, heads))) throw notFound('Person not found.');
  if (input.from > input.to) throw invalid({ from: 'The start date must be on or before the end date.' });
  if (daysBetween(input.from, input.to).length > MAX_DAYS) throw invalid({ to: `Mark at most ${MAX_DAYS} days at a time.` });
  if (input.status === 'half_day' && !input.half) throw invalid({ half: 'Choose whether they were away in the morning or the afternoon.' });
  for (const t of targets) if (input.to > dayIn(t!.work.zone, now.getTime())) throw invalid({ day: 'Attendance can be marked for today and past days only.' });
  const half = input.status === 'half_day';
  let written = 0;
  await tx(async (c) => {
    for (const t of targets as DirUser[]) {
      const [awayFrom, awayTo] = half ? halfDayRange(t.work, input.half!) : [null, null];
      // A single day is marked as asked; a range covers the person's working days.
      const days = input.from === input.to ? [input.from] : daysBetween(input.from, input.to).filter((d) => t.work.days.includes(weekday(d)));
      for (const day of days) {
        const r = await c.query(
          `insert into attendance (organization_id, user_id, day, status, away_from, away_to, marked_by, marked_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (user_id, day) do update set status = excluded.status, away_from = excluded.away_from, away_to = excluded.away_to, marked_by = excluded.marked_by,
             -- Review I-1 (D-164): saving an away mark again keeps when the absence began; only a new absence starts now.
             marked_at = case when attendance.status in ('absent', 'leave', 'half_day') and excluded.status in ('absent', 'leave', 'half_day') then attendance.marked_at else excluded.marked_at end
           where not $9 or attendance.status = 'unmarked'`,
          [actor.organizationId, t.id, day, input.status, awayFrom, awayTo, actor.id, now, input.onlyUnmarked ?? false],
        );
        written += r.rowCount ?? 0;
      }
    }
    await appendAdmin(c, { actorId: actor.id, kind: 'attendance.marked', target: `users:${input.userIds.join(',')}`, targetType: 'user', after: { ...input } }, now);
    // The away notices are queued in the same transaction: the marks and their notices are saved together or not at
    // all, and the dispatcher delivers (and retries) them like every other notification.
    if (input.status === 'absent' || input.status === 'leave' || half) {
      for (const t of targets as DirUser[]) if (input.to === dayIn(t.work.zone, now.getTime())) await awayNotice(c, t, dir, heads, input, now);
    }
  });
  return { updated: written };
}

/**
 * D-158: someone marked away today has open tasks due soon. Their assignee, GM and giver hear once per task
 * (job_runs), so a senior can reassign or cancel. Half day: tasks due in the away range; otherwise until the end of
 * the next working day.
 */
async function awayNotice(c: pg.PoolClient, t: DirUser, dir: Directory, heads: Map<string, number>, input: z.infer<typeof markSchema>, now: Date) {
  const today = input.to;
  const zone = t.work.zone;
  let until: number;
  if (input.status === 'half_day') {
    const [from, to] = halfDayRange(t.work, input.half!);
    until = at(zone, today, to, to <= from ? 1 : 0);
  }
  else {
    let next = 1;
    while (next < 8 && !t.work.days.includes((weekday(today) + next) % 7)) next++;
    const crosses = t.work.end <= t.work.start;
    until = at(zone, today, t.work.end, next + (crosses ? 1 : 0));
  }
  const { rows } = await c.query<{ id: number; title: string; assigner_id: number | null; due_at: Date }>(
    `select id, title, assigner_id, due_at from tasks where assignee_id = $1 and status in ('assigned','in_progress','blocked','changes_requested','reopened') and due_at > $3 and due_at <= $2 order by due_at`,
    [t.id, new Date(until), now], // already overdue ones escalate to the same people anyway
  );
  if (!rows.length) return;
  const gm = t.entityId === 'FO' ? dir.all().find((u) => u.active && hasRole(u, 'cos'))?.id : heads.get(t.entityId);
  const rules = (await getRuleSet(t.organizationId, c)).for(t.entityId);
  const label = input.status === 'half_day' ? `away this ${input.half === 'first' ? 'morning' : 'afternoon'}` : input.status === 'leave' ? 'on leave today' : 'absent today';
  for (const task of rows) {
    const { rowCount } = await c.query(`insert into job_runs (job, run_key, ran_at) values ('away_tasks', $1, $2) on conflict do nothing`, [`away:${t.id}:${today}:${task.id}`, now]);
    if (!rowCount) continue;
    const to = [...new Set([t.id, gm, task.assigner_id].filter((x): x is number => !!x))].map((userId) => ({ userId }));
    await notify(c, dir, rules, to, () => inAppNotice('away_tasks', task.id, `${t.name} is ${label}: “${task.title}”`, `${t.name} is ${label} and “${task.title}” is due soon. Reassign it, move its due time, or leave it with them.`));
  }
}

/** The people the caller marks, and their days in [from, to]; unmarked days come back as 'unmarked' (D-157). */
export async function listAttendance(actor: DirUser, dir: Directory, q: { from: string; to: string; teamId?: number; userId?: number; status?: AttendanceStatus }) {
  const heads = await headsOf(actor.organizationId);
  let people = dir.all().filter((u) => hasAttendance(u, heads) && canMark(actor, u, heads));
  const marksAnyone = hasRole(actor, 'cos') || [...heads.values()].includes(actor.id);
  if (!marksAnyone) throw notFound('Not found');
  if (!people.length) return { today: dayIn(actor.work.zone, clock.now().getTime()), people: [], days: [] };
  if (q.userId !== undefined) {
    people = people.filter((u) => u.id === q.userId);
    if (!people.length) throw notFound('Person not found.');
  }
  if (q.teamId !== undefined) people = people.filter((u) => u.teamId === q.teamId);
  if (q.from > q.to || daysBetween(q.from, q.to).length > MAX_DAYS) throw invalid({ to: `Choose at most ${MAX_DAYS} days.` });
  const marks = await readMarks(people.map((u) => u.id), q.from, q.to);
  const days = people.flatMap((u) => daysBetween(q.from, q.to).map((day) => marks.get(`${u.id}:${day}`) ?? { userId: u.id, day, status: 'unmarked' as const, awayFrom: null, awayTo: null }));
  return {
    // "Today" in the members' vertical zone, so the page marks the right day whatever the viewer's zone (D-163).
    today: dayIn(people[0]!.work.zone, clock.now().getTime()),
    people: people.map((u) => ({ id: u.id, name: u.name, teamId: u.teamId, entityId: u.entityId })),
    days: q.status ? days.filter((d) => d.status === q.status) : days,
  };
}

/** Everyone with attendance sees their own month (read-only). */
export async function myAttendance(user: DirUser, month: string) {
  const heads = await headsOf(user.organizationId);
  if (!hasAttendance(user, heads)) throw notFound('Not found');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const marks = await readMarks([user.id], from, to);
  return { days: daysBetween(from, to).map((day) => { const r = marks.get(`${user.id}:${day}`); return { day, status: r?.status ?? 'unmarked', awayFrom: r?.awayFrom ?? null, awayTo: r?.awayTo ?? null }; }) };
}

async function readMarks(userIds: number[], from: string, to: string) {
  const { rows } = await pool.query<{ user_id: number; day: string; status: AttendanceStatus; away_from: string | null; away_to: string | null }>(
    `select user_id, to_char(day, 'YYYY-MM-DD') as day, status, away_from, away_to from attendance where user_id = any($1) and day between $2 and $3`,
    [userIds, from, to],
  );
  return new Map(rows.map((r) => [`${r.user_id}:${r.day}`, { userId: r.user_id, day: r.day, status: r.status, awayFrom: r.away_from, awayTo: r.away_to }]));
}

