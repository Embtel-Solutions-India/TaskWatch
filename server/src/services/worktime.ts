// ADR-0015 (D-158, D-160, D-164): the clock a task's silence ladder runs on. Critical: wall clock. Otherwise the
// assignee's vertical working time, minus the time their GM marked them away (absent, leave, or a half day's range).
import { zonedInstant } from '@taskwatch/shared/levels';
import { makeWorkClock, WALL_CLOCK, type Interval, type WorkClock } from '@taskwatch/shared/worktime';
import type { Db } from '../db/pool.js';
import type { Priority } from '../domain.js';
import type { DirUser } from './directory.js';

const DAY = 86_400_000;

/** An away interval and why (for the task page tag). */
export type Away = Interval & { kind: 'absent' | 'leave' | 'half_day' };

/**
 * Away intervals per person over [from, to]. A whole day for absent or leave, the marked range for a half day, in the
 * person's vertical zone. Each starts no earlier than when it was marked (D-164), so a late mark never undoes time
 * already counted.
 */
export async function awayIntervals(db: Db, people: readonly Pick<DirUser, 'id' | 'work'>[], from: Date, to: Date): Promise<Map<number, Away[]>> {
  const out = new Map<number, Away[]>();
  if (!people.length || to <= from) return out;
  const zoneOf = new Map(people.map((p) => [p.id, p.work.zone]));
  const { rows } = await db.query<{ user_id: number; day: string; status: string; away_from: string | null; away_to: string | null; marked_at: Date }>(
    `select user_id, to_char(day, 'YYYY-MM-DD') as day, status, away_from, away_to, marked_at from attendance
      where user_id = any($1) and status in ('absent', 'leave', 'half_day') and day between ($2::timestamptz - interval '2 days')::date and ($3::timestamptz + interval '2 days')::date`,
    [[...zoneOf.keys()], from, to],
  );
  for (const r of rows) {
    const zone = zoneOf.get(r.user_id)!;
    const [y, m, d] = r.day.split('-').map(Number) as [number, number, number];
    const at = (hhmm: string, plusDays = 0) => {
      const [h, mm] = hhmm.split(':').map(Number) as [number, number];
      const n = new Date(Date.UTC(y, m - 1, d) + (plusDays + (h === 24 ? 1 : 0)) * DAY);
      return zonedInstant(zone, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), h === 24 ? 0 : h, mm);
    };
    const half = r.status === 'half_day';
    const [a, b] = half ? [at(r.away_from!), at(r.away_to!, r.away_to! <= r.away_from! ? 1 : 0)] : [at('00:00'), at('00:00', 1)];
    const start = Math.max(a, r.marked_at.getTime());
    if (b > start) out.set(r.user_id, [...(out.get(r.user_id) ?? []), { from: start, to: b, kind: r.status as Away['kind'] }]);
  }
  return out;
}

/** Who of these people is marked away at `now` (absent, on leave, or inside a half day's range). */
export async function awayNow(db: Db, people: readonly Pick<DirUser, 'id' | 'work'>[], now: Date): Promise<Set<number>> {
  const at = now.getTime();
  const away = await awayIntervals(db, people, now, new Date(at + 1));
  return new Set([...away].filter(([, xs]) => xs.some((x) => x.from <= at && x.to > at)).map(([id]) => id));
}

/** The silence clock for one task: wall clock for Critical (D-160), else working time minus away (D-158). */
export function clockFor(assignee: Pick<DirUser, 'work'> | undefined, priority: Priority, away: readonly Interval[] = []): WorkClock {
  return priority === 'critical' || !assignee ? WALL_CLOCK : makeWorkClock(assignee.work, away);
}
