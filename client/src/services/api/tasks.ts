import { mentionedNames } from '@taskwatch/shared/notifications';
import { overlaps as overlapsOf } from '@taskwatch/shared/schedule';
import { DEFAULT_STANDARD_TASKS, type StandardTask } from '@taskwatch/shared/standardTasks';
import { HOUR, LEVEL_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '../../constants';
import type { Attachment, Db, Priority, Task, User } from '../../types';
import { PRIORITIES } from '../../types';
import { ApiError, assertCanViewTask, assertPerm, assignableUsers, canAssignTo, canViewTask, hasPerm, isOverseer, reportsOf } from '../authz/permissions';
import { audit, createTaskRecord, iso, logActivity, ms, nextId, notify, processEscalations, recordAssignment, userName } from '../core';
import { allowedActions, assertAction, assertTransition } from '../engine/workflow';
import { now } from '../mock/store';
import { BACKEND } from '../http';
import type { RulesConfig } from '../../types';
import { findTask, invalid, mutate, read, toView, visibleTasks, type TaskView } from './base';
import { serverAttachmentUrl, tasksServer } from './tasksServer';

// File contents live only in this browser tab (object URLs). Nothing is uploaded anywhere.
const blobs = new Map<string, string>();
export function attachmentUrl(id: string): string | undefined {
  if (BACKEND === 'server') return serverAttachmentUrl(id);
  return blobs.get(id);
}

export type TaskScope = 'mine' | 'assigned_by_me' | 'team' | 'all';

export function listTasks(scope: TaskScope): TaskView[] | Promise<TaskView[]> {
  if (BACKEND === 'server') return tasksServer.list(scope);
  return read((db, user) => {
    let rows = visibleTasks(db, user);
    if (scope === 'mine') rows = rows.filter((t) => t.assigneeId === user.id && t.status !== 'draft');
    if (scope === 'assigned_by_me') {
      assertPerm(db, user, 'create_tasks', 'see tasks you assigned');
      rows = rows.filter((t) => t.assignedBy === user.id || t.createdBy === user.id);
    }
    if (scope === 'team') {
      assertPerm(db, user, 'view_tasks', 'view team tasks');
      const reports = user.role === 'cos' ? null : reportsOf(db, user.id);
      rows = rows.filter((t) => t.status !== 'draft' && (reports ? reports.has(t.assigneeId) : t.assigneeId !== user.id));
    }
    return rows.map((t) => ({
      ...toView(db, t),
      escalatedToMe: db.escalations.some((e) => e.taskId === t.id && e.level >= 1 && e.status !== 'resolved' && e.recipientIds.includes(user.id)),
    }));
  });
}

export function getTask(id: string): TaskDetail | Promise<TaskDetail> {
  return BACKEND === 'server' ? tasksServer.get(id) : mockGetTask(id);
}

function mockGetTask(id: string) {
  return read((db, user) => {
    const task = findTask(db, id);
    assertCanViewTask(db, user, task);
    const by = <T extends { taskId: string }>(arr: T[]) => arr.filter((x) => x.taskId === id);
    return {
      task: toView(db, task),
      activities: by(db.activities).sort((a, b) => b.at.localeCompare(a.at)),
      comments: by(db.comments),
      updates: by(db.updates).sort((a, b) => b.at.localeCompare(a.at)),
      attachments: by(db.attachments.filter((x) => !x.removedAt)),
      reviews: by(db.reviews).sort((a, b) => a.round - b.round),
      extensions: by(db.extensions).sort((a, b) => b.at.localeCompare(a.at)),
      assignments: by(db.assignments).sort((a, b) => a.at.localeCompare(b.at)),
      escalations: by(db.escalations).sort((a, b) => a.at.localeCompare(b.at)),
      actions: [...allowedActions(db, user, task)],
      parent: task.parentId ? db.tasks.find((t) => t.id === task.parentId && canViewTask(db, user, t)) ?? null : null,
      children: db.tasks.filter((t) => t.parentId === id && canViewTask(db, user, t)).map((t) => toView(db, t)),
      recurrence: task.recurrenceId ? db.recurrences.find((r) => r.id === task.recurrenceId) ?? null : null,
      users: db.users,
    };
  });
}

/** Server mode adds the task's entity rules (the page shows their thresholds) and its working time against the standard (D-125). */
export type TaskDetail = ReturnType<typeof mockGetTask> & { rules?: RulesConfig; time?: { worked: number; standard: number } | null };

export interface TaskInput {
  title: string;
  description: string;
  instructions: string;
  category: string;
  priority: Priority;
  assigneeId: string;
  teamId: string | null;
  dueDate: string;
  dueTime: string;
  startDate: string;
  /** D-144: scheduled start time (HH:MM); used only with a start date. */
  startTime: string;
  /** ADR-0014: what the assignee must hand in. */
  submissionRequirements: string;
  /** Who reviews when review is required; '' = the giver. */
  reviewerId: string;
  /** D-153 (new tasks only): more people, one task each, with the same fields. */
  alsoAssigneeIds: string[];
  reviewRequired: boolean;
  parentId: string;
  draft: boolean;
  files: File[];
  /** PERF: form strings; empty = not set. */
  target: string;
  unit: string;
  estimatedHours: string;
  purpose: '' | 'revenue' | 'support';
}

function validateTaskInput(db: Db, user: User, input: TaskInput, at: number, existing?: Task): string {
  const f: Record<string, string> = {};
  if (input.title.trim().length < 4) f.title = 'Give the task a title of at least 4 characters.';
  if (input.title.length > 140) f.title = 'Keep the title under 140 characters.';
  if (!PRIORITIES.includes(input.priority)) f.priority = 'Choose a priority.';
  if (!input.assigneeId) f.assigneeId = 'Choose who will do this.';
  else if ((!existing || existing.assigneeId !== input.assigneeId) && !canAssignTo(db, user, input.assigneeId))
    f.assigneeId = 'You can only assign to people below you in the reporting line.';
  if (!input.dueDate) f.dueDate = 'Set a due date.';
  const due = new Date(`${input.dueDate}T${input.dueTime || '17:00'}`).getTime();
  if (input.dueDate && Number.isNaN(due)) f.dueDate = 'Enter a valid date.';
  else if (input.dueDate && due <= at && (!existing || iso(due) !== existing.dueAt)) f.dueDate = 'The due time must be in the future.';
  if (input.startDate && new Date(`${input.startDate}T${input.startTime || '00:00'}`).getTime() >= due) f.startDate = 'The scheduled start must be before the due time.';
  if (input.reviewRequired && input.reviewerId && input.reviewerId === input.assigneeId) f.reviewerId = 'The assignee cannot review their own work.';
  if (input.parentId && !db.tasks.some((t) => t.id === input.parentId && canViewTask(db, user, t))) f.parentId = 'Pick a parent task you can see.';
  if (existing && input.parentId === existing.id) f.parentId = 'A task cannot be its own parent.';
  if (Object.keys(f).length) invalid(f);
  return iso(due);
}

function addFiles(db: Db, taskId: string, files: File[], by: string, at: string, context: Attachment['context']): string[] {
  const ids: string[] = [];
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) throw new ApiError(422, `${file.name} is larger than 15 MB.`); // D-13 / D-69
    const a: Attachment = { id: nextId(db, 'att'), taskId, name: file.name, size: file.size, mime: file.type || 'application/octet-stream', uploadedBy: by, at, context };
    db.attachments.push(a);
    try {
      blobs.set(a.id, URL.createObjectURL(file));
    } catch {
      /* non-browser */
    }
    logActivity(db, taskId, 'attachment_added', by, `Attached ${file.name}`, at);
    ids.push(a.id);
  }
  return ids;
}

