// Verticals and departments (ADR-0011; D-129…D-131). The database keeps `entities` and `teams`; the screens say
// "vertical" and "department". Reporting lines are automatic: after any change that can move one, every active person
// in the organization is placed by the shared reportsTo rule, in the same transaction, and each change is audited.
import { reportsTo, seniorOf, type Role } from '@taskwatch/shared/permissions';
import type pg from 'pg';
import { z } from 'zod';
import * as clock from '../clock.js';
import { tx } from '../db/pool.js';
import { HttpError, invalid, notFound } from '../http/errors.js';
import { appendAdmin } from './audit.js';
import { invalidateDirectory, type DirUser } from './directory.js';

type Row = { id: number; roles: Role[]; active: boolean; entity_id: string | null; team_id: number | null; manager_id: number | null };

/**
 * D-130: re-place the people `affected` picks, by the shared rule, from the organization's current structure; returns how
 * many lines changed. Only those people: a change never rewrites lines elsewhere (verticals without a general manager
 * keep their lines until the CoS sets one).
 */
export async function syncReportingLines(c: pg.PoolClient, org: number, actorId: number, affected: (p: Row) => boolean, opts: { audit?: boolean } = {}): Promise<number> {
  // One after another: a transaction client runs one query at a time (pg deprecates overlapping calls).
  const people = await c.query<Row>(
      'select id, roles, active, entity_id, team_id, manager_id from users where organization_id = $1 order by id for update',
      [org],
    );
  const entities = await c.query<{ id: string; head_id: number | null }>(
      `select e.id, case when h.active then e.head_id end as head_id from entities e left join users h on h.id = e.head_id where e.organization_id = $1`,
      [org],
    );
  const teams = await c.query<{ id: number; lead_id: number | null }>(
      `select t.id, case when l.active then t.lead_id end as lead_id from teams t left join users l on l.id = t.lead_id where t.organization_id = $1 and t.archived_at is null`,
      [org],
    );
  const ctx = {
    entities: entities.rows.map((e) => ({ id: e.id, headId: e.head_id })),
    teams: teams.rows.map((t) => ({ id: t.id, leadId: t.lead_id })),
    senior: seniorOf(people.rows),
    ceo: people.rows.find((x) => x.active && x.roles.includes('ceo'))?.id ?? null,
  };
  // Review fix #1: a line must never come back round to the person; if it would, they report to the senior instead.
  const managerOf = new Map(people.rows.map((x) => [x.id, x.manager_id]));
  const closesLoop = (id: number, start: number | null) => {
    for (let cur = start, hops = 0; cur !== null && hops <= people.rows.length; cur = managerOf.get(cur) ?? null, hops++) if (cur === id) return true;
    return false;
  };
  let changed = 0;
  for (const p of people.rows.filter((x) => x.active && affected(x))) {
    let want = reportsTo({ id: p.id, roles: p.roles, entityId: p.entity_id, teamId: p.team_id }, ctx);
    if (closesLoop(p.id, want)) want = ctx.senior !== p.id && !closesLoop(p.id, ctx.senior) ? ctx.senior : null;
    if (want === p.manager_id) continue;
    managerOf.set(p.id, want);
    await c.query('update users set manager_id = $2 where id = $1', [p.id, want]);
    if (opts.audit !== false) await appendAdmin(c, { actorId, kind: 'staff.manager_changed', target: `user:${p.id}`, targetType: 'user', before: { managerId: p.manager_id }, after: { managerId: want, automatic: true } });
    changed++;
  }
  return changed;
}

/**
 * Review fix #2: someone placed in a new post (or moved) leaves their old ones. A department they no longer belong to and a
 * vertical they no longer head stop pointing at them; their former reports are re-placed by the caller's sync.
 */
export async function vacatePosts(c: pg.PoolClient, personId: number, keep: { teamId: number | null; entityId: string | null }) {
  await c.query('update teams set lead_id = null where lead_id = $1 and id is distinct from $2', [personId, keep.teamId]);
  await c.query('update entities set head_id = null where head_id = $1 and id is distinct from $2', [personId, keep.entityId]);
}

const NAME = 'Enter a name.';
const name = z.string({ error: NAME }).trim().min(1, { error: NAME }).max(80, { error: 'Use at most 80 characters.' });
const personId = z.number({ error: 'Person not found.' }).int().nullable();

export const verticalSchema = z
  .object({
    id: z
      .string({ error: 'Use 2–10 capital letters or digits, e.g. BAIS.' })
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,10}$/, { error: 'Use 2–10 capital letters or digits, e.g. BAIS.' }),
    name,
    headId: personId.default(null),
  })
  .strict();
