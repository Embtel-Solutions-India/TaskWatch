// Roles and permissions live in the shared rules module (ADR-0004, ADR-0007), the same lists the server uses.
export { PERMISSIONS, ROLES } from '@taskwatch/shared/permissions';
export type { Permission, Role } from '@taskwatch/shared/permissions';
import type { Permission, Role } from '@taskwatch/shared/permissions';

export type Priority = 'critical' | 'high' | 'normal' | 'low';
export const PRIORITIES: Priority[] = ['critical', 'high', 'normal', 'low'];

// Task states live in the shared rules module (ADR-0003, ADR-0007), the same list the server uses.
export { ACTIVE_STATUSES, CLOSED_STATUSES, STATUSES } from '@taskwatch/shared/workflow';
export type { Status } from '@taskwatch/shared/workflow';
import type { Status } from '@taskwatch/shared/workflow';

export interface User {
  id: string;
  name: string;
  email: string;
  title: string;
  role: Role;
  managerId: string | null;
  teamId: string | null;
  status: 'active' | 'inactive';
  joinedAt: string;
  location: string;
  phone: string;
  /** International-format WhatsApp number; null = no WhatsApp alerts. */
  whatsapp: string | null;
  /** Has agreed to receive work alerts on WhatsApp. */
  whatsappOptIn: boolean;
  /** Recipient time zone, used for quiet hours. */
  timezone: string;
  /** Server mode: own quiet hours (D-105); null = the organization's. */
  quietStart?: string | null;
  quietEnd?: string | null;
}

export interface Department {
  id: string;
  name: string;
  headId: string | null;
}

export interface Team {
  id: string;
  name: string;
  departmentId: string;
  leadId: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  instructions: string;
  category: string;
  priority: Priority;
  status: Status;
  assigneeId: string;
  createdBy: string;
  assignedBy: string;
  reviewerId: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  startAt: string | null;
  dueAt: string;
  /** Last assignee progress update, or the (re)assignment time. Drives the silence clock. */
  clockStartedAt: string;
  acknowledgedAt: string | null;
  /** Acknowledgement suppresses repeat notifications until this time. Never resets clocks. */
  snoozeUntil: string | null;
  progress: number;
  reviewRequired: boolean;
  parentId: string | null;
  recurrenceId: string | null;
  occurrenceDate: string | null;
  cancelReason: string | null;
  completedAt: string | null;
}

export type ActivityType =
  | 'created'
  | 'assigned'
  | 'reassigned'
  | 'status_changed'
  | 'due_changed'
  | 'progress'
  | 'acknowledged'
  | 'extension_requested'
  | 'extension_decided'
  | 'comment'
  | 'review_submitted'
  | 'review_decided'
  | 'escalated'
  | 'escalation_acknowledged'
  | 'completed'
  | 'reopened'
  | 'cancelled'
  | 'attachment_added'
  | 'attachment_removed'
  | 'edited';

export interface Activity {
  id: string;
  taskId: string;
  type: ActivityType;
  actorId: string | null;
  at: string;
  text: string;
  data?: Record<string, string | number | null>;
}

export interface Comment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  at: string;
  editedAt: string | null;
  parentId: string | null;
  deleted: boolean;
}

export interface ProgressUpdate {
  id: string;
  taskId: string;
  authorId: string;
  message: string;
  percent: number;
  at: string;
  attachmentIds: string[];
}

export interface Attachment {
  id: string;
  taskId: string;
  name: string;
  size: number;
  mime: string;
  uploadedBy: string;
  at: string;
  context: 'task' | 'progress' | 'comment' | 'review';
}

