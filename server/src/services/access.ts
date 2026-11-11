// Server authorization over the shared rules (T-3.2; ADR-0004, ADR-0007, ADR-0010). Capabilities come from the
// organization's role matrix (`dir.org`), scope from the reporting line. Only FR-5's "a lead extends once" still
// looks at the role itself (`relation`), as ADR-0004 allows where the work order ties a rule to a role.
import {
  assignableUsers as sharedAssignable,
  canViewTask,
  hasPerm,
  isCoS,
  isFoundersOffice,
  isOverseer,
  type Permission,
  type TaskParties,
} from '@taskwatch/shared/permissions';
import { allowedActions, type Status, type TaskAction } from '@taskwatch/shared/workflow';
import { isRatable } from '@taskwatch/shared/performance';
import * as clock from '../clock.js';
import { isOpenStatus } from '../domain.js';
import type { Directory, DirUser } from './directory.js';
import { hasRole } from './directory.js';

export interface TaskRef {
  /** Required: a row loaded without it is refused (fail closed), never treated as the viewer's organization. */
  organization_id: number;
  assignee_id: number;
  assigner_id: number;
  created_by?: number | null;
  reviewer_id?: number | null;
  status: string;
  /** D-133: a discarded draft is visible to nobody. */
  discarded_at?: Date | null;
  lead_extension_used?: boolean;
}

/** The task's people, as the shared rules name them. A missing creator is the assigner (rows from before 002). */
const parties = (t: TaskRef): TaskParties<number> => ({
  assigneeId: t.assignee_id,
  assignedBy: t.assigner_id,
  createdBy: t.created_by ?? t.assigner_id,
  reviewerId: t.reviewer_id as number, // null never equals a person id
});

export const can = (viewer: DirUser, dir: Directory, perm: Permission): boolean => hasPerm(dir.org, viewer, perm);

/** The shared rules know one organization only ("the Founder's Office sees everything"), so every task check starts here. */
const sameOrg = (viewer: DirUser, task: TaskRef): boolean => task.organization_id === viewer.organizationId;

/** People whose tasks the viewer can see: themselves plus everyone they supervise. */
export function scopeIds(viewer: DirUser, dir: Directory): number[] {
  return [viewer.id, ...dir.descendants(viewer.id)];
}

/**
 * SQL filter for the tasks the viewer may see, always inside their own organization. Mirrors `canViewTask`:
 * the Founder's Office sees the whole organization; others see tasks they hold, gave, created or review, plus their
 * reports' tasks when they hold view_tasks. Enforced on every query.
 */
export function visibilityFilter(viewer: DirUser, dir: Directory, alias: string, firstParam: number): { sql: string; params: unknown[] } {
  const org = `${alias}.organization_id = $${firstParam} and ${alias}.discarded_at is null`; // D-133
  if (isFoundersOffice(viewer)) return { sql: org, params: [viewer.organizationId] };
  const me = `$${firstParam + 1}`;
  const reports = can(viewer, dir, 'view_tasks') ? [...dir.descendants(viewer.id)] : [];
  return {
    sql: `(${org} and (${alias}.assignee_id = ${me} or ${alias}.assigner_id = ${me} or ${alias}.created_by = ${me} or ${alias}.reviewer_id = ${me}
           or ${alias}.assignee_id = any($${firstParam + 2})))`,
    params: [viewer.organizationId, viewer.id, reports],
  };
}

export function canView(viewer: DirUser, task: TaskRef, dir: Directory): boolean {
  return sameOrg(viewer, task) && !task.discarded_at && canViewTask(dir.org, viewer, parties(task));
}

export type Relation = 'cos' | 'manager' | 'lead' | null;

/** FR-5: whose extension is unlimited (CoS, manager) and whose is once only (lead). Needs authority over the task. */
export function relation(viewer: DirUser, task: TaskRef, dir: Directory): Relation {
  if (!sameOrg(viewer, task)) return null;
  if (isCoS(viewer)) return 'cos';
  if (!isOverseer(dir.org, viewer, parties(task))) return null;
  if (hasRole(viewer, 'manager')) return 'manager';
  if (hasRole(viewer, 'lead')) return 'lead';
  return null;
}

