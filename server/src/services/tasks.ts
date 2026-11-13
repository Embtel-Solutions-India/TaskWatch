// Task core actions (Phase 4, T-4.3…T-4.9; TASKS-FRD, TASK-WORKFLOW-FRD). Every action runs through `act`: the task
// row is locked, a task the caller cannot see is reported as missing (T-1.12), the shared `allowedActions` decide what
// is allowed (WF-10), and escalation is re-evaluated in the same transaction (C-7). Task actions are recorded in the
// hash-chained activity log; admin_log keeps rule, directory and admin changes (DATABASE_DESIGN §3.10).
import { isCoS } from '@taskwatch/shared/permissions';
import type { TaskAction } from '@taskwatch/shared/workflow';
import { shiftOf, taskProgress, workingHours, type Purpose } from '@taskwatch/shared/performance';
import { PRE_DEADLINE_WARNING_MINUTES, deadlineMilestones } from '@taskwatch/shared/policy';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DateTime } from 'luxon';
import type pg from 'pg';
import * as clock from '../clock.js';
import { MINUTE } from '../clock.js';
import { config } from '../config.js';
import { HOUR } from '../clock.js';
import { pool, tx, type Db } from '../db/pool.js';
import { LEVEL_LABELS, type Priority, type Status } from '../domain.js';
import { applyLevel } from '../engine/engine.js';
import { routeEscalation } from '../engine/routing.js';
import { badRequest, forbidden, HttpError, invalid, notFound } from '../http/errors.js';
import { formatInZone } from '../notify/format.js';
import { assignedMessage, blockedMessage, inAppNotice, type TaskInfo } from '../notify/messages.js';
import { notify } from '../notify/notify.js';
import { appendLog } from './activity.js';
import { appendAdmin } from './audit.js';
import { assignableUsers, can, canView, relation, taskActions, taskPermissions } from './access.js';
import { getDirectory, hasRole, type Directory, type DirUser } from './directory.js';
import { awayNow, clockFor } from './worktime.js';
import { getRuleSet } from './rules.js';
import { findSensitiveId } from './sensitive.js';
import { getSettings } from './settings.js';

/* ---------- Shared helpers ---------- */

/** D-5: a due date is entered as a local date (and optional time, default 17:00) in the actor's zone. Null if invalid. */
export function dueFrom(date: string | undefined, time: string | undefined, timeZone: string): Date | null {
  if (!date) return null;
  const dt = DateTime.fromISO(`${date}T${time || '17:00'}`, { zone: timeZone });
  return dt.isValid ? dt.toJSDate() : null;
}

export function guardText(...texts: Array<string | undefined | null>): void {
  for (const t of texts) {
    if (!t) continue;
    const hit = findSensitiveId(t);
    if (hit) {
      throw new HttpError(422, `This looks like it contains ${hit}. Remove ID numbers from task text and link the case in ImmigrationCRM instead.`);
    }
  }
}

/** Locks the task row. A task the actor cannot see is reported exactly like a missing one (404), so ids never leak. */
export async function lockTask(c: pg.PoolClient, taskId: number, actor: DirUser, dir: Directory, missing = 'Task not found') {
  const { rows } = await c.query(
    `select t.*, e.name as entity_name from tasks t join entities e on e.id = t.entity_id where t.id = $1 for update of t`,
    [taskId],
  );
  if (!rows[0] || !canView(actor, rows[0], dir)) throw notFound(missing);
  return rows[0];
}

export const ref = (id: number) => `TW-${id}`;
const taskInfo = (t: any): TaskInfo => ({ id: t.id, title: t.title, priority: t.priority, dueAt: t.due_at, entityName: t.entity_name });
const who = (u: DirUser | undefined) => (u ? { id: u.id, name: u.name } : null);
const tooShort = (s: string | undefined, n: number) => !s || s.trim().length < n;

interface Ctx {
  c: pg.PoolClient;
  t: any;
  dir: Directory;
  now: Date;
  rules: Awaited<ReturnType<typeof getRuleSet>> extends { for(e: string): infer R } ? R : never;
  actions: TaskAction[];
}

/**
 * Run one task action. `precheck` runs on the locked row before the action check, for the FRD's specific answers
 * (409 conflicts, own-work messages); `label` completes "You can't <label> on TW-n in its current state."
 */
export async function act(
  actor: DirUser,
  taskId: number,
  action: TaskAction,
  label: string,
  fn: (x: Ctx) => Promise<void>,
  precheck?: (x: Omit<Ctx, 'actions'>) => Promise<void> | void,
): Promise<void> {
  const dir = await getDirectory(actor.organizationId);
  await tx(async (c) => {
    const t = await lockTask(c, taskId, actor, dir);
    const now = clock.now();
    const rules = (await getRuleSet(actor.organizationId)).for(t.entity_id);
    await precheck?.({ c, t, dir, now, rules });
    const { rows: f } = await c.query<{ pending: boolean; mine: boolean; any: boolean }>(
      `select exists (select 1 from extensions where task_id = $1 and status = 'pending') as pending,
              exists (select 1 from escalations e join escalation_recipients r on r.escalation_id = e.id
                       where e.task_id = $1 and e.cleared_at is null and e.acknowledged_at is null and r.user_id = $2 and r.kind = 'to') as mine,
              exists (select 1 from escalations where task_id = $1 and cleared_at is null and acknowledged_at is null) as any`,
      [taskId, actor.id],
    );
    const actions = taskActions(actor, dir, t, { pendingExtension: f[0]!.pending, mayAckEscalation: f[0]!.mine || (isCoS(actor) && f[0]!.any) });
    if (!actions.includes(action)) throw forbidden(`You can't ${label} on ${ref(taskId)} in its current state.`);
    const was = { due: t.due_at.getTime(), priority: t.priority, assignee: t.assignee_id, entity: t.entity_id, status: t.status };
    await fn({ c, t, dir, now, rules, actions });
    await restampIfMoved(c, taskId, was);
    await applyLevel(c, taskId, dir);
  });
}

/**
 * ADR-0014 (D-140, D-146): fix the task's L2 and L3 instants from its due time, priority and its vertical's policy as it
 * stands now. Progress never calls this, and a later policy change does not, so the milestones only move with the task.
 */
export async function stampMilestones(c: pg.PoolClient, taskId: number): Promise<void> {
  const { rows } = await c.query<{ due_at: Date; priority: Priority; entity_id: string; organization_id: number; assignee_id: number | null }>(
    'select due_at, priority, entity_id, organization_id, assignee_id from tasks where id = $1',
    [taskId],
  );
  const t = rows[0];
  if (!t) return;
  const set = await getRuleSet(t.organization_id);
  // ADR-0015 (D-160): non-Critical L2/L3 are working minutes after due in the assignee's vertical; away is not removed (late is late).
  const assignee = t.assignee_id ? (await getDirectory(t.organization_id)).get(t.assignee_id) : undefined;
  const [, l2, l3] = deadlineMilestones(t.due_at.getTime(), t.priority, set.for(t.entity_id), clockFor(assignee, t.priority));
  await c.query('update tasks set deadline_l2_at = $2, deadline_l3_at = $3, policy_version = $4 where id = $1', [taskId, new Date(l2), new Date(l3), set.versionTag(t.entity_id)]);
}

