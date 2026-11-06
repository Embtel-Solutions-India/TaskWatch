// The dashboard rules live in shared/insights.ts (ADR-0007, D-9), the same code the server runs. Re-exported here so
// existing imports keep working; the page only renders the payload of getDashboard().
import type { HealthBucket } from '@taskwatch/shared/insights';
import type { Db } from '../../types';

export type { AttentionItem, DashActivity, DashboardPayload, Kpi, Range, TaskBrief, TeamOverview, TrendPoint, WorkloadRow } from '@taskwatch/shared/insights';
export type Health = Record<HealthBucket, number>;

export const HEALTH_HELP = 'Open tasks in exactly one bucket, checked in order: Overdue (past due date) → Escalated (L1+ from missed updates) → At risk (L0 reminder, or due within 24 h) → On track.';

/** Mock only: a task's entity is its team's department (D-4). */
export function departmentOf(db: Db, teamId: string | null): string | null {
  return db.teams.find((t) => t.id === teamId)?.departmentId ?? null;
}
