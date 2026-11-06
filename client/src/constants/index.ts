import type { NotificationType, Permission, Priority, Role, RulesConfig, Status } from '../types';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export { ROLE_LABEL } from '@taskwatch/shared/permissions';
/** Seniority rank; higher outranks lower. */
export const ROLE_RANK: Record<Role, number> = { staff: 0, lead: 1, manager: 2, cos: 3, ceo: 4 };

export const PRIORITY_LABEL: Record<Priority, string> = { critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low' };
export const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export const STATUS_LABEL: Record<Status, string> = {
  draft: 'Draft',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  submitted: 'In review',
  changes_requested: 'Changes requested',
  completed: 'Completed',
  reopened: 'Reopened',
  cancelled: 'Cancelled',
};

export const LEVEL_LABEL = ['L0 Reminder', 'L1 Team Lead', 'L2 Manager', "L3 Founder's Office"] as const;
export const LEVEL_SHORT = ['L0', 'L1', 'L2', 'L3'] as const;

export const PERMISSION_LABEL: Record<Permission, string> = {
  view_tasks: 'View tasks',
  create_tasks: 'Create tasks',
  assign_tasks: 'Assign tasks',
  reassign_tasks: 'Reassign tasks',
  update_assigned_tasks: 'Update assigned tasks',
  review_tasks: 'Review tasks',
  approve_extensions: 'Approve extensions',
  manage_team: 'Manage team',
  view_team_reports: 'View team reports',
  view_org_reports: 'View organization reports',
  manage_staff: 'Manage staff',
  manage_roles: 'Manage roles',
  manage_escalation_policies: 'Manage escalation policies',
  view_audit_logs: 'View audit logs',
  manage_system_settings: 'Manage system settings',
};
export const PERMISSION_HELP: Record<Permission, string> = {
  view_tasks: 'See tasks of people in their reporting line (always: own tasks).',
  create_tasks: 'Create new tasks and drafts.',
  assign_tasks: 'Assign tasks to people below them in the hierarchy.',
  reassign_tasks: 'Move a task in their scope to another eligible person.',
  update_assigned_tasks: 'Acknowledge, post progress and submit their own tasks.',
  review_tasks: 'Approve or send back work submitted for review.',
  approve_extensions: 'Decide due-date extension requests in their scope.',
  manage_team: 'Edit team membership within their scope.',
  view_team_reports: 'Accountability reports scoped to their reporting line.',
  view_org_reports: 'Accountability reports across the whole organization.',
  manage_staff: 'Create, edit and deactivate staff accounts.',
  manage_roles: 'Change role permissions and role assignments.',
  manage_escalation_policies: 'Change escalation windows and thresholds.',
  view_audit_logs: 'Read the organization audit log.',
  manage_system_settings: 'Change platform-wide settings.',
};
/** Granting these gives organization-wide reach. */
export const ORG_WIDE_PERMISSIONS: Permission[] = [
  'view_org_reports',
  'manage_staff',
  'manage_roles',
  'manage_escalation_policies',
  'view_audit_logs',
  'manage_system_settings',
];

export const NOTIFICATION_LABEL: Record<NotificationType, string> = {
  assignment: 'New assignment',
  reassignment: 'Reassignment',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  escalation: 'Escalation',
  escalation_ack: 'Escalation acknowledged',
  progress: 'Progress update',
  review_required: 'Review required',
  review_decision: 'Review decision',
  extension_request: 'Extension request',
  extension_decision: 'Extension decision',
  mention: 'Mention',
  completed: 'Task completed',
  blocked: 'Task blocked',
  system_alert: 'System alert',
};

export const DEFAULT_RULES: RulesConfig = {
  windowsHours: { critical: 4, high: 24, normal: 48, low: 72 },
  multiples: [1, 1.5, 2, 3],
  overdueOffsetsHours: [0, 24, 72],
  ackSnoozeHours: 12,
  dueSoonHours: 24,
  quietHours: { enabled: true, start: '21:00', end: '08:00' },
  l3NotifyCeo: true,
};

export { CATEGORIES } from '@taskwatch/shared/settings';
