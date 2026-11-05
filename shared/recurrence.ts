// Recurrence rules (REC-01…04, D-9): one definition for the client preview and server generation (ADR-0007).
// Days are calendar dates (YYYY-MM-DD). Which day is "today" depends on the assignee's zone; the caller decides that (D-5).

export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'interval'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface RecurrenceRule {
  frequency: Frequency;
  /** For 'interval': every N days. For others: every N units. */
  interval: number;
  /** 0 = Sunday. */
  weekdays: number[];
  startDate: string;
  endDate: string | null;
}

/** A generated task is titled "<title> — <YYYY-MM-DD>", which must fit the 140-character task title. */
export const SCHEDULE_TITLE_MAX = 140 - ' — YYYY-MM-DD'.length;

const DAY = 86_400_000;

/** YYYY-MM-DD in UTC for a timestamp. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayMs(day: string): number {
  return Date.parse(day + 'T00:00:00Z');
}

export function addDays(day: string, n: number): string {
  return isoDay(dayMs(day) + n * DAY);
}

/** Does `day` (YYYY-MM-DD) fall on this recurrence's schedule? Pure and deterministic. */
export function occursOn(r: RecurrenceRule, day: string): boolean {
  if (day < r.startDate) return false;
  if (r.endDate && day > r.endDate) return false;
  const n = Math.max(1, r.interval);
  const diffDays = Math.round((dayMs(day) - dayMs(r.startDate)) / DAY);
  const d = new Date(dayMs(day));
  const s = new Date(dayMs(r.startDate));
  switch (r.frequency) {
    case 'daily':
    case 'interval':
      return diffDays % n === 0;
    case 'weekly': {
      const days = r.weekdays.length ? r.weekdays : [s.getUTCDay()];
      if (!days.includes(d.getUTCDay())) return false;
      return Math.floor(diffDays / 7) % n === 0;
    }
    case 'monthly': {
      // D-45: days 29–31 clamp to the last day of a shorter month.
      const months = (d.getUTCFullYear() - s.getUTCFullYear()) * 12 + d.getUTCMonth() - s.getUTCMonth();
      if (months % n !== 0) return false;
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === Math.min(s.getUTCDate(), lastDay);
    }
  }
}

/** All occurrence days in [from, to] inclusive. */
export function occurrencesBetween(r: RecurrenceRule, from: string, to: string, limit = 400): string[] {
  const out: string[] = [];
  for (let t = dayMs(from); t <= dayMs(to) && out.length < limit; t += DAY) {
    const day = isoDay(t);
    if (occursOn(r, day)) out.push(day);
  }
  return out;
}

export function describeRecurrence(r: RecurrenceRule): string {
  const n = Math.max(1, r.interval);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let s: string;
  switch (r.frequency) {
    case 'daily':
      s = n === 1 ? 'Every day' : `Every ${n} days`;
      break;
    case 'interval':
      s = `Every ${n} days`;
      break;
    case 'weekly':
      s = `${n === 1 ? 'Weekly' : `Every ${n} weeks`} on ${(r.weekdays.length ? r.weekdays : [new Date(dayMs(r.startDate)).getUTCDay()]).map((d) => names[d]).join(', ')}`;
      break;
    case 'monthly':
      s = `${n === 1 ? 'Monthly' : `Every ${n} months`} on day ${new Date(dayMs(r.startDate)).getUTCDate()}`;
      break;
  }
  return r.endDate ? `${s}, until ${r.endDate}` : s;
}

export interface ScheduleFields extends RecurrenceRule {
  title: string;
  assigneeId: unknown;
  dueHour: number;
}

/** REC-02 field rules and their messages; empty when valid. The server adds scope, category and team checks. */
export function scheduleErrors(input: ScheduleFields): Record<string, string> {
  const f: Record<string, string> = {};
  const title = input.title.trim();
  if (title.length < 4) f.title = 'Give the schedule a title of at least 4 characters.';
  else if (title.length > SCHEDULE_TITLE_MAX) f.title = `Keep the title under ${SCHEDULE_TITLE_MAX + 1} characters.`;
  if (!input.assigneeId) f.assigneeId = 'Choose an assignee.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || Number.isNaN(dayMs(input.startDate))) f.startDate = 'Choose a start date.';
  if (input.endDate && input.endDate < input.startDate) f.endDate = 'End date must be after the start date.';
  if (!(Number.isInteger(input.interval) && input.interval >= 1 && input.interval <= 365)) f.interval = 'Between 1 and 365.';
  if (input.frequency === 'weekly' && !input.weekdays.length) f.weekdays = 'Pick at least one weekday.';
  if (!(Number.isInteger(input.dueHour) && input.dueHour >= 0 && input.dueHour <= 23)) f.dueHour = 'Between 0 and 23.';
  return f;
}
