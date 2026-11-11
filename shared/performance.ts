// Performance, progress and workload formulas (PERFORMANCE-FRD §5) — one definition for server and client (ADR-0007).
// Pure: callers pass task facts; nothing here reads a database or the clock.
import { wallClock, zonedInstant } from '@taskwatch/shared/levels';
import { LADDER_STATUSES, type Status } from '@taskwatch/shared/workflow';

/** People with fewer eligible tasks in the period are shown but not ranked. */
export const RANK_MIN_TASKS = 5;
export const WORKLOAD_DAYS = 5;

export type Priority = 'critical' | 'high' | 'normal' | 'low';
/** D-124: a task's weight in the Outcome Score comes from its priority (Settings; visible on the leaderboard). */
export type PriorityWeights = Record<Priority, number>;
export const EQUAL_WEIGHTS: PriorityWeights = { critical: 1, high: 1, normal: 1, low: 1 };
export type Purpose = 'revenue' | 'support';

export interface ScoredTask {
  id: number;
  status: Status;
  dueAt: Date;
  completedAt: Date | null;
  target: number | null;
  achieved: number | null;
  /** The reviewer's or giver's 0–100 outcome, for tasks without a target. */
  outcomeScore: number | null;
  qualityScore: number | null;
  reviewed: boolean;
  /** The giver's decision on a shortfall or delay; true excludes the task from O, T and E. */
  shortfallAccepted: boolean | null;
  /** Reassigned after its due date had passed: not the new assignee's lateness. */
  reassignedAfterDue: boolean;
  /** False for tasks created before the feature existed. */
  scored: boolean;
  priority: Priority;
  reworkCount: number;
  /** Reviewed work: when the approved (or still pending) round was submitted. Review time never makes the assignee late. */
  submittedAt: Date | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const isHigh = (p: Priority) => p === 'critical' || p === 'high';

/** 0–100 progress of one task; null when cancelled. */
export function taskProgress(t: { status: Status; target: number | null; achieved: number | null; progress: number }): number | null {
  if (t.status === 'cancelled') return null;
  if (t.status === 'completed') return 100;
  if (t.target && t.target > 0) return Math.round(Math.min((t.achieved ?? 0) / t.target, 1) * 100);
  return t.progress;
}

/** 0–100 outcome of one task, or null when it has no number and was not rated. */
export function taskOutcome(t: ScoredTask, _now: Date): number | null {
  if (t.target && t.target > 0) return Math.min(((t.achieved ?? 0) / t.target) * 100, 100);
  return t.outcomeScore;
}

/**
 * Waiting for the giver's Rate step (FRD §4): a finished, unreviewed task without a target and no outcome score, or with
 * an undecided shortfall reason; or an open task past its due date whose delay has a reason (shortfall or block).
 */
export function isRatable(
  t: { status: Status; reviewRequired: boolean; scored: boolean; target: number | null; outcomeScore: number | null; shortfallReason: string | null; shortfallAccepted: boolean | null; blockedReason: string | null; dueAt: Date },
  now: Date,
): boolean {
  if (!t.scored) return false;
  if (t.status === 'completed') {
    if (t.reviewRequired) return false;
    return (t.target === null && t.outcomeScore === null) || (!!t.shortfallReason && t.shortfallAccepted === null);
  }
  const open = (LADDER_STATUSES as readonly Status[]).includes(t.status);
  return open && t.dueAt.getTime() < now.getTime() && !!(t.shortfallReason || t.blockedReason) && t.shortfallAccepted === null;
}

/** Done by the latest approved due date. An open task past its due date is late. */
export function isOnTime(t: ScoredTask, now: Date): boolean {
  const finished = t.submittedAt ?? t.completedAt;
  if (finished) return finished.getTime() <= t.dueAt.getTime();
  return now.getTime() <= t.dueAt.getTime();
}

/** Due in [from, to), already due or completed, scored, and neither cancelled nor a draft. */
export function isEligible(t: ScoredTask, from: Date, to: Date, now: Date): boolean {
  if (!t.scored || t.status === 'cancelled' || t.status === 'draft') return false;
  const due = t.dueAt.getTime();
  if (due < from.getTime() || due >= to.getTime()) return false;
  return t.status === 'completed' || due <= now.getTime();
}

export interface PersonScore {
  outcome: number | null;
  timeliness: number | null;
  quality: number | null;
  efficiency: number | null;
  efficiencyByPressure: { high: number | null; normal: number | null };
  score: number | null;
  eligible: number;
  ranked: boolean;
  flags: ('no_quality_reviews' | 'outcome_not_rated')[];
}

/**
 * D-124: Outcome Score = Σ(task outcome × weight) ÷ Σ(weight) over counted tasks (an accepted shortfall is left out), and the
 * leaderboard score is that Outcome Score alone. Timeliness, quality and efficiency are computed for display only.
 */
export function personScore(tasks: ScoredTask[], from: Date, to: Date, now: Date, weights: PriorityWeights = EQUAL_WEIGHTS): PersonScore {
  const eligible = tasks.filter((t) => isEligible(t, from, to, now));
  const counted = eligible.filter((t) => t.shortfallAccepted !== true);
  const outcomes = counted.map((t) => taskOutcome(t, now));
  const rated = counted.flatMap((t, i) => (outcomes[i] === null ? [] : [{ o: outcomes[i]!, w: weights[t.priority] }]));
  const weight = rated.reduce((a, r) => a + r.w, 0);
  const outcome = weight > 0 ? rated.reduce((a, r) => a + r.o * r.w, 0) / weight : null;
  const timely = counted.filter((t) => !t.reassignedAfterDue);
  const timeliness = timely.length ? (timely.filter((t) => isOnTime(t, now)).length / timely.length) * 100 : null;
  const quality = mean(eligible.filter((t) => t.reviewed && t.qualityScore !== null).map((t) => t.qualityScore!));
  const eff = (ts: ScoredTask[]) => mean(ts.map((t) => (isOnTime(t, now) ? (taskOutcome(t, now) ?? 0) : 0)));
  const score = outcome;
  const flags: PersonScore['flags'] = [];
  if (eligible.length && quality === null) flags.push('no_quality_reviews');
  if (outcomes.some((o) => o === null)) flags.push('outcome_not_rated');
  return {
    outcome,
    timeliness,
    quality,
    efficiency: eff(counted),
    efficiencyByPressure: { high: eff(counted.filter((t) => isHigh(t.priority))), normal: eff(counted.filter((t) => !isHigh(t.priority))) },
    score,
    eligible: eligible.length,
    ranked: eligible.length >= RANK_MIN_TASKS && score !== null,
    flags,
  };
}

/** Ranked rows by score (ties share a rank, the next rank skips), then unranked rows; name breaks ties for order. */
export function rankRows<T extends { score: number | null; ranked: boolean; name: string }>(rows: T[]): (T & { rank: number | null })[] {
  const ranked = rows.filter((r) => r.ranked).sort((a, b) => b.score! - a.score! || a.name.localeCompare(b.name));
  const out = ranked.map((r, i) => ({ ...r, rank: i > 0 && ranked[i - 1]!.score === r.score ? 0 : i + 1 }));
  for (let i = 1; i < out.length; i++) if (out[i]!.rank === 0) out[i]!.rank = out[i - 1]!.rank;
  const rest = rows.filter((r) => !r.ranked).sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r, rank: null }));
  return [...out, ...rest];
}