export function createTask(input: TaskInput): Task | Promise<Task> {
  if (BACKEND === 'server') return tasksServer.create(input);
  return mutate((db, user, at) => {
    assertPerm(db, user, 'create_tasks', 'create tasks');
    if (!input.draft) assertPerm(db, user, 'assign_tasks', 'assign tasks');
    const everyone = [input.assigneeId, ...input.alsoAssigneeIds];
    for (const a of everyone) validateTaskInput(db, user, { ...input, assigneeId: a }, now()); // D-153: all or none
    const made = everyone.map((a) => createOne(db, user, at, { ...input, assigneeId: a }));
    return made[0]!;
  });
}

function createOne(db: Db, user: User, at: string, input: TaskInput): Task {
  {
    const dueAt = validateTaskInput(db, user, input, now());
    const assignee = db.users.find((u) => u.id === input.assigneeId)!;
    const task = createTaskRecord(
      db,
      {
        title: input.title.trim(),
        description: input.description.trim(),
        instructions: input.instructions.trim(),
        category: input.category,
        priority: input.priority,
        assigneeId: input.assigneeId,
        teamId: input.teamId || assignee.teamId,
        dueAt,
        startAt: input.startDate ? iso(new Date(`${input.startDate}T${input.startTime || '09:00'}`).getTime()) : null,
        reviewRequired: input.reviewRequired,
        parentId: input.parentId || null,
        draft: input.draft,
      },
      user.id,
      at,
      input.instructions.trim() ? `Instructions: ${input.instructions.trim()}` : '',
    );
    addFiles(db, task.id, input.files, user.id, at, 'task');
    if (input.reviewRequired && input.reviewerId) task.reviewerId = input.reviewerId;
    task.submissionRequirements = input.submissionRequirements.trim() || null;
    audit(db, { at, actorId: user.id, action: input.draft ? 'task.draft_created' : 'task.created', targetType: 'task', targetId: task.id, taskId: task.id, prev: null, next: `${task.title} → ${assignee.name}`, source: 'ui', context: `${PRIORITY_LABEL[task.priority]} · due ${dueAt.slice(0, 16).replace('T', ' ')}` });
    return task;
  }
}