/** Restamp after an action that moved what the milestones are made of: due time, priority, assignee, vertical, or leaving draft / Done. */
async function restampIfMoved(c: pg.PoolClient, taskId: number, was: { due: number; priority: string; assignee: number; entity: string; status: string }): Promise<void> {
  const { rows } = await c.query('select due_at, priority, assignee_id, entity_id, status, deadline_l2_at from tasks where id = $1', [taskId]);
  const t = rows[0];
  if (!t || t.status === 'draft') return;
  const moved = t.due_at.getTime() !== was.due || t.priority !== was.priority || t.assignee_id !== was.assignee || t.entity_id !== was.entity;
  const backInPlay = t.status !== was.status && (was.status === 'draft' || was.status === 'completed');
  if (moved || backInPlay || !t.deadline_l2_at) await stampMilestones(c, taskId);
}

export async function notifyUser(c: pg.PoolClient, dir: Directory, rules: Ctx['rules'], userId: number | null | undefined, event: string, taskId: number, subject: string, text: string) {
  if (!userId) return;
  await notify(c, dir, rules, [{ userId }], () => inAppNotice(event, taskId, subject, text));
}

/* ---------- Create, draft, publish, edit (T-4.3, T-4.4; TASK-01…03, D-34, D-63) ---------- */

export interface TaskInput {
  title: string;
  description: string;
  instructions: string;
  category: string;
  priority: Priority;
  assigneeId: number;
  teamId: number | null;
  dueAt: Date;
  startAt: Date | null;
  /** ADR-0014: what the assignee must hand in (free text, optional). */
  submissionRequirements?: string | null;
  /** Who reviews when review is required; null = the giver (as before). */
  reviewerId?: number | null;
  reviewRequired: boolean;
  parentId: number | null;
  /** PERF (FRD §4): set by the task giver. Estimate and purpose are required except on drafts and system-generated tasks. */
  target: number | null;
  unit: string | null;
  estimatedHours: number | null;
  purpose: Purpose | null;
}

/** PERF field rules shared by create, edit and publish. */
export function measuredErrors(p: { target: number | null; unit: string | null; estimatedHours: number | null; purpose: Purpose | null }, requireMeasures: boolean): Record<string, string> {
  const f: Record<string, string> = {};
  if (p.target !== null && !p.unit) f.unit = 'Name the unit, e.g. emails.';
  if (requireMeasures && p.estimatedHours === null) f.estimatedHours = 'Between 0.25 and 200 hours.';
  if (requireMeasures && p.purpose === null) f.purpose = 'Choose revenue or support.';
  return f;
}

/** The FRD's field rules; `existing` relaxes what an edit may leave unchanged. Returns the derived entity (D-63). */
async function checkTask(c: pg.PoolClient, actor: DirUser, dir: Directory, p: TaskInput, opts: { draft: boolean; existing?: any; now: Date; system?: boolean }): Promise<string> {
  const f: Record<string, string> = measuredErrors(p, !opts.draft && !opts.system);
  const title = p.title.trim();
  if (title.length < 4) f.title = 'Give the task a title of at least 4 characters.';
  else if (title.length > 140) f.title = 'Keep the title under 140 characters.';
  const settings = await getSettings(actor.organizationId);
  if (p.category && !settings.categories.includes(p.category)) f.category = 'Choose a category.'; // optional (owner 2026-11-13)
  const assignee = dir.get(p.assigneeId);
  const sameAssignee = opts.existing?.assignee_id === p.assigneeId;
  if (!assignee?.active && !sameAssignee) f.assigneeId = 'Choose who will do this.';
  else if (!opts.draft && !sameAssignee && !assignableUsers(actor, dir).some((u) => u.id === p.assigneeId)) {
    f.assigneeId = 'You can only assign to people below you in the reporting line.';
  }
  const sameDue = opts.existing && opts.existing.due_at.getTime() === p.dueAt.getTime();
  if (!sameDue && p.dueAt.getTime() <= opts.now.getTime()) f.dueDate = 'The due time must be in the future.';
  if (p.startAt && p.startAt.getTime() >= p.dueAt.getTime()) f.startDate = 'The scheduled start must be before the due time.';
  if (p.reviewRequired && p.reviewerId != null) {
    const reviewer = dir.get(p.reviewerId);
    if (p.reviewerId === p.assigneeId) f.reviewerId = 'The assignee cannot review their own work.';
    else if (!reviewer?.active || !can(reviewer, dir, 'review_tasks')) f.reviewerId = 'Choose someone who can review tasks.';
  }
  if (p.parentId !== null) {
    if (opts.existing && p.parentId === opts.existing.id) f.parentId = 'A task cannot be its own parent.';
    else {
      const { rows } = await c.query('select * from tasks where id = $1', [p.parentId]);
      if (!rows[0] || !canView(actor, rows[0], dir)) f.parentId = 'Pick a parent task you can see.';
    }
  }
  let entityId = assignee?.entityId ?? opts.existing?.entity_id;
  if (p.teamId !== null) {
    const teamEntity = await teamEntityOf(c, actor.organizationId, p.teamId);
    if (!teamEntity) f.teamId = 'Choose a team.';
    else entityId = teamEntity; // D-4/D-63: the team's entity, else the assignee's
  }
  if (Object.keys(f).length) throw invalid(f);
  return entityId;
}

/** The entity of an active team in this organization (D-4/D-63), or null when there is no such team. */
export async function teamEntityOf(c: pg.PoolClient | pg.Pool, organizationId: number, teamId: number): Promise<string | null> {
  const { rows } = await c.query<{ entity_id: string }>('select entity_id from teams where id = $1 and organization_id = $2 and archived_at is null', [teamId, organizationId]);
  return rows[0]?.entity_id ?? null;
}

type CreateOpts = { draft?: boolean; recurringId?: number; occurrenceDate?: string };

/** TASK-01/02: assign now, or save a draft (no assignment, no notification, no clock). Returns the new id. */
export async function createTask(actor: DirUser, p: TaskInput, opts: CreateOpts = {}): Promise<number> {
  return (await createTasks(actor, [p], opts))[0]!;
}

/** D-153: the same task for several people, one task each, in one transaction: all are created or none. */
export async function createTasks(actor: DirUser, inputs: TaskInput[], opts: CreateOpts = {}): Promise<number[]> {
  const dir = await getDirectory(actor.organizationId);
  const draft = !!opts.draft;
  if (!can(actor, dir, 'create_tasks')) throw forbidden("You don't have permission to create tasks.");
  if (!draft && !can(actor, dir, 'assign_tasks')) throw forbidden("You don't have permission to assign tasks.");
  for (const p of inputs) guardText(p.title, p.description, p.instructions, p.submissionRequirements);
  return tx(async (c) => {
    const ids: number[] = [];
    for (const p of inputs) ids.push(await insertTask(c, actor, dir, p, opts));
    return ids;
  });
}

