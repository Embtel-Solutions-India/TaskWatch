import { describeRecurrence, occurrencesBetween, occursOn, scheduleErrors, addDays, type Frequency, type RecurrenceRule } from '@taskwatch/shared/recurrence';
import { DateTime } from 'luxon';
import type pg from 'pg';
import * as clock from '../clock.js';
import { pool, tx } from '../db/pool.js';
import type { Priority } from '../domain.js';
import { forbidden, HttpError, invalid, notFound } from '../http/errors.js';
import { assignableUsers, can, scopeIds } from './access.js';
import { appendAdmin } from './audit.js';
import { getDirectory, hasRole, isFounderOffice, type Directory, type DirUser } from './directory.js';
import { getSettings } from './settings.js';
import { createTask, guardText, measuredErrors, teamEntityOf } from './tasks.js';
import type { Purpose } from '@taskwatch/shared/performance';

// FR-7 recurring schedules (REC-01…04). Occurrence days follow the assignee's zone (D-5); missed days are not
// backfilled and days 29–31 clamp to the month end (D-45); an occurrence the owner may no longer assign is skipped
// and logged (D-46).

export interface ScheduleInput extends RecurrenceRule {
  title: string;
  description: string;
  category: string;
  priority: Priority;
  /** null only until validation: saveRecurring rejects it. */
  assigneeId: number | null;
  teamId: number | null;
  reviewRequired: boolean;
  dueHour: number;
  target: number | null;
  unit: string | null;
  estimatedHours: number | null;
  purpose: Purpose | null;
}

const COLUMNS = `r.*, r.start_date::text as start_day, r.end_date::text as end_day`;

const rule = (r: any): RecurrenceRule => ({ frequency: r.frequency as Frequency, interval: r.interval, weekdays: r.weekdays, startDate: r.start_day, endDate: r.end_day });

const todayIn = (zone: string, now: Date) => DateTime.fromJSDate(now, { zone }).toISODate()!;

/** Same visibility as the list: the Founder's Office sees all; anyone else their own and those for people below them. */
function sees(actor: DirUser, dir: Directory, r: { created_by: number; assignee_id: number }): boolean {
  return isFounderOffice(actor) || r.created_by === actor.id || scopeIds(actor, dir).includes(r.assignee_id);
}

const canEdit = (actor: DirUser, r: { created_by: number }) => r.created_by === actor.id || hasRole(actor, 'cos');

function requireManage(actor: DirUser, dir: Directory) {
  if (!can(actor, dir, 'create_tasks')) throw forbidden("You don't have permission to manage recurring tasks.");
}

/** Locks a live schedule the actor may change. Not visible (or archived) is 404, visible but not theirs is 403. */
async function lockOwned(c: pg.PoolClient, actor: DirUser, dir: Directory, id: number, verb: 'edit' | 'change' | 'delete') {
  const { rows } = await c.query(`select ${COLUMNS} from recurring_tasks r where id = $1 and organization_id = $2 and deleted_at is null for update`, [id, actor.organizationId]);
  const r = rows[0];
  if (!r || !sees(actor, dir, r)) throw notFound('Schedule not found.');
  if (!canEdit(actor, r)) throw forbidden(`Only the owner can ${verb} this schedule.`);
  return r;
}

/** REC-01: the schedules the actor may see, live ones only, with summary, next three days and generated count. */
export async function listRecurring(actor: DirUser) {
  const dir = await getDirectory(actor.organizationId);
  requireManage(actor, dir);
  const all = isFounderOffice(actor);
  const { rows } = await pool.query(
    `select ${COLUMNS}, (select count(*) from tasks t where t.recurring_id = r.id) as instances
       from recurring_tasks r
      where r.organization_id = $1 and r.deleted_at is null ${all ? '' : 'and (r.created_by = $2 or r.assignee_id = any($3))'}
      order by r.active desc, r.id`,
    all ? [actor.organizationId] : [actor.organizationId, actor.id, scopeIds(actor, dir)],
  );
  const now = clock.now();
  return rows.map((r) => {
    const tomorrow = addDays(todayIn(dir.get(r.assignee_id)?.timeZone ?? 'UTC', now), 1);
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      category: r.category,
      priority: r.priority,
      assigneeId: r.assignee_id,
      assigneeName: dir.get(r.assignee_id)?.name ?? '',
      createdBy: r.created_by,
      ownerName: dir.get(r.created_by)?.name ?? '',
      teamId: r.team_id,
      entityId: r.entity_id,
      reviewRequired: r.review_required,
      ...rule(r),
      dueHour: r.due_hour,
      target: r.target,
      unit: r.unit,
      estimatedHours: r.estimated_hours,
      purpose: r.purpose,
      active: r.active,
      createdAt: r.created_at,
      summary: describeRecurrence(rule(r)),
      next: occurrencesBetween(rule(r), tomorrow, addDays(tomorrow, 119), 3),
      instances: r.instances,
      canEdit: canEdit(actor, r),
    };
  });
}

