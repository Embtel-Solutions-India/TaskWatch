import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { forbidden, notFound } from '../http/errors.js';
import { can } from '../services/access.js';
import { idParam, me, requirePermission, requireUser } from '../http/middleware.js';
import { resetAccess, sendOnboarding } from '../services/passwordReset.js';
import { archiveDepartment, archiveVertical, canManageVertical, headOf, createDepartment, createVertical, departmentEditSchema, departmentSchema, updateDepartment, updateVertical, updateWorktime, verticalEditSchema, verticalSchema, worktimeSchema } from '../services/structure.js';
import {
  createPerson,
  listPeople,
  orgView,
  personProfile,
  personRow,
  personSchema,
  placementSchema,
  setPersonStatus,
  setPlacement,
  updatePerson,
} from '../services/staff.js';

export const peopleRouter = Router();
peopleRouter.use(requireUser);

peopleRouter.get('/entities', async (req, res) => {
  const { rows } = await pool.query('select id, name from entities where organization_id = $1 and archived_at is null order by sort', [me(req).user.organizationId]);
  res.json(rows);
});

// ADR-0011 / D-131: verticals (entities) and departments (teams), managed by manage_staff. Never deleted.
peopleRouter.post('/entities', requirePermission('manage_staff', 'manage verticals'), async (req, res) => {
  res.status(201).json({ id: await createVertical(me(req).user, verticalSchema.parse(req.body)) });
});
peopleRouter.put('/entities/:id', requirePermission('manage_staff', 'manage verticals'), async (req, res) => {
  await updateVertical(me(req).user, String(req.params.id), verticalEditSchema.parse(req.body));
  res.status(204).end();
});
// ADR-0015 (D-159, D-162): a vertical's working time, set by its GM or the CoS. 404 for anyone else (no existence leak).
peopleRouter.put('/entities/:id/worktime', async (req, res) => {
  const { user, dir } = me(req);
  const id = String(req.params.id);
  if (!(await canManageVertical(user, dir, id))) throw notFound('Vertical not found.');
  await updateWorktime(user, id, worktimeSchema.parse(req.body));
  res.status(204).end();
});
peopleRouter.post('/entities/:id/archive', requirePermission('manage_staff', 'manage verticals'), async (req, res) => {
  await archiveVertical(me(req).user, String(req.params.id));
  res.status(204).end();
});
peopleRouter.post('/teams', async (req, res) => {
  const body = departmentSchema.parse(req.body);
  // Review C-1: a GM's department lead must already be in their vertical (placing a lead moves them into it).
  await staffScope(req, [body.entityId, ...(body.leadId ? [(await personOf(req, body.leadId))?.entity_id] : [])], 'manage departments');
  res.status(201).json({ id: await createDepartment(me(req).user, body) });
});
peopleRouter.put('/teams/:id', async (req, res) => {
  const body = departmentEditSchema.parse(req.body);
  await staffScope(req, [await teamEntity(req, idParam(req)), ...(body.leadId ? [(await personOf(req, body.leadId))?.entity_id] : [])], 'manage departments');
  await updateDepartment(me(req).user, idParam(req), body);
  res.status(204).end();
});
peopleRouter.post('/teams/:id/archive', async (req, res) => {
  await staffScope(req, [await teamEntity(req, idParam(req))], 'manage departments');
  await archiveDepartment(me(req).user, idParam(req));
  res.status(204).end();
});

/**
 * ADR-0015 (D-162): who may manage these verticals' people or departments. manage_staff holders: everything. A GM:
 * their own vertical only (anything else is "not found", no existence leak), never the Founder's Office, and never
 * the CoS or CEO role. Everyone else: refused as before.
 */