async function insertTask(c: pg.PoolClient, actor: DirUser, dir: Directory, p: TaskInput, opts: CreateOpts): Promise<number> {
  const draft = !!opts.draft;
  const now = clock.now();
  {
    const entityId = await checkTask(c, actor, dir, p, { draft, now, system: opts.recurringId !== undefined });
    const assignee = dir.must(p.assigneeId);
    const { rows } = await c.query<{ id: number }>(
      `insert into tasks (title, description, instructions, category, entity_id, assignee_id, assigner_id, created_by, reviewer_id, priority,
         due_at, original_due_at, start_at, review_required, parent_id, team_id, created_at, assigned_at, clock_started_at, updated_at,
         recurring_id, organization_id, status, occurrence_date, target, unit, estimated_hours, purpose, submission_requirements)
       values ($1,$2,$3,$4,$5,$6,$7,$7,coalesce($23::int, $7::int),$8,$9,$9,$10,$11,$12,$13,$14,$14,$14,$14,$15,$16,$17,$18,$19,$20,$21,$22,$24) returning id`,
      [p.title.trim(), p.description, p.instructions, p.category, entityId, p.assigneeId, actor.id, p.priority, p.dueAt, p.startAt, p.reviewRequired,
        p.parentId, p.teamId ?? assignee.teamId, now, opts.recurringId ?? null, actor.organizationId, draft ? 'draft' : 'assigned', opts.occurrenceDate ?? null, p.target, p.target === null ? null : p.unit, p.estimatedHours, p.purpose,
        p.reviewerId ?? null, p.submissionRequirements ?? null],
    );
    const id = rows[0]!.id;
    await appendLog(c, {
      taskId: id,
      actorId: actor.id,
      kind: 'created',
      body: opts.recurringId ? 'Created from a recurring schedule' : draft ? 'Saved as a draft' : null,
      after: { title: p.title.trim(), entity: entityId, assignee: who(assignee), priority: p.priority, dueAt: p.dueAt.toISOString(), instructions: p.instructions },
    });
    if (!draft) {
      await stampMilestones(c, id);
      await assignNow(c, id, actor, assignee, dir, now);
    }
    return id;
  }
}

/** The assignment record, the `assigned` log row and the mandatory assignment notification (TASK-01, TASK-02 publish). */
async function assignNow(c: pg.PoolClient, taskId: number, actor: DirUser, assignee: DirUser, dir: Directory, now: Date) {
  await c.query(`insert into assignments (task_id, assignee_id, assigned_by, assigned_at) values ($1,$2,$3,$4)`, [taskId, assignee.id, actor.id, now]);
  await appendLog(c, { taskId, actorId: actor.id, kind: 'assigned', after: { assignee: who(assignee) } });
  const { rows } = await c.query(`select t.*, e.name as entity_name from tasks t join entities e on e.id = t.entity_id where t.id = $1`, [taskId]);
  const rules = (await getRuleSet(actor.organizationId)).for(rows[0].entity_id);
  await notify(c, dir, rules, [{ userId: assignee.id }], (u) => assignedMessage(taskInfo(rows[0]), actor, u, false, now));
}

/** TASK-02: a draft is assigned; the clock starts now. */
export async function publishTask(actor: DirUser, taskId: number): Promise<void> {
  await act(actor, taskId, 'publish', 'assign this draft', async ({ c, t, dir, now }) => {
    if (t.due_at.getTime() <= now.getTime()) throw invalid({ dueDate: 'Move the due date into the future before assigning.' });
    const missing = measuredErrors({ target: t.target, unit: t.unit, estimatedHours: t.estimated_hours, purpose: t.purpose }, true);
    if (Object.keys(missing).length) throw invalid(missing);
    if (!assignableUsers(actor, dir).some((u) => u.id === t.assignee_id)) throw forbidden('The selected assignee is outside your scope.');
    await c.query(`update tasks set status = 'assigned', assigned_at = $2, clock_started_at = $2, updated_at = $2 where id = $1`, [taskId, now]);
    await assignNow(c, taskId, actor, dir.must(t.assignee_id), dir, now);
  });
}

/**
 * TASK-03: edit an open task. An assignee change is a reassignment (needs the `reassign` action, so D-29 holds) and a
 * due change follows FR-5's authority (BR-56), so Edit can bypass neither.
 */
export async function updateTask(actor: DirUser, taskId: number, p: TaskInput): Promise<void> {
  guardText(p.title, p.description, p.instructions, p.submissionRequirements);
  await act(actor, taskId, 'edit', 'edit this task', async (x) => {
    const { c, t, dir, now, actions } = x;
    await checkTask(c, actor, dir, p, { draft: t.status === 'draft', existing: t, now });
    if (p.assigneeId !== t.assignee_id) {
      if (t.status !== 'draft' && !actions.includes('reassign')) throw forbidden(`You can't reassign on ${ref(taskId)} in its current state.`);
      const due = t.status === 'draft' ? null : reassignDueError(t, now, p.dueAt.getTime() !== t.due_at.getTime() ? p.dueAt : undefined);
      if (due) throw invalid({ dueDate: due });
      if (t.status !== 'draft') await doReassign(x, actor, p.assigneeId, 'Changed while editing the task');
    }
    if (t.status !== 'draft' && p.dueAt.getTime() !== t.due_at.getTime()) await doDueChange(x, actor, p.dueAt, 'Changed while editing the task');
    const fields = { title: p.title.trim(), description: p.description, instructions: p.instructions, category: p.category, priority: p.priority, team_id: p.teamId ?? t.team_id, start_at: p.startAt, review_required: p.reviewRequired, parent_id: p.parentId,
      target: p.target, unit: p.target === null ? null : p.unit, estimated_hours: p.estimatedHours, purpose: p.purpose,
      submission_requirements: p.submissionRequirements ?? null, reviewer_id: p.reviewRequired && p.reviewerId !== undefined ? p.reviewerId : t.reviewer_id }; // null: back to the giver
    const changed = Object.entries(fields).filter(([k, v]) => String(v ?? '') !== String(t[k] ?? ''));
    await c.query(
      `update tasks set title = $2, description = $3, instructions = $4, category = $5, priority = $6, team_id = $7, start_at = $8,
         review_required = $9, parent_id = $10, updated_at = $11, target = $14, unit = $15, estimated_hours = $16, purpose = $17,
         submission_requirements = $18, reviewer_id = $19,
         assignee_id = case when status = 'draft' then $12 else assignee_id end, due_at = case when status = 'draft' then $13 else due_at end
       where id = $1`,
      [taskId, fields.title, fields.description, fields.instructions, fields.category, fields.priority, fields.team_id, fields.start_at, fields.review_required, fields.parent_id, now, p.assigneeId, p.dueAt, fields.target, fields.unit, fields.estimated_hours, fields.purpose,
        fields.submission_requirements, fields.reviewer_id],
    );
    if (changed.length) {
      await appendLog(c, {
        taskId,
        actorId: actor.id,
        kind: 'edited',
        before: Object.fromEntries(changed.map(([k]) => [k, t[k] instanceof Date ? t[k].toISOString() : t[k]])),
        after: Object.fromEntries(changed.map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])),
      });
    }
  });
}

/* ---------- FR-5 direct due change (EXT-04) ---------- */

/**
 * FR-5 authority: CoS; a manager over the task; a lead over it once (lead_extension_used). Writes the log and notifies.
 * `earlierOk`: a reassignment may also set an earlier due time for the new person (D-148); only a later one is an
 * extension, so only that uses up a lead's one extension.
 */
