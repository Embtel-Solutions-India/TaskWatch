// Escalation policy pieces added by ADR-0014: deadline milestones, the reviewer deadline, extra recipients and the
// field-by-field inheritance of a vertical's policy from the global one. Pure (ADR-0007): no Node or DOM APIs.
import type { Priority } from '@taskwatch/shared/performance';
import { WALL_CLOCK, type WorkClock } from '@taskwatch/shared/worktime';

const MINUTE = 60_000;

/** Minutes after the due time at which L2 and L3 apply, per priority (D-140). L1 is always at the due time. */
export type DeadlineDelays = Record<Priority, [l2Minutes: number, l3Minutes: number]>;
/** People copied on a level in addition to the reporting line (D-142). */
export interface ExtraRecipients {
  l1: number[];
  l2: number[];
  l3: number[];
}

export interface PolicyExtras {
  deadlineDelaysMinutes: DeadlineDelays;
  /** Minutes a reviewer has from submission before the first review reminder (D-145). */
  reviewSlaMinutes: Record<Priority, number>;
  extraRecipients: ExtraRecipients;
}

/** What ships: the work order's L2 at due + 24 h and L3 at due + 72 h for every priority (AC-2). */
export const SHIP_DEADLINE_DELAYS: DeadlineDelays = { critical: [1440, 4320], high: [1440, 4320], normal: [1440, 4320], low: [1440, 4320] };
export const DEFAULT_REVIEW_SLA: Record<Priority, number> = { critical: 30, high: 240, normal: 1440, low: 2880 };

/** System-controlled: nobody configures these (US-05). */
export const PRE_DEADLINE_WARNING_MINUTES = 10;
export const START_NOTICE_MINUTES = 10;

/** The policy fields a vertical may set for itself; everything else is organization-wide. */
export const VERTICAL_FIELDS = ['windowsHours', 'multiples', 'deadlineDelaysMinutes', 'reviewSlaMinutes', 'extraRecipients'] as const;

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

const isBranch = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Field-by-field inheritance: each later layer replaces only the leaves it sets (arrays and tuples are leaves), so a
 * change to an earlier layer still shows through wherever a later one is silent. Never mutates its arguments.
 */
export function resolvePolicy<T extends object>(base: T, ...layers: Array<DeepPartial<NoInfer<T>> | null | undefined>): T {
  let out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const layer of layers) {
    if (!layer) continue;
    const next = { ...out };
    for (const [k, v] of Object.entries(layer as Record<string, unknown>)) {
      if (v === undefined) continue;
      next[k] = isBranch(v) && isBranch(out[k]) ? resolvePolicy(out[k] as object, v) : v;
    }
    out = next;
  }
  return out as T;
}

/** The instants at which L1, L2 and L3 apply to a task with this due time: fixed, whatever updates are posted. */
export function deadlineMilestones<P extends string = Priority>(
  dueAt: number,
  priority: P,
  p: { deadlineDelaysMinutes?: Record<P, readonly [number, number]>; overdueOffsetsHours?: readonly number[] },
  clock: WorkClock = WALL_CLOCK, // ADR-0015 (D-160): the vertical's working time for non-Critical tasks
): [number, number, number] {
  // Rules saved before ADR-0014 (an old browser store, an old policy row) have offsets instead of delays.
  const o = p.overdueOffsetsHours;
  const [l2, l3] = p.deadlineDelaysMinutes?.[priority] ?? (o ? [o[1]! * 60, o[2]! * 60] : SHIP_DEADLINE_DELAYS[priority as unknown as Priority]);
  return [dueAt, clock.add(dueAt, l2 * MINUTE), clock.add(dueAt, l3 * MINUTE)];
}

/** A stored policy from before ADR-0014 has past-due offsets in hours, the same for every priority. */
export function legacyDelays(overdueOffsetsHours: readonly [number, number, number]): DeadlineDelays {
  const d = (): [number, number] => [overdueOffsetsHours[1] * 60, overdueOffsetsHours[2] * 60];
  return { critical: d(), high: d(), normal: d(), low: d() };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a vertical stores (D-142): the leaves of its effective policy that differ from the global one, for the vertical
 * fields only; tuples and lists are compared whole. A value equal to the global one is not stored, so it is inherited.
 */
export function diffPolicy<T extends object>(effective: T, base: T): DeepPartial<T> {
  const out: Record<string, unknown> = {};
  const e = effective as Record<string, unknown>;
  const b = base as Record<string, unknown>;
  for (const k of VERTICAL_FIELDS) {
    if (!(k in e)) continue;
    if (Array.isArray(e[k]) || !isBranch(e[k])) {
      if (!same(e[k], b[k])) out[k] = e[k];
      continue;
    }
    const inner = Object.fromEntries(Object.entries(e[k] as Record<string, unknown>).filter(([kk, v]) => !same(v, (b[k] as Record<string, unknown>)?.[kk])));
    if (Object.keys(inner).length) out[k] = inner;
  }
  return out as DeepPartial<T>;
}