export function updateTask(id: string, input: TaskInput): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.update(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'edit', 'edit this task');
    const dueAt = validateTaskInput(db, user, input, now(), task);
    const changes: string[] = [];
    if (task.title !== input.title.trim()) changes.push('title');
    if (task.priority !== input.priority) {
      changes.push(`priority ${PRIORITY_LABEL[task.priority]} → ${PRIORITY_LABEL[input.priority]}`);
    }
    if (task.dueAt !== dueAt) {
      logActivity(db, id, 'due_changed', user.id, `Due date changed to ${dueAt.slice(0, 10)}`, at, { from: task.dueAt, to: dueAt });
      audit(db, { at, actorId: user.id, action: 'task.due_changed', targetType: 'task', targetId: id, taskId: id, prev: task.dueAt, next: dueAt, source: 'ui', context: 'Edited by task giver' });
    }
    if (task.assigneeId !== input.assigneeId) {
      recordAssignment(db, task, task.assigneeId, input.assigneeId, user.id, at, 'Changed while editing');
      task.assigneeId = input.assigneeId;
      task.clockStartedAt = at;
      task.acknowledgedAt = null;
    }
    Object.assign(task, {
      title: input.title.trim(),
      description: input.description.trim(),
      instructions: input.instructions.trim(),
      category: input.category,
      priority: input.priority,
      teamId: input.teamId || task.teamId,
      dueAt,
      reviewRequired: input.reviewRequired,
      parentId: input.parentId || null,
      startAt: input.startDate ? iso(new Date(input.startDate + 'T09:00').getTime()) : null,
      updatedAt: at,
    });
    addFiles(db, id, input.files, user.id, at, 'task');
    logActivity(db, id, 'edited', user.id, changes.length ? `Edited ${changes.join(', ')}` : 'Edited task details', at);
    processEscalations(db, now());
  });
}

function setStatus(db: Db, task: Task, to: Task['status'], actor: string, at: string, text: string) {
  assertTransition(task, to);
  const from = task.status;
  task.status = to;
  task.updatedAt = at;
  logActivity(db, task.id, 'status_changed', actor, text, at, { from, to });
  audit(db, { at, actorId: actor, action: 'task.status_changed', targetType: 'task', targetId: task.id, taskId: task.id, prev: STATUS_LABEL[from], next: STATUS_LABEL[to], source: 'ui', context: text });
}

export function publishTask(id: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.publish(id);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'publish', 'assign this draft');
    if (!canAssignTo(db, user, task.assigneeId)) throw new ApiError(403, 'The selected assignee is outside your scope.');
    if (ms(task.dueAt) <= now()) throw new ApiError(422, 'Move the due date into the future before assigning.');
    setStatus(db, task, 'assigned', user.id, at, 'Published draft');
    task.clockStartedAt = at;
    recordAssignment(db, task, null, task.assigneeId, user.id, at, 'Published from draft');
  });
}

export function acknowledgeTask(id: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.acknowledge(id);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'acknowledge', 'acknowledge');
    task.acknowledgedAt = at;
    // Suppresses repeat notifications only. Escalation and silence clocks keep running.
    task.snoozeUntil = iso(now() + db.rules.ackSnoozeHours * HOUR);
    logActivity(db, id, 'acknowledged', user.id, 'Acknowledged the task', at);
    audit(db, { at, actorId: user.id, action: 'task.acknowledged', targetType: 'task', targetId: id, taskId: id, prev: null, next: 'Acknowledged', source: 'ui', context: `Notifications snoozed ${db.rules.ackSnoozeHours} h` });
  });
}

export function startTask(id: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.start(id);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'start', 'start work');
    setStatus(db, task, 'in_progress', user.id, at, 'Started work');
    if (!task.acknowledgedAt) task.acknowledgedAt = at;
  });
}