/** Who the viewer may assign work to (FR-1, D-32): needs assign_tasks; themselves and their reports; a CoS anyone. */
export function assignableUsers(viewer: DirUser, dir: Directory): DirUser[] {
  const ids = new Set(sharedAssignable(dir.org, viewer).map((p) => p.id));
  return dir.all().filter((u) => ids.has(u.id));
}

export function canAssign(viewer: DirUser, dir: Directory): boolean {
  return can(viewer, dir, 'assign_tasks');
}

/**
 * WF-10: the actions the viewer may take on this task, from the shared workflow rules (the same code the client
 * runs). Facts the rules cannot know from the row (pending extension, escalation recipient) come from the query.
 */
export function taskActions(
  viewer: DirUser,
  dir: Directory,
  task: TaskRef & { acknowledged_at?: Date | null; review_required?: boolean; [k: string]: any },
  facts: { pendingExtension: boolean; mayAckEscalation: boolean },
): TaskAction[] {
  const p = parties(task);
  const isAssignee = task.assignee_id === viewer.id;
  return [
    ...allowedActions(
      { status: task.status as Status, acknowledgedAt: task.acknowledged_at ?? null, reviewRequired: !!task.review_required, ratable: ratableRow(task, clock.now()) },
      {
        canView: canView(viewer, task, dir),
        isAssignee,
        isOverseer: !isAssignee && isOverseer(dir.org, viewer, p),
        isGiver: p.createdBy === viewer.id || p.assignedBy === viewer.id || isCoS(viewer),
        isCurrentGiver: p.assignedBy === viewer.id || isCoS(viewer), // D-133: once reassigned, the original creator no longer gives it
        can: (perm) => can(viewer, dir, perm),
        ...facts,
      },
    ),
  ];
}

/** PERF: the shared isRatable on a task row (snake_case columns). */
export const ratableRow = (r: Record<string, any>, now: Date): boolean =>
  r.due_at instanceof Date &&
  isRatable(
    { status: r.status, reviewRequired: !!r.review_required, scored: !!r.scored, target: r.target ?? null, outcomeScore: r.outcome_score ?? null, shortfallReason: r.shortfall_reason ?? null, shortfallAccepted: r.shortfall_accepted ?? null, blockedReason: r.blocked_reason ?? null, dueAt: r.due_at },
    now,
  );

/** Authority over the task (giver, reviewer, or above the assignee with view_tasks), inside the viewer's organization. */
export const isOverseerOf = (viewer: DirUser, task: TaskRef, dir: Directory): boolean => sameOrg(viewer, task) && isOverseer(dir.org, viewer, parties(task));

export interface TaskPermissions {
  postUpdate: boolean;
  comment: boolean;
  extendDue: boolean;
  reassign: boolean;
  close: boolean;
  reopen: boolean;
}

export function taskPermissions(viewer: DirUser, task: TaskRef, dir: Directory): TaskPermissions {
  const open = isOpenStatus(task.status);
  const rel = relation(viewer, task, dir);
  const isAssignee = task.assignee_id === viewer.id;
  const extendRole = rel === 'cos' || rel === 'manager' || (rel === 'lead' && !task.lead_extension_used);
  return {
    postUpdate: open && isAssignee && can(viewer, dir, 'update_assigned_tasks'),
    comment: canView(viewer, task, dir), // D-74: the assignee may comment too (KI-45)
    extendDue: open && extendRole && can(viewer, dir, 'approve_extensions'),
    reassign: open && rel !== null && can(viewer, dir, 'reassign_tasks'), // D-29: leads lack it by default
    close: open && (rel === 'cos' || rel === 'manager'),
    reopen: !open && (rel === 'cos' || rel === 'manager' || task.assigner_id === viewer.id),
  };
}