async function doDueChange(x: Pick<Ctx, 'c' | 't' | 'dir' | 'rules' | 'now'>, actor: DirUser, dueAt: Date, reason: string, earlierOk = false) {
  const { c, t, dir, rules, now } = x;
  if (!taskPermissions(actor, t, dir).extendDue) {
    throw forbidden(t.lead_extension_used && relation(actor, t, dir) === 'lead' ? 'A team lead can extend a task only once' : 'You cannot change this due date');
  }
  const later = dueAt.getTime() > t.due_at.getTime();
  if (!later && !earlierOk) throw invalid({ dueDate: 'The new due date must be later than the current one' });
  if (dueAt.getTime() <= now.getTime()) throw invalid({ dueDate: 'The new due date must be in the future.' });
  const rel = relation(actor, t, dir);
  const usesExtension = rel === 'lead' && later;
  await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'due_change', body: reason, before: { dueAt: t.due_at.toISOString() }, after: { dueAt: dueAt.toISOString(), as: rel } });
  await c.query('update tasks set due_at = $2, lead_extension_used = lead_extension_used or $3, updated_at = $4 where id = $1', [t.id, dueAt, usesExtension, now]);
  t.due_at = dueAt;
  t.lead_extension_used = t.lead_extension_used || usesExtension;
  await notify(c, dir, rules, [{ userId: t.assignee_id }], (u) =>
    inAppNotice('due_change', t.id, `New due date for “${t.title}”`, `${actor.name} moved the due date to ${formatInZone(dueAt, u.timeZone)}: ${reason}`),
  );
}

export async function changeDue(actor: DirUser, taskId: number, dueAt: Date, reason: string): Promise<void> {
  if (!reason.trim()) throw invalid({ reason: 'Give a reason for the new due date' });
  guardText(reason);
  const dir = await getDirectory(actor.organizationId);
  await tx(async (c) => {
    const t = await lockTask(c, taskId, actor, dir);
    const rules = (await getRuleSet(actor.organizationId)).for(t.entity_id);
    await doDueChange({ c, t, dir, rules, now: clock.now() }, actor, dueAt, reason.trim());
    await stampMilestones(c, taskId);
    await applyLevel(c, taskId, dir);
  });
}

/* ---------- Acknowledge, start, progress, block (T-4.5, T-4.6; WF-01…03, WF-11) ---------- */

/** WF-01: receipt confirmed; repeats pause for ackSnoozeHours; the clock and level never change (BR-45). */
export async function acknowledgeTask(actor: DirUser, taskId: number): Promise<void> {
  await act(actor, taskId, 'acknowledge', 'acknowledge', async ({ c, now, rules }) => {
    await c.query('update tasks set acknowledged_at = $2, snooze_until = $3, updated_at = $2 where id = $1', [taskId, now, new Date(now.getTime() + rules.ackSnoozeHours * HOUR)]);
    await appendLog(c, { taskId, actorId: actor.id, kind: 'acknowledged' });
  });
}

/** WF-02: → In progress; acknowledges if not yet; does not reset the clock (BR-11). Also unblocks (ADR-0003). */
export async function startTask(actor: DirUser, taskId: number): Promise<void> {
  await act(actor, taskId, 'start', 'start work', async ({ c, t, now }) => {
    await c.query(
      `update tasks set status = 'in_progress', blocked_reason = null, acknowledged_at = coalesce(acknowledged_at, $2), updated_at = $2 where id = $1`,
      [taskId, now],
    );
    await appendLog(c, { taskId, actorId: actor.id, kind: 'status', before: { status: t.status }, after: { status: 'in_progress' } });
  });
}

/** An upload held in memory: its type was detected from its bytes and checked against the allow-list (D-69). */
export interface PendingFile {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  buffer: Buffer;
}

/**
 * S-4: files reach the disk only inside an authorized action. `written` collects the storage keys, so `withCleanup`
 * can remove them again if the transaction fails afterwards (ATT-01-AC-1).
 */
export async function withCleanup<T>(run: (written: string[]) => Promise<T>): Promise<T> {
  const written: string[] = [];
  try {
    return await run(written);
  } catch (err) {
    await Promise.all(written.map((k) => fsp.rm(path.join(config.uploadDir, k), { force: true })));
    throw err;
  }
}

