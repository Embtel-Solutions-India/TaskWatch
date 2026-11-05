// Staff directory and profile (T-3.3; STAFF-01, STAFF-04). Rows are limited to the people the viewer may see
// (shared canViewUser) inside their organization; contact details only for manage_staff or oneself (SEC-9).
import { ancestorsOf, canViewUser, wouldCreateLoop } from '@taskwatch/shared/permissions';
import { DateTime } from 'luxon';
import type pg from 'pg';
import { z } from 'zod';
import * as clock from '../clock.js';
import { pool, tx } from '../db/pool.js';
import { isOpenStatus, openSql, ROLES } from '../domain.js';
import { forbidden, HttpError, invalid, notFound } from '../http/errors.js';
import { can, visibilityFilter } from './access.js';
import { presentKind } from './activity.js';
import { appendAdmin } from './audit.js';
import { hhmm } from './rules.js';
import { endAllSessions } from './auth.js';
import { invalidateDirectory, type Directory, type DirUser } from './directory.js';
import { sendAccountEmail } from './passwordReset.js';
import { effectivePermissions } from './permissions.js';
import { listTasks } from './queries.js';
import { getSettings } from './settings.js';

/** One person as the directory shows them; contact fields only when `withContact`. */
function staffRow(r: Record<string, any>, withContact: boolean) {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    roles: r.roles,
    entityId: r.entity_id,
    teamId: r.team_id,
    teamName: r.team_name,
    managerId: r.manager_id,
    managerName: r.manager_name,
    status: r.active ? 'active' : 'inactive',
    joinedAt: r.created_at,
    archivedAt: r.archived_at,
    location: r.location,
    timezone: r.time_zone,
    whatsappOptIn: r.whatsapp_opt_in,
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    ...(withContact ? { email: r.email, phone: r.phone, whatsapp: r.whatsapp } : {}),
    openTasks: r.open_tasks,
    overdueTasks: r.overdue_tasks,
  };
}

const ROW_SQL = `
  select u.*, m.name as manager_name, tm.name as team_name,
    (select count(*)::int from tasks t where t.assignee_id = u.id and ${openSql('t')}) as open_tasks,
    (select count(*)::int from tasks t where t.assignee_id = u.id and ${openSql('t')} and t.due_at < $2) as overdue_tasks
  from users u left join users m on m.id = u.manager_id left join teams tm on tm.id = u.team_id
  where u.organization_id = $1`;

const seesContact = (viewer: DirUser, dir: Directory, personId: number) => personId === viewer.id || can(viewer, dir, 'manage_staff');

/** STAFF-01: everyone the viewer may see, active and inactive. Filters and stats stay client-side (ADR-0009). */
export async function listPeople(viewer: DirUser, dir: Directory) {
  const visible = dir.all().filter((u) => canViewUser(dir.org, viewer, u)).map((u) => u.id);
  const { rows } = await pool.query(`${ROW_SQL} and u.id = any($3) order by u.entity_id, u.name`, [viewer.organizationId, clock.now(), visible]);
  return { items: rows.map((r) => staffRow(r, seesContact(viewer, dir, r.id))) };
}

/** One person's directory row, for the create and edit responses (the caller manages staff, so contacts included). */
export async function personRow(viewer: DirUser, id: number) {
  const { rows } = await pool.query(`${ROW_SQL} and u.id = $3`, [viewer.organizationId, clock.now(), id]);
  return staffRow(rows[0], true);
}

const brief = (u: DirUser) => ({ id: u.id, name: u.name, title: u.title, roles: u.roles });