export const verticalEditSchema = z.object({ name, headId: personId }).strict();
export const departmentSchema = z.object({ entityId: z.string({ error: 'Choose a vertical.' }).min(1, { error: 'Choose a vertical.' }), name, leadId: personId.default(null) }).strict();
export const departmentEditSchema = z.object({ name, leadId: personId }).strict();

/** A general manager or department lead: an active person in this organization, with the right role. */
async function checkPerson(c: pg.PoolClient, org: number, id: number | null, role: Role, field: string, label: string) {
  if (id === null) return;
  const { rows } = await c.query<{ roles: Role[] }>('select roles from users where id = $1 and organization_id = $2 and active', [id, org]);
  if (!rows[0]) throw invalid({ [field]: 'Person not found.' });
  if (!rows[0].roles.includes(role)) throw invalid({ [field]: `Choose someone with the ${label} role.` });
}

/** The vertical, locked; archived ones cannot be edited. */
async function lockVertical(c: pg.PoolClient, org: number, id: string) {
  const { rows } = await c.query('select * from entities where id = $1 and organization_id = $2 for update', [id, org]);
  if (!rows[0]) throw notFound('Vertical not found.');
  if (rows[0].archived_at) throw new HttpError(409, 'This vertical is archived.');
  return rows[0];
}

const done = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
  const out = await tx(fn);
  invalidateDirectory(); // reporting lines, scopes and alert routing read the directory
  return out;
};

/** D-131: add a vertical. A general manager given here moves into it (no department) and the lines follow. */
export function createVertical(actor: DirUser, v: z.infer<typeof verticalSchema>) {
  const org = actor.organizationId;
  return done(async (c) => {
    await checkPerson(c, org, v.headId, 'manager', 'headId', 'Manager');
    const taken = await c.query('select 1 from entities where id = $1 or (organization_id = $2 and lower(name) = lower($3) and archived_at is null)', [v.id, org, v.name]);
    if (taken.rowCount) throw invalid({ id: 'This code or name is already in use.' });
    const { rows } = await c.query<{ n: number }>('select coalesce(max(sort), 0) + 1 as n from entities where organization_id = $1', [org]);
    await c.query('insert into entities (id, name, sort, head_id, organization_id) values ($1,$2,$3,$4,$5)', [v.id, v.name, rows[0]!.n, v.headId, org]);
    if (v.headId !== null) {
      await c.query('update users set entity_id = $2, team_id = null where id = $1', [v.headId, v.id]);
      await vacatePosts(c, v.headId, { teamId: null, entityId: v.id });
    }
    await appendAdmin(c, { actorId: actor.id, kind: 'vertical.created', target: `vertical:${v.id}`, targetType: 'settings', after: v });
    await syncReportingLines(c, org, actor.id, (p) => p.entity_id === v.id || (v.headId !== null && p.manager_id === v.headId));
    return v.id;
  });
}

/** D-131: rename a vertical or change its general manager; the new manager moves into it, and the lines follow. */
export function updateVertical(actor: DirUser, id: string, v: z.infer<typeof verticalEditSchema>) {
  const org = actor.organizationId;
  return done(async (c) => {
    const b = await lockVertical(c, org, id);
    await checkPerson(c, org, v.headId, 'manager', 'headId', 'Manager');
    const clash = await c.query('select 1 from entities where organization_id = $1 and lower(name) = lower($2) and id <> $3 and archived_at is null', [org, v.name, id]);
    if (clash.rowCount) throw invalid({ name: 'Another vertical already uses this name.' });
    await c.query('update entities set name = $2, head_id = $3 where id = $1', [id, v.name, v.headId]);
    if (v.headId !== null && v.headId !== b.head_id) {
      const { rows: moved } = await c.query<{ team_id: number | null }>('update users set entity_id = $2, team_id = case when entity_id = $2 then team_id end where id = $1 returning team_id', [v.headId, id]);
      await vacatePosts(c, v.headId, { teamId: moved[0]?.team_id ?? null, entityId: id });
    }
    await appendAdmin(c, { actorId: actor.id, kind: 'vertical.updated', target: `vertical:${id}`, targetType: 'settings', before: { name: b.name, headId: b.head_id }, after: v });
    await syncReportingLines(c, org, actor.id, (p) => p.entity_id === id || p.id === b.head_id || (v.headId !== null && p.manager_id === v.headId));
  });
}

