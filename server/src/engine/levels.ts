// Server adapter over the shared ladder (shared/levels.ts, ADR-0007): the server works in Date, the shared
// module in epoch ms. No rule logic lives here.
import * as ladder from '@taskwatch/shared/levels';
import type { WorkClock } from '@taskwatch/shared/worktime';
import { LADDER_STATUSES, type Priority, type RulesConfig } from '../domain.js';

export { levelApplies, silenceThresholds } from '@taskwatch/shared/levels';

export interface LevelInput {
  priority: Priority;
  /** Last assignee update, or the (re)assignment time if there has been none. */
  clockStartedAt: Date;
  dueAt: Date;
  /** The task's stored L1, L2 and L3 instants (ADR-0014); absent: derived from the rules. */
  deadlineAt?: readonly [Date, Date, Date];
  blocked?: boolean;
  silencePaused?: boolean;
  /** ADR-0015: how silence time is counted (services/worktime.ts `clockFor`); wall clock when absent. */
  silenceClock?: WorkClock;
}

export interface LevelResult extends Omit<ladder.LevelResult, 'next'> {
  /** The next time the task will climb, if nothing changes. */
  next: { level: number; at: Date } | null;
}

export function computeLevel(t: LevelInput, cfg: RulesConfig, now: Date): LevelResult {
  const deadlineAt = t.deadlineAt && ([t.deadlineAt[0].getTime(), t.deadlineAt[1].getTime(), t.deadlineAt[2].getTime()] as const);
  const r = ladder.computeLevel({ ...t, clockStartedAt: t.clockStartedAt.getTime(), dueAt: t.dueAt.getTime(), deadlineAt }, cfg, now.getTime());
  return { ...r, next: r.next && { level: r.next.level, at: new Date(r.next.at) } };
}

/** A task row's level now, or null when the engine does not evaluate its status (LADDER_STATUSES). */
export function taskLevel(
  t: { status: string; priority: Priority; clock_started_at: Date; due_at: Date; deadline_l2_at?: Date | null; deadline_l3_at?: Date | null },
  cfg: RulesConfig,
  now: Date,
  silenceClock?: WorkClock,
): LevelResult | null {
  if (!(LADDER_STATUSES as readonly string[]).includes(t.status)) return null;
  return computeLevel(
    {
      priority: t.priority,
      clockStartedAt: t.clock_started_at,
      dueAt: t.due_at,
      deadlineAt: t.deadline_l2_at && t.deadline_l3_at ? [t.due_at, t.deadline_l2_at, t.deadline_l3_at] : undefined,
      blocked: t.status === 'blocked',
      silencePaused: t.status === 'submitted',
      silenceClock,
    },
    cfg,
    now,
  );
}

export const isQuietTime = (timeZone: string, now: Date, start: string, end: string): boolean => ladder.isQuietTime(timeZone, now.getTime(), start, end);

export const quietEndsAt = (timeZone: string, now: Date, end: string): Date => new Date(ladder.quietEndsAt(timeZone, now.getTime(), end));
