// Demo-only controls: clock, reset and scripted scenarios. Not a production feature.
import { HOUR } from '../../constants';
import type { Db, Priority, Task } from '../../types';
import { audit, createTaskRecord, iso, logActivity, nextId, processEscalations, runTicks } from '../core';
import { commit, getDb, now, resetDb } from '../mock/store';
import { switchUser } from './misc';

export function advanceClock(hours: number): void {
  const db = getDb();
  db.clockOffsetMs += hours * HOUR;
  runTicks(db, now());
  audit(db, { at: iso(now()), actorId: null, action: 'demo.clock_advanced', targetType: 'demo', targetId: 'clock', taskId: null, prev: null, next: `+${hours} h`, source: 'demo', context: 'Simulated time' });
  commit();
}

export function resetClock(): void {
  const db = getDb();
  db.clockOffsetMs = 0;
  runTicks(db, now());
  commit();
}

export function resetDemoData(): void {
  resetDb();
}

export function clockOffsetHours(): number {
  return getDb().clockOffsetMs / HOUR;
}

interface Made {
  task: Task;
}

function make(db: Db, o: { title: string; priority: Priority; assigneeId: string; giverId: string; ageH: number; dueInH: number; silentH?: number; status?: Task['status']; review?: boolean; ack?: boolean }): Made {
  const t0 = now();
  const createdAt = iso(t0 - o.ageH * HOUR);
  const assignee = db.users.find((u) => u.id === o.assigneeId)!;
  const task = createTaskRecord(
    db,
    {
      title: `[Demo] ${o.title}`,
      description: 'Scenario task created by demo mode. Follow the scenario steps shown in the demo panel.',
      category: 'Operations',
      priority: o.priority,
      assigneeId: o.assigneeId,
      teamId: assignee.teamId,
      dueAt: iso(t0 + o.dueInH * HOUR),
      reviewRequired: o.review ?? false,
    },
    o.giverId,
    createdAt,
  );
  if (o.ack) {
    task.acknowledgedAt = iso(Date.parse(createdAt) + 0.25 * HOUR);
    logActivity(db, task.id, 'acknowledged', o.assigneeId, 'Acknowledged the task', task.acknowledgedAt);
  }
  if (o.status && o.status !== 'assigned') {
    const startAt = iso(Date.parse(createdAt) + 0.5 * HOUR);
    task.status = 'in_progress';
    logActivity(db, task.id, 'status_changed', o.assigneeId, 'Started work', startAt, { from: 'assigned', to: 'in_progress' });
    const updAt = iso(t0 - (o.silentH ?? 1) * HOUR);
    db.updates.push({ id: nextId(db, 'upd'), taskId: task.id, authorId: o.assigneeId, message: 'First pass done; working through the remaining items.', percent: 40, at: updAt, attachmentIds: [] });
    logActivity(db, task.id, 'progress', o.assigneeId, 'Progress update · 40%', updAt, { percent: 40 });
    task.progress = 40;
    task.clockStartedAt = updAt;
  } else if (o.silentH !== undefined) {
    task.clockStartedAt = iso(t0 - o.silentH * HOUR);
  }
  return { task };
}

function submit(db: Db, task: Task, round: number, at: number) {
  db.reviews.push({ id: nextId(db, 'rev'), taskId: task.id, round, submittedBy: task.assigneeId, submittedAt: iso(at), note: round > 1 ? 'Updated per feedback.' : 'Ready for review — reconciliation attached.', reviewerId: null, decision: null, decidedAt: null, comment: null });
  logActivity(db, task.id, 'review_submitted', task.assigneeId, `Submitted for review (round ${round})`, iso(at));
  task.status = 'submitted';
  task.clockStartedAt = iso(at);
}