/** D-131: archive a vertical (never deleted). Only when nobody active is in it; its departments are archived with it. */
export function archiveVertical(actor: DirUser, id: string) {
  const org = actor.organizationId;
  return done(async (c) => {
    await lockVertical(c, org, id);
    const { rows } = await c.query<{ n: number }>('select count(*)::int as n from users where entity_id = $1 and organization_id = $2 and active', [id, org]);
    if (rows[0]!.n > 0) throw new HttpError(409, `Move or deactivate the ${rows[0]!.n} active people in this vertical first.`);
    const now = clock.now();
    await c.query('update entities set archived_at = $2 where id = $1', [id, now]);
    await c.query("update teams set archived_at = $2, name = name || ' (archived #' || id || ')' where entity_id = $1 and archived_at is null", [id, now]);
    await appendAdmin(c, { actorId: actor.id, kind: 'vertical.archived', target: `vertical:${id}`, targetType: 'settings' });
  });
}

/** D-131: a department (team) in a vertical. A lead given here joins it, and the lines follow. */
export function createDepartment(actor: DirUser, d: z.infer<typeof departmentSchema>) {
  const org = actor.organizationId;
  return done(async (c) => {
    await lockVertical(c, org, d.entityId).catch((e) => {
      throw e instanceof HttpError && e.status === 404 ? invalid({ entityId: 'Choose a vertical.' }) : e;
    });
    await checkPerson(c, org, d.leadId, 'lead', 'leadId', 'Team Lead');
    const clash = await c.query('select 1 from teams where entity_id = $1 and lower(name) = lower($2) and archived_at is null', [d.entityId, d.name]);
    if (clash.rowCount) throw invalid({ name: 'This vertical already has a department with this name.' });
    const { rows } = await c.query<{ id: number }>('insert into teams (name, entity_id, lead_id, organization_id) values ($1,$2,$3,$4) returning id', [d.name, d.entityId, d.leadId, org]);
    const id = rows[0]!.id;
    if (d.leadId !== null) {
      await c.query('update users set entity_id = $2, team_id = $3 where id = $1', [d.leadId, d.entityId, id]);
      await vacatePosts(c, d.leadId, { teamId: id, entityId: d.entityId });
    }
    await appendAdmin(c, { actorId: actor.id, kind: 'department.created', target: `team:${id}`, targetType: 'team', after: d });
    await syncReportingLines(c, org, actor.id, (p) => p.team_id === id || (d.leadId !== null && p.manager_id === d.leadId));
    return id;
  });
}

async function lockDepartment(c: pg.PoolClient, org: number, id: number) {
  const { rows } = await c.query('select * from teams where id = $1 and organization_id = $2 and archived_at is null for update', [id, org]);
  if (!rows[0]) throw notFound('Department not found.');
  return rows[0];
}

/** D-131: rename a department or change its lead; the new lead joins it, and the lines follow. */
export function updateDepartment(actor: DirUser, id: number, d: z.infer<typeof departmentEditSchema>) {
  const org = actor.organizationId;
  return done(async (c) => {
    const b = await lockDepartment(c, org, id);
    await checkPerson(c, org, d.leadId, 'lead', 'leadId', 'Team Lead');
    const clash = await c.query('select 1 from teams where entity_id = $1 and lower(name) = lower($2) and id <> $3 and archived_at is null', [b.entity_id, d.name, id]);
    if (clash.rowCount) throw invalid({ name: 'This vertical already has a department with this name.' });
    await c.query('update teams set name = $2, lead_id = $3 where id = $1', [id, d.name, d.leadId]);
    if (d.leadId !== null && d.leadId !== b.lead_id) {
      await c.query('update users set entity_id = $2, team_id = $3 where id = $1', [d.leadId, b.entity_id, id]);
      await vacatePosts(c, d.leadId, { teamId: id, entityId: b.entity_id });
    }
    await appendAdmin(c, { actorId: actor.id, kind: 'department.updated', target: `team:${id}`, targetType: 'team', before: { name: b.name, leadId: b.lead_id }, after: d });
    await syncReportingLines(c, org, actor.id, (p) => p.team_id === id || p.id === b.lead_id || (d.leadId !== null && p.manager_id === d.leadId));
  });
}

/** D-131: archive a department (never deleted), only when nobody active is in it. */
export function archiveDepartment(actor: DirUser, id: number) {
  const org = actor.organizationId;
  return done(async (c) => {
    await lockDepartment(c, org, id);
    const { rows } = await c.query<{ n: number }>('select count(*)::int as n from users where team_id = $1 and active', [id]);
    if (rows[0]!.n > 0) throw new HttpError(409, `Move or deactivate the ${rows[0]!.n} active people in this department first.`);
    // Review fix #6: the (entity, name) index covers archived rows, so the archived one gives its name back.
    await c.query("update teams set archived_at = $2, name = name || ' (archived #' || id || ')' where id = $1", [id, clock.now()]);
    await appendAdmin(c, { actorId: actor.id, kind: 'department.archived', target: `team:${id}`, targetType: 'team' });
  });
}