/** REC-02: create (id null) or edit a schedule, then generate today's occurrence if it is still due. */
export async function saveRecurring(actor: DirUser, id: number | null, p: ScheduleInput): Promise<{ id: number; generated: number }> {
  const dir = await getDirectory(actor.organizationId);
  requireManage(actor, dir);
  if (!can(actor, dir, 'assign_tasks')) throw forbidden("You don't have permission to assign recurring tasks.");
  const saved = await tx(async (c) => {
    const existing = id === null ? null : await lockOwned(c, actor, dir, id, 'edit');
    guardText(p.title, p.description);
    const f = { ...scheduleErrors(p), ...measuredErrors(p, true) };
    if (p.category && !(await getSettings(actor.organizationId)).categories.includes(p.category)) f.category = 'Choose a category.'; // optional (owner 2026-11-13)
    const assignee = p.assigneeId === null ? undefined : dir.get(p.assigneeId);
    // An unchanged assignee is not re-checked: the owner may keep editing after the assignee moved (REC-02).
    if (!f.assigneeId && existing?.assignee_id !== p.assigneeId) {
      if (!assignee?.active) f.assigneeId = 'Choose an assignee.';
      else if (!assignableUsers(actor, dir).some((u) => u.id === p.assigneeId)) f.assigneeId = 'You can only assign to people below you in the reporting line.';
    }
    const teamId = p.teamId ?? assignee?.teamId ?? null;
    let entityId = assignee?.entityId ?? existing?.entity_id;
    if (teamId !== null) {
      const teamEntity = await teamEntityOf(c, actor.organizationId, teamId);
      if (teamEntity) entityId = teamEntity;
      else if (p.teamId !== null) f.teamId = 'Choose a team.';
    }
    if (Object.keys(f).length) throw invalid(f);
    const values = [p.title.trim(), p.description, p.category, p.priority, p.assigneeId, teamId, entityId, p.reviewRequired, p.frequency, p.interval,
      p.frequency === 'weekly' ? [...new Set(p.weekdays)].sort() : [], p.startDate, p.endDate, p.dueHour,
      p.target, p.target === null ? null : p.unit, p.estimatedHours, p.purpose];
    const fields = `title = $1, description = $2, category = $3, priority = $4, assignee_id = $5, team_id = $6, entity_id = $7,
       review_required = $8, frequency = $9, "interval" = $10, weekdays = $11, start_date = $12, end_date = $13, due_hour = $14,
       target = $15, unit = $16, estimated_hours = $17, purpose = $18`;
    let sid: number;
    if (existing) {
      // Edits shape future occurrences only; today's is re-evaluated, and the unique key stops a second task for it.
      await c.query(`update recurring_tasks set ${fields}, last_occurrence = null where id = $19`, [...values, existing.id]);
      sid = existing.id;
    } else {
      const { rows } = await c.query<{ id: number }>(
        `insert into recurring_tasks (title, description, category, priority, assignee_id, team_id, entity_id, review_required, frequency,
           "interval", weekdays, start_date, end_date, due_hour, target, unit, estimated_hours, purpose, created_by, created_at, organization_id, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,true) returning id`,
        [...values, actor.id, clock.now(), actor.organizationId],
      );
      sid = rows[0]!.id;
    }
    await appendAdmin(c, {
      actorId: actor.id,
      kind: existing ? 'recurrence.updated' : 'recurrence.created',
      target: `recurrence:${sid}`,
      targetType: 'recurrence',
      after: { summary: describeRecurrence(p) },
      context: p.title.trim(),
    });
    return sid;
  });
  return { id: saved, generated: await runRecurring(saved) };
}