/** STAFF-04: one person, with only the tasks, escalations and activity the viewer may see. Not viewable = missing. */
export async function personProfile(viewer: DirUser, dir: Directory, id: number) {
  const target = dir.get(id);
  if (!target || !canViewUser(dir.org, viewer, target)) throw notFound('Person not found.');
  const now = clock.now();
  const [{ rows }, assigned, created] = await Promise.all([
    pool.query(`${ROW_SQL} and u.id = $3`, [viewer.organizationId, now, id]),
    listTasks(viewer, dir, { view: 'all', assigneeId: id }).then((l) => l.items),
    listTasks(viewer, dir, { view: 'all', givenBy: id }).then((l) => l.items),
  ]);
  const vis = visibilityFilter(viewer, dir, 't', 2);
  const [escalations, activity] = await Promise.all([
    pool.query(
      `select e.id, e.task_id as "taskId", t.title as "taskTitle", e.level, e.reason, e.fired_at as "firedAt",
              e.acknowledged_at as "acknowledgedAt", e.cleared_at as "clearedAt"
         from escalations e join tasks t on t.id = e.task_id
        where t.assignee_id = $1 and ${vis.sql} order by e.fired_at desc limit 20`,
      [id, ...vis.params],
    ),
    pool.query(
      `select l.id, l.task_id as "taskId", t.title as "taskTitle", l.kind, l.body, l.at
         from activity_log l join tasks t on t.id = l.task_id
        where l.actor_id = $1 and ${vis.sql} order by l.at desc limit 15`,
      [id, ...vis.params],
    ),
  ]);
  const closed = assigned.filter((t) => t.status === 'completed');
  const onTime = closed.filter((t) => t.completedAt && t.completedAt <= t.dueAt).length;
  const manager = target.managerId ? dir.get(target.managerId) : undefined;
  const team = rows[0].team_id ? { id: rows[0].team_id, name: rows[0].team_name } : null;
  return {
    user: staffRow(rows[0], seesContact(viewer, dir, id)),
    manager: manager && canViewUser(dir.org, viewer, manager) ? brief(manager) : null,
    reports: dir.all().filter((u) => u.managerId === id && canViewUser(dir.org, viewer, u)).map(brief),
    chain: ancestorsOf(dir.org, id).filter((p) => canViewUser(dir.org, viewer, p)).map((p) => brief(dir.must(p.id))),
    team,
    permissions: effectivePermissions(target, dir.org.rolePermissions),
    assigned: assigned.slice(0, 25),
    created: created.slice(0, 25),
    stats: {
      open: assigned.filter((t) => isOpenStatus(t.status)).length,
      overdue: assigned.filter((t) => isOpenStatus(t.status) && t.dueAt < now).length,
      completed: closed.length,
      onTimeRate: closed.length ? onTime / closed.length : null,
    },
    escalations: escalations.rows,
    activity: activity.rows.map((a) => ({ ...a, kind: presentKind(a.kind) })),
  };
}

/* ---------- Create / edit (T-3.4; STAFF-02, STAFF-05, D-75, D-99) ---------- */

const NAME = 'Enter a first and last name.';
const EMAIL = 'Enter a valid email address.';
const TITLE = 'Enter a job title.';
const ROLE = 'Choose a role.';
const WHATSAPP = 'Use international format, e.g. +14155550123.';

/** The StaffDialog body (client `StaffInput` with `roles[]` and `entityId`). The FRD's messages, field by field. */
export const personSchema = z
  .object({
    name: z
      .string({ error: NAME })
      .trim()
      .max(120, { error: 'Use at most 120 characters.' })
      .refine((n) => n.split(/\s+/).filter(Boolean).length >= 2, { error: NAME }),
    email: z.string({ error: EMAIL }).trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { error: EMAIL }),
    title: z.string({ error: TITLE }).trim().min(1, { error: TITLE }).max(120, { error: 'Use at most 120 characters.' }),
    roles: z
      .array(z.enum(ROLES, { error: ROLE }), { error: ROLE })
      .min(1, { error: ROLE })
      .refine((r) => new Set(r).size === r.length, { error: ROLE }),
    entityId: z.string({ error: 'Choose an entity.' }).min(1, { error: 'Choose an entity.' }),
    managerId: z.number({ error: 'Manager not found.' }).int().nullable().default(null),
    teamId: z.number({ error: 'Choose a team in this entity.' }).int().nullable().default(null),
    location: z.string().trim().max(120, { error: 'Use at most 120 characters.' }).default(''),
    phone: z.string().trim().max(40, { error: 'Use at most 40 characters.' }).nullable().default(null).transform((v) => v || null),
    whatsapp: z
      .string()
      .nullable()
      .default(null)
      .transform((v) => (v ? v.replace(/[\s()-]/g, '') : null))
      .refine((v) => v === null || /^\+[1-9]\d{7,14}$/.test(v), { error: WHATSAPP }),
    whatsappOptIn: z.boolean().default(false), // D-75: consent is explicit
    timezone: z
      .string()
      .trim()
      .default('')
      .refine((tz) => !tz || DateTime.now().setZone(tz).isValid, { error: 'Unknown time zone' }),
    // D-105: own quiet window; null = the organization's. Omitted on edit = unchanged.
    quietStart: hhmm.nullable().optional(),
    quietEnd: hhmm.nullable().optional(),
  })
  .strict()
  .refine((p) => (p.quietStart == null) === (p.quietEnd == null), { error: 'Set both quiet-hours times, or neither.', path: ['quietEnd'] })
  .refine((p) => !p.whatsappOptIn || p.whatsapp, { error: 'Add a WhatsApp number before opting in.', path: ['whatsappOptIn'] });

