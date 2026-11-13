// Task pages against the real server (T-4.14; API_CONTRACTS §2.2). Used only when BACKEND === 'server'. Maps the
// server's shapes (numeric ids, TaskView with actions[], a `people` map) onto the prototype's, so pages keep their design.
import { LEVEL_LABEL, STATUS_LABEL } from '../../constants';
import type { Activity, ActivityType, Assignment, Attachment, AuditRecord, Comment, EscalationEvent, Extension, ProgressUpdate, Review, Task, User } from '../../types';
import { ApiError } from '../authz/permissions';
import type { TaskAction } from '../engine/workflow';
import { http } from '../http';
import { userStub } from './adminServer';
import type { TaskView } from './base';
import type { FinishReport, RateInput, ReviewInput, TaskDetail, TaskInput, TaskScope } from './tasks';

/* eslint-disable @typescript-eslint/no-explicit-any -- server JSON is mapped field by field below */
const S = (n: number | null | undefined): string | null => (n == null ? null : String(n));
const N = (s: string | null | undefined): number | null => (s ? Number(s) : null);

/** Attachment id → its task, so `attachmentUrl(id)` can name the server route. */
const attachmentTask = new Map<string, string>();
export const serverAttachmentUrl = (id: string): string | undefined => {
  const taskId = attachmentTask.get(id);
  // inline=1: the server previews only safe types and downloads everything else (ATT-02).
  return taskId ? `/api/tasks/${taskId}/attachments/${id}?inline=1` : undefined;
};

export function toView(t: any): TaskView {
  return {
    id: String(t.id),
    title: t.title,
    description: t.description ?? '',
    instructions: t.instructions ?? '',
    category: t.category ?? '',
    priority: t.priority,
    status: t.status,
    assigneeId: String(t.assigneeId),
    createdBy: String(t.createdBy),
    assignedBy: String(t.assignedBy),
    reviewerId: String(t.reviewerId),
    teamId: S(t.teamId),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    startAt: t.startAt,
    milestones: t.milestones ?? null,
    assigneeAwayUntil: t.assigneeAwayUntil ?? null,
    assigneeAwayKind: t.assigneeAwayKind ?? null,
    submissionRequirements: t.submissionRequirements ?? null,
    policyVersion: t.policyVersion ?? null,
    dueAt: t.dueAt,
    clockStartedAt: t.clockStartedAt,
    acknowledgedAt: t.acknowledgedAt,
    snoozeUntil: t.snoozeUntil,
    progress: t.progress,
    reviewRequired: t.reviewRequired,
    parentId: S(t.parentId),
    recurrenceId: S(t.recurrenceId),
    occurrenceDate: t.occurrenceDate,
    cancelReason: t.cancelReason,
    completedAt: t.completedAt,
    level: t.level,
    levelInfo: t.levelInfo,
    overdue: t.overdue,
    lastUpdateAt: t.lastUpdateAt,
    escalationAcked: t.escalationAcked,
    assignee: userStub(t.assignee),
    giver: userStub(t.giver),
    team: t.team ? { id: String(t.team.id), name: t.team.name, departmentId: t.entityId, leadId: null } : undefined,
    actions: t.actions as TaskAction[],
    blockedReason: t.blockedReason ?? null,
    // PERF
    target: t.target ?? null,
    unit: t.unit ?? null,
    achieved: t.achieved ?? null,
    result: t.result ?? null,
    estimatedHours: t.estimatedHours ?? null,
    purpose: t.purpose ?? null,
    qualityScore: t.qualityScore ?? null,
    outcomeScore: t.outcomeScore ?? null,
    shortfallReason: t.shortfallReason ?? null,
    shortfallAccepted: t.shortfallAccepted ?? null,
    awaitingRating: t.awaitingRating === true,
    escalatedToMe: t.myEscalation != null,
  };
}

const KIND_TEXT: Record<string, string> = {
  created: 'Created the task',
  assigned: 'Assigned the task',
  acknowledged: 'Acknowledged the task',
  edited: 'Edited the task',
  completed: 'Marked the task done',
  cancelled: 'Cancelled the task',
  reopened: 'Reopened the task',
  escalated: 'Escalated',
  escalation_acknowledged: 'Acknowledged the escalation',
  attachment_added: 'Attached a file',
  attachment_removed: 'Removed a file',
  rated: 'Rated the task',
  extension_requested: 'Requested an extension',
  extension_decided: 'Decided an extension request',
  review_submitted: 'Submitted for review',
  review_decided: 'Reviewed the submission',
  comment_edited: 'Edited a comment',
  comment_deleted: 'Deleted a comment',
};