export interface Scenario {
  id: string;
  title: string;
  actAs: string;
  steps: string[];
  run: (db: Db) => string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 's1',
    title: 'Staff receives and acknowledges a task',
    actAs: 'u-s1',
    steps: ['You are Sam Whitfield (Staff).', 'Open the new task from Marcus Bell.', 'Click "Acknowledge". Notifications are snoozed 12 h, but the silence clock keeps running.'],
    run: (db) => `/tasks/${make(db, { title: 'Confirm carrier pickup windows', priority: 'high', assigneeId: 'u-s1', giverId: 'u-l1', ageH: 0.2, dueInH: 30 }).task.id}`,
  },
  {
    id: 's2',
    title: 'Staff updates progress',
    actAs: 'u-s1',
    steps: ['The task is a Critical task, silent for 3.5 h (L0 is 30 min away).', 'Click "Post update", write a note and set progress.', 'The silence clock resets; comments would not.'],
    run: (db) => `/tasks/${make(db, { title: 'Fix mislabeled outbound pallets', priority: 'critical', assigneeId: 'u-s1', giverId: 'u-l1', ageH: 5, dueInH: 20, silentH: 3.5, status: 'in_progress', ack: true }).task.id}`,
  },
  {
    id: 's3',
    title: 'Task becomes overdue',
    actAs: 'u-s2',
    steps: ['This High task is due in 30 minutes.', 'Use "+1 h" in the demo bar.', 'The task turns Overdue and jumps to L1 (past-due floor) and the lead is alerted.'],
    run: (db) => `/tasks/${make(db, { title: 'Submit cycle-count variance', priority: 'high', assigneeId: 'u-s2', giverId: 'u-l1', ageH: 10, dueInH: 0.5, silentH: 2, status: 'in_progress', ack: true }).task.id}`,
  },
  {
    id: 's4',
    title: 'Task escalates from L0 to L1',
    actAs: 'u-l1',
    steps: ['You are Marcus Bell (Team Lead).', 'A Critical task has been silent 4.5 h: it is at L0.', 'Use "+2 h" in the demo bar: at 6 h silence it reaches L1 and you are notified.', 'Acknowledge the escalation — the level does not drop.'],
    run: (db) => {
      const { task } = make(db, { title: 'Recover missing shipment manifest', priority: 'critical', assigneeId: 'u-s3', giverId: 'u-l1', ageH: 6, dueInH: 24, silentH: 4.5, status: 'in_progress', ack: true });
      processEscalations(db, now());
      return `/tasks/${task.id}`;
    },
  },
  {
    id: 's5',
    title: 'Senior reviews an extension request',
    actAs: 'u-l1',
    steps: ['You are Marcus Bell (Team Lead).', 'Nina Kovac asked to move a due date by 3 days.', 'Approve or reject it from Extensions. Approval moves the due date and recalculates escalation.'],
    run: (db) => {
      const { task } = make(db, { title: 'Quarterly stock write-off schedule', priority: 'normal', assigneeId: 'u-s2', giverId: 'u-l1', ageH: 30, dueInH: 10, silentH: 5, status: 'in_progress', ack: true });
      const at = iso(now() - HOUR);
      db.extensions.push({ id: nextId(db, 'ext'), taskId: task.id, requestedBy: 'u-s2', at, currentDue: task.dueAt, requestedDue: iso(Date.parse(task.dueAt) + 72 * HOUR), reason: 'Finance has not closed the month yet; numbers will move.', info: 'Expected close is Thursday.', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null });
      logActivity(db, task.id, 'extension_requested', 'u-s2', 'Requested a 3-day extension', at);
      db.notifications.push({ id: nextId(db, 'ntf'), userId: 'u-l1', type: 'extension_request', title: `${task.id}: extension requested`, body: 'Nina Kovac asks for 3 more days', taskId: task.id, at, read: false, emailSimulated: true });
      return '/extensions';
    },
  },
  {
    id: 's6',
    title: 'Task is reassigned',
    actAs: 'u-l1',
    steps: ['You are Marcus Bell (Team Lead).', 'Theo Mensah is overloaded on this task.', 'Click "Reassign", choose Diego Alvarez and give a reason. History and escalation events are kept.'],
    run: (db) => `/tasks/${make(db, { title: 'Build weekend dispatch schedule', priority: 'high', assigneeId: 'u-s3', giverId: 'u-l1', ageH: 26, dueInH: 12, silentH: 25, status: 'in_progress', ack: true }).task.id}`,
  },
  {
    id: 's7',
    title: 'Task is submitted for review',
    actAs: 'u-s1',
    steps: ['You are Sam Whitfield (Staff).', 'This task requires review.', 'Click "Submit for review" with a summary. "Mark complete" is not offered because review is required.'],
    run: (db) => `/tasks/${make(db, { title: 'Draft revised courier SLA', priority: 'normal', assigneeId: 'u-s1', giverId: 'u-l1', ageH: 20, dueInH: 28, silentH: 2, status: 'in_progress', review: true, ack: true }).task.id}`,
  },
  {
    id: 's8',
    title: 'Reviewer requests changes',
    actAs: 'u-l1',
    steps: ['You are Marcus Bell (Team Lead).', 'Nina Kovac submitted work for review.', 'Click "Review", choose "Request changes" and explain. The task returns to Nina.'],
    run: (db) => {
      const { task } = make(db, { title: 'Inventory shrinkage analysis', priority: 'high', assigneeId: 'u-s2', giverId: 'u-l1', ageH: 30, dueInH: 18, silentH: 4, status: 'in_progress', review: true, ack: true });
      submit(db, task, 1, now() - HOUR);
      return `/tasks/${task.id}`;
    },
  },
  {
    id: 's9',
    title: 'Staff resubmits and task is approved',
    actAs: 'u-s1',
    steps: ['You are Sam Whitfield (Staff). Changes were requested on round 1.', 'Click "Start work", then "Submit for review" again.', 'Switch to Marcus Bell (Team Lead) and approve: the task completes.'],
    run: (db) => {
      const { task } = make(db, { title: 'Carrier performance scorecard', priority: 'normal', assigneeId: 'u-s1', giverId: 'u-l1', ageH: 50, dueInH: 30, silentH: 6, status: 'in_progress', review: true, ack: true });
      submit(db, task, 1, now() - 5 * HOUR);
      const r = db.reviews.filter((x) => x.taskId === task.id).at(-1)!;
      Object.assign(r, { reviewerId: 'u-l1', decision: 'changes_requested', decidedAt: iso(now() - 3 * HOUR), comment: 'Add on-time % by carrier and resubmit.' });
      logActivity(db, task.id, 'review_decided', 'u-l1', 'Requested changes: Add on-time % by carrier and resubmit.', iso(now() - 3 * HOUR));
      task.status = 'changes_requested';
      task.clockStartedAt = iso(now() - 3 * HOUR);
      return `/tasks/${task.id}`;
    },
  },
  {
    id: 's10',
    title: 'Chief of Staff manages staff and roles',
    actAs: 'u-cos',
    steps: ['You are Elena Marsh (Chief of Staff).', 'Add a person, change a manager, deactivate someone in Staff Management.', 'Then open Roles & Permissions and adjust the Team Lead matrix (you will be asked to confirm).'],
    run: () => '/admin/staff',
  },
  {
    id: 's11',
    title: 'Chief of Staff reviews an organization-wide escalation',
    actAs: 'u-cos',
    steps: ['You are Elena Marsh (Chief of Staff).', 'A Critical Support task is at L3. Its lead (Aisha Bello) has no manager, so L2 routed straight to you.', 'Open Escalations, filter L3, open the task and acknowledge or reassign.'],
    run: (db) => {
      make(db, { title: 'Customer data export failing for enterprise tier', priority: 'critical', assigneeId: 'u-s16', giverId: 'u-l6', ageH: 16, dueInH: -2, silentH: 13, status: 'in_progress', ack: true });
      processEscalations(db, now());
      return '/escalations?level=3';
    },
  },
  {
    id: 's12',
    title: 'Unauthorized user attempts to access a restricted task',
    actAs: 'u-s14',
    steps: ['You are Elif Demir (Support staff).', 'You are sent straight to a Logistics task URL.', 'Access is denied both by the route guard and by the data service.'],
    run: (db) => `/tasks/${make(db, { title: 'Confidential: carrier contract renegotiation', priority: 'high', assigneeId: 'u-s1', giverId: 'u-l1', ageH: 4, dueInH: 40 }).task.id}`,
  },
];

export function runScenario(id: string): { path: string; scenario: Scenario } {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (!scenario) throw new Error('Unknown scenario');
  const db = getDb();
  const path = scenario.run(db);
  audit(db, { at: iso(now()), actorId: null, action: 'demo.scenario_loaded', targetType: 'demo', targetId: id, taskId: null, prev: null, next: scenario.title, source: 'demo', context: 'Demo mode' });
  commit();
  switchUser(scenario.actAs);
  return { path, scenario };
}
