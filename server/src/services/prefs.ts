// NTF-04 notification preferences: one row per person in notification_prefs (missing row = defaults).
import {
  defaultPrefs,
  MANDATORY_TYPES,
  NOTIFICATION_TYPES,
  WHATSAPP_ENABLED,
  WHATSAPP_TYPES,
  type NotificationPrefs,
  type NotificationType,
} from '@taskwatch/shared/notifications';
import { z } from 'zod';
import * as clock from '../clock.js';
import { pool, tx, type Db } from '../db/pool.js';
import { invalid } from '../http/errors.js';
import { appendAdmin } from './audit.js';
import type { DirUser } from './directory.js';

/** Stored prefs over the defaults, so a type added later starts at its default. */
function merge(stored: Partial<NotificationPrefs> | undefined): NotificationPrefs {
  const d = defaultPrefs();
  if (!stored) return d;
  return { inApp: { ...d.inApp, ...stored.inApp }, email: { ...d.email, ...stored.email }, whatsapp: { ...d.whatsapp, ...stored.whatsapp } };
}

/** Preferences of several people at once (the notifier). */
export async function prefsOf(db: Db, userIds: number[]): Promise<Map<number, NotificationPrefs>> {
  const { rows } = await db.query<{ user_id: number; prefs: NotificationPrefs }>('select user_id, prefs from notification_prefs where user_id = any($1)', [userIds]);
  const stored = new Map(rows.map((r) => [r.user_id, r.prefs]));
  return new Map(userIds.map((id) => [id, merge(stored.get(id))]));
}

export async function getPrefs(user: DirUser) {
  const prefs = (await prefsOf(pool, [user.id])).get(user.id)!;
  return {
    prefs,
    mandatory: MANDATORY_TYPES,
    whatsappTypes: WHATSAPP_ENABLED ? WHATSAPP_TYPES : [],
    whatsappAvailable: WHATSAPP_ENABLED && Boolean(user.whatsapp && user.whatsappOptIn),
  };
}

const channel = z.partialRecord(z.enum(NOTIFICATION_TYPES, { error: 'Unknown notification type.' }), z.boolean({ error: 'Use true or false.' }));
export const prefsSchema = z.object({ inApp: channel, email: channel, whatsapp: channel }).strict();

/** Save one's own preferences. Mandatory types are stored on: the work order does not let them be switched off. */
export async function savePrefs(user: DirUser, input: z.infer<typeof prefsSchema>): Promise<void> {
  const offTemplate = Object.keys(input.whatsapp).filter((t) => !WHATSAPP_TYPES.includes(t as NotificationType));
  if (offTemplate.length) throw invalid({ whatsapp: 'No approved WhatsApp template for this event' });
  const prefs = merge(input as Partial<NotificationPrefs>);
  for (const ch of ['inApp', 'email', 'whatsapp'] as const) for (const t of MANDATORY_TYPES) prefs[ch][t] = true;
  await tx(async (c) => {
    await c.query(
      `insert into notification_prefs (user_id, prefs, updated_at) values ($1, $2, $3)
       on conflict (user_id) do update set prefs = excluded.prefs, updated_at = excluded.updated_at`,
      [user.id, JSON.stringify(prefs), clock.now()],
    );
    await appendAdmin(c, { actorId: user.id, kind: 'preferences.updated', target: `user:${user.id}`, targetType: 'user', after: prefs });
  });
}