/** Write one file and its row (with an `attachment_added` log row unless it belongs to a logged update). */
export async function storeAttachment(
  c: pg.PoolClient,
  x: { taskId: number; logId: number; actor: DirUser; file: PendingFile; now: Date; context: 'task' | 'progress' | 'comment' | 'review'; commentId?: number; written: string[] },
): Promise<number> {
  const key = crypto.randomUUID();
  await fsp.writeFile(path.join(config.uploadDir, key), x.file.buffer, { flag: 'wx' });
  x.written.push(key);
  const { rows } = await c.query<{ id: number }>(
    `insert into attachments (task_id, log_id, file_name, mime, size, sha256, storage_key, uploaded_by, uploaded_at, context, comment_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [x.taskId, x.logId, x.file.name, x.file.mime, x.file.size, x.file.sha256, key, x.actor.id, x.now, x.context, x.commentId ?? null],
  );
  return rows[0]!.id;
}

/** Counts as an assignee update: the clock restarts and the assignment's first update is recorded (FR-3, FR-11). */
async function recordAssigneeUpdate(c: pg.PoolClient, taskId: number, now: Date) {
  await c.query(`update tasks set clock_started_at = $2, last_update_at = $2, updated_at = $2, acknowledged_at = coalesce(acknowledged_at, $2) where id = $1`, [taskId, now]);
  await c.query(`update assignments set first_update_at = $2 where task_id = $1 and ended_at is null and first_update_at is null`, [taskId, now]);
}

const fileMeta = (fs: PendingFile[] = []) => (fs.length ? { files: fs.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })) } : {});

/** WF-03: the only routine way to reset the silence clock. Moves the task to In progress (also from Blocked). */
export async function postProgress(actor: DirUser, taskId: number, input: { message: string; percent?: number; achieved?: number; files?: PendingFile[] }): Promise<void> {
  const message = input.message.trim();
  const f: Record<string, string> = {};
  if (message.length < 5) f.message = 'Describe what changed (at least 5 characters).';
  if (input.percent !== undefined && (input.percent < 0 || input.percent > 100)) f.percent = 'Progress must be between 0 and 100.';
  if (Object.keys(f).length) throw invalid(f);
  guardText(message, ...(input.files ?? []).map((f) => f.name));
  await withCleanup((written) => act(actor, taskId, 'progress', 'post progress', async ({ c, t, dir, now, rules }) => {
    if (input.achieved !== undefined && t.target === null) throw invalid({ achieved: 'This task has no target to report against.' });
    // PERF: reporting an achieved amount sets progress from it (FRD §4); it is an assignee update like any other.
    const percent = input.achieved !== undefined ? taskProgress({ status: t.status, target: t.target, achieved: input.achieved, progress: t.progress })! : input.percent;
    const next: Status = ['assigned', 'reopened', 'changes_requested', 'blocked'].includes(t.status) ? 'in_progress' : t.status;
    const logId = await appendLog(c, {
      taskId,
      actorId: actor.id,
      kind: 'update',
      body: message,
      before: next !== t.status ? { status: t.status } : null,
      after: { ...(next !== t.status ? { status: next } : {}), ...(percent !== undefined ? { progress: percent } : {}), ...(input.achieved !== undefined ? { achieved: input.achieved } : {}), ...fileMeta(input.files) },
    });
    for (const file of input.files ?? []) await storeAttachment(c, { taskId, logId, actor, file, now, context: 'progress', written });
    await c.query('update tasks set status = $2, blocked_reason = null, progress = coalesce($3, progress), achieved = coalesce($4, achieved) where id = $1', [taskId, next, percent ?? null, input.achieved ?? null]);
    await recordAssigneeUpdate(c, taskId, now);
    if (t.assigner_id !== actor.id) await notifyUser(c, dir, rules, t.assigner_id, 'progress', taskId, `Update on “${t.title}”`, `${actor.name}: ${message}`);
  }));
}

/** WF-11: Blocked with a reason; counts as an update; the lead route is alerted at once (AC-3). */
export async function blockTask(actor: DirUser, taskId: number, reasonInput: string): Promise<void> {
  const reason = reasonInput.trim();
  if (reason.length < 5) throw invalid({ reason: 'Say what is blocking the task (at least 5 characters).' });
  guardText(reason);
  await act(actor, taskId, 'block', 'mark this task blocked', async ({ c, t, dir, now, rules }) => {
    await appendLog(c, { taskId, actorId: actor.id, kind: 'update', body: reason, before: { status: t.status }, after: { status: 'blocked' } });
    await c.query(`update tasks set status = 'blocked', blocked_reason = $2 where id = $1`, [taskId, reason]);
    await recordAssigneeUpdate(c, taskId, now);
    if (rules.blockedAlertsLead) {
      // An L1 marked away now is passed over: the alert goes straight to L2.
      const route = routeEscalation(dir, t.assignee_id, 1, rules, await awayNow(c, dir.ancestors(t.assignee_id), now));
      await notify(c, dir, rules, route.to.map((userId) => ({ userId })), () => blockedMessage(taskInfo(t), actor, reason));
    }
  });
}

/* ---------- Submit, complete, review (T-4.7; WF-04…06) ---------- */

/** WF-04: opens review round n+1; the clock restarts. */
export async function submitTask(actor: DirUser, taskId: number, input: { note: string; files?: PendingFile[] } & FinishReport): Promise<void> {
  const note = input.note.trim();
  if (note.length < 5) throw invalid({ note: 'Summarize what you are submitting.' });
  guardText(note, ...(input.files ?? []).map((f) => f.name));
  await withCleanup((written) => act(actor, taskId, 'submit', 'submit this task for review', async ({ c, t, dir, now, rules }) => {
    const { rows } = await c.query<{ n: number }>('select coalesce(max(round), 0)::int + 1 as n from reviews where task_id = $1', [taskId]);
    const round = rows[0]!.n;
    await finish(c, t, dir, actor, input, now);
    await c.query('insert into reviews (task_id, round, submitted_by, submitted_at, note) values ($1,$2,$3,$4,$5)', [taskId, round, actor.id, now, note]);
    const logId = await appendLog(c, { taskId, actorId: actor.id, kind: 'review_submitted', body: note, before: { status: t.status }, after: { status: 'submitted', round, ...fileMeta(input.files) } });
    for (const file of input.files ?? []) await storeAttachment(c, { taskId, logId, actor, file, now, context: 'review', written });
    await c.query(`update tasks set status = 'submitted' where id = $1`, [taskId]);
    await recordAssigneeUpdate(c, taskId, now);
    for (const id of new Set([t.reviewer_id, t.assigner_id])) {
      if (id !== actor.id) await notifyUser(c, dir, rules, id, 'review_required', taskId, `Review needed: “${t.title}”`, `${actor.name} submitted round ${round}: ${note}`);
    }
  }));
}

/** PERF: what the assignee reports when finishing (FRD §4). */
export interface FinishReport {
  achieved?: number;
  result?: string;
  shortfallReason?: string;
}

/** A task's working time so far against its standard (D-125); null without an estimate or a clock start. */
export type TimeUsed = { worked: number; standard: number };

/**
 * D-125: working hours from the automatic clock start (the scheduled start, else when it was assigned) to `until`, in
 * the assignee's own zone and shift (their quiet-hours complement, else the workday).
 */
export async function timeUsed(
  t: { id: number; start_at: Date | null; assigned_at: Date | null; estimated_hours: number | null; assignee_id: number },
  dir: Directory,
  organizationId: number,
  until: Date,
  db: Db = pool,
): Promise<TimeUsed | null> {
  const person = dir.get(t.assignee_id);
  if ((!t.start_at && !t.assigned_at) || !person || t.estimated_hours === null) return null;
  // Review fixes #3/#4: a reassigned task starts the new assignee's clock at their assignment; a reopened one at the reopen.
  const { rows: reopen } = await db.query<{ at: Date | null }>("select max(at) as at from activity_log where task_id = $1 and kind = 'reopened'", [t.id]);
  const start = new Date(Math.max(...[t.start_at, t.assigned_at, reopen[0]?.at].filter((d): d is Date => !!d).map((d) => d.getTime())));
  const shift = shiftOf(person, await getSettings(organizationId, db));
  const hours = (from: Date, to: Date) => workingHours(from, to, person.timeZone, shift);
  // Waiting in review is the reviewer's time, not the assignee's: each round from submission to decision is left out.
  const { rows } = await db.query<{ submitted_at: Date; decided_at: Date | null }>('select submitted_at, decided_at from reviews where task_id = $1', [t.id]);
  const inReview = rows.reduce((h, r) => h + hours(new Date(Math.max(r.submitted_at.getTime(), start.getTime())), new Date(Math.min((r.decided_at ?? until).getTime(), until.getTime()))), 0);
  return { worked: Math.max(0, Math.round((hours(start, until) - inReview) * 100) / 100), standard: t.estimated_hours };
}

/**
 * Validates a finishing report against the task and returns the values to store. A scored task that ends short of its
 * target, after its due date, or over its standard working time (D-125) needs a reason (the giver later accepts or not).
 */
function finishValues(t: any, r: FinishReport, now: Date, time: TimeUsed | null): { achieved: number | null; result: string | null; shortfallReason: string | null } {
  const f: Record<string, string> = {};
  if (r.achieved !== undefined && t.target === null) f.achieved = 'This task has no target to report against.';
  const achieved = r.achieved ?? t.achieved;
  const result = r.result?.trim() || t.result || null;
  const shortfallReason = r.shortfallReason?.trim() || t.shortfall_reason || null;
  const short = t.target !== null && (achieved ?? 0) < t.target;
  const late = now.getTime() > t.due_at.getTime();
  const over = !!time && time.worked > time.standard;
  if (t.scored && (short || late || over) && !shortfallReason) {
    f.shortfallReason = over && !short && !late ? `Took ${time!.worked.toFixed(1)} working hours against a ${time!.standard} h standard: explain the delay.` : 'Explain the shortfall or delay.';
  }
  if (Object.keys(f).length) throw invalid(f);
  guardText(result, shortfallReason);
  return { achieved, result, shortfallReason };
}

/** A comment and its activity entry, inside the caller's transaction (CMT-01; also D-125's reason "in chat"). */
export async function insertComment(c: pg.PoolClient, m: { taskId: number; actorId: number; body: string; now: Date; parentId?: number | null }): Promise<{ id: number; logId: number }> {
  const logId = await appendLog(c, { taskId: m.taskId, actorId: m.actorId, kind: 'comment', body: m.body, after: m.parentId ? { parentId: m.parentId } : null });
  const { rows } = await c.query<{ id: number }>(`insert into comments (task_id, author_id, parent_id, body, created_at, log_id) values ($1,$2,$3,$4,$5,$6) returning id`, [
    m.taskId,
    m.actorId,
    m.parentId ?? null,
    m.body,
    m.now,
    logId,
  ]);
  return { id: rows[0]!.id, logId };
}

/** Store the finishing report; a newly given reason is also posted to the task's comments (D-125). */
async function finish(c: pg.PoolClient, t: any, dir: Directory, actor: DirUser, r: FinishReport, now: Date) {
  const v = finishValues(t, r, now, t.scored ? await timeUsed(t, dir, actor.organizationId, now, c) : null); // review fix #8
  await c.query('update tasks set achieved = $2, result = $3, shortfall_reason = $4 where id = $1', [t.id, v.achieved, v.result, v.shortfallReason]);
  if (v.shortfallReason && v.shortfallReason !== t.shortfall_reason) {
    await insertComment(c, { taskId: t.id, actorId: actor.id, body: `Reason for delay or shortfall: ${v.shortfallReason}`, now });
  }
  return v;
}

async function closeAsCompleted(c: pg.PoolClient, taskId: number, actor: DirUser, now: Date) {
  await c.query(
    `update tasks set status = 'completed', progress = 100, completed_at = $2, closed_at = $2, closed_by = $3, blocked_reason = null, updated_at = $2 where id = $1`,
    [taskId, now, actor.id],
  );
}

/** WF-05 (R-2): the assignee marks it Done from Open, In progress or Blocked when no review is required. */
export async function completeTask(actor: DirUser, taskId: number, noteInput = '', report: FinishReport = {}): Promise<void> {
  const note = noteInput.trim();
  guardText(note);
  await act(
    actor,
    taskId,
    'complete',
    'mark this task done',
    async ({ c, t, dir, now, rules }) => {
      const v = await finish(c, t, dir, actor, report, now);
      await closeAsCompleted(c, taskId, actor, now);
      await appendLog(c, { taskId, actorId: actor.id, kind: 'completed', body: note || null, before: { status: t.status, achieved: t.achieved }, after: { status: 'completed', ...v } });
      if (t.assigner_id !== actor.id) await notifyUser(c, dir, rules, t.assigner_id, 'completed', taskId, `Done: “${t.title}”`, `${actor.name} marked it done.${note ? ` ${note}` : ''}`);
    },
    ({ t }) => {
      if (t.review_required && t.assignee_id === actor.id && ['assigned', 'in_progress', 'blocked'].includes(t.status)) {
        throw new HttpError(409, 'This task requires review approval before it can be completed.');
      }
    },
  );
}

/** WF-06: approve, or send back (changes requested / rejected); one decision per round, the second gets 409. */
export async function reviewTask(
  actor: DirUser,
  taskId: number,
  input: { decision: 'approved' | 'changes_requested' | 'rejected'; comment: string; qualityScore?: number; outcomeScore?: number; shortfallAccepted?: boolean },
): Promise<void> {
  const comment = input.comment.trim();
  if (input.decision !== 'approved' && comment.length < 5) throw invalid({ comment: 'Explain what needs to change.' });
  guardText(comment);
  await act(
    actor,
    taskId,
    'review',
    'review this task',
    async ({ c, t, dir, now, rules }) => {
      const { rows } = await c.query<{ id: number; round: number }>('select id, round from reviews where task_id = $1 and decision is null', [taskId]);
      const round = rows[0]!;
      if (input.decision === 'approved' && t.scored) {
        // PERF: approval carries the reviewer's quality score, and the outcome score when there is no target.
        const f: Record<string, string> = {};
        if (input.qualityScore === undefined) f.qualityScore = 'Give a quality score from 0 to 100.';
        if (t.target === null && input.outcomeScore === undefined) f.outcomeScore = 'Give an outcome score from 0 to 100.';
        if (input.shortfallAccepted !== undefined && !t.shortfall_reason) f.shortfallAccepted = 'There is no shortfall or delay reason to decide on.';
        if (Object.keys(f).length) throw invalid(f);
        await c.query(
          `update tasks set quality_score = $2, outcome_score = coalesce($3, outcome_score), shortfall_accepted = coalesce($4, shortfall_accepted),
             shortfall_decided_by = case when $4::boolean is null then shortfall_decided_by else $5 end,
             shortfall_decided_at = case when $4::boolean is null then shortfall_decided_at else $6 end where id = $1`,
          [taskId, input.qualityScore, t.target === null ? input.outcomeScore : null, input.shortfallAccepted ?? null, actor.id, now],
        );
      }
      await c.query('update reviews set decision = $2, decided_at = $3, reviewer_id = $4, comment = $5 where id = $1', [round.id, input.decision, now, actor.id, comment || null]);
      const next: Status = input.decision === 'approved' ? 'completed' : 'changes_requested';
      if (next === 'completed') await closeAsCompleted(c, taskId, actor, now);
      else await c.query(`update tasks set status = 'changes_requested', clock_started_at = $2, updated_at = $2 where id = $1`, [taskId, now]);
      await appendLog(c, { taskId, actorId: actor.id, kind: 'review_decided', body: comment || null, before: { status: t.status, qualityScore: t.quality_score, outcomeScore: t.outcome_score, shortfallAccepted: t.shortfall_accepted }, after: { status: next, round: round.round, decision: input.decision, ...(input.decision === 'approved' ? { qualityScore: input.qualityScore ?? null, outcomeScore: input.outcomeScore ?? null, shortfallAccepted: input.shortfallAccepted ?? null } : {}) } });
      await notifyUser(c, dir, rules, t.assignee_id, 'review_decision', taskId, `Review of “${t.title}”`, `${actor.name}: ${input.decision.replace('_', ' ')}${comment ? ` — ${comment}` : ''}`);
    },
    async ({ c, t }) => {
      if (t.assignee_id === actor.id) throw forbidden('You cannot review your own work.');
      const { rowCount } = await c.query('select 1 from reviews where task_id = $1 and decision is null', [taskId]);
      if (!rowCount) throw new HttpError(409, 'There is no pending submission to review.');
    },
  );
}

/** PERF Rate step (FRD §4): the giver scores a finished task without a target, and/or accepts a shortfall or delay. */
export async function rateTask(actor: DirUser, taskId: number, input: { outcomeScore?: number; shortfallAccepted?: boolean }): Promise<void> {
  await act(actor, taskId, 'rate', 'rate this task', async ({ c, t, now }) => {
    if (input.outcomeScore !== undefined && t.target !== null) throw invalid({ outcomeScore: "This task's outcome comes from its target." });
    if (input.shortfallAccepted !== undefined && !t.shortfall_reason && !t.blocked_reason) throw invalid({ shortfallAccepted: 'There is no shortfall or delay reason to decide on.' });
    await c.query(
      `update tasks set outcome_score = coalesce($2, outcome_score), shortfall_accepted = coalesce($3, shortfall_accepted),
         shortfall_decided_by = case when $3::boolean is null then shortfall_decided_by else $4 end,
         shortfall_decided_at = case when $3::boolean is null then shortfall_decided_at else $5 end, updated_at = $5 where id = $1`,
      [taskId, input.outcomeScore ?? null, input.shortfallAccepted ?? null, actor.id, now],
    );
    await appendLog(c, { taskId, actorId: actor.id, kind: 'rated', before: { outcomeScore: t.outcome_score, shortfallAccepted: t.shortfall_accepted }, after: input });
  });
}

/* ---------- Reassign, cancel, reopen (T-4.8; WF-07…09, D-29, D-30) ---------- */

/** D-148: the new person is not escalated the moment they receive a task that is late (or about to be). `newDue`: only when it moves. */
function reassignDueError(t: { due_at: Date }, now: Date, newDue: Date | undefined): string | null {
  if (newDue && newDue.getTime() <= now.getTime()) return 'The due time must be in the future.';
  const late = t.due_at.getTime() <= now.getTime() + PRE_DEADLINE_WARNING_MINUTES * MINUTE;
  return late && !newDue ? 'This task is past due or due within 10 minutes: set a new due time for the new assignee.' : null;
}

/** BR-63/64: assignment record, the reassigner becomes the giver, acknowledgement cleared, clock restarts, escalations re-fire (D-30). */
async function doReassign(x: Pick<Ctx, 'c' | 't' | 'dir' | 'rules' | 'now'>, actor: DirUser, toId: number, reason: string) {
  const { c, t, dir, rules, now } = x;
  const from = dir.get(t.assignee_id);
  const to = dir.must(toId);
  await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'reassign', body: reason, before: { assignee: who(from) }, after: { assignee: who(to) } });
  await c.query(
    `update tasks set assignee_id = $2, assigner_id = $5, assigned_at = $3, clock_started_at = $3, last_update_at = null, updated_at = $3, team_id = $4,
       acknowledged_at = null, snooze_until = null, status = case when status = 'blocked' then 'assigned' else status end, blocked_reason = null where id = $1`,
    [t.id, toId, now, to.teamId, actor.id],
  );
  await c.query('update assignments set ended_at = $2 where task_id = $1 and ended_at is null', [t.id, now]);
  await c.query(`insert into assignments (task_id, assignee_id, assigned_by, assigned_at) values ($1,$2,$3,$4)`, [t.id, toId, actor.id, now]);
  await c.query('update escalations set cleared_at = $2 where task_id = $1 and cleared_at is null', [t.id, now]);
  await c.query('update tasks set level = -1, level_reason = null where id = $1', [t.id]);
  await notify(c, dir, rules, [{ userId: toId }], (u) => assignedMessage(taskInfo(t), actor, u, true, now));
  if (from && from.id !== actor.id) await notifyUser(c, dir, rules, from.id, 'reassigned', t.id, `“${t.title}” was reassigned`, `${actor.name} moved it to ${to.name}: ${reason}`);
  t.assignee_id = toId;
}

export async function reassignTask(actor: DirUser, taskId: number, input: { toId?: number; reason: string; dueAt?: Date }): Promise<void> {
  const reason = input.reason.trim();
  guardText(reason);
  await act(actor, taskId, 'reassign', 'reassign this task', async (x) => {
    const f: Record<string, string> = {};
    if (!input.toId) f.toId = 'Choose the new assignee.';
    else if (input.toId === x.t.assignee_id) f.toId = 'Choose someone other than the current assignee.';
    else if (!assignableUsers(actor, x.dir).some((u) => u.id === input.toId)) f.toId = 'That person is outside your assignment scope.';
    if (reason.length < 5) f.reason = 'Give a reason for the reassignment.';
    const due = reassignDueError(x.t, x.now, input.dueAt);
    if (due) f.dueDate = due;
    if (Object.keys(f).length) throw invalid(f);
    // A new due time with the reassignment needs the same authority as any due change (FR-5 / BR-56), before the move.
    if (input.dueAt && input.dueAt.getTime() !== x.t.due_at.getTime()) await doDueChange(x, actor, input.dueAt, `New due time with the reassignment: ${reason}`, true);
    await doReassign(x, actor, input.toId!, reason);
  });
}

/**
 * D-133: the giver discards a never-assigned draft. Nobody had it, so it simply disappears from every screen; the row
 * and its log stay (never deleted, 009), and the admin audit records the discard.
 */
export async function discardDraft(actor: DirUser, taskId: number): Promise<void> {
  await act(actor, taskId, 'discard', 'delete this draft', async ({ c, t, now }) => {
    await c.query('update tasks set discarded_at = $2 where id = $1', [taskId, now]);
    await appendAdmin(c, { actorId: actor.id, kind: 'task.draft_discarded', target: `task:${taskId}`, targetType: 'task', before: { title: t.title, status: t.status } });
  });
}

/** WF-08: closed without completion; can never be reopened; escalations resolve with the close. */
export async function cancelTask(actor: DirUser, taskId: number, reasonInput: string): Promise<void> {
  const reason = reasonInput.trim();
  if (reason.length < 5) throw invalid({ reason: 'A cancellation reason is required.' });
  guardText(reason);
  await act(actor, taskId, 'cancel', 'cancel this task', async ({ c, t, dir, now, rules }) => {
    await c.query(`update tasks set status = 'cancelled', cancel_reason = $2, closed_at = $3, closed_by = $4, updated_at = $3 where id = $1`, [taskId, reason, now, actor.id]);
    await appendLog(c, { taskId, actorId: actor.id, kind: 'cancelled', body: reason, before: { status: t.status }, after: { status: 'cancelled' } });
    if (t.assignee_id !== actor.id) await notifyUser(c, dir, rules, t.assignee_id, 'cancelled', taskId, `Cancelled: “${t.title}”`, `${actor.name}: ${reason}`);
  });
}

/** WF-09: a completed task back to work with a new future due date and a fresh clock. */
export async function reopenTask(actor: DirUser, taskId: number, input: { reason: string; dueAt: Date | null }): Promise<void> {
  const reason = input.reason.trim();
  const now = clock.now();
  const f: Record<string, string> = {};
  if (reason.length < 5) f.reason = 'Explain why the task is being reopened.';
  if (!input.dueAt || input.dueAt.getTime() <= now.getTime()) f.dueDate = 'Set a new due date in the future.';
  if (Object.keys(f).length) throw invalid(f);
  guardText(reason);
  await act(actor, taskId, 'reopen', 'reopen this task', async ({ c, t, dir, rules }) => {
    if (input.dueAt!.getTime() !== t.due_at.getTime()) {
      await appendLog(c, { taskId, actorId: actor.id, kind: 'due_change', body: reason, before: { dueAt: t.due_at.toISOString() }, after: { dueAt: input.dueAt!.toISOString(), as: 'reopen' } });
    }
    await c.query(
      // PERF: the new round is judged afresh, so the old ratings and reason go (they stay in the log below).
      `update tasks set status = 'reopened', due_at = $2, completed_at = null, closed_at = null, closed_by = null, clock_started_at = $3,
         acknowledged_at = null, snooze_until = null, updated_at = $3, quality_score = null, outcome_score = null, shortfall_reason = null,
         shortfall_accepted = null, shortfall_decided_by = null, shortfall_decided_at = null where id = $1`,
      [taskId, input.dueAt, now],
    );
    await appendLog(c, { taskId, actorId: actor.id, kind: 'reopened', body: reason, before: { status: t.status, qualityScore: t.quality_score, outcomeScore: t.outcome_score, shortfallReason: t.shortfall_reason, shortfallAccepted: t.shortfall_accepted }, after: { status: 'reopened' } });
    await notifyUser(c, dir, rules, t.assignee_id, 'reopened', taskId, `Reopened: “${t.title}”`, `${actor.name}: ${reason}`);
  });
}

/* ---------- Extensions (T-4.9; EXT-01…03, ADR-0005, D-27) ---------- */

export async function requestExtension(actor: DirUser, taskId: number, input: { requestedDue: Date | null; reason: string; info: string }): Promise<number> {
  const reason = input.reason.trim();
  guardText(reason, input.info);
  let id = 0;
  await act(actor, taskId, 'request_extension', 'request an extension', async ({ c, t, dir, now, rules }) => {
    const f: Record<string, string> = {};
    if (!input.requestedDue) f.requestedDate = 'Choose the new due date.';
    else if (input.requestedDue.getTime() <= t.due_at.getTime()) f.requestedDate = 'The new date must be later than the current due date.';
    else if (input.requestedDue.getTime() <= now.getTime()) f.requestedDate = 'The new date must be in the future.';
    if (reason.length < 10) f.reason = 'Explain why (at least 10 characters).';
    if (Object.keys(f).length) throw invalid(f);
    const { rows } = await c.query<{ id: number }>(
      `insert into extensions (task_id, requested_by, requested_at, current_due, requested_due, reason, info) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [taskId, actor.id, now, t.due_at, input.requestedDue, reason, input.info.trim()],
    );
    id = rows[0]!.id;
    await appendLog(c, { taskId, actorId: actor.id, kind: 'extension_requested', body: reason, after: { requestedDue: input.requestedDue!.toISOString(), extensionId: id } });
    // Approvers: the giver and the requester's manager, when they hold approve_extensions (EXT-01-AC-3).
    for (const uid of new Set([t.assigner_id, actor.managerId])) {
      const u = uid ? dir.get(uid) : undefined;
      if (u && u.id !== actor.id && can(u, dir, 'approve_extensions')) {
        await notifyUser(c, dir, rules, u.id, 'extension_requested', taskId, `Extension request: “${t.title}”`, `${actor.name} asks for ${formatInZone(input.requestedDue!, u.timeZone)}: ${reason}`);
      }
    }
  });
  return id;
}

