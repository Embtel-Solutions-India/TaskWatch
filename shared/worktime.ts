// ADR-0015 (D-159, D-160): one working-time clock, used by the escalation ladder, the deadline milestones and the
// D-125 over-time check. Pure (ADR-0007): no Node or DOM APIs. Instants are epoch milliseconds.
import { wallClock, zonedInstant } from '@taskwatch/shared/levels';

/** A vertical's working time. `days`: 0 = Sunday. `end <= start` = overnight; `00:00`–`24:00` = all day. */
export interface Schedule {
  zone: string;
  days: readonly number[];
  start: string;
  end: string;
}

/** Half-open [from, to) in epoch ms. */
export interface Interval {
  from: number;
  to: number;
}

export interface WorkClock {
  /** Working ms in [from, to). */
  elapsed(from: number, to: number): number;
  /** The instant at which `ms` of working time has passed after `from` (Infinity if never within 400 days). */
  add(from: number, ms: number): number;
}

export const WALL_CLOCK: WorkClock = { elapsed: (from, to) => Math.max(0, to - from), add: (from, ms) => from + ms };

/** Every hour counts: the schedule test fixtures use for "no working-time rules". */
export const ALWAYS: Schedule = { zone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' };

const DAY = 86_400_000;
const hm = (s: string) => s.split(':').map(Number) as [number, number];

/** The vertical's own values, else the organization's workday and zone, Monday to Friday. */
export function scheduleOf(
  entity: { timeZone: string | null; workDays: readonly number[] | null; workStart: string | null; workEnd: string | null },
  org: { timezone: string; workdayStart: string; workdayEnd: string },
): Schedule {
  return { zone: entity.timeZone ?? org.timezone, days: entity.workDays ?? [1, 2, 3, 4, 5], start: entity.workStart ?? org.workdayStart, end: entity.workEnd ?? org.workdayEnd };
}

/**
 * One calendar day's working window, cached: the zone maths (Intl) is the expensive part, and the engine and every
 * task list ask for the same days again and again (review I-3). ponytail: the cache is cleared whole at 50k entries.
 */
const windowCache = new Map<string, [number, number] | null>();
function windowOn(s: Schedule, day: number): [number, number] | null {
  const key = `${s.zone}|${s.days.join(',')}|${s.start}|${s.end}|${day}`;
  let w = windowCache.get(key);
  if (w !== undefined) return w;
  const d = new Date(day);
  if (!s.days.includes(d.getUTCDay())) w = null;
  else {
    const [sh, sm] = hm(s.start);
    const [eh, em] = hm(s.end);
    const crosses = eh * 60 + em <= sh * 60 + sm || eh === 24;
    const begin = zonedInstant(s.zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), sh, sm);
    const endDay = new Date(crosses ? day + DAY : day);
    w = [begin, zonedInstant(s.zone, endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(), eh === 24 ? 0 : eh, em)];
  }
  if (windowCache.size > 50_000) windowCache.clear();
  windowCache.set(key, w);
  return w;
}

/** Working windows in order, starting with the one that began the day before `from` (an overnight shift may still run). */
function* windows(s: Schedule, from: number, maxDays = Infinity): Generator<[number, number]> {
  if (!s.days.length) return;
  const first = wallClock(s.zone, from);
  let day = Date.UTC(first.year, first.month - 1, first.day - 1);
  for (let i = 0; i < maxDays; i++, day += DAY) {
    const w = windowOn(s, day);
    if (w) yield w;
  }
}

/** Parts of [b, e) not covered by `away` (sorted by start). */
function minus(b: number, e: number, away: readonly Interval[]): [number, number][] {
  const out: [number, number][] = [];
  let cur = b;
  for (const a of away) {
    if (a.to <= cur || a.from >= e) continue;
    if (a.from > cur) out.push([cur, a.from]);
    cur = Math.max(cur, a.to);
    if (cur >= e) return out;
  }
  if (cur < e) out.push([cur, e]);
  return out;
}

export function makeWorkClock(s: Schedule, away: readonly Interval[] = []): WorkClock {
  const gaps = [...away].sort((a, b) => a.from - b.from);
  return {
    elapsed(from, to) {
      if (to <= from) return 0;
      let ms = 0;
      for (const [b, e] of windows(s, from)) {
        if (b >= to) break;
        for (const [x, y] of minus(Math.max(b, from), Math.min(e, to), gaps)) ms += Math.max(0, y - x);
      }
      return ms;
    },
    add(from, ms) {
      let left = ms;
      if (left <= 0) return from;
      for (const [b, e] of windows(s, from, 400)) {
        for (const [x, y] of minus(Math.max(b, from), e, gaps)) {
          if (y <= x) continue;
          if (y - x >= left) return x + left;
          left -= y - x;
        }
      }
      return Infinity;
    },
  };
}
