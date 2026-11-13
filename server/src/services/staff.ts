// Staff directory and profile (T-3.3; STAFF-01, STAFF-04). Rows are limited to the people the viewer may see
// (shared canViewUser) inside their organization; contact details only for manage_staff or oneself (SEC-9).
import { ancestorsOf, canViewUser } from '@taskwatch/shared/permissions';
import { DateTime } from 'luxon';
import type pg from 'pg';
import { z } from 'zod';
import * as clock from '../clock.js';
import { pool, tx } from '../db/pool.js';
import { activeSql, isOpenStatus, openSql, ROLES } from '../domain.js';
import { forbidden, HttpError, invalid, notFound } from '../http/errors.js';
import { can, visibilityFilter } from './access.js';
import { presentKind } from './activity.js';
import { appendAdmin } from './audit.js';
import { hhmm } from './rules.js';
import { endAllSessions, signInMethod } from './auth.js';
import { invalidateDirectory, type Directory, type DirUser } from './directory.js';
import { sendAccountEmail } from './passwordReset.js';
import { headOf, syncReportingLines, vacatePosts, worktimeOf } from './structure.js';
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
    ...(withContact ? { email: r.email, phone: r.phone, whatsapp: r.whatsapp, signIn: signInMethod(r.email, r.google_domains, r.has_password) } : {}),
    openTasks: r.open_tasks,
    overdueTasks: r.overdue_tasks,
  };
}

const ROW_SQL = `
  select u.*, m.name as manager_name, tm.name as team_name,
    (select o.google_domains from organizations o where o.id = u.organization_id) as google_domains,
    exists (select 1 from user_credentials c where c.user_id = u.id and c.password_hash is not null) as has_password,
    (select count(*)::int from tasks t where t.assignee_id = u.id and ${openSql('t')}) as open_tasks,
    (select count(*)::int from tasks t where t.assignee_id = u.id and ${activeSql('t')} and t.due_at < $2) as overdue_tasks -- H3: in review is never overdue
  from users u left join users m on m.id = u.manager_id left join teams tm on tm.id = u.team_id
  where u.organization_id = $1`;

/** Contacts: oneself, manage_staff holders, and a GM for their own vertical's people (ADR-0015, D-162). */
const seesContact = (viewer: DirUser, dir: Directory, person: { id: number; entity_id: string }, heads: readonly string[]) =>
  person.id === viewer.id || can(viewer, dir, 'manage_staff') || heads.includes(person.entity_id);

/** STAFF-01: everyone the viewer may see, active and inactive. Filters and stats stay client-side (ADR-0009). */
export async function listPeople(viewer: DirUser, dir: Directory) {
  const visible = dir.all().filter((u) => canViewUser(dir.org, viewer, u)).map((u) => u.id);
  const { rows } = await pool.query(`${ROW_SQL} and u.id = any($3) order by u.entity_id, u.name`, [viewer.organizationId, clock.now(), visible]);
  const heads = await headOf(viewer.id, viewer.organizationId);
  return { items: rows.map((r) => staffRow(r, seesContact(viewer, dir, r, heads))) };
}

/** One person's directory row. Create and edit need manage_staff, so contacts are included unless the caller says otherwise. */
export async function personRow(viewer: DirUser, id: number, contact = true) {
  const { rows } = await pool.query(`${ROW_SQL} and u.id = $3`, [viewer.organizationId, clock.now(), id]);
  return staffRow(rows[0], contact);
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
    user: staffRow(rows[0], seesContact(viewer, dir, rows[0], await headOf(viewer.id, viewer.organizationId))),
    manager: manager && canViewUser(dir.org, viewer, manager) ? brief(manager) : null,
    reports: dir.all().filter((u) => u.managerId === id && canViewUser(dir.org, viewer, u)).map(brief),
    chain: ancestorsOf(dir.org, id).filter((p) => canViewUser(dir.org, viewer, p)).map((p) => brief(dir.must(p.id))),
    team,
    permissions: effectivePermissions(target, dir.org.rolePermissions),
    assigned: assigned.slice(0, 25),
    created: created.slice(0, 25),
    stats: {
      open: assigned.filter((t) => isOpenStatus(t.status)).length,
      overdue: assigned.filter((t) => t.overdue).length, // one rule, from the task view
      completed: closed.length,
      onTimeRate: closed.length ? onTime / closed.length : null,
    },
    escalations: escalations.rows,
    activity: activity.rows.map((a) => ({ ...a, kind: presentKind(a.kind) })),
  };
}

/* ---------- Create / edit (T-3.4; STAFF-02, STAFF-05, D-75, D-99) ---------- */