/** PERF: what the assignee reports when finishing (server mode; the prototype ignores it). */
export interface FinishReport {
  achieved?: number;
  result?: string;
  shortfallReason?: string;
}

export function postProgress(id: string, input: { message: string; percent: number; achieved?: number; files: File[] }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.progress(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'progress', 'post a progress update');
    const f: Record<string, string> = {};
    if (input.message.trim().length < 5) f.message = 'Describe what changed (at least 5 characters).';
    if (!(input.percent >= 0 && input.percent <= 100)) f.percent = 'Progress must be between 0 and 100.';
    if (Object.keys(f).length) invalid(f);
    const attachmentIds = addFiles(db, id, input.files, user.id, at, 'progress');
    db.updates.push({ id: nextId(db, 'upd'), taskId: id, authorId: user.id, message: input.message.trim(), percent: input.percent, at, attachmentIds });
    if (task.status === 'assigned' || task.status === 'reopened' || task.status === 'changes_requested') setStatus(db, task, 'in_progress', user.id, at, 'Started work');
    task.progress = input.percent;
    task.clockStartedAt = at; // An assignee progress update resets the silence clock.
    task.updatedAt = at;
    if (!task.acknowledgedAt) task.acknowledgedAt = at;
    logActivity(db, id, 'progress', user.id, `Progress update · ${input.percent}%`, at, { percent: input.percent });
    notify(db, [task.assignedBy], 'progress', `${task.id}: ${input.percent}% complete`, input.message.trim().slice(0, 120), id, at);
    processEscalations(db, now());
  });
}

export function submitForReview(id: string, input: { note: string; files: File[] } & FinishReport): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.submit(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'submit', 'submit for review');
    if (input.note.trim().length < 5) invalid({ note: 'Summarize what you are submitting.' });
    addFiles(db, id, input.files, user.id, at, 'review');
    const round = db.reviews.filter((r) => r.taskId === id).length + 1;
    db.reviews.push({ id: nextId(db, 'rev'), taskId: id, round, submittedBy: user.id, submittedAt: at, note: input.note.trim(), reviewerId: null, decision: null, decidedAt: null, comment: null });
    setStatus(db, task, 'submitted', user.id, at, `Submitted for review (round ${round})`);
    task.clockStartedAt = at;
    logActivity(db, id, 'review_submitted', user.id, `Submitted for review (round ${round})`, at);
    const reviewers = [task.reviewerId, task.assignedBy].filter((x) => x !== user.id);
    notify(db, reviewers, 'review_required', `${task.id} needs your review`, task.title, id, at);
    processEscalations(db, now());
  });
}

export function completeTask(id: string, note: string, report: FinishReport = {}): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.complete(id, note, report);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'complete', 'complete this task');
    if (task.reviewRequired) throw new ApiError(409, 'This task requires review approval before it can be completed.');
    setStatus(db, task, 'completed', user.id, at, note.trim() ? `Completed: ${note.trim()}` : 'Marked complete');
    task.progress = 100;
    task.completedAt = at;
    logActivity(db, id, 'completed', user.id, 'Completed', at);
    notify(db, [task.assignedBy], 'completed', `${task.id} completed`, task.title, id, at);
    processEscalations(db, now());
  });
}

export interface ReviewInput {
  decision: 'approved' | 'changes_requested' | 'rejected';
  comment: string;
  /** PERF (server): required when approving a scored task; outcome only when it has no target. */
  qualityScore?: number;
  outcomeScore?: number;
  shortfallAccepted?: boolean;
}

/** PERF Rate step: outcome score (no target) and/or the decision on a shortfall or delay. */
export interface RateInput {
  outcomeScore?: number;
  shortfallAccepted?: boolean;
}

/** PERF: server only; the prototype has no ratings. */
export function rateTask(id: string, input: RateInput): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.rate(id, input);
  throw new ApiError(400, 'Ratings are available with the server backend.');
}

