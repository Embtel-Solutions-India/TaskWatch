// The state machine and action rules live in shared/workflow.ts (ADR-0003, ADR-0007), the code the server runs.
// This adapter only gathers the facts about a person and task from the prototype's data.
import { allowedActions as sharedActions, canTransition, type TaskAction } from '@taskwatch/shared/workflow';
import type { Db, Status, Task, User } from '../../types';
import { ApiError, canViewTask, hasPerm, isOverseer } from '../authz/permissions';

export { canTransition, TRANSITIONS } from '@taskwatch/shared/workflow';
export type { TaskAction } from '@taskwatch/shared/workflow';

export function assertTransition(task: Task, to: Status): void {
  if (!canTransition(task.status, to)) {
    throw new ApiError(409, `A task that is "${task.status.replace('_', ' ')}" cannot move to "${to.replace('_', ' ')}".`);
  }
}

export function allowedActions(db: Db, user: User | null, task: Task): Set<TaskAction> {
  if (!user) return new Set();
  return sharedActions(task, {
    canView: canViewTask(db, user, task),
    isAssignee: task.assigneeId === user.id,
    isOverseer: isOverseer(db, user, task) && task.assigneeId !== user.id,
    isGiver: user.role === 'cos' || task.createdBy === user.id || task.assignedBy === user.id,
    can: (p) => hasPerm(db, user, p),
    pendingExtension: db.extensions.some((e) => e.taskId === task.id && e.status === 'pending'),
    // R-1: the "to" recipients of an active level, or a Chief of Staff. Copied (cc) people cannot.
    mayAckEscalation: db.escalations.some((e) => e.taskId === task.id && e.status === 'active' && (e.recipientIds.includes(user.id) || user.role === 'cos')),
  });
}

export function assertAction(db: Db, user: User, task: Task, action: TaskAction, label: string): void {
  if (!canViewTask(db, user, task)) throw new ApiError(403, `You are not authorized to view ${task.id}.`);
  if (!allowedActions(db, user, task).has(action)) throw new ApiError(403, `You can't ${label} on ${task.id} in its current state.`);
}
