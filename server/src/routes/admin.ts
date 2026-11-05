import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { runEngine } from '../engine/engine.js';
import type { Role } from '@taskwatch/shared/permissions';
import { HttpError, notFound } from '../http/errors.js';
import { me, requirePermission, requireRole, requireUser } from '../http/middleware.js';
import { can } from '../services/access.js';
import { EDITABLE_ROLES, getRoleMatrix, roleCounts, saveRolePermissions } from '../services/permissions.js';
import { getSettings, publicSettings, saveSettings, settingsSchema } from '../services/settings.js';
import { dispatchDue } from '../notify/dispatcher.js';
import { appendAdmin } from '../services/audit.js';
import { auditCsv, AUDIT_SOURCES, integrityChecks, listAudit, runIntegrityCheck, type AuditFilters } from '../services/auditView.js';
import { isDigestRecipient, sendWeeklyDigest } from '../services/digest.js';

export const adminRouter = Router();
adminRouter.use(requireUser);

/* ---------- Audit log and integrity (T-4.13; AUD-01, AUD-02, D-16), per organization ---------- */

const auditQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use YYYY-MM-DD.' }).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use YYYY-MM-DD.' }).optional(),
    actorId: z.union([z.literal('system'), z.coerce.number().int()]).optional(),
    action: z.string().max(60).optional(),
    teamId: z.coerce.number().int().optional(),
    source: z.enum(AUDIT_SOURCES, { error: 'Unknown source.' }).optional(),
    taskId: z.coerce.number().int().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { error: 'The start date must be on or before the end date.', path: ['to'] });

/** Dates are whole days in the viewer's own zone (D-5); `to` includes its whole day. */
function auditFilters(req: Request): AuditFilters {
  const q = auditQuery.parse(req.query);
  const zone = me(req).user.timeZone;
  const day = (d: string) => DateTime.fromISO(d, { zone });
  return {
    from: q.from ? day(q.from).toJSDate() : undefined,
    to: q.to ? day(q.to).plus({ days: 1 }).toJSDate() : undefined,
    actorId: q.actorId,
    action: q.action || undefined,
    teamId: q.teamId,
    source: q.source,
    taskId: q.taskId,
  };
}

const viewAudit = requirePermission('view_audit_logs', 'view audit logs');

adminRouter.get('/audit', viewAudit, async (req, res) => {
  res.json(await listAudit(me(req).user, auditFilters(req)));
});

adminRouter.get('/audit/export.csv', viewAudit, async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="taskwatch-audit.csv"');
  res.send(await auditCsv(me(req).user, auditFilters(req)));
});

adminRouter.get('/audit/integrity', viewAudit, async (req, res) => {
  res.json({ checks: await integrityChecks(me(req).user) });
});

adminRouter.post('/audit/chain-check', viewAudit, async (req, res) => {
  res.json(await runIntegrityCheck(me(req).user));
});

/* ---------- Role matrix (T-3.1; ROLE-01, ROLE-02), per organization ---------- */

adminRouter.get('/roles', requirePermission('manage_roles', 'manage roles'), async (req, res) => {
  const org = me(req).user.organizationId;
  const [matrix, counts] = await Promise.all([getRoleMatrix(org), roleCounts(org)]);
  res.json({ matrix, counts });
});

const rolePermissionsSchema = z
  .object({ permissions: z.array(z.string().max(64), { error: 'Send the permissions as a list.' }).max(100, { error: 'Too many permissions.' }) })
  .strict();

adminRouter.put('/roles/:role', requirePermission('manage_roles', 'manage roles'), async (req, res) => {
  const role = String(req.params.role);
  if (role === 'cos') throw new HttpError(403, 'Chief of Staff always has full platform authority and cannot be edited.');
  if (!(EDITABLE_ROLES as string[]).includes(role)) throw notFound('Role not found.');
  const { permissions } = rolePermissionsSchema.parse(req.body);
  res.json(await saveRolePermissions(me(req).user, role as Role, permissions));
});

/* ---------- System settings (T-3.7; SET-01), per organization ---------- */

adminRouter.get('/settings', async (req, res) => {
  const { user, dir } = me(req);
  const s = await getSettings(user.organizationId);
  res.json(can(user, dir, 'manage_system_settings') ? s : publicSettings(s));
});

adminRouter.put('/settings', requirePermission('manage_system_settings', 'change system settings'), async (req, res) => {
  res.json(await saveSettings(me(req).user, settingsSchema.parse(req.body)));
});

/** ESC-08: run the engine now for the caller's organization (the scheduler runs it every minute anyway). */
adminRouter.post('/admin/engine/run', requirePermission('manage_escalation_policies', 'run the escalation engine'), async (req, res) => {
  const result = await runEngine({ organizationId: me(req).user.organizationId });
  await dispatchDue();
  res.json(result);
});

/** NTF-05 manual send: `all` = the caller's organization, needs manage_system_settings, audited; `me` = a preview to oneself. */
adminRouter.post('/admin/digest', async (req, res) => {
  const { user, dir } = me(req);
  const { scope } = z.object({ scope: z.enum(['me', 'all'], { error: 'Choose all or me.' }) }).strict().parse(req.body);
  if (scope === 'all') {
    if (!can(user, dir, 'manage_system_settings')) throw new HttpError(403, "You don't have permission to send the weekly digest.");
    const sent = await sendWeeklyDigest(user.organizationId);
    await appendAdmin(null, { actorId: user.id, kind: 'digest.sent_manually', target: 'digest', targetType: 'settings', after: { recipients: sent } });
    return res.json({ sent });
  }
  if (!isDigestRecipient(user)) throw new HttpError(403, 'Only managers and the Founder’s Office receive the weekly digest.');
  res.json({ sent: await sendWeeklyDigest(user.organizationId, user.id) });
});

// Demo only: move the simulated clock forward to watch the ladder climb. Disabled in production.
adminRouter.post('/dev/clock', requireRole('cos'), async (req, res) => {
  if (!config.demoTools) throw notFound();
  const { user } = me(req);
  const body = z.object({ advanceHours: z.number().min(0).max(24 * 30).optional(), reset: z.boolean().optional() }).parse(req.body);
  const before = clock.getOffsetMs();
  const after = body.reset ? 0 : before + (body.advanceHours ?? 0) * HOUR;
  clock.setOffsetMs(after);
  await pool.query(
    `insert into app_state (key, value) values ('clock_offset_ms', $1) on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(after)],
  );
  await appendAdmin(null, {
    actorId: user.id,
    kind: 'demo_clock',
    before: { offsetHours: before / HOUR },
    after: { offsetHours: after / HOUR },
    targetType: 'demo',
    source: 'demo',
  });
  const engine = await runEngine();
  await dispatchDue();
  res.json({ offsetHours: after / HOUR, engine });
});