export function reviewTask(id: string, input: ReviewInput): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.review(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'review', 'review this submission');
    if (task.assigneeId === user.id) throw new ApiError(403, 'You cannot review your own work.');
    if (input.decision !== 'approved' && input.comment.trim().length < 5) invalid({ comment: 'Explain what needs to change.' });
    const r = db.reviews.filter((x) => x.taskId === id && !x.decision).at(-1);
    if (!r) throw new ApiError(409, 'There is no pending submission to review.');
    Object.assign(r, { reviewerId: user.id, decision: input.decision, decidedAt: at, comment: input.comment.trim() || null });
    if (input.decision === 'approved') {
      setStatus(db, task, 'completed', user.id, at, 'Approved and completed');
      task.progress = 100;
      task.completedAt = at;
      logActivity(db, id, 'review_decided', user.id, 'Approved the submission', at);
      logActivity(db, id, 'completed', user.id, 'Completed', at);
    } else {
      // Rejected and changes-requested both return the work to the assignee to rework.
      setStatus(db, task, 'changes_requested', user.id, at, input.decision === 'rejected' ? 'Rejected the submission' : 'Requested changes');
      task.clockStartedAt = at;
      logActivity(db, id, 'review_decided', user.id, input.decision === 'rejected' ? `Rejected: ${input.comment.trim()}` : `Requested changes: ${input.comment.trim()}`, at);
    }
    notify(db, [task.assigneeId], 'review_decision', `${task.id}: ${input.decision === 'approved' ? 'approved' : input.decision === 'rejected' ? 'rejected' : 'changes requested'}`, input.comment.trim() || task.title, id, at);
    processEscalations(db, now());
  });
}

export function requestExtension(id: string, input: { requestedDate: string; requestedTime: string; reason: string; info: string }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.requestExtension(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'request_extension', 'request an extension');
    const due = new Date(`${input.requestedDate}T${input.requestedTime || '17:00'}`).getTime();
    const f: Record<string, string> = {};
    if (!input.requestedDate || Number.isNaN(due)) f.requestedDate = 'Choose the new due date.';
    else if (due <= ms(task.dueAt)) f.requestedDate = 'The new date must be later than the current due date.';
    else if (due <= now()) f.requestedDate = 'The new date must be in the future.';
    if (input.reason.trim().length < 10) f.reason = 'Explain why (at least 10 characters).';
    if (Object.keys(f).length) invalid(f);
    db.extensions.push({ id: nextId(db, 'ext'), taskId: id, requestedBy: user.id, at, currentDue: task.dueAt, requestedDue: iso(due), reason: input.reason.trim(), info: input.info.trim(), status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null });
    logActivity(db, id, 'extension_requested', user.id, `Requested extension to ${iso(due).slice(0, 10)}`, at);
    audit(db, { at, actorId: user.id, action: 'extension.requested', targetType: 'task', targetId: id, taskId: id, prev: task.dueAt, next: iso(due), source: 'ui', context: input.reason.trim() });
    const approvers = db.users.filter((u) => u.id !== user.id && isOverseer(db, u, task) && hasPerm(db, u, 'approve_extensions') && (u.id === task.assignedBy || u.id === user.managerId));
    notify(db, approvers.map((u) => u.id), 'extension_request', `${task.id}: extension requested`, `${user.name} asks to move the due date to ${iso(due).slice(0, 10)}`, id, at);
  });
}

export function decideExtension(extId: string, input: { approve: boolean; note: string }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.decideExtension(extId, input);
  mutate((db, user, at) => {
    const ext = db.extensions.find((e) => e.id === extId);
    if (!ext) throw new ApiError(404, 'Extension request not found.');
    const task = findTask(db, ext.taskId);
    assertAction(db, user, task, 'decide_extension', 'decide this extension');
    if (ext.requestedBy === user.id) throw new ApiError(403, 'You cannot approve your own extension request.');
    if (ext.status !== 'pending') throw new ApiError(409, 'This request has already been decided.');
    if (!input.approve && input.note.trim().length < 5) invalid({ note: 'Give the assignee a reason.' });
    Object.assign(ext, { status: input.approve ? 'approved' : 'rejected', decidedBy: user.id, decidedAt: at, decisionNote: input.note.trim() || null });
    logActivity(db, task.id, 'extension_decided', user.id, `Extension ${input.approve ? 'approved' : 'rejected'}${input.note.trim() ? `: ${input.note.trim()}` : ''}`, at);
    audit(db, { at, actorId: user.id, action: input.approve ? 'extension.approved' : 'extension.rejected', targetType: 'task', targetId: task.id, taskId: task.id, prev: ext.currentDue, next: input.approve ? ext.requestedDue : ext.currentDue, source: 'ui', context: input.note.trim() });
    if (input.approve) {
      logActivity(db, task.id, 'due_changed', user.id, `Due date moved to ${ext.requestedDue.slice(0, 10)}`, at, { from: task.dueAt, to: ext.requestedDue });
      task.dueAt = ext.requestedDue; // Due-based escalation recalculates from the approved date.
      task.updatedAt = at;
    }
    notify(db, [ext.requestedBy], 'extension_decision', `${task.id}: extension ${input.approve ? 'approved' : 'rejected'}`, input.note.trim() || task.title, task.id, at);
    processEscalations(db, now());
  });
}