/** REC-03: pause or resume. Resuming generates today's occurrence if it is still due (no backfill, D-45). */
export async function setRecurringActive(actor: DirUser, id: number, active: boolean): Promise<number> {
  const dir = await getDirectory(actor.organizationId);
  requireManage(actor, dir);
  await tx(async (c) => {
    const r = await lockOwned(c, actor, dir, id, 'change');
    await c.query('update recurring_tasks set active = $2 where id = $1', [id, active]);
    await appendAdmin(c, { actorId: actor.id, kind: active ? 'recurrence.resumed' : 'recurrence.paused', target: `recurrence:${id}`, targetType: 'recurrence', after: { active }, context: r.title });
  });
  return active ? runRecurring(id) : 0;
}

/** REC-03: soft delete (D-12). The row stays with `deleted_at`; tasks it generated are untouched. */
export async function deleteRecurring(actor: DirUser, id: number): Promise<void> {
  const dir = await getDirectory(actor.organizationId);
  requireManage(actor, dir);
  await tx(async (c) => {
    const r = await lockOwned(c, actor, dir, id, 'delete');
    await c.query('update recurring_tasks set deleted_at = $2, active = false where id = $1', [id, clock.now()]);
    await appendAdmin(c, { actorId: actor.id, kind: 'recurrence.deleted', target: `recurrence:${id}`, targetType: 'recurrence', before: { title: r.title }, context: 'Existing task instances are kept' });
  });
}

/**
 * REC-04: generate today's occurrence of every live schedule (or of one schedule), once per (schedule, day).
 * Each schedule is claimed for its assignee's today before any task is made, so two scheduler instances never both
 * handle it; the unique key on (recurring_id, occurrence_date) is the backstop.
 */
export async function runRecurring(only?: number): Promise<number> {
  const now = clock.now();
  let created = 0;
  for (;;) {
    const claimed = await tx(async (c) => {
      const { rows } = await c.query(
        `select ${COLUMNS}, ($1::timestamptz at time zone coalesce(u.time_zone, 'UTC'))::date::text as today
           from recurring_tasks r join users u on u.id = r.assignee_id
          where r.active and r.deleted_at is null and ($2::int is null or r.id = $2)
            and (r.last_occurrence is null or r.last_occurrence < ($1::timestamptz at time zone coalesce(u.time_zone, 'UTC'))::date)
          order by r.id limit 1 for update of r skip locked`,
        [now, only ?? null],
      );
      const r = rows[0];
      if (r) await c.query('update recurring_tasks set last_occurrence = $2, last_run_at = $3 where id = $1', [r.id, r.today, now]);
      return r ?? null;
    });
    if (!claimed) return created;
    if (!occursOn(rule(claimed), claimed.today)) continue;
    const dir = await getDirectory(claimed.organization_id);
    const zone = dir.get(claimed.assignee_id)?.timeZone ?? 'UTC';
    const dueAt = DateTime.fromISO(claimed.today, { zone }).set({ hour: claimed.due_hour }).toJSDate();
    if (dueAt.getTime() <= now.getTime()) continue; // D-45: a missed occurrence is not backfilled
    try {
      const owner = dir.get(claimed.created_by);
      if (!owner?.active) throw new Error('The person who set up this schedule is no longer active.');
      await createTask(
        owner,
        {
          title: `${claimed.title} — ${claimed.today}`,
          description: claimed.description,
          instructions: claimed.instructions,
          category: claimed.category,
          priority: claimed.priority,
          assigneeId: claimed.assignee_id,
          teamId: claimed.team_id,
          dueAt,
          startAt: null,
          reviewRequired: claimed.review_required,
          target: claimed.target,
          unit: claimed.unit,
          estimatedHours: claimed.estimated_hours,
          purpose: claimed.purpose,
          parentId: null,
        },
        { recurringId: claimed.id, occurrenceDate: claimed.today },
      );
      created++;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') continue; // today's task already exists (an edit re-ran the day)
      // D-46: the owner lost the permission or scope, the assignee left, the category was removed, …: skip and log.
      const reason = err instanceof HttpError && err.fields ? Object.values(err.fields).join(' ') : (err as Error).message;
      await appendAdmin(
        null,
        { actorId: null, kind: 'recurring_skipped', target: `recurrence:${claimed.id}`, note: `${claimed.today}: ${reason}`, targetType: 'recurrence', source: 'system', organizationId: claimed.organization_id },
        now,
      );
    }
  }
}
