// The escalation ladder lives in shared/levels.ts (ADR-0007), the same code the server runs. Re-exported here so
// existing imports keep working.
export { computeLevel, isQuietTime, levelApplies, quietEndsAt, silenceThresholds } from '@taskwatch/shared/levels';
export type { LevelInput, LevelResult } from '@taskwatch/shared/levels';
