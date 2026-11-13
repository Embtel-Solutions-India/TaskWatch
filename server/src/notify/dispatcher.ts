import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import * as clock from '../clock.js';
import { MINUTE } from '../clock.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { sendEmail, sendWhatsApp, type OutgoingMessage } from './channels.js';
import { taskEmail, type TaskContext } from './emailTemplates.js';
import { pushToUser } from './push.js';

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

/** The designed email for a task alert, from the task as it stands now; undefined = plain shell. */
async function taskHtml(n: { task_id: number | null; user_id: number; event: string; body: string; link: string | null }): Promise<string | undefined> {
  if (n.task_id == null) return undefined;
  const { rows } = await pool.query(
    `select t.id, t.title, t.priority, t.status, t.due_at, t.level, t.description, t.assignee_id, e.name entity, a.name assignee, g.name assigner, u.time_zone
       from tasks t join entities e on e.id = t.entity_id join users a on a.id = t.assignee_id join users g on g.id = t.assigner_id
       join users u on u.id = $2
      where t.id = $1`,
    [n.task_id, n.user_id],
  );
  const r = rows[0];
  if (!r) return undefined;
  const ctx: TaskContext = {
    id: r.id, title: r.title, entity: r.entity, priority: r.priority, status: r.status, dueAt: r.due_at, level: r.level,
    assignee: r.assignee, assigneeId: r.assignee_id, assigner: r.assigner, description: r.description, recipientId: n.user_id, timeZone: r.time_zone,
  };
  return taskEmail(n.event, ctx, n.body, n.link ?? `${config.appUrl}/tasks/${r.id}`, clock.now());
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
      [now, limit, WHATSAPP_ENABLED ? ['email', 'whatsapp', 'push'] : ['email', 'push'], new Date(now.getTime() - LEASE_MS)],
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
        if (n.channel === 'push') {
          // ADR-0012: one row, every browser the person enabled. None left (all revoked meanwhile) = skipped.
          const r = await pushToUser(n.user_id, { title: n.subject, body: String(n.body).slice(0, 240), url: n.link ?? `${config.appUrl}/notifications`, tag: `tw-${n.parent_id ?? n.id}` });
          await pool.query('update notifications set status = $2, sent_at = $3, error = $4 where id = $1', [
            n.id,
            r.simulated ? 'simulated' : r.delivered ? 'sent' : 'skipped',
            clock.now(),
            r.delivered || r.simulated ? null : 'No browser enabled for notifications',
          ]);
          continue;
        }
        const result = n.channel === 'whatsapp' ? await sendWhatsApp(msg) : await sendEmail(msg, n.event === 'digest' ? n.body : await taskHtml(n));
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
