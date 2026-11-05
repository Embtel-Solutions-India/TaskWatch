import { typeOfEvent, wants, WHATSAPP_ENABLED, type PrefChannel } from '@taskwatch/shared/notifications';
import * as clock from '../clock.js';
import type { Db } from '../db/pool.js';
import type { RulesConfig } from '../domain.js';
import { isQuietTime, quietEndsAt } from '../engine/levels.js';
import type { Directory, DirUser } from '../services/directory.js';
import { prefsOf } from '../services/prefs.js';
import { kickDispatcher } from './dispatcher.js';
import { zoneLabel } from './format.js';
import { taskLink, type Message } from './messages.js';

export interface Recipient {
  userId: number;
  copied?: boolean;
}

interface Row {
  channel: 'inapp' | 'email' | 'whatsapp';
  status: string;
  address: string | null;
  error: string | null;
  sendAfter: Date;
  sentAt: Date | null;
}

/** NTF-03 + D-105: the recipient's own quiet window, else the organization's, in the recipient's zone. */
function quietHold(u: DirUser, rules: RulesConfig, now: Date): { until: Date; reason: string } | null {
  if (!rules.quietHours.enabled) return null;
  const start = u.quietStart ?? rules.quietHours.start;
  const end = u.quietEnd ?? rules.quietHours.end;
  if (!isQuietTime(u.timeZone, now, start, end)) return null;
  return { until: quietEndsAt(u.timeZone, now, end), reason: `Quiet hours ${start}–${end} (${zoneLabel(u.timeZone, now)})` };
}

/**
 * Queue an alert for each recipient: in-app at once, email (and WhatsApp while D-106 keeps it off: never) through
 * the dispatcher. Each channel follows the recipient's preferences, except mandatory types (NTF-04, D-43).
 */
export async function notify(
  db: Db,
  dir: Directory,
  rules: RulesConfig,
  recipients: Recipient[],
  build: (u: DirUser, copied: boolean) => Message,
): Promise<void> {
  const now = clock.now();
  const firsts = new Map<number, Recipient>(); // de-duplicated; the first mention (to before cc) wins
  for (const r of recipients) if (!firsts.has(r.userId)) firsts.set(r.userId, r);
  const prefs = await prefsOf(db, [...firsts.keys()]);
  for (const r of firsts.values()) {
    const u = dir.get(r.userId);
    if (!u || !u.active) continue;
    const msg = build(u, Boolean(r.copied));
    const type = typeOfEvent(msg.event);
    const want = (ch: PrefChannel) => type === null || wants(prefs.get(u.id)!, type, ch);
    const hold = msg.quietable ? quietHold(u, rules, now) : null;
    const queued = { status: hold ? 'held' : 'pending', sendAfter: hold?.until ?? now, error: hold?.reason ?? null, sentAt: null };

    const rows: Row[] = [];
    if (!msg.html && want('inApp')) rows.push({ channel: 'inapp', status: 'sent', address: null, error: null, sendAfter: now, sentAt: now });
    if (want('email')) rows.push({ channel: 'email', address: u.email, ...queued });
    if (WHATSAPP_ENABLED && !msg.html && msg.template && want('whatsapp')) {
      const wa = u.whatsapp; // migration 009 copied the older numbers from phone (KI-25)
      if (!wa) rows.push({ channel: 'whatsapp', status: 'skipped', address: null, error: 'No WhatsApp number on file', sendAfter: now, sentAt: null });
      else if (!u.whatsappOptIn) rows.push({ channel: 'whatsapp', status: 'skipped', address: wa, error: 'Has not opted in to WhatsApp alerts', sendAfter: now, sentAt: null });
      else rows.push({ channel: 'whatsapp', address: wa, ...queued });
    }

    let inboxId: number | null = null; // email/WhatsApp rows point at their in-app row (DATABASE_DESIGN §3.9)
    for (const row of rows) {
      const ins: { rows: { id: number }[] } = await db.query<{ id: number }>(
        `insert into notifications (user_id, task_id, escalation_id, event, channel, status, address, subject, body,
           template, template_params, link, send_after, created_at, sent_at, error, parent_id, level, organization_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, (select organization_id from users where id = $1))
         returning id`,
        [
          u.id,
          msg.taskId,
          msg.escalationId ?? null,
          msg.event,
          row.channel,
          row.status,
          row.address,
          msg.subject,
          row.channel === 'email' && msg.html ? msg.html : msg.text,
          row.channel === 'whatsapp' ? msg.template : null,
          row.channel === 'whatsapp' ? JSON.stringify(msg.params) : null,
          msg.taskId != null ? taskLink(msg.taskId) : null,
          row.sendAfter,
          now,
          row.sentAt,
          row.error,
          row.channel === 'inapp' ? null : inboxId,
          msg.level ?? null,
        ],
      );
      if (row.channel === 'inapp') inboxId = ins.rows[0]!.id;
    }
  }
  kickDispatcher();
}
