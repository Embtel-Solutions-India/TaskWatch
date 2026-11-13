// Web Push (ADR-0012): the public key, and each person's own browser subscriptions. Nobody manages anyone else's.
import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock.js';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { me, requireUser } from '../http/middleware.js';
import { pushToUser } from '../notify/push.js';
import { appendAdmin } from '../services/audit.js';

export const pushRouter = Router();
pushRouter.use(requireUser);

const endpoint = z.url({ protocol: /^https$/, error: 'A browser push endpoint (https) is required.' }).max(1000, { error: 'Endpoint too long.' });
const subscribeSchema = z
  .object({
    endpoint,
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }, { error: 'Browser keys are missing.' }).strict(),
  })
  .strict();

/** Whether push is configured, and the key a browser subscribes with. */
pushRouter.get('/push/key', (_req, res) => {
  res.json({ enabled: config.push.enabled, publicKey: config.push.enabled ? config.push.publicKey : null });
});

/** Enable push in this browser for the signed-in person. A browser that belonged to someone else moves to this person. */
pushRouter.post('/push/subscribe', async (req, res) => {
  const { user } = me(req);
  const s = subscribeSchema.parse(req.body);
  const agent = String(req.get('user-agent') ?? '').slice(0, 300) || null;
  await tx(async (c) => {
    await c.query(
      `insert into push_subscriptions (user_id, organization_id, endpoint, p256dh, auth, user_agent, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (endpoint) do update set user_id = excluded.user_id, organization_id = excluded.organization_id,
         p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, revoked_at = null`,
      [user.id, user.organizationId, s.endpoint, s.keys.p256dh, s.keys.auth, agent, clock.now()],
    );
    await appendAdmin(c, { actorId: user.id, kind: 'push.enabled', target: `user:${user.id}`, targetType: 'user', after: { browser: agent } });
  });
  res.status(204).end();
});

/** Turn push off in this browser (only one's own). */
pushRouter.post('/push/unsubscribe', async (req, res) => {
  const { user } = me(req);
  const { endpoint: e } = z.object({ endpoint }).strict().parse(req.body);
  await pool.query('update push_subscriptions set revoked_at = $3 where endpoint = $1 and user_id = $2 and revoked_at is null', [e, user.id, clock.now()]);
  res.status(204).end();
});

/** A test notification to all of one's own browsers (checking a phone, for example). */
pushRouter.post('/push/test', async (req, res) => {
  const { user } = me(req);
  z.object({}).strict().parse(req.body ?? {});
  const r = await pushToUser(user.id, { title: 'TaskWatch', body: 'Browser notifications are on for this device.', url: `${config.appUrl}/notifications`, tag: 'tw-test' });
  res.json(r);
});
