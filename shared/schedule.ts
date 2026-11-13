// Scheduled work (ADR-0014): which task the floating countdown shows. Pure (ADR-0007); times are epoch ms.
import { PRE_DEADLINE_WARNING_MINUTES } from '@taskwatch/shared/policy';
import { wallClock } from '@taskwatch/shared/levels';
import { ACTIVE_STATUSES, type Status } from '@taskwatch/shared/workflow';

export interface CountdownItem {
  id: string;
  title: string;
  dueAt: number;
  overdue: boolean;
  /** Time left; negative once overdue. */
  msLeft: number;
}

/**
 * US-05 / D-149: the assignee's tasks that are within 10 minutes of their due time or past it, and not handed in.
 * The primary one is the oldest overdue task, else the soonest due; the rest follow in the same order.
 */
export function nextCountdown(tasks: ReadonlyArray<{ id: string; title: string; status: Status; dueAt: number }>, now: number): { primary: CountdownItem | null; others: CountdownItem[] } {
  const items = tasks
    .filter((t) => ACTIVE_STATUSES.includes(t.status) && t.dueAt - now <= PRE_DEADLINE_WARNING_MINUTES * 60_000)
    .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, overdue: t.dueAt <= now, msLeft: t.dueAt - now }))
    .sort((a, b) => a.dueAt - b.dueAt); // the oldest overdue is the earliest due, so one order covers both rules
  return { primary: items[0] ?? null, others: items.slice(1) };
}

/**
 * US-01 / D-151: ids of the tasks whose scheduled window [start, end) intersects another one. A task with no start is
 * taken as its last hour before the due time; windows that only touch do not overlap.
 */
export function overlaps(items: ReadonlyArray<{ id: string; start: number | null; end: number }>): Set<string> {
  const w = items.map((t) => ({ id: t.id, s: t.start ?? t.end - 3_600_000, e: t.end })).sort((a, b) => a.s - b.s);
  const out = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    for (let j = i + 1; j < w.length && w[j]!.s < w[i]!.e; j++) {
      out.add(w[i]!.id);
      out.add(w[j]!.id);
    }
  }
  return out;
}

/** D-151: whether an instant falls outside the working day in the person's own zone (the end time is outside). */
export function outsideWorkingHours(at: number, zone: string, workdayStart: string, workdayEnd: string): boolean {
  const w = wallClock(zone, at);
  const m = w.hour * 60 + w.minute;
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return m < mins(workdayStart) || m >= mins(workdayEnd);
}

/** ADR-0014 §2: an Open task whose scheduled start is still ahead reads "Scheduled" (a label, not a status). */
export function scheduleLabel(t: { status: Status; startAt: number | null }, now: number): 'Scheduled' | null {
  return t.status === 'assigned' && t.startAt !== null && t.startAt > now ? 'Scheduled' : null;
}