/** D-148: a new due time is required (server mode) when the task is past due or due within 10 minutes. */
export function reassignTask(id: string, input: { toId: string; reason: string; dueDate?: string; dueTime?: string }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.reassign(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'reassign', 'reassign this task');
    const f: Record<string, string> = {};
    if (!input.toId) f.toId = 'Choose the new assignee.';
    else if (input.toId === task.assigneeId) f.toId = 'Choose someone other than the current assignee.';
    else if (!canAssignTo(db, user, input.toId)) f.toId = 'That person is outside your assignment scope.';
    if (input.reason.trim().length < 5) f.reason = 'Give a reason for the reassignment.';
    if (Object.keys(f).length) invalid(f);
    const from = task.assigneeId;
    recordAssignment(db, task, from, input.toId, user.id, at, input.reason.trim());
    task.assigneeId = input.toId;
    task.assignedBy = user.id;
    task.acknowledgedAt = null;
    task.snoozeUntil = null;
    task.clockStartedAt = at; // New owner gets a fresh update window; past-due levels still hold.
    task.updatedAt = at;
    const t = db.users.find((u) => u.id === input.toId);
    if (t?.teamId) task.teamId = t.teamId;
    audit(db, { at, actorId: user.id, action: 'task.reassigned', targetType: 'task', targetId: id, taskId: id, prev: userName(db, from), next: userName(db, input.toId), source: 'ui', context: input.reason.trim() });
    processEscalations(db, now());
  });
}

/** D-133: the giver deletes a never-assigned draft. The server hides it everywhere (never deleted); the prototype drops it. */
export function discardTask(id: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.discard(id);
  mutate((db, user) => {
    assertAction(db, user, findTask(db, id), 'discard', 'delete this draft');
    db.tasks = db.tasks.filter((t) => t.id !== id);
    db.activities = db.activities.filter((a) => a.taskId !== id);
  });
}

export function cancelTask(id: string, reason: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.cancel(id, reason);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'cancel', 'cancel this task');
    if (reason.trim().length < 5) invalid({ reason: 'A cancellation reason is required.' });
    setStatus(db, task, 'cancelled', user.id, at, `Cancelled: ${reason.trim()}`);
    task.cancelReason = reason.trim();
    logActivity(db, id, 'cancelled', user.id, `Cancelled: ${reason.trim()}`, at);
    notify(db, [task.assigneeId], 'reassignment', `${task.id} was cancelled`, reason.trim(), id, at);
    processEscalations(db, now());
  });
}

export function reopenTask(id: string, input: { reason: string; dueDate: string }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.reopen(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'reopen', 'reopen this task');
    const due = new Date(`${input.dueDate}T17:00`).getTime();
    const f: Record<string, string> = {};
    if (input.reason.trim().length < 5) f.reason = 'Explain why the task is being reopened.';
    if (!input.dueDate || Number.isNaN(due) || due <= now()) f.dueDate = 'Set a new due date in the future.';
    if (Object.keys(f).length) invalid(f);
    setStatus(db, task, 'reopened', user.id, at, `Reopened: ${input.reason.trim()}`);
    task.completedAt = null;
    task.clockStartedAt = at;
    task.acknowledgedAt = null;
    if (iso(due) !== task.dueAt) {
      logActivity(db, id, 'due_changed', user.id, `Due date set to ${iso(due).slice(0, 10)}`, at, { from: task.dueAt, to: iso(due) });
      task.dueAt = iso(due);
    }
    logActivity(db, id, 'reopened', user.id, `Reopened: ${input.reason.trim()}`, at);
    notify(db, [task.assigneeId], 'assignment', `${task.id} was reopened`, input.reason.trim(), id, at);
  });
}

/** WO FR-9: with a note. The server acknowledges one event (D-26); the prototype acknowledges the task's active ones. */
export function ackEscalation(id: string, note: string, eventId?: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.ackEscalation(eventId, note);
  mutate((db, user, at) => {
    if (!note.trim()) invalid({ note: 'Add a note with your acknowledgement' });
    const task = findTask(db, id);
    assertAction(db, user, task, 'ack_escalation', 'acknowledge this escalation');
    const events = db.escalations.filter((e) => e.taskId === id && e.status === 'active');
    for (const e of events) {
      e.status = 'acknowledged';
      e.ackBy = user.id;
      e.ackAt = at;
    }
    // Level and clocks are unchanged: acknowledgement only pauses repeat alerts.
    task.snoozeUntil = iso(now() + db.rules.ackSnoozeHours * HOUR);
    const top = Math.max(...events.map((e) => e.level));
    logActivity(db, id, 'escalation_acknowledged', user.id, `Acknowledged ${LEVEL_LABEL[top] ?? 'escalation'}: ${note.trim()}`, at);
    notify(db, [task.assigneeId, task.assignedBy].filter((x) => x !== user.id), 'escalation_ack', `${user.name} acknowledged the ${task.id} escalation`, task.title, id, at);
    audit(db, { at, actorId: user.id, action: 'escalation.acknowledged', targetType: 'task', targetId: id, taskId: id, prev: 'active', next: 'acknowledged', source: 'ui', context: LEVEL_LABEL[top] ?? '' });
  });
}

