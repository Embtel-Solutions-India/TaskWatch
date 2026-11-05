// Single source of "now" for the server. Client devices never supply timestamps.
//
// Two test hooks exist, neither reachable in production:
//  - offset: the simulated-clock demo control (DEMO_TOOLS), persisted in app_state.
//  - fixed:  used by the seed script and automated tests to replay history.

let offsetMs = 0;
let fixed: Date | null = null;

export function now(): Date {
  if (fixed) return new Date(fixed.getTime());
  return new Date(Date.now() + offsetMs);
}

export function getOffsetMs(): number {
  return offsetMs;
}

export function setOffsetMs(ms: number): void {
  offsetMs = ms;
}

export function setFixed(date: Date | null): void {
  fixed = date ? new Date(date.getTime()) : null;
}

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
