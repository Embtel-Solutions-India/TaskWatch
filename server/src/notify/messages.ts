import { config } from '../config.js';
import { formatHours, LEVEL_LABELS, PRIORITY_LABELS, type Priority } from '../domain.js';
import type { LevelResult } from '../engine/levels.js';
import type { DirUser } from '../services/directory.js';
import { formatInZone } from './format.js';

/**
 * One alert as it goes out on every channel. `template` and `params` are the approved
 * WhatsApp template (docs/whatsapp-templates.md); `text` is used for email and in-app.
 */
export interface Message {
  event: string;
  subject: string;
  text: string;
  template: string;
  params: string[];
  taskId: number | null;
  escalationId?: number | null;
  /** L0/L1-class alerts are held during quiet hours (D4); L2/L3 always go out. */
  quietable: boolean;
  /** Escalation level (0–3) for ladder alerts. */
  level?: number;
  /** Optional custom HTML for email (the weekly digest). */
  html?: string;
}

export interface TaskInfo {
  id: number;
  title: string;
  priority: Priority;
  dueAt: Date;
  entityName: string;
}

export function taskLink(taskId: number): string {
  return `${config.appUrl}/tasks/${taskId}`;
}

export function assignedMessage(task: TaskInfo, assigner: DirUser, recipient: DirUser, reassigned = false): Message {
  const due = formatInZone(task.dueAt, recipient.timeZone);
  const priority = PRIORITY_LABELS[task.priority];
  const verb = reassigned ? 'Task reassigned to you' : 'New task';
  return {
    event: reassigned ? 'reassigned' : 'assigned',
    subject: `${verb}: ${task.title}`,
    text: `${verb} from ${assigner.name}: “${task.title}” (${task.entityName}).\nPriority: ${priority}. Due: ${due}.\n\nPost your first update in TaskWatch — only your updates reset the update clock.`,
    template: 'taskwatch_task_assigned',
    params: [assigner.name, task.title, priority, due],
    taskId: task.id,
    quietable: false,
  };
}

function reasonText(level: number, r: LevelResult): string {
  if (r.reason === 'overdue' && level >= 1) {
    return r.overdueHours < 1 ? 'now past due' : `past due by ${formatHours(r.overdueHours)}`;
  }
  if (r.reason === 'blocked' && level >= 1) return 'marked Blocked';
  return `no assignee update for ${formatHours(r.silentHours)}`;
}

export function escalationMessage(
  level: number,
  task: TaskInfo,
  assignee: DirUser,
  r: LevelResult,
  copied: boolean,
  repeat = false,
): Message {
  const label = LEVEL_LABELS[level]!;
  const reason = reasonText(level, r);
  if (level === 0) {
    return {
      event: repeat ? 'repeat' : 'L0',
      subject: `Update needed: ${task.title}`,
      text: `Reminder: there has been no update on “${task.title}” for ${formatHours(r.silentHours)}. Please post an update in TaskWatch.`,
      template: 'taskwatch_update_reminder',
      params: [task.title, formatHours(r.silentHours)],
      taskId: task.id,
      level,
      quietable: true,
    };
  }
  const tag = repeat ? `${label} (still open)` : copied ? `${label} (copy)` : label;
  const ask = copied ? 'You are copied for visibility.' : 'Please review and acknowledge in TaskWatch.';
  return {
    event: repeat ? 'repeat' : `L${level}`,
    subject: `[${tag}] ${task.title} — ${reason}`,
    text: `Escalation ${tag}: “${task.title}” assigned to ${assignee.name} (${task.entityName}, ${PRIORITY_LABELS[task.priority]}) — ${reason}.\n\n${ask}`,
    template: 'taskwatch_escalation',
    params: [tag, task.title, assignee.name, task.entityName, reason],
    taskId: task.id,
    level,
    quietable: level <= 1,
  };
}

export function blockedMessage(task: TaskInfo, assignee: DirUser, reason: string): Message {
  return {
    event: 'blocked',
    subject: `Blocked: ${task.title}`,
    text: `${assignee.name} marked “${task.title}” (${task.entityName}) as Blocked.\nReason: ${reason}`,
    template: 'taskwatch_task_blocked',
    params: [assignee.name, task.title, reason],
    taskId: task.id,
    quietable: true,
  };
}

/** A task notice: in-app by default; email too when the recipient's preferences ask for it (NTF-04). */
export function inAppNotice(event: string, taskId: number, subject: string, text: string): Message {
  return { event, subject, text, template: '', params: [], taskId, quietable: false };
}

export function systemAlertMessage(event: string, subject: string, text: string): Message {
  return {
    event,
    subject,
    text,
    template: 'taskwatch_system_alert',
    params: [text],
    taskId: null,
    quietable: false,
  };
}