/** EXT-02: approve or reject; approving moves the due date (and, per D-27, uses a lead's one change). */
export async function decideExtension(actor: DirUser, extensionId: number, input: { approve: boolean; note: string }): Promise<number> {
  const note = input.note.trim();
  if (!input.approve && note.length < 5) throw invalid({ note: 'Give the assignee a reason.' });
  guardText(note);
  const { rows } = await tx((c) => c.query('select task_id from extensions where id = $1', [extensionId]));
  if (!rows[0]) throw notFound('Extension request not found.');
  const taskId: number = rows[0].task_id;
  const ext = async (c: pg.PoolClient) => (await c.query('select * from extensions where id = $1 for update', [extensionId])).rows[0];
  await act(
    actor,
    taskId,
    'decide_extension',
    'decide this extension',
    async (x) => {
      const { c, t, now, rules } = x;
      const e = await ext(c);
      if (input.approve) {
        if (relation(actor, t, x.dir) === 'lead' && t.lead_extension_used) throw forbidden('A team lead can extend a task only once');
        await appendLog(c, { taskId, actorId: actor.id, kind: 'due_change', body: note || e.reason, before: { dueAt: t.due_at.toISOString() }, after: { dueAt: e.requested_due.toISOString(), as: 'extension' } });
        await c.query('update tasks set due_at = $2, lead_extension_used = lead_extension_used or $3, updated_at = $4 where id = $1', [taskId, e.requested_due, relation(actor, t, x.dir) === 'lead', now]);
      }
      await c.query(`update extensions set status = $2, decided_by = $3, decided_at = $4, decision_note = $5 where id = $1`, [extensionId, input.approve ? 'approved' : 'rejected', actor.id, now, note || null]);
      await appendLog(c, { taskId, actorId: actor.id, kind: 'extension_decided', body: note || null, after: { extensionId, approved: input.approve } });
      await notifyUser(c, x.dir, rules, e.requested_by, 'extension_decided', taskId, `Extension ${input.approve ? 'approved' : 'rejected'}: “${t.title}”`, note || `${actor.name} decided your request.`);
    },
    async ({ c }) => {
      const e = await ext(c);
      if (e.requested_by === actor.id) throw forbidden('You cannot approve your own extension request.');
      if (e.status !== 'pending') throw new HttpError(409, 'This request has already been decided.');
    },
  );
  return taskId;
}

