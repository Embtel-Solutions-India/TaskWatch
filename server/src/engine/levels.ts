// Server adapter over the shared ladder (shared/levels.ts, ADR-0007): the server works in Date, the shared
// module in epoch ms. No rule logic lives here.
import * as ladder from '@taskwatch/shared/levels';
import { LADDER_STATUSES, type Priority, type RulesConfig } from '../domain.js';

export { levelApplies, silenceThresholds } from '@taskwatch/shared/levels';

export interface LevelInput {
  priority: Priority;
  /** Last assignee update, or the (re)assignment time if there has been none. */
  clockStartedAt: Date;
  dueAt: Date;
  blocked?: boolean;
  silencePaused?: boolean;
}

export interface LevelResult extends Omit<ladder.LevelResult, 'next'> {
  /** The next time the task will climb, if nothing changes. */
  next: { level: number; at: Date } | null;
}

export function computeLevel(t: LevelInput, cfg: RulesConfig, now: Date): LevelResult {
  const r = ladder.computeLevel({ ...t, clockStartedAt: t.clockStartedAt.getTime(), dueAt: t.dueAt.getTime() }, cfg, now.getTime());
  return { ...r, next: r.next && { level: r.next.level, at: new Date(r.next.at) } };
}

/** A task row's level now, or null when the engine does not evaluate its status (LADDER_STATUSES). */
export function taskLevel(t: { status: string; priority: Priority; clock_started_at: Date; due_at: Date }, cfg: RulesConfig, now: Date): LevelResult | null {
  if (!(LADDER_STATUSES as readonly string[]).includes(t.status)) return null;
  return computeLevel(
    { priority: t.priority, clockStartedAt: t.clock_started_at, dueAt: t.due_at, blocked: t.status === 'blocked', silencePaused: t.status === 'submitted' },
    cfg,
    now,
  );
}

export const isQuietTime = (timeZone: string, now: Date, start: string, end: string): boolean => ladder.isQuietTime(timeZone, now.getTime(), start, end);

export const quietEndsAt = (timeZone: string, now: Date, end: string): Date => new Date(ladder.quietEndsAt(timeZone, now.getTime(), end));
