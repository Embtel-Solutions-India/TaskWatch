// Notifications, preferences and the delivery log against the real server (T-6.9; NOTIFICATIONS-FRD). Used only when
// BACKEND === 'server'. Maps the server's shapes (numeric ids, recipient objects) onto the prototype's types.
import { WHATSAPP_TYPES } from '@taskwatch/shared/notifications';
import type { Delivery, Notification, NotificationPrefs } from '../../types';
import { http } from '../http';

/* eslint-disable @typescript-eslint/no-explicit-any -- server JSON is mapped field by field below */
const S = (n: number | null | undefined): string | null => (n == null ? null : String(n));

const notification = (n: any): Notification => ({
  id: String(n.id),
  userId: '', // always the caller's own (NTF-01)
  type: n.type ?? 'progress', // digests and account emails never reach the inbox; D-107 maps the rest
  title: n.title,
  body: n.body,
  taskId: S(n.taskId),
  at: n.at,
  read: n.read,
  emailSimulated: n.deliveries.some((d: any) => d.channel === 'email' && d.status === 'simulated'),
  deliveries: n.deliveries,
});

const delivery = (d: any): Delivery => ({
  id: String(d.id),
  notificationId: null,
  kind: d.kind,
  digestWeek: null,
  userId: String(d.recipient.id),
  recipientName: d.recipient.name,
  channel: d.channel,
  address: d.address,
  subject: d.subject,
  body: d.body,
  template: d.template,
  templateParams: d.templateParams,
  link: d.link,
  taskId: S(d.taskId),
  level: d.level,
  createdAt: d.at,
  status: d.status,
  heldUntil: d.heldUntil,
  sentAt: d.sentAt,
  reason: d.reason,
  copied: d.copied,
});

export type Integrations = { email: 'live' | 'simulated'; whatsapp: 'live' | 'simulated' | 'off' };

export const notificationsServer = {
  /** The newest 100; the inbox filters on the page (D-10). */
  list: async (): Promise<Notification[]> => (await http<{ items: any[] }>('GET', '/notifications?limit=100')).items.map(notification),
  markRead: async (id: string, read: boolean): Promise<void> => void (await http('PATCH', `/notifications/${id}`, { read })),
  markAllRead: async (): Promise<number> => (await http<{ count: number }>('POST', '/notifications/read-all', {})).count,

  prefs: async (): Promise<NotificationPrefs> => (await http<{ prefs: NotificationPrefs }>('GET', '/me/notification-prefs')).prefs,
  /** WhatsApp keys only for types with a template (the server rejects the rest, NTF-04-AC-3). */
  setPrefs: async (prefs: NotificationPrefs): Promise<void> =>
    void (await http('PUT', '/me/notification-prefs', { ...prefs, whatsapp: Object.fromEntries(WHATSAPP_TYPES.map((t) => [t, prefs.whatsapp[t]])) })),

  deliveries: async (): Promise<{ items: Delivery[]; integrations: Integrations }> => {
    const r = await http<{ items: any[]; integrations: Integrations }>('GET', '/deliveries');
    return { items: r.items.map(delivery), integrations: r.integrations };
  },
  myDeliveries: async (): Promise<Delivery[]> => (await http<{ items: any[] }>('GET', '/me/deliveries')).items.map(delivery),
  sendDigest: async (): Promise<number> => (await http<{ sent: number }>('POST', '/admin/digest', { scope: 'all' })).sent,
};