/** One readable line per log row: the body if there is one, else what changed. Also used for dashboard feeds. */
export function activityText(a: any): string {
  const from = a.before?.status;
  const to = a.after?.status;
  const statusChange = from && to && from !== to ? `${STATUS_LABEL[from as Task['status']] ?? from} → ${STATUS_LABEL[to as Task['status']] ?? to}` : '';
  if (a.kind === 'due_changed') return `Due date ${a.before?.dueAt ? new Date(a.before.dueAt).toLocaleString() : ''} → ${a.after?.dueAt ? new Date(a.after.dueAt).toLocaleString() : ''}${a.body ? `: ${a.body}` : ''}`;
  if (a.kind === 'reassigned') return `Reassigned ${a.before?.assignee?.name ?? ''} → ${a.after?.assignee?.name ?? ''}${a.body ? `: ${a.body}` : ''}`;
  return [statusChange, a.body ?? (statusChange ? '' : (KIND_TEXT[a.kind] ?? a.kind))].filter(Boolean).join(' · ');
}

const ACTIVITY_TYPE: Record<string, ActivityType> = { comment_edited: 'edited', comment_deleted: 'edited', deescalation: 'escalated' };
export const activityType = (kind: string): ActivityType => (ACTIVITY_TYPE[kind] ?? kind) as ActivityType;

const escalationEvent = (taskId: string) => (e: any): EscalationEvent => ({
  id: String(e.id),
  taskId,
  level: e.level,
  reason: e.reason,
  accountable: e.accountable ?? 'assignee',
  at: e.reachedAt ?? e.firedAt,
  cycle: e.cycleStartedAt ?? '',
  recipientIds: e.recipients.filter((r: any) => r.kind === 'to').map((r: any) => String(r.id)),
  ccIds: e.recipients.filter((r: any) => r.kind === 'cc').map((r: any) => String(r.id)),
  status: e.clearedAt ? 'resolved' : e.acknowledgedAt ? 'acknowledged' : 'active',
  ackBy: S(e.acknowledgedById),
  ackAt: e.acknowledgedAt,
  resolvedAt: e.clearedAt,
  lastNotifiedAt: e.lastAlertAt ?? e.firedAt,
  ackNote: e.ackNote ?? null,
  canAck: e.canAcknowledge === true,
});

const review = (r: any): Review => ({
  id: String(r.id),
  taskId: String(r.task_id),
  round: r.round,
  submittedBy: String(r.submitted_by),
  submittedAt: r.submitted_at,
  note: r.note,
  reviewerId: S(r.reviewer_id),
  decision: r.decision,
  decidedAt: r.decided_at,
  comment: r.comment,
});

export const extension = (x: any): Extension => ({
  id: String(x.id),
  taskId: String(x.task_id),
  requestedBy: String(x.requested_by),
  at: x.requested_at,
  currentDue: x.current_due,
  requestedDue: x.requested_due,
  reason: x.reason,
  info: x.info ?? '',
  status: x.status,
  decidedBy: S(x.decided_by),
  decidedAt: x.decided_at,
  decisionNote: x.decision_note,
});

