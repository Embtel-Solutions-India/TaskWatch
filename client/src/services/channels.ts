// Email + WhatsApp delivery, simulated. Mirrors server/src/notify: the same five WhatsApp Business
// templates (docs/whatsapp-templates.md), quiet hours for L0/L1, and skip rules. Nothing is sent.
import { HOUR, LEVEL_LABEL, PRIORITY_LABEL } from '../constants';
import type { Db, Delivery, Notification, WhatsAppTemplate } from '../types';
import { isQuietTime, quietEndsAt as nextLocalTime } from './engine/escalation';
import { reportsOf } from './authz/permissions';
import { ACTIVE_STATUSES as ACTIVE } from '../types';

export const TEMPLATES: Record<WhatsAppTemplate, { body: string; button: boolean; vars: string[]; used: string }> = {
  taskwatch_task_assigned: {
    body: 'New task from {{1}}: {{2}}. Priority: {{3}}. Due: {{4}}. Please post your first update in TaskWatch.',
    button: true,
    vars: ['assigner', 'title', 'priority', "due (recipient's zone)"],
    used: 'New assignment and reassignment',
  },
  taskwatch_update_reminder: {
    body: 'Reminder: there has been no update on {{1}} for {{2}}. Please post an update in TaskWatch.',
    button: true,
    vars: ['title', 'silence'],
    used: 'L0 reminder to the assignee',
  },
  taskwatch_escalation: {
    body: 'TaskWatch {{1}}: {{2}} (assigned to {{3}}, {{4}}) — {{5}}. Please review and acknowledge in TaskWatch.',
    button: true,
    vars: ['level', 'title', 'assignee', 'team', 'reason'],
    used: 'L1–L3 escalations and their reminders',
  },
  taskwatch_task_blocked: {
    body: '{{1}} marked {{2}} as Blocked. Reason: {{3}}. Please help unblock it in TaskWatch.',
    button: true,
    vars: ['assignee', 'title', 'reason'],
    used: 'Not used: this workflow has no Blocked status',
  },
  taskwatch_system_alert: {
    body: 'TaskWatch alert: {{1}} Open TaskWatch for details.',
    button: false,
    vars: ['alert text'],
    used: 'Platform alerts (none raised in the prototype)',
  },
};

