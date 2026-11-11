// Platform settings (SET-01) — one definition and one set of defaults for server and client (ADR-0007).
import { DEFAULT_STANDARD_TASKS, type StandardTask } from '@taskwatch/shared/standardTasks';

// The server stores only what the Chief of Staff changes (app_state 'settings'); everything else falls back here.

export const CATEGORIES = ['Operations', 'Finance', 'Compliance', 'Client delivery', 'Reporting', 'Hiring', 'IT & Systems', 'Facilities'];

export interface Settings {
  orgName: string;
  timezone: string;
  workdayStart: string;
  workdayEnd: string;
  emailSimulation: boolean;
  /** Simulate WhatsApp Business delivery (templates are rendered, nothing is sent). */
  whatsappSimulation: boolean;
  /** Fixed at 7 (WO retention); shown read-only. */
  retentionYears: number;
  sessionTimeoutMinutes: number;
  categories: string[];
  /** Active tasks above this count flag a person as overloaded on workload charts. */
  overloadThreshold: number;
  /** Weekly digest to Managers and the Founder's Office: weekday (0 = Sun) and hour, in IST (D-14, D-44). */
  digestDay: number;
  digestHour: number;
  /** D-124: each task's weight in the Outcome Score, by priority (1–10). All 1 = equal weights. */
  priorityWeights: { critical: number; high: number; normal: number; low: number };
  /** D-125: standard task times; the task form recommends an estimate from them. */
  standardTasks: StandardTask[];
}

export const DEFAULT_SETTINGS: Settings = {
  orgName: 'Embtel Solutions',
  timezone: 'America/New_York',
  workdayStart: '09:00',
  workdayEnd: '18:00',
  emailSimulation: true,
  whatsappSimulation: true,
  retentionYears: 7,
  sessionTimeoutMinutes: 60,
  categories: CATEGORIES,
  overloadThreshold: 6,
  digestDay: 1,
  digestHour: 9, // WO FR-12: Monday 09:00 IST
  priorityWeights: { critical: 1, high: 1, normal: 1, low: 1 },
  standardTasks: DEFAULT_STANDARD_TASKS,
};