function detail(d: any): TaskDetail {
  const taskId = String(d.task.id);
  const users = Object.values(d.people as Record<string, { id: number; name: string; title: string | null }>).map((p) => userStub(p));
  const attachments: Attachment[] = d.attachments.map((a: any) => {
    attachmentTask.set(String(a.id), taskId);
    return { id: String(a.id), taskId, name: a.fileName, size: a.size, mime: a.mime, uploadedBy: String(a.uploadedBy), at: a.uploadedAt, context: a.context ?? 'task' };
  });
  const updates: ProgressUpdate[] = d.activities
    .filter((a: any) => a.kind === 'progress' && a.body)
    .map((a: any) => ({
      id: String(a.id),
      taskId,
      authorId: String(a.actorId),
      message: a.body,
      percent: a.after?.progress ?? 0,
      at: a.at,
      attachmentIds: d.attachments.filter((x: any) => x.logId === a.id).map((x: any) => String(x.id)),
    }));
  let prev: string | null = null;
  const assignments: Assignment[] = d.assignments.map((s: any, i: number) => {
    const row = { id: `${taskId}-${i}`, taskId, fromId: prev, toId: String(s.assigneeId), byId: String(s.assignedById), at: s.assignedAt, reason: '' };
    prev = row.toId;
    return row;
  });
  return {
    task: toView(d.task),
    time: d.time ?? null,
    activities: d.activities
      .map((a: any): Activity => ({ id: String(a.id), taskId, type: activityType(a.kind), actorId: S(a.actorId), at: a.at, text: activityText(a) }))
      .reverse(),
    comments: d.comments.map((c: any): Comment => ({ id: String(c.id), taskId, authorId: String(c.authorId), body: c.body ?? '', at: c.at, editedAt: c.editedAt, parentId: S(c.parentId), deleted: c.deleted })),
    updates: updates.reverse(),
    attachments,
    reviews: d.reviews.map(review),
    extensions: d.extensions.map(extension).reverse(),
    assignments,
    escalations: d.escalations.map(escalationEvent(taskId)).reverse(),
    actions: d.actions as TaskAction[],
    // The page reads only id and title from these.
    parent: d.parent ? ({ id: String(d.parent.id), title: d.parent.title, status: d.parent.status } as unknown as Task) : null,
    children: d.children.map((c: any) => ({ id: String(c.id), title: c.title, status: c.status }) as unknown as TaskView),
    // The page describes the rule (describeRecurrence); the server sends the full rule.
    recurrence: d.recurrence ? ({ ...d.recurrence, id: String(d.recurrence.id) } as TaskDetail['recurrence']) : null,
    users,
    rules: d.rules,
  } as TaskDetail;
}

/** TASK-01 body. Dates are sent as the person entered them; the server reads them in their own zone (D-5). */
const taskBody = (i: TaskInput) => ({
  title: i.title,
  description: i.description,
  instructions: i.instructions,
  category: i.category,
  priority: i.priority,
  assigneeId: Number(i.assigneeId),
  teamId: N(i.teamId),
  dueDate: i.dueDate,
  ...(i.dueTime ? { dueTime: i.dueTime } : {}),
  startDate: i.startDate || null,
  ...(i.startDate && i.startTime ? { startTime: i.startTime } : {}),
  submissionRequirements: i.submissionRequirements,
  reviewerId: i.reviewRequired ? N(i.reviewerId) : null,
  reviewRequired: i.reviewRequired,
  parentId: N(i.parentId),
  target: i.target ? Number(i.target) : null,
  unit: i.unit,
  estimatedHours: i.estimatedHours ? Number(i.estimatedHours) : null,
  purpose: i.purpose || null,
});

/** Multipart when files are attached; otherwise JSON. */
async function post(path: string, body: Record<string, unknown>, files: File[] = []): Promise<any> {
  if (!files.length) return http('POST', path, body);
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) form.append(k, String(v));
  for (const f of files) form.append('files', f, f.name);
  const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-taskwatch': '1' }, body: form });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new ApiError((res.status as ApiError['status']) || 500, data?.error ?? 'The upload could not be completed.', data?.fields);
  return data;
}

const act = async (id: string, path: string, body: Record<string, unknown> = {}) => void (await http('POST', `/tasks/${id}/${path}`, body));

