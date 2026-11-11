export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

// Task states come from the shared workflow (ADR-0003, ADR-0007); T-4.0 moved the server onto them.
import { ACTIVE_STATUSES, CLOSED_STATUSES, LADDER_STATUSES, STATUSES, type Status } from '@taskwatch/shared/workflow';
export { ACTIVE_STATUSES, CLOSED_STATUSES, LADDER_STATUSES, STATUSES, type Status };

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
/** Work still on someone's plate: neither closed nor a draft (lists, counts, dashboards). */
export const isOpenStatus = (s: string): boolean => s !== 'draft' && !(CLOSED_STATUSES as readonly string[]).includes(s);
export const openSql = (alias = 't') => `${alias}.status not in (${sqlList([...CLOSED_STATUSES, 'draft'])})`;
/** Active statuses (assigned, in progress, blocked, changes requested, reopened): what can be overdue (H3). */
export const activeSql = (alias = 't') => `${alias}.status in (${sqlList(ACTIVE_STATUSES)})`;
/** Statuses the escalation engine evaluates (shared LADDER_STATUSES: active, Blocked, and In review for the past-due floor). */
export const ladderSql = (alias = 't') => `${alias}.status in (${sqlList(LADDER_STATUSES)})`;

export const ROLES = ['ceo', 'cos', 'manager', 'lead', 'staff'] as const;
export type Role = (typeof ROLES)[number];

// Level -1 is "on track"; 0..3 are the four rungs of the ladder.
export const LEVEL_LABELS = ['L0 Reminder', 'L1 Team lead', 'L2 Manager', "L3 Founder's Office"] as const;

export const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

/** WO names for the core states (Open, In progress, Blocked, Done); the rest are prototype extras (D-20). */
export const STATUS_LABELS: Record<Status, string> = {
  draft: 'Draft',
  assigned: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  submitted: 'Submitted for review',
  changes_requested: 'Changes requested',
  reopened: 'Reopened',
  completed: 'Done',
  cancelled: 'Cancelled',
};

export interface RulesConfig {
  /** D2: required update rhythm per priority, in hours. */
  windowsHours: Record<Priority, number>;
  /** D3: silence multiples for L0..L3. */
  multiples: [number, number, number, number];
  /** D3: hours after the due time at which L1, L2 and L3 apply regardless of updates. */
  overdueOffsetsHours: [number, number, number];
  /** D4: hold L0/L1 WhatsApp and email between these local times. */
  quietHours: { enabled: boolean; start: string; end: string };
  /** D7: L3 goes to the CEO as well as the Chief of Staff. */
  l3NotifyCeo: boolean;
  /** FR-9: an acknowledgement silences repeat alerts at that level for this long. */
  ackSnoozeHours: number;
  /** Unacknowledged escalations re-alert every N update windows (0 = never). */
  repeatAfterWindows: number;
  /** ESC-07: the "due soon" notice goes out this many hours before the due time (D-48). */
  dueSoonHours: number;
  /** Acceptance: marking a task Blocked alerts the team lead. */
  blockedAlertsLead: boolean;
}

export const DEFAULT_RULES: RulesConfig = {
  windowsHours: { critical: 4, high: 24, normal: 48, low: 72 },
  multiples: [1, 1.5, 2, 3],
  overdueOffsetsHours: [0, 24, 72],
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
  l3NotifyCeo: true,
  ackSnoozeHours: 12,
  repeatAfterWindows: 1,
  blockedAlertsLead: true,
  dueSoonHours: 24,
};

export type Stage = 'on_track' | 'amber' | 'red';

/** Dashboard bands: L0–L1 are amber, L2–L3 are red. */
export function stageOf(level: number): Stage {
  if (level >= 2) return 'red';
  if (level >= 0) return 'amber';
  return 'on_track';
}

/** TASK-10: a task's stage stripe; the rule is shared with the client. */
export { taskStage } from '@taskwatch/shared/insights';

export function formatHours(hours: number): string {
  const h = Math.max(0, Math.floor(hours));
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem ? `${d} d ${rem} h` : `${d} d`;
}
