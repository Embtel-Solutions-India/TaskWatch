// The escalation ladder (WO FR-8, quiet hours) — the one implementation used by server and client (ADR-0007).
// Pure: no dependencies, no Node or DOM APIs. Instants are epoch milliseconds; time zones use Intl.

const HOUR = 3_600_000;

/** The rule fields the ladder needs. Server and client RulesConfig both satisfy it. */
export interface LadderRules<P extends string = string> {
  windowsHours: Record<P, number>;
  multiples: readonly number[];
  overdueOffsetsHours: readonly number[];
}

export interface LevelInput<P extends string = string> {
  priority: P;
  /** Last assignee update, or the (re)assignment time if there has been none. */
  clockStartedAt: number;
  dueAt: number;
  /** Marked Blocked: the task sits at L1 or higher while it stays blocked (WO ladder, D-24). */
  blocked?: boolean;
  /** In review: the silence clock pauses, the past-due floor still applies (D-25). */
  silencePaused?: boolean;
}

export interface LevelResult {
  /** -1 on track, 0..3 = L0..L3. The highest level any rule gives the task. */
  level: number;
  /** Which rule gives the level; past due wins a tie, then silence (ESC-02-AC-3). */
  reason: 'silence' | 'overdue' | 'blocked' | null;
  silenceLevel: number;
  overdueLevel: number;
  silentHours: number;
  overdueHours: number;
  /** When each level was (or will be) reached in the current cycle. */
  reachedAt: number[];
  /** The next time the task will climb, if nothing changes. */
  next: { level: number; at: number } | null;
}

/** Silence thresholds in hours for L0..L3: update window × multiple. */
export function silenceThresholds<P extends string>(priority: P, cfg: LadderRules<P>): number[] {
  const window = cfg.windowsHours[priority];
  return cfg.multiples.map((m) => window * m);
}

export function computeLevel<P extends string>(t: LevelInput<P>, cfg: LadderRules<P>, now: number): LevelResult {
  const silentMs = now - t.clockStartedAt;
  const overdueMs = now - t.dueAt;
  const thresholds = silenceThresholds(t.priority, cfg);

  let silenceLevel = -1;
  if (!t.silencePaused) {
    thresholds.forEach((h, k) => {
      if (silentMs >= h * HOUR) silenceLevel = k;
    });
  }
  let overdueLevel = -1;
  cfg.overdueOffsetsHours.forEach((h, i) => {
    if (overdueMs >= h * HOUR) overdueLevel = i + 1;
  });
  const blockedLevel = t.blocked ? 1 : -1;

  const level = Math.max(silenceLevel, overdueLevel, blockedLevel);
  const reason = level < 0 ? null : overdueLevel === level ? 'overdue' : silenceLevel === level ? 'silence' : 'blocked';

  // Level k is reached at the earliest of its silence threshold (unless paused), its past-due offset (L1+)
  // and, for L1, now when blocked. Infinity = not reachable while things stay as they are.
  const reachedAt = thresholds.map((h, k) => {
    const candidates = t.silencePaused ? [Infinity] : [t.clockStartedAt + h * HOUR];
    if (k >= 1) candidates.push(t.dueAt + cfg.overdueOffsetsHours[k - 1]! * HOUR);
    if (k === 1 && t.blocked) candidates.push(now);
    return Math.min(...candidates);
  });

  let next: LevelResult['next'] = null;
  for (let k = level + 1; k <= 3; k++) {
    const at = reachedAt[k]!;
    if (Number.isFinite(at) && (!next || at < next.at)) next = { level: k, at };
  }

  return {
    level,
    reason,
    silenceLevel,
    overdueLevel,
    silentHours: Math.max(0, silentMs / HOUR),
    overdueHours: Math.max(0, overdueMs / HOUR),
    reachedAt,
    next,
  };
}

/**
 * Whether level k currently applies. L0 is a silence reminder only, so it applies only while
 * the assignee is silent; L1–L3 apply whenever the task sits at or above them.
 */
export function levelApplies(k: number, r: Pick<LevelResult, 'level' | 'silenceLevel'>): boolean {
  return k === 0 ? r.silenceLevel >= 0 : r.level >= k;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Wall-clock fields of instant `t` in `timeZone`. */
export function wallClock(timeZone: string, t: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** The zone's offset from UTC at instant `t`, in ms. */
function offsetAt(timeZone: string, t: number): number {
  const w = wallClock(timeZone, t);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - (t - (((t % 1000) + 1000) % 1000));
}

/**
 * The instant at which `timeZone` shows the given wall-clock time. The zone's offset can differ between the
 * naive guess and the answer near a DST change, so the guess is corrected until the offset is consistent.
 * A wall time skipped by spring-forward has no instant; it resolves to the moment just after the gap.
 */
export function zonedInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const o1 = offsetAt(timeZone, asUtc);
  const t1 = asUtc - o1;
  const o2 = offsetAt(timeZone, t1);
  if (o2 === o1) return t1;
  const t2 = asUtc - o2;
  if (offsetAt(timeZone, t2) === o2) return t2;
  return Math.max(t1, t2); // in the spring-forward gap
}

/** Is it quiet time (e.g. 21:00–08:00) in the given time zone? */
export function isQuietTime(timeZone: string, now: number, start: string, end: string): boolean {
  const w = wallClock(timeZone, now);
  const m = w.hour * 60 + w.minute;
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** The next moment the local clock in `timeZone` reads `end` (when held alerts are released). */
export function quietEndsAt(timeZone: string, now: number, end: string): number {
  const e = minutesOf(end);
  const w = wallClock(timeZone, now);
  let candidate = zonedInstant(timeZone, w.year, w.month, w.day, Math.floor(e / 60), e % 60);
  if (candidate <= now) {
    const tomorrow = new Date(Date.UTC(w.year, w.month - 1, w.day + 1));
    candidate = zonedInstant(timeZone, tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), Math.floor(e / 60), e % 60);
  }
  return candidate;
}