export const tasksServer = {
  list: async (scope: TaskScope): Promise<TaskView[]> => (await http<{ items: any[] }>('GET', `/tasks?scope=${scope}`)).items.map(toView),
  get: async (id: string): Promise<TaskDetail> => detail(await http('GET', `/tasks/${id}`)),
  create: async (i: TaskInput): Promise<Task> => {
    if (i.alsoAssigneeIds.length) {
      // D-153: one task per person in one request; the first is returned, files go on each.
      const { assigneeId, ...body } = taskBody(i);
      const r = await http<{ tasks: any[] }>('POST', '/tasks', { ...body, assigneeIds: [assigneeId, ...i.alsoAssigneeIds.map(Number)], draft: i.draft });
      if (i.files.length) for (const t of r.tasks) await post(`/tasks/${t.id}/attachments`, {}, i.files);
      return toView(r.tasks[0]);
    }
    const r = await http<{ task: any }>('POST', '/tasks', { ...taskBody(i), draft: i.draft });
    if (i.files.length) await post(`/tasks/${r.task.id}/attachments`, {}, i.files); // files go on after create (KI-31)
    return toView(r.task);
  },
  update: async (id: string, i: TaskInput): Promise<void> => {
    await http('PUT', `/tasks/${id}`, taskBody(i));
    if (i.files.length) await post(`/tasks/${id}/attachments`, {}, i.files);
  },
  publish: (id: string) => act(id, 'publish'),
  acknowledge: (id: string) => act(id, 'acknowledge'),
  start: (id: string) => act(id, 'start'),
  progress: async (id: string, i: { message: string; percent: number; achieved?: number; files: File[] }) =>
    void (await post(`/tasks/${id}/progress`, i.achieved !== undefined ? { message: i.message, achieved: i.achieved } : { message: i.message, percent: i.percent }, i.files)),
  block: (id: string, reason: string) => act(id, 'block', { reason }),
  submit: async (id: string, i: { note: string; files: File[] } & FinishReport) => {
    const { files, ...body } = i;
    await post(`/tasks/${id}/submit`, body, files);
  },
  complete: (id: string, note: string, report: FinishReport = {}) => act(id, 'complete', { note, ...report }),
  review: (id: string, i: ReviewInput) => act(id, 'review', { ...i }),
  rate: (id: string, i: RateInput) => act(id, 'rate', { ...i }),
  requestExtension: async (id: string, i: { requestedDate: string; requestedTime: string; reason: string; info: string }) =>
    void (await http('POST', `/tasks/${id}/extensions`, { requestedDate: i.requestedDate, ...(i.requestedTime ? { requestedTime: i.requestedTime } : {}), reason: i.reason, info: i.info })),
  decideExtension: async (extId: string, i: { approve: boolean; note: string }) => void (await http('POST', `/extensions/${extId}/decision`, i)),
  reassign: (id: string, i: { toId: string; reason: string; dueDate?: string; dueTime?: string }) =>
    act(id, 'reassign', { toId: N(i.toId) ?? undefined, reason: i.reason, ...(i.dueDate ? { dueDate: i.dueDate, ...(i.dueTime ? { dueTime: i.dueTime } : {}) } : {}) }),
  cancel: (id: string, reason: string) => act(id, 'cancel', { reason }),
  discard: async (id: string): Promise<void> => void (await http('POST', `/tasks/${id}/discard`, {})), // D-133: 204
  reopen: (id: string, i: { reason: string; dueDate: string }) => act(id, 'reopen', i),
  /** ESC-06/06a: one event (D-26: that level only), with the WO FR-9 note. */
  ackEscalation: async (eventId: string | undefined, note: string): Promise<void> => {
    if (!eventId) throw new ApiError(409, 'There is no escalation here for you to acknowledge.');
    await http('POST', `/escalations/${eventId}/ack`, { note });
  },
  /** ESC-09: every row in scope; the page filters them (its counts need all of them). */
  escalations: async () =>
    (await http<{ rows: any[] }>('GET', '/escalations?status=all')).rows.map((r) => ({
      task: toView(r.task),
      level: r.level as number,
      status: r.status as 'active' | 'acknowledged' | 'resolved',
      since: r.since as string,
      recipients: r.recipients as string[],
      nextLevel: r.nextLevel ? { level: r.nextLevel.level as number, at: r.nextLevel.at as string, label: LEVEL_LABEL[r.nextLevel.level] } : null,
      canAck: r.canAck as boolean,
      ackEventId: S(r.ackEventId),
      events: (r.events as any[]).map(escalationEvent(String(r.task.id))),
    })),
  /** POL-01/03: the default policy, entity overrides (D-48: windows and multiples) and the entities to choose from. */
  policies: async () => {
    const [r, entities] = await Promise.all([http<any>('GET', '/rules'), http<{ id: string; name: string }[]>('GET', '/entities')]);
    return { defaults: r.defaults, overrides: r.overrides, stored: r.stored ?? {}, history: r.history ?? [], headOf: r.headOf ?? [], entities };
  },
  /** ADR-0014: a vertical sends only the fields it changed (the page computes them with diffPolicy). */
  setPolicy: async (scope: string, config: any): Promise<void> => void (await http('PUT', `/rules/${scope}`, { config })),
  applyPolicy: async (scope: string): Promise<{ updated: number }> => http('POST', `/rules/${scope}/apply`, {}),
  schedule: async (date: string, who: { team?: boolean; userId?: string }) => {
    const q = who.team ? '&team=1' : who.userId ? `&userId=${who.userId}` : '';
    const r = await http<any>('GET', `/schedule?date=${date}${q}`);
    return { date: r.date, people: r.people.map((p: any) => ({ ...p, userId: String(p.userId), tasks: p.tasks.map((t: any) => ({ ...t, id: String(t.id) })) })) };
  },
  resetPolicy: async (scope: string): Promise<void> => void (await http('DELETE', `/rules/${scope}`)),
  comment: async (id: string, i: { body: string; parentId: string | null; files: File[] }) => void (await post(`/tasks/${id}/comments`, { body: i.body, ...(i.parentId ? { parentId: i.parentId } : {}) }, i.files)),
  editComment: async (commentId: string, body: string) => void (await http('PUT', `/comments/${commentId}`, { body })),
  deleteComment: async (commentId: string) => void (await http('DELETE', `/comments/${commentId}`)),
  attach: async (id: string, files: File[]) => void (await post(`/tasks/${id}/attachments`, {}, files)),
  removeAttachment: async (attId: string) => void (await http('DELETE', `/attachments/${attId}`)),
  bulkCancel: async (ids: string[], reason: string) => {
    const r = await http<{ done: number[]; skipped: number[] }>('POST', '/tasks/bulk/cancel', { ids: ids.map(Number), reason });
    return { done: r.done.map(String), skipped: r.skipped.map(String) };
  },
  bulkAcknowledge: async (ids: string[]) => {
    const r = await http<{ done: number[]; skipped: number[] }>('POST', '/tasks/bulk/acknowledge', { ids: ids.map(Number) });
    return { done: r.done.map(String), skipped: r.skipped.map(String) };
  },
  assigneeOptions: async (): Promise<(User & { entityId?: string; load?: { loadPercent: number; band: string } })[]> =>
    (await http<any[]>('GET', '/tasks/options/assignees')).map((u) => ({ ...userStub(u), entityId: u.entityId as string, load: u.load, teamId: S(u.teamId), timezone: u.timeZone ?? '', openCount: u.openCount, teamName: u.teamName ?? null })),
  formLookups: async () => {
    const [me, org, settings] = await Promise.all([http<any>('GET', '/me'), http<any>('GET', '/org'), http<any>('GET', '/settings')]);
    return {
      categories: me.settings.categories as string[],
      rules: me.rules,
      teams: (org.teams as any[]).map((t) => ({ id: String(t.id), name: t.name, departmentId: t.entityId as string })),
      entities: (org.entities as any[]).map((e) => ({ id: e.id as string, name: e.name as string })),
      standardTasks: settings.standardTasks ?? [],
    };
  },
  reviewQueue: async () => (await http<any[]>('GET', '/reviews')).map((x) => ({ task: toView(x.task), submission: review(x.submission) })),
  extensions: async () => (await http<any[]>('GET', '/extensions?status=all')).map((x) => ({ ext: extension(x.ext), task: toView(x.task), canDecide: x.canDecide })),
  /** AUD-02 / D-16: run the audit-chain integrity check now (throttled on the server to once per 5 minutes). */
  chainCheck: () => http<{ ok: boolean; breaks: unknown[] }>('POST', '/audit/chain-check'),
  audit: async (): Promise<(AuditRecord & { actorName: string | null })[]> =>
    (await http<{ items: any[] }>('GET', '/audit')).items.map((i) => ({
      id: i.id,
      at: i.at,
      actorId: S(i.actor?.id),
      actorName: i.actor?.name ?? null,
      action: i.action,
      targetType: i.targetType,
      targetId: i.targetId ?? '',
      taskId: S(i.taskId),
      prev: i.prev == null ? null : typeof i.prev === 'string' ? i.prev : JSON.stringify(i.prev),
      next: i.next == null ? (i.note ?? null) : typeof i.next === 'string' ? i.next : JSON.stringify(i.next),
      source: i.source,
      context: i.context ?? '',
    })),
};