const NAME = "Enter the person's name.";
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
      .min(1, { error: NAME }) // D-136: one word is enough (single-name people)
      .max(120, { error: 'Use at most 120 characters.' }),
    email: z.string({ error: EMAIL }).trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { error: EMAIL }),
    title: z.string({ error: TITLE }).trim().min(1, { error: TITLE }).max(120, { error: 'Use at most 120 characters.' }),
    roles: z
      .array(z.enum(ROLES, { error: ROLE }), { error: ROLE })
      .min(1, { error: ROLE })
      .refine((r) => new Set(r).size === r.length, { error: ROLE }),
    entityId: z.string({ error: 'Choose a vertical.' }).min(1, { error: 'Choose a vertical.' }),
    // ADR-0011 / D-130: no managerId; the reporting line follows the department and vertical.
    teamId: z.number({ error: 'Choose a department in this vertical.' }).int().nullable().default(null),
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

/** Checks that need the database: vertical and department in this organization, email free. */
async function checkPerson(c: pg.PoolClient, org: number, p: PersonInput, id: number | null): Promise<void> {
  const fields: Record<string, string> = {};
  // One after another: a transaction client runs one query at a time (pg deprecates overlapping calls).
  const entity = await c.query('select 1 from entities where id = $1 and organization_id = $2 and archived_at is null', [p.entityId, org]);
  const team = p.teamId === null ? null : await c.query<{ entity_id: string }>('select entity_id from teams where id = $1 and organization_id = $2 and archived_at is null', [p.teamId, org]);
  const email = await c.query('select 1 from users where lower(email) = $1 and id <> $2', [p.email, id ?? 0]); // emails are unique platform-wide (D-96)
  if (!entity.rowCount) fields.entityId = 'Choose a vertical.';
  if (team && team.rows[0]?.entity_id !== p.entityId) fields.teamId = 'Choose a department in this vertical.';
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
    await checkPerson(c, org, p, null);
    const { rows } = await c.query<{ id: number }>(
      `insert into users (name, email, title, roles, entity_id, manager_id, team_id, location, phone, whatsapp, whatsapp_opt_in, time_zone, created_at, organization_id, quiet_start, quiet_end)
       values ($1,$2,$3,$4,$5,null,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [p.name, p.email, p.title, p.roles, p.entityId, p.teamId, p.location || 'Remote', p.phone, p.whatsapp, p.whatsappOptIn, p.timezone || settings.timezone, clock.now(), org, p.quietStart ?? null, p.quietEnd ?? null],
    );
    const newId = rows[0]!.id;
    // D-130: placed before the creation is audited, so the line is part of that record (not a separate "change").
    await syncReportingLines(c, org, actor.id, (x) => x.id === newId, { audit: false });
    const { rows: placed } = await c.query<{ manager_id: number | null }>('select manager_id from users where id = $1', [newId]);
    await appendAdmin(c, { actorId: actor.id, kind: 'staff.created', target: `user:${newId}`, targetType: 'user', after: { name: p.name, roles: p.roles, managerId: placed[0]!.manager_id }, context: p.email });
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
export async function updatePerson(actor: DirUser, dir: Directory, id: number, p: PersonInput, opts: { lineRoles?: boolean } = {}): Promise<void> {
  const org = actor.organizationId;
  const before = await tx(async (c) => {
    const { rows } = await c.query('select * from users where id = $1 and organization_id = $2 for update', [id, org]);
    const b = rows[0];
    if (!b) throw notFound('Person not found.');
    if (!sameSet(b.roles, p.roles)) {
      if (id === actor.id) throw forbidden('You cannot change your own role.');
      // ADR-0015 (D-162): a GM may move people between staff, lead and manager in their vertical (the route checks the roles).
      if (!can(actor, dir, 'manage_roles') && !opts.lineRoles) throw forbidden("You don't have permission to change roles.");
      if (b.roles.includes('cos') && !p.roles.includes('cos') && b.active) await keepOneActiveCos(c, org, id);
    }
    await checkPerson(c, org, p, id);
    const quiet = p.quietStart === undefined ? [b.quiet_start, b.quiet_end] : [p.quietStart, p.quietEnd ?? null];
    await c.query(
      `update users set name=$2, email=$3, title=$4, roles=$5, entity_id=$6, team_id=$7, location=$8, phone=$9,
         whatsapp=$10, whatsapp_opt_in=$11, time_zone=$12, quiet_start=$13, quiet_end=$14 where id = $1`,
      [id, p.name, p.email, p.title, p.roles, p.entityId, p.teamId, p.location, p.phone, p.whatsapp, p.whatsappOptIn, p.timezone || b.time_zone, quiet[0], quiet[1]],
    );
    const audit = (kind: string, from: unknown, to: unknown) =>
      appendAdmin(c, { actorId: actor.id, kind, target: `user:${id}`, targetType: 'user', before: from, after: to });
    if (!sameSet(b.roles, p.roles)) await audit('staff.role_changed', { roles: b.roles }, { roles: p.roles });
    if (b.team_id !== p.teamId) await audit('staff.team_changed', { teamId: b.team_id }, { teamId: p.teamId });
    if (b.whatsapp !== p.whatsapp || b.whatsapp_opt_in !== p.whatsappOptIn) {
      await audit('staff.whatsapp_changed', { whatsapp: b.whatsapp, optIn: b.whatsapp_opt_in }, { whatsapp: p.whatsapp, optIn: p.whatsappOptIn });
    }
    if (b.email !== p.email) await audit('staff.email_changed', { email: b.email }, { email: p.email });
    const rest = { name: [b.name, p.name], title: [b.title, p.title], entityId: [b.entity_id, p.entityId], location: [b.location, p.location], phone: [b.phone, p.phone], timezone: [b.time_zone, p.timezone || b.time_zone], quietHours: [b.quiet_start && `${b.quiet_start}–${b.quiet_end}`, quiet[0] && `${quiet[0]}–${quiet[1]}`] };
    const changed = Object.entries(rest).filter(([, [x, y]]) => x !== y);
    if (changed.length) await audit('staff.updated', Object.fromEntries(changed.map(([k, [x]]) => [k, x])), Object.fromEntries(changed.map(([k, [, y]]) => [k, y])));
    await vacatePosts(c, id, { teamId: p.teamId, entityId: p.entityId }); // review fix #1: a moved lead or manager leaves their old post
    await syncReportingLines(c, org, actor.id, (x) => x.id === id || x.manager_id === id); // D-130: theirs, and their reports'
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
    await syncReportingLines(c, org, actor.id, (x) => x.id === id || x.manager_id === id); // D-130: an inactive lead no longer heads a line
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
    pool.query(`select * from entities where organization_id = $1 and archived_at is null order by sort, name`, [org]),
    pool.query(`select id, name, entity_id as "entityId", lead_id as "leadId" from teams where organization_id = $1 and archived_at is null order by entity_id, name`, [org]),
    listPeople(viewer, dir),
    getSettings(org),
  ]);
  return { entities: entities.rows.map((e) => ({ id: e.id, name: e.name, headId: e.head_id, worktime: worktimeOf(e) })), teams: teams.rows, people: people.items, overloadThreshold: settings.overloadThreshold };
}

export const placementSchema = z
  .object({
    teamId: z.number({ error: 'Choose a department in this vertical.' }).int().nullable().optional(),
  })
  .strict();

/**
 * ORG-02 / ADR-0011: move a person to another department of their vertical; their reporting line follows (D-130).
 * Needs manage_staff, or manage_team for someone in the caller's reports.
 */
export async function setPlacement(actor: DirUser, dir: Directory, id: number, p: z.infer<typeof placementSchema>) {
  const org = actor.organizationId;
  // Checked up front, not only on a change: an empty body must not become a free read of someone's row.
  const mayMove = can(actor, dir, 'manage_staff') || (can(actor, dir, 'manage_team') && dir.descendants(actor.id).has(id));
  if (!mayMove) throw forbidden('You cannot move this person between departments.');
  await tx(async (c) => {
    const { rows } = await c.query('select name, entity_id, team_id from users where id = $1 and organization_id = $2 for update', [id, org]);
    const b = rows[0];
    if (!b) throw notFound('Person not found.');
    if (p.teamId === undefined || p.teamId === b.team_id) return;
    if (p.teamId !== null) {
      const { rows: t } = await c.query('select entity_id from teams where id = $1 and organization_id = $2 and archived_at is null', [p.teamId, org]);
      if (t[0]?.entity_id !== b.entity_id) throw invalid({ teamId: 'Choose a department in this vertical.' });
    }
    await c.query('update users set team_id = $2 where id = $1', [id, p.teamId]);
    await vacatePosts(c, id, { teamId: p.teamId, entityId: b.entity_id }); // review fix #1: no longer leads the department they left
    await appendAdmin(c, { actorId: actor.id, kind: 'staff.team_changed', target: `user:${id}`, targetType: 'user', before: { teamId: b.team_id }, after: { teamId: p.teamId } });
    await syncReportingLines(c, org, actor.id, (x) => x.id === id || x.manager_id === id);
  });
  invalidateDirectory(); // alert routing reads the directory, so the next escalation follows the new line (ORG-02-AC-4)
  return personRow(actor, id, seesContact(actor, dir, { id, entity_id: dir.must(id).entityId }, await headOf(actor.id, actor.organizationId))); // SEC-9: a team move by a lead returns no contact details
}
