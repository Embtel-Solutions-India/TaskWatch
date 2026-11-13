// Web Push (ADR-0012): deliver one notification to every browser a person enabled. Without VAPID keys the channel is
// simulated, like email without SMTP. A browser the push service reports as gone (404/410) is revoked, never retried.
import * as webpush from 'web-push';
import * as clock from '../clock.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Opened when the notification is clicked. */
  url: string;
  /** Same tag = replaces an earlier notification instead of stacking. */
  tag: string;
}

let configured = false;
const ready = () => {
  if (!config.push.enabled) return false;
  if (!configured) {
    webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    configured = true;
  }
  return true;
};

/** Tests replace the sender; the default is the web-push library. */
type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, body: string) => Promise<unknown>;
let send: Sender = (sub, body) => webpush.sendNotification(sub, body, { TTL: 24 * 3600, urgency: 'high' });
export function setPushSender(s: Sender | null): void {
  send = s ?? ((sub, body) => webpush.sendNotification(sub, body, { TTL: 24 * 3600, urgency: 'high' }));
}

export type PushResult = { simulated: boolean; delivered: number; gone: number; noBrowser: boolean };

/** Send to all of a person's active browsers. Throws only if every browser failed with a retryable error. */
export async function pushToUser(userId: number, payload: PushPayload): Promise<PushResult> {
  const { rows } = await pool.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'select id, endpoint, p256dh, auth from push_subscriptions where user_id = $1 and revoked_at is null',
    [userId],
  );
  if (!rows.length) return { simulated: false, delivered: 0, gone: 0, noBrowser: true };
  if (!ready()) return { simulated: true, delivered: 0, gone: 0, noBrowser: false };
  const body = JSON.stringify(payload);
  let delivered = 0;
  let gone = 0;
  let lastError: Error | null = null;
  for (const s of rows) {
    try {
      await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
      await pool.query('update push_subscriptions set last_used_at = $2 where id = $1', [s.id, clock.now()]);
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await pool.query('update push_subscriptions set revoked_at = $2 where id = $1', [s.id, clock.now()]);
        gone++;
      } else lastError = err as Error;
    }
  }
  if (!delivered && lastError) throw lastError;
  return { simulated: false, delivered, gone, noBrowser: delivered + gone === 0 && !lastError };
}
