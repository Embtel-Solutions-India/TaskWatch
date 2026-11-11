import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { idParam, me, requirePermission, requireUser } from '../http/middleware.js';
import { resetAccess } from '../services/passwordReset.js';
import { archiveDepartment, archiveVertical, createDepartment, createVertical, departmentEditSchema, departmentSchema, updateDepartment, updateVertical, verticalEditSchema, verticalSchema } from '../services/structure.js';
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
peopleRouter.post('/entities/:id/archive', requirePermission('manage_staff', 'manage verticals'), async (req, res) => {
  await archiveVertical(me(req).user, String(req.params.id));
  res.status(204).end();
});
peopleRouter.post('/teams', requirePermission('manage_staff', 'manage departments'), async (req, res) => {
  res.status(201).json({ id: await createDepartment(me(req).user, departmentSchema.parse(req.body)) });
});
peopleRouter.put('/teams/:id', requirePermission('manage_staff', 'manage departments'), async (req, res) => {
  await updateDepartment(me(req).user, idParam(req), departmentEditSchema.parse(req.body));
  res.status(204).end();
});
peopleRouter.post('/teams/:id/archive', requirePermission('manage_staff', 'manage departments'), async (req, res) => {
  await archiveDepartment(me(req).user, idParam(req));
  res.status(204).end();
});

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
peopleRouter.post('/people', requirePermission('manage_staff', 'manage staff'), async (req, res) => {
  const { user, dir } = me(req);
  const id = await createPerson(user, dir, personSchema.parse(req.body));
  res.status(201).json(await personRow(user, id));
});

peopleRouter.put('/people/:id', requirePermission('manage_staff', 'manage staff'), async (req, res) => {
  const { user, dir } = me(req);
  const id = idParam(req);
  await updatePerson(user, dir, id, personSchema.parse(req.body));
  res.json(await personRow(user, id));
});

/** STAFF-03: archive or restore (never delete). */
peopleRouter.post('/people/:id/status', requirePermission('manage_staff', 'manage staff'), async (req, res) => {
  const { status } = z.object({ status: z.enum(['active', 'inactive'], { error: 'Choose active or inactive.' }) }).strict().parse(req.body);
  res.json(await setPersonStatus(me(req).user, idParam(req), status));
});

/** ORG-02: manager and team together; the permission rules live in the service. */
peopleRouter.put('/people/:id/placement', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await setPlacement(user, dir, idParam(req), placementSchema.parse(req.body)));
});

/** AUTH-05: send another person a reset link (manage_staff; a CoS target needs a CoS). */
peopleRouter.post('/people/:id/reset-access', requirePermission('manage_staff', 'manage staff'), async (req, res) => {
  const { user } = me(req);
  await resetAccess(user, idParam(req));
  res.json({ ok: true });
});
