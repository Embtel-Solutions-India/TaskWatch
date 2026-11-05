// Task states and the actions a person may take on a task — one implementation for server and client
// (ADR-0003 states, ADR-0007 sharing). Pure: no data access; callers pass the facts about the person and task.

export const STATUSES = [
  'draft',
  'assigned',
  'in_progress',
  'blocked',
  'submitted',
  'changes_requested',
  'reopened',
  'completed',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];

/** The assignee owes work, so the silence and past-due ladder runs (ADR-0003: Blocked included). */
export const ACTIVE_STATUSES: readonly Status[] = ['assigned', 'in_progress', 'blocked', 'changes_requested', 'reopened'];
export const CLOSED_STATUSES: readonly Status[] = ['completed', 'cancelled'];
/** Statuses the escalation engine evaluates: the active ones plus In review, where only the past-due floor runs (D-25). */
export const LADDER_STATUSES: readonly Status[] = [...ACTIVE_STATUSES, 'submitted'];

/** WO FR-2 core is Open (assigned) → In progress → Blocked → Done (completed); the rest are prototype extras (D-20). */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  draft: ['assigned', 'cancelled'],
  // R-2: Done straight from Open, In progress or Blocked when no review is required.
  assigned: ['in_progress', 'blocked', 'completed', 'cancelled'],
  in_progress: ['submitted', 'completed', 'blocked', 'cancelled'],
  // Unblock by starting or posting progress; reassigning a blocked task returns it to Open (ADR-0003).
  blocked: ['in_progress', 'assigned', 'completed', 'cancelled'],
  submitted: ['completed', 'changes_requested', 'cancelled'],
  changes_requested: ['in_progress', 'blocked', 'cancelled'],
  reopened: ['in_progress', 'blocked', 'cancelled'],
  completed: ['reopened'],
  cancelled: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

export const isClosed = (status: Status): boolean => CLOSED_STATUSES.includes(status);
export const isActive = (status: Status): boolean => ACTIVE_STATUSES.includes(status);

export type TaskAction =
  | 'publish'
  | 'acknowledge'
  | 'start'
  | 'progress'
  | 'block'
  | 'submit'
  | 'complete'
  | 'review'
  | 'request_extension'
  | 'decide_extension'
  | 'reassign'
  | 'cancel'
  | 'reopen'
  | 'edit'
  | 'comment'
  | 'attach'
  | 'ack_escalation';

/** The permissions allowedActions consults (a subset of the 15 in the role matrix). */
export type ActionPermission = 'update_assigned_tasks' | 'review_tasks' | 'approve_extensions' | 'reassign_tasks' | 'assign_tasks' | 'create_tasks';

export interface ActionTask {
  status: Status;
  acknowledgedAt: unknown;
  reviewRequired: boolean;
}

/** What the caller knows about this person and task. Computed by each side from its own data. */
export interface ActionFacts {
  /** The person may see the task at all. Without this, no action is allowed. */
  canView: boolean;
  isAssignee: boolean;
  /** Has authority over the task (giver, reviewer, or above the assignee) and is not its assignee. */
  isOverseer: boolean;
  /** Created or assigned the task, or is a Chief of Staff. */
  isGiver: boolean;
  can: (p: ActionPermission) => boolean;
  pendingExtension: boolean;
  /** R-1: a "to" recipient of an active escalation level on this task, or a Chief of Staff with one active. */
  mayAckEscalation: boolean;
}

export function allowedActions(task: ActionTask, f: ActionFacts): Set<TaskAction> {
  const out = new Set<TaskAction>();
  if (!f.canView) return out;

  const assignee = f.isAssignee && f.can('update_assigned_tasks');
  const { status } = task;
  const active = isActive(status);
  const closed = isClosed(status);

  if (status === 'draft' && f.isGiver && f.can('assign_tasks')) out.add('publish');
  if (assignee && active && !task.acknowledgedAt) out.add('acknowledge');
  if (assignee && ['assigned', 'blocked', 'changes_requested', 'reopened'].includes(status)) out.add('start');
  if (assignee && active) out.add('progress');
  if (assignee && canTransition(status, 'blocked')) out.add('block');
  if (assignee && status === 'in_progress' && task.reviewRequired) out.add('submit');
  if (assignee && !task.reviewRequired && ['assigned', 'in_progress', 'blocked'].includes(status)) out.add('complete');
  if (status === 'submitted' && f.isOverseer && f.can('review_tasks')) out.add('review');
  if (assignee && active && !f.pendingExtension) out.add('request_extension');
  if (f.pendingExtension && f.isOverseer && f.can('approve_extensions')) out.add('decide_extension');
  if (!closed && status !== 'draft' && f.isOverseer && f.can('reassign_tasks')) out.add('reassign');
  if (!closed && (f.isGiver || f.isOverseer) && f.can('assign_tasks')) out.add('cancel');
  if (status === 'completed' && (f.isGiver || f.isOverseer) && f.can('assign_tasks')) out.add('reopen');
  if (!closed && (f.isGiver || f.isOverseer) && f.can('create_tasks')) out.add('edit');
  out.add('comment');
  // D-33: a read-only senior (the CEO by default) oversees everything but may not add files.
  if (!closed && (assignee || ((f.isOverseer || f.isGiver) && f.can('create_tasks')))) out.add('attach');
  if (f.mayAckEscalation) out.add('ack_escalation');
  return out;
}