export type PersonInput = z.infer<typeof personSchema>;

/** Checks that need the database: entity and team in this organization, manager known and loop-free, email free. */
async function checkPerson(c: pg.PoolClient, org: number, dir: Directory, p: PersonInput, id: number | null): Promise<void> {
  const fields: Record<string, string> = {};
  const [entity, team, email] = await Promise.all([
    c.query('select 1 from entities where id = $1 and organization_id = $2', [p.entityId, org]),
    p.teamId === null ? null : c.query<{ entity_id: string }>('select entity_id from teams where id = $1 and organization_id = $2', [p.teamId, org]),
    c.query('select 1 from users where lower(email) = $1 and id <> $2', [p.email, id ?? 0]), // emails are unique platform-wide (D-96)
  ]);
  if (!entity.rowCount) fields.entityId = 'Choose an entity.';
  if (team && team.rows[0]?.entity_id !== p.entityId) fields.teamId = 'Choose a team in this entity.';
  if (p.managerId !== null && !dir.get(p.managerId)) fields.managerId = 'Manager not found.';
  else if (id !== null && wouldCreateLoop(dir.org, id, p.managerId)) fields.managerId = 'That would create a reporting loop.';
  if (email.rowCount) fields.email = 'Another account already uses this email.';
  if (Object.keys(fields).length) throw invalid(fields);
}

/** A concurrent insert of the same email loses the unique index race: report it like the pre-check does. Only that index. */
const duplicateEmail = (err: unknown) => {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'users_email_lower_uq') throw invalid({ email: 'Another account already uses this email.' });
  throw err;
};

