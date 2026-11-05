import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { eventsOfType, NOTIFICATION_TYPES, typeOfEvent, WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import { notFound } from '../http/errors.js';
import { me, requirePermission, requireUser } from '../http/middleware.js';
import { hasRole } from '../services/directory.js';
import { getPrefs, prefsSchema, savePrefs } from '../services/prefs.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

const inboxQuery = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    type: z.enum(NOTIFICATION_TYPES, { error: 'Unknown notification type.' }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();

// NTF-01: one's own in-app notifications, newest first, each with its email/WhatsApp delivery status.
notificationsRouter.get('/notifications', async (req, res) => {
  const { user } = me(req);
  const q = inboxQuery.parse(req.query);
  const params: unknown[] = [user.id];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = [`n.user_id = $1`, `n.channel = 'inapp'`];
  if (q.unread === 'true') where.push('n.read_at is null');
  if (q.unread === 'false') where.push('n.read_at is not null');
  if (q.type) where.push(`n.event = any(${p(eventsOfType(q.type))})`);
  if (q.before) where.push(`(n.created_at, n.id) < (select created_at, id from notifications where id = ${p(q.before)} and user_id = $1)`);
  const [items, unread] = await Promise.all([
    pool.query(
      `select n.id, n.event, n.subject, n.body, n.task_id, n.created_at, n.read_at,
              coalesce((select json_agg(json_build_object('channel', d.channel, 'status', d.status) order by d.channel)
                          from notifications d where d.parent_id = n.id), '[]') as deliveries
         from notifications n where ${where.join(' and ')}
        order by n.created_at desc, n.id desc limit ${p(q.limit + 1)}`,
      params,
    ),
    pool.query(`select count(*)::int as n from notifications where user_id = $1 and channel = 'inapp' and read_at is null`, [user.id]),
  ]);
  const page = items.rows.slice(0, q.limit);
  res.json({
    unread: unread.rows[0].n,
    items: page.map((n) => ({
      id: n.id,
      type: typeOfEvent(n.event),
      title: n.subject,
      body: n.body,
      taskId: n.task_id,
      at: n.created_at,
      read: n.read_at !== null,
      deliveries: n.deliveries,
    })),
    next: items.rows.length > q.limit ? page.at(-1)!.id : null,
  });
});

notificationsRouter.patch('/notifications/:id', async (req, res) => {
  const { user } = me(req);
  const id = z.coerce.number().int().positive().safeParse(req.params.id);
  const { read } = z.object({ read: z.boolean({ error: 'Use true or false.' }) }).strict().parse(req.body);
  const { rowCount } = id.success
    ? await pool.query(`update notifications set read_at = $3 where id = $1 and user_id = $2 and channel = 'inapp'`, [id.data, user.id, read ? clock.now() : null])
    : { rowCount: 0 };
  if (!rowCount) throw notFound('Notification not found.');
  res.status(204).end();
});

notificationsRouter.post('/notifications/read-all', async (req, res) => {
  const { user } = me(req);
  z.object({}).strict().parse(req.body ?? {});
  const { rowCount } = await pool.query(`update notifications set read_at = $2 where user_id = $1 and channel = 'inapp' and read_at is null`, [user.id, clock.now()]);
  res.json({ count: rowCount ?? 0 });
});

// NTF-04: one's own preferences (no path id, so nothing to probe).
notificationsRouter.get('/me/notification-prefs', async (req, res) => {
  res.json(await getPrefs(me(req).user));
});

notificationsRouter.put('/me/notification-prefs', async (req, res) => {
  await savePrefs(me(req).user, prefsSchema.parse(req.body));
  res.status(204).end();
});


/* ---------- Delivery log (T-6.7; DLV-01, DLV-02, D-52, ADR-0009) ---------- */

/** Email and WhatsApp rows as the delivery log shows them. Filters, counts and paging stay client-side (D-10). */
async function deliveries(where: string, params: unknown[], limit: number) {
  const { rows } = await pool.query(
    `select n.id, n.user_id, u.name as recipient, n.task_id, n.event, n.channel, n.status, n.address, n.subject,
            case when n.event = 'digest' then 'Weekly digest (HTML email)' else n.body end as body,
            n.template, n.template_params, n.link, n.level, n.send_after, n.created_at, n.sent_at, n.attempts, n.error,
            exists (select 1 from escalation_recipients r where r.escalation_id = n.escalation_id and r.user_id = n.user_id and r.kind = 'cc') as copied
       from notifications n join users u on u.id = n.user_id
      where n.channel <> 'inapp' and ${where}
      order by n.created_at desc, n.id desc limit ${limit}`,
    params,
  );
  return rows.map((n) => ({
    id: n.id,
    at: n.created_at,
    channel: n.channel,
    kind: n.event === 'digest' ? 'digest' : 'alert',
    status: n.status,
    recipient: { id: n.user_id, name: n.recipient },
    address: n.address,
    subject: n.subject,
    body: n.body,
    template: n.template,
    templateParams: n.template_params,
    link: n.link,
    taskId: n.task_id,
    level: n.level,
    copied: n.copied,
    heldUntil: n.status === 'held' ? n.send_after : null,
    sentAt: n.sent_at,
    attempts: n.attempts,
    reason: n.error,
  }));
}

const integrations = () => ({ email: config.smtp.enabled ? 'live' : 'simulated', whatsapp: WHATSAPP_ENABLED ? (config.whatsapp.enabled ? 'live' : 'simulated') : 'off' });

// D-52: a Chief of Staff sees their organization's whole log; anyone else with the permission sees their own rows.
// ponytail: last 30 days, newest 2000 (ADR-0009 cap); add a date-range filter when someone needs older rows.
notificationsRouter.get('/deliveries', requirePermission('view_audit_logs', 'view the delivery log'), async (req, res) => {
  const { user } = me(req);
  const since = new Date(clock.now().getTime() - 30 * 24 * HOUR);
  const items = hasRole(user, 'cos')
    ? await deliveries('n.organization_id = $1 and n.created_at >= $2', [user.organizationId, since], 2000)
    : await deliveries('n.user_id = $1 and n.created_at >= $2', [user.id, since], 2000);
  res.json({ items, integrations: integrations() });
});

notificationsRouter.get('/me/deliveries', async (req, res) => {
  res.json({ items: await deliveries('n.user_id = $1', [me(req).user.id], 30) });
});
