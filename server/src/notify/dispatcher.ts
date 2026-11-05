import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import * as clock from '../clock.js';
import { MINUTE } from '../clock.js';
import { pool } from '../db/pool.js';
import { sendEmail, sendWhatsApp, type OutgoingMessage } from './channels.js';

const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * MINUTE;
let running = false;
let kickTimer: NodeJS.Timeout | null = null;
let enabled = true;

/** Tests and the seed script replay history without sending anything. */
export function setDispatcherEnabled(on: boolean): void {
  enabled = on;
}

/** Ask the dispatcher to run shortly (after the caller's transaction commits). */
export function kickDispatcher(): void {
  if (!enabled || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    dispatchDue().catch((err) => console.error('[dispatcher]', err));
  }, 250);
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/tr|\/h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Send every WhatsApp and email alert whose time has come; log the outcome on each row. */
export async function dispatchDue(limit = 100): Promise<number> {
  if (!enabled || running) return 0;
  running = true;
  try {
    const now = clock.now();
    // A row still 'sending' after the lease was claimed by a process that died mid-send: claim it again (NTF-02-AC-5).
    const { rows } = await pool.query(
      `update notifications set status = 'sending', attempts = attempts + 1, claimed_at = $1
       where id in (
         select id from notifications
         where channel = any($3)
           and ((status in ('pending','held') and send_after <= $1) or (status = 'sending' and claimed_at < $4))
         order by send_after, id limit $2 for update skip locked)
       returning *`,
      [now, limit, WHATSAPP_ENABLED ? ['email', 'whatsapp'] : ['email'], new Date(now.getTime() - LEASE_MS)],
    );
    for (const n of rows) {
      const msg: OutgoingMessage = {
        address: n.address,
        subject: n.subject,
        body: n.event === 'digest' ? htmlToText(n.body) : n.body,
        template: n.template,
        templateParams: n.template_params,
        link: n.link,
        taskId: n.task_id,
      };
      try {
        const result = n.channel === 'whatsapp' ? await sendWhatsApp(msg) : await sendEmail(msg, n.event === 'digest' ? n.body : undefined);
        await pool.query(`update notifications set status = $2, sent_at = $3, provider_id = $4, error = null where id = $1`, [
          n.id,
          result.simulated ? 'simulated' : 'sent',
          clock.now(),
          result.providerId,
        ]);
      } catch (err) {
        const failed = n.attempts >= MAX_ATTEMPTS;
        await pool.query(`update notifications set status = $2, send_after = $3, error = $4 where id = $1`, [
          n.id,
          failed ? 'failed' : 'pending',
          new Date(clock.now().getTime() + 5 * MINUTE * n.attempts),
          (err as Error).message.slice(0, 500),
        ]);
      }
    }
    return rows.length;
  } finally {
    running = false;
  }
}