async function staffScope(req: Request, entityIds: readonly (string | null | undefined)[], what: string, roles: readonly string[] = []): Promise<'all' | 'vertical'> {
  const { user, dir } = me(req);
  if (can(user, dir, 'manage_staff')) return 'all';
  const heads = await headOf(user.id, user.organizationId);
  if (!heads.length) throw forbidden(`You don't have permission to ${what}.`);
  if (entityIds.some((e) => !e || e === 'FO' || !heads.includes(e))) throw notFound(what === 'manage departments' ? 'Department not found.' : 'Person not found.');
  if (roles.some((r) => r === 'cos' || r === 'ceo')) throw forbidden('Only the Chief of Staff can do that.');
  return 'vertical';
}
/** Owner, 2026-11-13: a GM does not deactivate or reset their own account; the CoS does. */
async function notOwnAccount(req: Request, scope: 'all' | 'vertical') {
  if (scope === 'vertical' && idParam(req) === me(req).user.id) throw forbidden('Ask the Chief of Staff to change your own account.');
}
const personOf = async (req: Request, id: number) =>
  (await pool.query<{ entity_id: string; roles: string[] }>('select entity_id, roles from users where id = $1 and organization_id = $2', [id, me(req).user.organizationId])).rows[0];
const teamEntity = async (req: Request, id: number) =>
  (await pool.query<{ entity_id: string }>('select entity_id from teams where id = $1 and organization_id = $2', [id, me(req).user.organizationId])).rows[0]?.entity_id;

/** ORG-01: entities, teams and the people the caller may see, with load counts. */
peopleRouter.get('/org', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await orgView(user, dir));
});


// Directory (STAFF-01) and profile (STAFF-04): everyone sees the people the shared canViewUser allows, in their own
// organization. Editing stays with the Chief of Staff. People are archived, never deleted.
peopleRouter.get('/people', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await listPeople(user, dir));
});

peopleRouter.get('/people/:id', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await personProfile(user, dir, idParam(req)));
});

// STAFF-02 / STAFF-05: manage_staff; roles need manage_roles (checked in the service with the exact FRD messages).
peopleRouter.post('/people', async (req, res) => {
  const { user, dir } = me(req);
  const body = personSchema.parse(req.body);
  await staffScope(req, [body.entityId], 'manage staff', body.roles);
  const id = await createPerson(user, dir, body);
  res.status(201).json(await personRow(user, id));
});

peopleRouter.put('/people/:id', async (req, res) => {
  const { user, dir } = me(req);
  const id = idParam(req);
  const body = personSchema.parse(req.body);
  const was = await personOf(req, id);
  const scope = await staffScope(req, [was?.entity_id, body.entityId], 'manage staff', [...(was?.roles ?? []), ...body.roles]);
  await updatePerson(user, dir, id, body, { lineRoles: scope === 'vertical' });
  res.json(await personRow(user, id));
});

/** STAFF-03: archive or restore (never delete). */
peopleRouter.post('/people/:id/status', async (req, res) => {
  const was = await personOf(req, idParam(req));
  await notOwnAccount(req, await staffScope(req, [was?.entity_id], 'manage staff', was?.roles ?? []));
  const { status } = z.object({ status: z.enum(['active', 'inactive'], { error: 'Choose active or inactive.' }) }).strict().parse(req.body);
  res.json(await setPersonStatus(me(req).user, idParam(req), status));
});

/** ORG-02: manager and team together; the permission rules live in the service. */
peopleRouter.put('/people/:id/placement', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await setPlacement(user, dir, idParam(req), placementSchema.parse(req.body)));
});

/** AUTH-05: send another person a reset link (manage_staff; a CoS target needs a CoS). */
peopleRouter.post('/people/:id/reset-access', async (req, res) => {
  const was = await personOf(req, idParam(req));
  await notOwnAccount(req, await staffScope(req, [was?.entity_id], 'manage staff', was?.roles ?? []));
  const { user } = me(req);
  await resetAccess(user, idParam(req));
  res.json({ ok: true });
});

/** D-172: email a person their onboarding (welcome + set-password link); the same people and scope as reset-access. */
peopleRouter.post('/people/:id/onboarding-email', async (req, res) => {
  const was = await personOf(req, idParam(req));
  await notOwnAccount(req, await staffScope(req, [was?.entity_id], 'manage staff', was?.roles ?? []));
  const { user } = me(req);
  await sendOnboarding(user, idParam(req));
  res.json({ ok: true });
});
