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

/** ADR-0012: 'push' = browser (Web Push) notifications on the devices a person enabled. */
export type PrefChannel = 'inApp' | 'email' | 'whatsapp' | 'push';
export type NotificationPrefs = Record<PrefChannel, Record<NotificationType, boolean>>;

const on = (list: readonly NotificationType[]) => Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, list.includes(t)])) as Record<NotificationType, boolean>;

/** A new user's preferences: in-app and browser all on; email and WhatsApp for the events that matter most. */
export function defaultPrefs(): NotificationPrefs {
  return {
    inApp: on(NOTIFICATION_TYPES),
    email: on(['escalation', 'assignment', 'review_required', 'extension_request', 'blocked', 'system_alert']),
    whatsapp: on(['escalation', 'assignment', 'reassignment', 'blocked', 'system_alert']),
    push: on(NOTIFICATION_TYPES),
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
  // ADR-0015 (D-158): someone marked away today has tasks due soon.
  away_tasks: 'due_soon',
  // ADR-0014: the 10-minute warning and the start notice follow the due-soon preference.
  deadline_warning: 'due_soon',
  start_notice: 'due_soon',
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
  // D-145: the reviewer's deadline reminders follow the review preference.
  review_r1: 'review_required',
  review_r2: 'review_required',
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

/**
 * CMT-01 / D-136: the names written as `@Name` in `body`. A mention ends at a non-letter, non-digit (so `@Raj` is not
 * inside `@Rajesh`), and the longest name wins (so `@Ana Lee` does not also mention a single-named "Ana").
 */
export function mentionedNames(body: string, names: readonly string[]): Set<string> {
  let rest = body;
  const hit = new Set<string>();
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    rest = rest.replace(re, () => (hit.add(name), ' '));
  }
  return hit;
}