export function addComment(id: string, input: { body: string; parentId: string | null; files: File[] }): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.comment(id, input);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'comment', 'comment');
    if (!input.body.trim()) invalid({ body: 'Write a comment first.' });
    if (input.body.length > 4000) invalid({ body: 'Comments are limited to 4000 characters.' });
    db.comments.push({ id: nextId(db, 'cmt'), taskId: id, authorId: user.id, body: input.body.trim(), at, editedAt: null, parentId: input.parentId, deleted: false });
    addFiles(db, id, input.files, user.id, at, 'comment');
    // Comments are logged but never reset the silence clock.
    logActivity(db, id, 'comment', user.id, input.parentId ? 'Replied to a comment' : 'Commented', at);
    const names = mentionedNames(input.body, db.users.map((u) => u.name));
    const mentioned = db.users.filter((u) => names.has(u.name) && canViewTask(db, u, task) && u.id !== user.id);
    notify(db, mentioned.map((u) => u.id), 'mention', `${user.name} mentioned you on ${task.id}`, input.body.trim().slice(0, 140), id, at);
  });
}

export function editComment(commentId: string, body: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.editComment(commentId, body);
  mutate((db, user, at) => {
    const c = db.comments.find((x) => x.id === commentId);
    if (!c || c.deleted) throw new ApiError(404, 'Comment not found.');
    assertCanViewTask(db, user, findTask(db, c.taskId));
    if (c.authorId !== user.id) throw new ApiError(403, 'You can only edit your own comments.');
    if (!body.trim()) invalid({ body: 'A comment cannot be empty.' });
    c.body = body.trim();
    c.editedAt = at;
  });
}

export function deleteComment(commentId: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.deleteComment(commentId);
  mutate((db, user, at) => {
    const c = db.comments.find((x) => x.id === commentId);
    if (!c || c.deleted) throw new ApiError(404, 'Comment not found.');
    assertCanViewTask(db, user, findTask(db, c.taskId));
    if (c.authorId !== user.id && user.role !== 'cos') throw new ApiError(403, 'You can only delete your own comments.');
    c.deleted = true;
    c.body = '';
    audit(db, { at, actorId: user.id, action: 'comment.deleted', targetType: 'task', targetId: c.taskId, taskId: c.taskId, prev: 'comment', next: null, source: 'ui', context: commentId });
  });
}

export function addAttachments(id: string, files: File[]): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.attach(id, files);
  mutate((db, user, at) => {
    const task = findTask(db, id);
    assertAction(db, user, task, 'attach', 'attach files');
    if (!files.length) invalid({ files: 'Choose at least one file.' });
    addFiles(db, id, files, user.id, at, 'task');
  });
}

export function removeAttachment(attId: string): void | Promise<void> {
  if (BACKEND === 'server') return tasksServer.removeAttachment(attId);
  mutate((db, user, at) => {
    const a = db.attachments.find((x) => x.id === attId && !x.removedAt);
    if (!a) throw new ApiError(404, 'Attachment not found.');
    const task = findTask(db, a.taskId);
    assertCanViewTask(db, user, task);
    // D-33: like attaching, a supervisor must also hold create_tasks (KI-40).
    if (a.uploadedBy !== user.id && !(isOverseer(db, user, task) && hasPerm(db, user, 'create_tasks'))) throw new ApiError(403, 'Only the uploader or a task supervisor can remove this file.');
    a.removedAt = at; // D-31: hidden, never deleted
    logActivity(db, a.taskId, 'attachment_removed', user.id, `Removed ${a.name}`, at);
  });
}