export async function createPerson(actor: DirUser, dir: Directory, p: PersonInput): Promise<number> {
  if (p.roles.includes('cos') && !can(actor, dir, 'manage_roles')) throw forbidden("You don't have permission to grant Chief of Staff.");
  const org = actor.organizationId;
  const settings = await getSettings(org);
  const id = await tx(async (c) => {
    await checkPerson(c, org, dir, p, null);
    const { rows } = await c.query<{ id: number }>(
      `insert into users (name, email, title, roles, entity_id, manager_id, team_id, location, phone, whatsapp, whatsapp_opt_in, time_zone, created_at, organization_id, quiet_start, quiet_end)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [p.name, p.email, p.title, p.roles, p.entityId, p.managerId, p.teamId, p.location || 'Remote', p.phone, p.whatsapp, p.whatsappOptIn, p.timezone || settings.timezone, clock.now(), org, p.quietStart ?? null, p.quietEnd ?? null],
    );
    const newId = rows[0]!.id;
    await appendAdmin(c, { actorId: actor.id, kind: 'staff.created', target: `user:${newId}`, targetType: 'user', after: { name: p.name, roles: p.roles }, context: p.email });
    return newId;
  }).catch(duplicateEmail);
  invalidateDirectory();
  return id;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * STAFF-02 edit. Role changes need manage_roles, never on oneself, and the organization keeps an active CoS. Each kind
 * of change gets its own audit record. D-99: an email change ends the person's sessions and tells the old address.
 */
export async function updatePerson(actor: DirUser, dir: Directory, id: number, p: PersonInput): Promise<void> {
  const org = actor.organizationId;
  const before = await tx(async (c) => {
    const { rows } = await c.query('select * from users where id = $1 and organization_id = $2 for update', [id, org]);
    const b = rows[0];
    if (!b) throw notFound('Person not found.');
    if (!sameSet(b.roles, p.roles)) {
      if (id === actor.id) throw forbidden('You cannot change your own role.');
      if (!can(actor, dir, 'manage_roles')) throw forbidden("You don't have permission to change roles.");
      if (b.roles.includes('cos') && !p.roles.includes('cos') && b.active) await keepOneActiveCos(c, org, id);
    }
    await checkPerson(c, org, dir, p, id);
    const quiet = p.quietStart === undefined ? [b.quiet_start, b.quiet_end] : [p.quietStart, p.quietEnd ?? null];
    await c.query(
      `update users set name=$2, email=$3, title=$4, roles=$5, entity_id=$6, manager_id=$7, team_id=$8, location=$9, phone=$10,
         whatsapp=$11, whatsapp_opt_in=$12, time_zone=$13, quiet_start=$14, quiet_end=$15 where id = $1`,
      [id, p.name, p.email, p.title, p.roles, p.entityId, p.managerId, p.teamId, p.location, p.phone, p.whatsapp, p.whatsappOptIn, p.timezone || b.time_zone, quiet[0], quiet[1]],
    );
    const audit = (kind: string, from: unknown, to: unknown) =>
      appendAdmin(c, { actorId: actor.id, kind, target: `user:${id}`, targetType: 'user', before: from, after: to });
    if (!sameSet(b.roles, p.roles)) await audit('staff.role_changed', { roles: b.roles }, { roles: p.roles });
    if (b.manager_id !== p.managerId) await audit('staff.manager_changed', { managerId: b.manager_id }, { managerId: p.managerId });
    if (b.team_id !== p.teamId) await audit('staff.team_changed', { teamId: b.team_id }, { teamId: p.teamId });
    if (b.whatsapp !== p.whatsapp || b.whatsapp_opt_in !== p.whatsappOptIn) {
      await audit('staff.whatsapp_changed', { whatsapp: b.whatsapp, optIn: b.whatsapp_opt_in }, { whatsapp: p.whatsapp, optIn: p.whatsappOptIn });
    }
    if (b.email !== p.email) await audit('staff.email_changed', { email: b.email }, { email: p.email });
    const rest = { name: [b.name, p.name], title: [b.title, p.title], entityId: [b.entity_id, p.entityId], location: [b.location, p.location], phone: [b.phone, p.phone], timezone: [b.time_zone, p.timezone || b.time_zone], quietHours: [b.quiet_start && `${b.quiet_start}–${b.quiet_end}`, quiet[0] && `${quiet[0]}–${quiet[1]}`] };
    const changed = Object.entries(rest).filter(([, [x, y]]) => x !== y);
    if (changed.length) await audit('staff.updated', Object.fromEntries(changed.map(([k, [x]]) => [k, x])), Object.fromEntries(changed.map(([k, [, y]]) => [k, y])));
    return b;
  }).catch(duplicateEmail);
  invalidateDirectory();
  if (before.email !== p.email) {
    // D-99: whoever controls the new address could now reset the password, so the old sessions end and the old address hears about it.
    await endAllSessions(id);
    await sendAccountEmail({
      userId: id,
      address: before.email,
      event: 'email_changed',
      subject: 'Your TaskWatch sign-in email was changed',
      body: `The email you use to sign in to TaskWatch was changed to ${p.email}. You have been signed out everywhere. If you did not expect this, contact your Chief of Staff.`,
    });
  }
}

/* ---------- Activate / deactivate (T-3.5; STAFF-03) ---------- */

/** The organization keeps at least one active CoS: lock the others and refuse if `id` is the last one. */
async function keepOneActiveCos(c: pg.PoolClient, org: number, id: number): Promise<void> {
  const { rows } = await c.query(`select 1 from users where organization_id = $1 and active and 'cos' = any(roles) and id <> $2 for update`, [org, id]);
  if (!rows.length) throw new HttpError(409, 'The organization must keep at least one active Chief of Staff.');
}

/** Archive or restore a person (never deleted, D-12). Deactivation ends every session at once. Returns open tasks left. */
export async function setPersonStatus(actor: DirUser, id: number, status: 'active' | 'inactive'): Promise<{ openTasks: number }> {
  const org = actor.organizationId;
  if (status === 'inactive' && id === actor.id) throw forbidden('You cannot deactivate your own account.');
  await tx(async (c) => {
    const { rows } = await c.query('select active, roles from users where id = $1 and organization_id = $2 for update', [id, org]);
    const b = rows[0];
    if (!b) throw notFound('Person not found.');
    if (b.active === (status === 'active')) return; // already so: nothing to change or audit
    if (status === 'inactive' && b.roles.includes('cos')) await keepOneActiveCos(c, org, id);
    await c.query('update users set active = $2, archived_at = $3 where id = $1', [id, status === 'active', status === 'active' ? null : clock.now()]);
    const prev = b.active ? 'active' : 'inactive';
    await appendAdmin(c, { actorId: actor.id, kind: status === 'active' ? 'staff.activated' : 'staff.deactivated', target: `user:${id}`, targetType: 'user', before: { status: prev }, after: { status } });
  });
  invalidateDirectory();
  if (status === 'inactive') await endAllSessions(id); // requireUser also refuses inactive people on their next request
  const { rows } = await pool.query(`select count(*)::int n from tasks where assignee_id = $1 and ${openSql('tasks')}`, [id]);
  return { openTasks: rows[0].n };
}

/* ---------- Organisation view and placement (T-3.6; ORG-01, ORG-02) ---------- */

/** ORG-01: the caller's organization: entities, teams, and the people they may see with load counts. */
export async function orgView(viewer: DirUser, dir: Directory) {
  const org = viewer.organizationId;
  const [entities, teams, people, settings] = await Promise.all([
    pool.query(`select id, name, head_id as "headId" from entities where organization_id = $1 order by sort, name`, [org]),
    pool.query(`select id, name, entity_id as "entityId", lead_id as "leadId" from teams where organization_id = $1 and archived_at is null order by entity_id, name`, [org]),
    listPeople(viewer, dir),
    getSettings(org),
  ]);
  return { entities: entities.rows, teams: teams.rows, people: people.items, overloadThreshold: settings.overloadThreshold };
}

export const placementSchema = z
  .object({
    managerId: z.number({ error: 'Manager not found.' }).int().nullable().optional(),
    teamId: z.number({ error: 'Choose a team in this entity.' }).int().nullable().optional(),
  })
  .strict();

/**
 * ORG-02: manager and team in one transaction, so a failed half never leaves a half move. Manager changes need
 * manage_staff; team changes need manage_staff, or manage_team for someone in the caller's reports.
 */
export async function setPlacement(actor: DirUser, dir: Directory, id: number, p: z.infer<typeof placementSchema>) {
  const org = actor.organizationId;
  await tx(async (c) => {
    const { rows } = await c.query('select name, entity_id, manager_id, team_id from users where id = $1 and organization_id = $2 for update', [id, org]);
    const b = rows[0];
    if (!b) throw notFound('Person not found.');
    const managerChange = p.managerId !== undefined && p.managerId !== b.manager_id;
    const teamChange = p.teamId !== undefined && p.teamId !== b.team_id;
    if (managerChange) {
      if (!can(actor, dir, 'manage_staff')) throw forbidden("You don't have permission to change reporting lines.");
      const m = p.managerId === null ? null : dir.get(p.managerId!);
      if (p.managerId !== null && (!m || !m.active || m.id === id)) throw invalid({ managerId: 'Manager not found.' });
      if (wouldCreateLoop(dir.org, id, p.managerId!)) throw new HttpError(409, `${b.name} cannot report to someone in their own reporting line.`);
    }
    if (teamChange) {
      const mayMove = can(actor, dir, 'manage_staff') || (can(actor, dir, 'manage_team') && dir.descendants(actor.id).has(id));
      if (!mayMove) throw forbidden('You cannot move this person between teams.');
      if (p.teamId !== null) {
        const { rows: t } = await c.query('select entity_id from teams where id = $1 and organization_id = $2 and archived_at is null', [p.teamId, org]);
        if (t[0]?.entity_id !== b.entity_id) throw invalid({ teamId: 'Choose a team in this entity.' });
      }
    }
    if (!managerChange && !teamChange) return;
    const managerId = managerChange ? p.managerId! : b.manager_id;
    const teamId = teamChange ? p.teamId! : b.team_id;
    await c.query('update users set manager_id = $2, team_id = $3 where id = $1', [id, managerId, teamId]);
    const audit = (kind: string, from: unknown, to: unknown) =>
      appendAdmin(c, { actorId: actor.id, kind, target: `user:${id}`, targetType: 'user', before: from, after: to });
    if (managerChange) await audit('staff.manager_changed', { managerId: b.manager_id }, { managerId });
    if (teamChange) await audit('staff.team_changed', { teamId: b.team_id }, { teamId });
  });
  invalidateDirectory(); // alert routing reads the directory, so the next escalation follows the new line (ORG-02-AC-4)
  return personRow(actor, id);
}