export function renderTemplate(t: WhatsAppTemplate, params: string[]): string {
  return TEMPLATES[t].body.replace(/\{\{(\d)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
}

function zoneAbbr(tz: string, at: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
}

/** "Thu 5 Nov, 5:00 PM EST" in the recipient's zone. */
function dueInZone(iso: string, tz: string): string {
  const t = Date.parse(iso);
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(t);
  return `${s.replace(/ (am|pm)$/i, (m) => m.toUpperCase())} ${zoneAbbr(tz, t)}`;
}

/** If `at` is inside quiet hours in `tz`, the moment they end; otherwise null. */
export function quietEndsAt(db: Db, tz: string, at: number): number | null {
  const q = db.rules.quietHours;
  if (!q.enabled || !isQuietTime(tz, at, q.start, q.end)) return null;
  // Released exactly when the local clock reaches the end time, as on the server (shared ladder).
  return nextLocalTime(tz, at, q.end);
}

function link(taskId: string | null): string | null {
  if (!taskId) return null;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://taskwatch.example';
  return `${origin}/tasks/${taskId}`;
}

export interface DispatchContext {
  level?: number;
  reason?: string;
  /** Recipient is copied, not the owner of this level. */
  copy?: boolean;
}

/** Work order: these go on every channel regardless of personal preferences (shared with the server, NTF-04). */
export { MANDATORY_TYPES } from '@taskwatch/shared/notifications';
import { MANDATORY_TYPES } from '@taskwatch/shared/notifications';

function whatsappFor(db: Db, n: Notification, ctx: DispatchContext, tz: string): { template: WhatsAppTemplate; params: string[] } | null {
  const task = db.tasks.find((t) => t.id === n.taskId);
  if (!task) return null;
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? 'Unknown';
  if ((n.type === 'assignment' || n.type === 'reassignment') && task.assigneeId === n.userId)
    return { template: 'taskwatch_task_assigned', params: [name(task.assignedBy), task.title, PRIORITY_LABEL[task.priority], dueInZone(task.dueAt, tz)] };
  if (n.type === 'escalation' && ctx.level === 0) return { template: 'taskwatch_update_reminder', params: [task.title, ctx.reason ?? 'the required window'] };
  if (n.type === 'escalation' && ctx.level !== undefined)
    return { template: 'taskwatch_escalation', params: [`${LEVEL_LABEL[ctx.level]!}${ctx.copy ? ' (copy)' : ''}`, task.title, name(task.assigneeId), db.teams.find((t) => t.id === task.teamId)?.name ?? 'no team', ctx.reason ?? 'needs attention'] };
  return null;
}

/** Create the email and WhatsApp deliveries for a notification. */
export function dispatch(db: Db, n: Notification, ctx: DispatchContext = {}, nextId: (p: string) => string): void {
  const user = db.users.find((u) => u.id === n.userId);
  if (!user) return;
  const prefs = db.prefs[user.id];
  const at = Date.parse(n.at);
  // Work order: quiet hours hold L0/L1 email and WhatsApp. L2/L3 always go; in-app is never held.
  const holdable = n.type === 'escalation' && ctx.level !== undefined && ctx.level <= 1;
  const heldUntil = holdable ? quietEndsAt(db, user.timezone, at) : null;
  const base = { notificationId: n.id as string | null, kind: 'alert' as const, digestWeek: null, userId: user.id, link: link(n.taskId), taskId: n.taskId, level: ctx.level ?? null, createdAt: n.at };
  const out: Omit<Delivery, 'id'>[] = [];

  const mandatory = MANDATORY_TYPES.includes(n.type);
  if (db.settings.emailSimulation && (mandatory || (prefs?.email[n.type] ?? true))) {
    out.push({
      ...base,
      channel: 'email',
      address: user.email,
      subject: n.title,
      body: n.body,
      template: null,
      templateParams: null,
      status: heldUntil ? 'held' : 'sent',
      heldUntil: heldUntil ? new Date(heldUntil).toISOString() : null,
      sentAt: heldUntil ? null : n.at,
      reason: heldUntil ? `Quiet hours ${db.rules.quietHours.start}–${db.rules.quietHours.end} (${zoneAbbr(user.timezone, at)})` : null,
    });
  }

  const wa = db.settings.whatsappSimulation && (mandatory || (prefs?.whatsapp?.[n.type] ?? false)) ? whatsappFor(db, n, ctx, user.timezone) : null;
  if (wa) {
    const skip = !user.whatsapp ? 'No WhatsApp number on file' : !user.whatsappOptIn ? 'Has not opted in to WhatsApp alerts' : null;
    out.push({
      ...base,
      channel: 'whatsapp',
      address: user.whatsapp,
      subject: null,
      body: renderTemplate(wa.template, wa.params),
      template: wa.template,
      templateParams: wa.params,
      status: skip ? 'skipped' : heldUntil ? 'held' : 'sent',
      heldUntil: !skip && heldUntil ? new Date(heldUntil).toISOString() : null,
      sentAt: skip || heldUntil ? null : n.at,
      reason: skip ?? (heldUntil ? `Quiet hours ${db.rules.quietHours.start}–${db.rules.quietHours.end} (${zoneAbbr(user.timezone, at)})` : null),
    });
  }
  for (const d of out) db.deliveries.push({ id: nextId('dlv'), ...d });
  n.emailSimulated = out.some((d) => d.channel === 'email');
}

/** Release held messages whose quiet hours have ended. */
export function releaseHeld(db: Db, now: number): number {
  let c = 0;
  for (const d of db.deliveries) {
    if (d.status === 'held' && d.heldUntil && Date.parse(d.heldUntil) <= now) {
      d.status = 'sent';
      d.sentAt = d.heldUntil;
      c++;
    }
  }
  return c;
}

/* ---------------- Weekly digest (email only: Managers + Founder's Office) ---------------- */

/** Monday (local) of the week containing `t`, as YYYY-MM-DD. */
function mondayKey(t: number): string {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** When the digest for the week starting `monday` goes out. */
function digestTime(db: Db, monday: string): number {
  const d = new Date(`${monday}T00:00:00`);
  d.setDate(d.getDate() + ((db.settings.digestDay + 6) % 7));
  d.setHours(db.settings.digestHour, 0, 0, 0);
  return d.getTime();
}

export function digestRecipients(db: Db) {
  return db.users.filter((u) => u.status === 'active' && (u.role === 'manager' || u.role === 'cos' || u.role === 'ceo'));
}

/** Plain-text digest for one recipient, covering the 7 days before `at`. */
export function buildDigest(db: Db, userId: string, at: number): { subject: string; body: string } {
  const user = db.users.find((u) => u.id === userId)!;
  const orgWide = user.role === 'cos' || user.role === 'ceo';
  const scope = orgWide ? null : reportsOf(db, user.id);
  const tasks = db.tasks.filter((t) => t.status !== 'draft' && (!scope || scope.has(t.assigneeId)));
  const from = at - 7 * 24 * HOUR;
  const inWeek = (s: string | null) => !!s && Date.parse(s) >= from && Date.parse(s) < at;
  const open = tasks.filter((t) => ACTIVE.includes(t.status) || t.status === 'submitted');
  const overdue = open.filter((t) => Date.parse(t.dueAt) < at);
  const ids = new Set(tasks.map((t) => t.id));
  const raised = db.escalations.filter((e) => ids.has(e.taskId) && e.level >= 1 && inWeek(e.at));
  const l3 = db.escalations.filter((e) => ids.has(e.taskId) && e.level === 3 && e.status !== 'resolved');
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? '—';
  const week = new Date(from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const lines = [
    `Weekly digest for ${user.name} — ${orgWide ? `${db.settings.orgName}, organization-wide` : 'your reporting line'}, week of ${week}.`,
    '',
    `Open tasks: ${open.length} (${overdue.length} overdue)`,
    `Created this week: ${tasks.filter((t) => inWeek(t.createdAt)).length} · Completed this week: ${tasks.filter((t) => inWeek(t.completedAt)).length}`,
    `Escalations raised (L1+): ${raised.length} · Still at L3 Founder's Office: ${new Set(l3.map((e) => e.taskId)).size}`,
  ];
  const top = [...overdue].sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 5);
  if (top.length) {
    lines.push('', 'Most overdue:');
    for (const t of top) lines.push(`• ${t.id} ${t.title} — ${name(t.assigneeId)}, ${Math.floor((at - Date.parse(t.dueAt)) / HOUR / 24)} d late`);
  }
  return { subject: `TaskWatch weekly digest — week of ${week}`, body: lines.join('\n') };
}

function sendDigest(db: Db, userId: string, at: number, week: string, nextId: (p: string) => string): void {
  const user = db.users.find((u) => u.id === userId)!;
  const { subject, body } = buildDigest(db, userId, at);
  const when = new Date(at).toISOString();
  db.deliveries.push({ id: nextId('dlv'), notificationId: null, kind: 'digest', digestWeek: week, userId, channel: 'email', address: user.email, subject, body, template: null, templateParams: null, link: link(null) ?? (typeof window !== 'undefined' ? window.location.origin + '/' : null), taskId: null, level: null, createdAt: when, status: 'sent', heldUntil: null, sentAt: when, reason: null });
}

/** Send any scheduled digests due up to `now` (last 4 weeks). One per recipient per week. */
export function processDigests(db: Db, now: number, nextId: (p: string) => string): number {
  if (!db.settings.emailSimulation) return 0;
  let c = 0;
  for (let w = 0; w < 4; w++) {
    const week = mondayKey(now - w * 7 * 24 * HOUR);
    const at = digestTime(db, week);
    if (at > now) continue;
    for (const u of digestRecipients(db)) {
      if (db.deliveries.some((d) => d.kind === 'digest' && d.userId === u.id && d.digestWeek === week)) continue;
      sendDigest(db, u.id, at, week, nextId);
      c++;
    }
  }
  return c;
}

/** Demo: send this week's digest immediately to every recipient. */
export function sendDigestNow(db: Db, now: number, nextId: (p: string) => string): number {
  const key = `manual-${new Date(now).toISOString()}`;
  for (const u of digestRecipients(db)) sendDigest(db, u.id, now, key, nextId);
  return digestRecipients(db).length;
}