export function bulkCancel(ids: string[], reason: string): { done: string[]; skipped: string[] } | Promise<{ done: string[]; skipped: string[] }> {
  if (BACKEND === 'server') return tasksServer.bulkCancel(ids, reason);
  return mutate((db, user, at) => {
    if (reason.trim().length < 5) invalid({ reason: 'A cancellation reason is required.' });
    const done: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const task = db.tasks.find((t) => t.id === id);
      if (!task || !allowedActions(db, user, task).has('cancel')) {
        skipped.push(id);
        continue;
      }
      setStatus(db, task, 'cancelled', user.id, at, `Cancelled (bulk): ${reason.trim()}`);
      task.cancelReason = reason.trim();
      logActivity(db, id, 'cancelled', user.id, `Cancelled: ${reason.trim()}`, at);
      done.push(id);
    }
    processEscalations(db, now());
    return { done, skipped };
  });
}

export function bulkAcknowledge(ids: string[]): { done: string[]; skipped: string[] } | Promise<{ done: string[]; skipped: string[] }> {
  if (BACKEND === 'server') return tasksServer.bulkAcknowledge(ids);
  return mutate((db, user, at) => {
    const done: string[] = [];
    const skipped: string[] = [];
    for (const id of ids) {
      const task = db.tasks.find((t) => t.id === id);
      if (!task || !allowedActions(db, user, task).has('acknowledge')) {
        skipped.push(id);
        continue;
      }
      task.acknowledgedAt = at;
      task.snoozeUntil = iso(now() + db.rules.ackSnoozeHours * HOUR);
      logActivity(db, id, 'acknowledged', user.id, 'Acknowledged the task', at);
      done.push(id);
    }
    return { done, skipped };
  });
}

/** Eligible assignees for the signed-in user, for pickers (shared rule, D-32: includes themselves). */
export function assigneeOptions(): (User & { entityId?: string; load?: { loadPercent: number; band: string } })[] | Promise<(User & { entityId?: string; load?: { loadPercent: number; band: string } })[]> {
  if (BACKEND === 'server') return tasksServer.assigneeOptions();
  return read((db, user) => assignableUsers(db, user));
}

/** What the task form looks up besides people: categories, the escalation rules shown as hints, and teams. */
export interface TaskFormLookups {
  categories: string[];
  rules: RulesConfig;
  teams: { id: string; name: string; departmentId?: string }[];
  /** Verticals (entities), for showing the derived entity (D-63). */
  entities: { id: string; name: string }[];
  /** D-125: standard task times; the form recommends an estimate from them. */
  standardTasks: StandardTask[];
}

export function taskFormLookups(): TaskFormLookups | Promise<TaskFormLookups> {
  if (BACKEND === 'server') return tasksServer.formLookups();
  return read((db) => ({ categories: db.settings.categories, rules: db.rules, teams: db.teams, entities: db.departments, standardTasks: db.settings.standardTasks ?? DEFAULT_STANDARD_TASKS }));
}

/** ADR-0014 / US-01, US-04: one day's scheduled work (the day is read in each person's zone). */
export interface ScheduleDay {
  date: string;
  people: {
    userId: string;
    name: string;
    timeZone: string;
    tasks: { id: string; title: string; priority: Priority; status: Task['status']; startAt: string | null; dueAt: string; submittedAt: string | null; overlap: boolean }[];
  }[];
}

export function getSchedule(date: string, who: { team?: boolean; userId?: string } = {}): ScheduleDay | Promise<ScheduleDay> {
  if (BACKEND === 'server') return tasksServer.schedule(date, who);
  return read((db, user) => {
    // The prototype: the browser's zone, the same window rule as the server.
    const ids = who.team ? [...reportsOf(db, user.id)] : [who.userId ?? user.id];
    const from = new Date(`${date}T00:00`).getTime();
    const to = from + 24 * HOUR;
    return {
      date,
      people: ids.map((id) => {
        const u = db.users.find((x) => x.id === id);
        const mine = db.tasks.filter((t) => t.assigneeId === id && t.status !== 'draft' && t.status !== 'cancelled' && (t.startAt ? Date.parse(t.startAt) : Date.parse(t.dueAt) - HOUR) < to && Date.parse(t.dueAt) > from);
        const clash = overlapsOf(mine.filter((t) => t.status !== 'completed').map((t) => ({ id: t.id, start: t.startAt ? Date.parse(t.startAt) : null, end: Date.parse(t.dueAt) })));
        const sub = (taskId: string) => db.reviews.filter((r) => r.taskId === taskId).map((r) => r.submittedAt).sort().at(-1) ?? null;
        return {
          userId: id,
          name: u?.name ?? id,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          tasks: mine.map((t) => ({ id: t.id, title: t.title, priority: t.priority, status: t.status, startAt: t.startAt, dueAt: t.dueAt, submittedAt: sub(t.id), overlap: clash.has(t.id) })),
        };
      }),
    };
  });
}
