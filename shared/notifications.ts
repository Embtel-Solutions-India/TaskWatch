// Notification types and preferences (NTF-04) — one definition for server and client (ADR-0007).

export const NOTIFICATION_TYPES = [
  'assignment',
  'reassignment',
  'due_soon',
  'overdue',
  'escalation',
  'escalation_ack',
  'progress',
  'review_required',
  'review_decision',
  'extension_request',
  'extension_decision',
  'mention',
  'completed',
  'blocked',
  'system_alert',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Always delivered on every channel, whatever the preferences say (WO events; D-42 adds Blocked). */
export const MANDATORY_TYPES: readonly NotificationType[] = ['assignment', 'reassignment', 'escalation', 'blocked', 'system_alert'];

/** Types with an approved WhatsApp template (docs/whatsapp-templates.md). */
export const WHATSAPP_TYPES: readonly NotificationType[] = ['assignment', 'reassignment', 'escalation', 'blocked', 'system_alert'];

/** D-106: WhatsApp is switched off. Nothing queues it and the UI hides it; flip this to bring it back. */
export const WHATSAPP_ENABLED = false;

export type PrefChannel = 'inApp' | 'email' | 'whatsapp';
export type NotificationPrefs = Record<PrefChannel, Record<NotificationType, boolean>>;

const on = (list: readonly NotificationType[]) => Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, list.includes(t)])) as Record<NotificationType, boolean>;

/** A new user's preferences: in-app all on; email and WhatsApp for the events that matter most. */
export function defaultPrefs(): NotificationPrefs {
  return {
    inApp: on(NOTIFICATION_TYPES),
    email: on(['escalation', 'assignment', 'review_required', 'extension_request', 'blocked', 'system_alert']),
    whatsapp: on(['escalation', 'assignment', 'reassignment', 'blocked', 'system_alert']),
  };
}

/** Whether `type` goes to `channel` for someone with `prefs` (D-43: each channel is independent). */
export function wants(prefs: NotificationPrefs, type: NotificationType, channel: PrefChannel): boolean {
  return MANDATORY_TYPES.includes(type) || prefs[channel][type];
}

/**
 * The type of a stored notification event. Stored events keep their original names (they are evidence); the
 * type is derived when read. Null = not an alert (digest, account email): preferences never apply.
 * D-107: events with no client type of their own map to the closest one.
 */
const EVENT_TYPE: Record<string, NotificationType> = {
  assigned: 'assignment',
  reassigned: 'reassignment',
  due_soon: 'due_soon',
  overdue: 'overdue',
  L0: 'escalation',
  L1: 'escalation',
  L2: 'escalation',
  L3: 'escalation',
  repeat: 'escalation',
  escalation_ack: 'escalation_ack',
  progress: 'progress',
  due_change: 'progress',
  cancelled: 'progress',
  reopened: 'progress',
  review_required: 'review_required',
  review_decision: 'review_decision',
  extension_requested: 'extension_request',
  extension_decided: 'extension_decision',
  mention: 'mention',
  comment: 'mention',
  completed: 'completed',
  blocked: 'blocked',
  chain_break: 'system_alert',
};

export const typeOfEvent = (event: string): NotificationType | null => EVENT_TYPE[event] ?? null;

/** Every stored event that reads as `type` (for filtering stored rows by type). */
export const eventsOfType = (type: NotificationType): string[] => Object.keys(EVENT_TYPE).filter((e) => EVENT_TYPE[e] === type);