export interface Review {
  id: string;
  taskId: string;
  round: number;
  submittedBy: string;
  submittedAt: string;
  note: string;
  reviewerId: string | null;
  decision: 'approved' | 'changes_requested' | 'rejected' | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface Extension {
  id: string;
  taskId: string;
  requestedBy: string;
  at: string;
  currentDue: string;
  requestedDue: string;
  reason: string;
  info: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface Assignment {
  id: string;
  taskId: string;
  fromId: string | null;
  toId: string;
  byId: string;
  at: string;
  reason: string;
}

export interface EscalationEvent {
  id: string;
  taskId: string;
  level: number;
  /** `blocked`: the task was marked Blocked (D-24, WO ladder L1). */
  reason: 'silence' | 'overdue' | 'blocked';
  /** The moment the level was reached (may be earlier than when the tick noticed it). */
  at: string;
  /** Silence-cycle start this event belongs to; each level fires once per cycle. */
  cycle: string;
  recipientIds: string[];
  /** Copied per the work order: L1 copies the assignee, L2 the lead and assignee, L3 the manager. */
  ccIds: string[];
  status: 'active' | 'acknowledged' | 'resolved';
  ackBy: string | null;
  ackAt: string | null;
  resolvedAt: string | null;
  lastNotifiedAt: string;
  /** WO FR-9: the acknowledgement note (server mode). */
  ackNote?: string | null;
  /** Server mode: the viewer may acknowledge this event (ESC-06). */
  canAck?: boolean;
}

// Notification types and preferences live in the shared module (NTF-04, ADR-0007), the same lists the server uses.
export type { NotificationPrefs, NotificationType } from '@taskwatch/shared/notifications';
import type { NotificationPrefs, NotificationType } from '@taskwatch/shared/notifications';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string | null;
  at: string;
  read: boolean;
  /** Simulated email; nothing is actually sent. */
  emailSimulated: boolean;
  /** Server mode: the email/WhatsApp status of this notification (NTF-01-AC-4). */
  deliveries?: { channel: Channel; status: Delivery['status'] }[];
}

export type Channel = 'email' | 'whatsapp';
export type WhatsAppTemplate = 'taskwatch_task_assigned' | 'taskwatch_update_reminder' | 'taskwatch_escalation' | 'taskwatch_task_blocked' | 'taskwatch_system_alert';

/** One outbound email or WhatsApp message. Simulated: nothing leaves the browser. */
export interface Delivery {
  id: string;
  /** Null for scheduled mail such as the weekly digest. */
  notificationId: string | null;
  kind: 'alert' | 'digest';
  /** Week the digest covers (YYYY-MM-DD of its Monday). */
  digestWeek: string | null;
  userId: string;
  channel: Channel;
  address: string | null;
  /** Email subject. */
  subject: string | null;
  /** Email body, or the rendered WhatsApp template text. */
  body: string;
  template: WhatsAppTemplate | null;
  templateParams: string[] | null;
  link: string | null;
  taskId: string | null;
  level: number | null;
  createdAt: string;
  /** The prototype uses sent/held/skipped; the server also reports pending, sending, simulated and failed (NTF-02). */
  status: 'sent' | 'held' | 'skipped' | 'pending' | 'sending' | 'simulated' | 'failed';
  heldUntil: string | null;
  sentAt: string | null;
  reason: string | null;
  /** Server mode: recipient name and whether they were copied (DLV-01-AC-5). */
  recipientName?: string;
  copied?: boolean;
}

export interface AuditRecord {
  id: string;
  at: string;
  actorId: string | null;
  action: string;
  targetType: 'task' | 'user' | 'role' | 'policy' | 'settings' | 'team' | 'recurrence' | 'demo';
  targetId: string;
  taskId: string | null;
  prev: string | null;
  next: string | null;
  source: 'ui' | 'demo' | 'system';
  context: string;
}

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'interval';

export interface Recurrence {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: Priority;
  assigneeId: string;
  createdBy: string;
  teamId: string | null;
  reviewRequired: boolean;
  frequency: Frequency;
  /** For 'interval': every N days. For others: every N units. */
  interval: number;
  weekdays: number[];
  startDate: string;
  endDate: string | null;
  dueHour: number;
  active: boolean;
  createdAt: string;
}

export interface RulesConfig {
  windowsHours: Record<Priority, number>;
  multiples: [number, number, number, number];
  overdueOffsetsHours: [number, number, number];
  ackSnoozeHours: number;
  dueSoonHours: number;
  quietHours: { enabled: boolean; start: string; end: string };
  /** Decision D7: L3 goes to the CEO as well as the Chief of Staff. */
  l3NotifyCeo: boolean;
}

export type { Settings } from '@taskwatch/shared/settings';
import type { Settings } from '@taskwatch/shared/settings';


export interface Db {
  version: number;
  seededAt: string;
  clockOffsetMs: number;
  seq: number;
  users: User[];
  departments: Department[];
  teams: Team[];
  tasks: Task[];
  activities: Activity[];
  comments: Comment[];
  updates: ProgressUpdate[];
  attachments: Attachment[];
  reviews: Review[];
  extensions: Extension[];
  assignments: Assignment[];
  escalations: EscalationEvent[];
  notifications: Notification[];
  deliveries: Delivery[];
  audit: AuditRecord[];
  recurrences: Recurrence[];
  rolePermissions: Record<Role, readonly Permission[]>;
  rules: RulesConfig;
  settings: Settings;
  prefs: Record<string, NotificationPrefs>;
  passwordResets: { email: string; token: string; at: string }[];
}