/** [from, to) of the week (Mon–Sun) or month containing `anchor`, in `zone`. */
export function periodBounds(kind: 'week' | 'month', anchor: Date, zone: string): { from: Date; to: Date } {
  const w = wallClock(zone, anchor.getTime());
  if (kind === 'month') {
    const next = w.month === 12 ? [w.year + 1, 1] : [w.year, w.month + 1];
    return { from: new Date(zonedInstant(zone, w.year, w.month, 1, 0, 0)), to: new Date(zonedInstant(zone, next[0]!, next[1]!, 1, 0, 0)) };
  }
  const dow = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay(); // 0 = Sunday
  const monday = new Date(Date.UTC(w.year, w.month - 1, w.day - ((dow + 6) % 7)));
  const at = (d: Date) => new Date(zonedInstant(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0));
  return { from: at(monday), to: at(new Date(monday.getTime() + 7 * 86_400_000)) };
}

export interface WorkloadInput {
  status: Status;
  dueAt: Date;
  estimatedHours: number | null;
  priority: Priority;
}

export interface Workload {
  openHours: number;
  windowHours: number;
  capacityHours: number;
  loadPercent: number;
  band: 'light' | 'normal' | 'overloaded';
  highShare: number;
  overdue: number;
  blocked: number;
  noEstimate: number;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** End (exclusive) of the WORKLOAD_DAYS-th working day (Mon–Fri) from `now` in `zone`; today counts if a working day. */
function windowEnd(now: Date, zone: string): number {
  const w = wallClock(zone, now.getTime());
  let day = new Date(Date.UTC(w.year, w.month - 1, w.day));
  let left = WORKLOAD_DAYS;
  for (;;) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
    if (left === 0) break;
    day = new Date(day.getTime() + 86_400_000);
  }
  const next = new Date(day.getTime() + 86_400_000);
  return zonedInstant(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/** Open load of one person (FRD §5.8). Bands: under 50 % light, 50–100 % normal, over 100 % overloaded. */
export function workload(tasks: WorkloadInput[], opts: { now: Date; zone: string; workdayStart: string; workdayEnd: string }): Workload {
  const open = tasks.filter((t) => (LADDER_STATUSES as readonly Status[]).includes(t.status));
  const end = windowEnd(opts.now, opts.zone);
  const inWindow = open.filter((t) => t.dueAt.getTime() < end);
  const hours = (ts: WorkloadInput[]) => ts.reduce((s, t) => s + (t.estimatedHours ?? 0), 0);
  const windowHours = hours(inWindow);
  const capacityHours = (WORKLOAD_DAYS * Math.max(0, minutes(opts.workdayEnd) - minutes(opts.workdayStart))) / 60;
  const loadPercent = capacityHours ? (windowHours / capacityHours) * 100 : 0;
  return {
    openHours: hours(open),
    windowHours,
    capacityHours,
    loadPercent,
    band: loadPercent < 50 ? 'light' : loadPercent <= 100 ? 'normal' : 'overloaded',
    highShare: windowHours ? (hours(inWindow.filter((t) => isHigh(t.priority))) / windowHours) * 100 : 0,
    overdue: open.filter((t) => t.dueAt.getTime() < opts.now.getTime()).length,
    blocked: open.filter((t) => t.status === 'blocked').length,
    noEstimate: open.filter((t) => t.estimatedHours === null).length,
  };
}

/** D-125: a person's working shift as wall-clock "HH:MM" times; an end at or before the start runs past midnight. */
export interface Shift {
  start: string;
  end: string;
}

const mins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * D-105/D-125: a person whose own quiet window covers the middle of the workday (the night team, 08:00–20:00) works the
 * other hours; everyone else, including someone whose quiet window is only their night (22:00–07:00), works the workday.
 */
export function shiftOf(person: { quietStart: string | null; quietEnd: string | null }, org: { workdayStart: string; workdayEnd: string }): Shift {
  const workday = { start: org.workdayStart, end: org.workdayEnd };
  if (!person.quietStart || !person.quietEnd) return workday;
  const [qs, qe, ws, we] = [mins(person.quietStart), mins(person.quietEnd), mins(org.workdayStart), mins(org.workdayEnd)];
  const mid = (ws + ((we - ws + 1440) % 1440) / 2) % 1440;
  const quietAtMid = qs < qe ? mid >= qs && mid < qe : mid >= qs || mid < qe;
  return quietAtMid ? { start: person.quietEnd, end: person.quietStart } : workday;
}

/**
 * D-125: hours of [from, to) that fall in the shift, for shifts starting Monday to Friday in `zone`. No timer: this is
 * how long a task was open in working time. ponytail: no public holidays (owner accepted, 2026-11-11).
 */
export function workingHours(from: Date, to: Date, zone: string, shift: Shift): number {
  if (to.getTime() <= from.getTime()) return 0;
  const [sh, sm] = shift.start.split(':').map(Number) as [number, number];
  const [eh, em] = shift.end.split(':').map(Number) as [number, number];
  const overnight = eh * 60 + em <= sh * 60 + sm;
  const first = wallClock(zone, from.getTime());
  let day = new Date(Date.UTC(first.year, first.month - 1, first.day - 1)); // the shift that began yesterday may still run
  let ms = 0;
  while (true) {
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const begin = zonedInstant(zone, y, m, d, sh, sm);
    if (begin >= to.getTime()) break;
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const next = new Date(day.getTime() + 86_400_000);
      const end = overnight ? zonedInstant(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), eh, em) : zonedInstant(zone, y, m, d, eh, em);
      ms += Math.max(0, Math.min(end, to.getTime()) - Math.max(begin, from.getTime()));
    }
    day = new Date(day.getTime() + 86_400_000);
  }
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/** Leaderboard analytics: the average of the Outcome Scores people have (no score = left out), and how many have one. */
export function averageScore(scores: (number | null)[]): { average: number | null; scored: number } {
  const have = scores.filter((s): s is number => s !== null);
  return { average: have.length ? Math.round((have.reduce((a, b) => a + b, 0) / have.length) * 10) / 10 : null, scored: have.length };
}