/* ---------- Legacy request shapes, kept until the client moves to the action endpoints (T-4.14) ---------- */

export interface LegacyUpdate {
  body: string;
  status?: 'in_progress' | 'blocked' | 'completed';
  files?: PendingFile[];
}

/** `POST /tasks/:id/updates`: progress, or Blocked / Done when `status` says so. */
export async function postUpdate(actor: DirUser, taskId: number, input: LegacyUpdate): Promise<void> {
  if (input.status === 'blocked') {
    if (!input.body.trim()) throw badRequest('Marking a task Blocked requires a reason');
    return blockTask(actor, taskId, input.body);
  }
  if (input.status === 'completed') return completeTask(actor, taskId, input.body);
  if (!input.body.trim()) throw badRequest('Write an update');
  return postProgress(actor, taskId, { message: input.body, files: input.files });
}

/* ---------- Escalation acknowledgement (reworked in Phase 5); comments live in collab.ts ---------- */

/**
 * ESC-06/06a (FR-9): the person an escalation reached marks it acknowledged, with a note. Repeat alerts at that level
 * pause for `ackSnoozeHours`; the level and the clock are unchanged, and other levels keep alerting (D-26).
 * Answers the task id.
 */
export async function acknowledge(actor: DirUser, escalationId: number, noteInput: string): Promise<number> {
  const note = noteInput.trim();
  if (!note) throw invalid({ note: 'Add a note with your acknowledgement' });
  guardText(note);
  const dir = await getDirectory(actor.organizationId);
  return tx(async (c) => {
    const { rows } = await c.query('select task_id from escalations where id = $1', [escalationId]);
    if (!rows[0]) throw notFound('Escalation not found');
    const t = await lockTask(c, rows[0].task_id, actor, dir, 'Escalation not found');
    const { rows: ev } = await c.query('select * from escalations where id = $1', [escalationId]); // read again under the task lock
    const e = ev[0];
    if (e.cleared_at) throw new HttpError(409, 'This escalation is no longer active');
    const { rows: rec } = await c.query(`select 1 from escalation_recipients where escalation_id = $1 and user_id = $2 and kind = 'to'`, [escalationId, actor.id]);
    if (!rec[0] && !isCoS(actor)) throw forbidden('Only the person this escalation reached can acknowledge it');
    if (e.acknowledged_at) throw new HttpError(409, 'This escalation was already acknowledged');
    const now = clock.now();
    const rules = (await getRuleSet(actor.organizationId)).for(t.entity_id);
    const snoozeUntil = new Date(now.getTime() + rules.ackSnoozeHours * HOUR);
    const label = LEVEL_LABELS[e.level]!;
    await c.query(`update escalations set acknowledged_at = $2, acknowledged_by = $3, ack_note = $4, snooze_until = $5 where id = $1`, [escalationId, now, actor.id, note, snoozeUntil]);
    await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'ack', body: note, after: { level: e.level, label, repeatsPausedUntil: snoozeUntil.toISOString() } });
    for (const userId of new Set<number>([t.assignee_id, t.assigner_id])) {
      if (userId !== actor.id) await notifyUser(c, dir, rules, userId, 'escalation_ack', t.id, `${label} acknowledged: “${t.title}”`, `${actor.name}: ${note}`);
    }
    return t.id as number;
  });
}
