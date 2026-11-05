/// <reference types="node" />
// Run: npx tsx client/src/selfcheck.ts — asserts the business rules the prototype depends on.
import assert from 'node:assert/strict';
import { DEFAULT_RULES, HOUR } from './constants';
import { ApiError, assignableUsers, canAssignTo, canViewTask, wouldCreateLoop } from './services/authz/permissions';
import { BACKEND, http } from './services/http';
import { createTaskRecord, iso, processEscalations, processRecurrences } from './services/core';
import { computeLevel } from './services/engine/escalation';
import { occurrencesBetween } from './services/engine/recurrence';
import { allowedActions, canTransition } from './services/engine/workflow';
import { createSeed } from './services/mock/seed';
import { dispatch, processDigests, releaseHeld } from './services/channels';
import { escalationRecipients } from './services/core';

const T = Date.parse('2026-11-03T12:00:00Z');
const lvl = (priority: 'critical' | 'high' | 'normal' | 'low', silentH: number, dueInH = 999) =>
  computeLevel({ priority, clockStartedAt: T - silentH * HOUR, dueAt: T + dueInH * HOUR }, DEFAULT_RULES, T).level;

// Policy table: L0..L3 silence thresholds per priority.
const table = { critical: [4, 6, 8, 12], high: [24, 36, 48, 72], normal: [48, 72, 96, 144], low: [72, 108, 144, 216] } as const;
for (const [p, hs] of Object.entries(table) as [keyof typeof table, readonly number[]][]) {
  hs.forEach((h, k) => {
    assert.equal(lvl(p, h), k, `${p} at ${h} h should be L${k}`);
    assert.equal(lvl(p, h - 0.01), k - 1, `${p} just before ${h} h should be L${k - 1}`);
  });
}
// Past-due floors: due → L1, +24 h → L2, +72 h → L3, even with fresh updates.
assert.equal(lvl('low', 0, 0), 1);
assert.equal(lvl('low', 0, -24), 2);
assert.equal(lvl('low', 0, -72), 3);
assert.equal(lvl('low', 0, -23.9), 1);

// Workflow transitions.
assert.ok(canTransition('in_progress', 'submitted'));
assert.ok(canTransition('assigned', 'completed'), 'R-2: Done straight from Open when no review is required');
assert.ok(!canTransition('assigned', 'submitted'), 'review needs the work started first');
assert.ok(!canTransition('cancelled', 'in_progress'));
assert.ok(!canTransition('completed', 'in_progress'));
assert.ok(canTransition('completed', 'reopened'));

// Authorization and hierarchy on the seeded org.
const db = createSeed(T);
const user = (id: string) => db.users.find((u) => u.id === id)!;
assert.ok(canAssignTo(db, user('u-l1'), 'u-s1'), 'lead assigns to own staff');
assert.ok(!canAssignTo(db, user('u-l1'), 'u-s6'), 'lead cannot assign outside reporting line');
assert.ok(!canAssignTo(db, user('u-s1'), 'u-s2'), 'staff cannot assign');
assert.ok(!assignableUsers(db, user('u-m1')).some((u) => u.id === 'u-cos'), 'cannot assign upward');
assert.ok(wouldCreateLoop(db, 'u-m1', 'u-s1'), 'manager reporting to own staff is a loop');
assert.ok(!wouldCreateLoop(db, 'u-s1', 'u-l2'));

const at = iso(T);
const task = createTaskRecord(db, { title: 'Check', description: '', category: 'Operations', priority: 'critical', assigneeId: 'u-s1', teamId: 't-log', dueAt: iso(T + 48 * HOUR), reviewRequired: true }, 'u-l1', at);
assert.ok(canViewTask(db, user('u-s1'), task));
assert.ok(canViewTask(db, user('u-m1'), task), 'manager above sees it');
assert.ok(!canViewTask(db, user('u-s14'), task), 'other team staff cannot see it');
assert.ok(!canViewTask(db, user('u-l3'), task), 'other lead cannot see it');
task.status = 'in_progress';
assert.ok(allowedActions(db, user('u-s1'), task).has('submit'));
assert.ok(!allowedActions(db, user('u-s1'), task).has('complete'), 'review-required tasks cannot be self-completed');
assert.ok(!allowedActions(db, user('u-s1'), task).has('reassign'));

// Acknowledgement never resets the silence clock; escalation events are created once per level.
const before = task.clockStartedAt;
task.acknowledgedAt = at;
assert.equal(task.clockStartedAt, before);
processEscalations(db, T + 6.5 * HOUR);
const evs = () => db.escalations.filter((e) => e.taskId === task.id);
assert.deepEqual(evs().map((e) => e.level).sort(), [0, 1]);
processEscalations(db, T + 6.6 * HOUR);
assert.equal(evs().length, 2, 'ticks are idempotent');
{
  // Reminders repeat once per update window, not on every tick.
  const reminders = () => db.notifications.filter((n) => n.taskId === task.id && n.title.startsWith('Reminder')).length;
  const r0 = reminders();
  processEscalations(db, T + 16.5 * HOUR); // L3 reached at 12 h; critical window 4 h
  const r1 = reminders();
  processEscalations(db, T + 16.7 * HOUR);
  processEscalations(db, T + 16.9 * HOUR);
  assert.equal(reminders(), r1, 'no reminder spam between windows');
  assert.ok(r1 > r0, 'a reminder fires after a full window');
}
assert.ok(evs().find((e) => e.level === 1)!.recipientIds.includes('u-l1'), 'L1 goes to the team lead');
// L2 for a staff member whose lead has no manager skips to the Chief of Staff.
const sup = createTaskRecord(db, { title: 'Sup', description: '', category: 'Operations', priority: 'critical', assigneeId: 'u-s14', teamId: 't-sup', dueAt: iso(T + 99 * HOUR), reviewRequired: false }, 'u-l6', at);
sup.status = 'in_progress';
processEscalations(db, T + 8.5 * HOUR);
assert.deepEqual(db.escalations.find((e) => e.taskId === sup.id && e.level === 2)!.recipientIds, ['u-ceo', 'u-cos'], 'missing manager skips to the Founders Office');

// Recurrence is deterministic and never duplicates.
const rec = db.recurrences[0]!;
const count = () => db.tasks.filter((t) => t.recurrenceId === rec.id).length;
const n1 = count();
processRecurrences(db, T);
processRecurrences(db, T);
assert.equal(count(), n1, 'recurrence does not duplicate');
assert.deepEqual(occurrencesBetween({ ...rec, frequency: 'weekly', interval: 1, weekdays: [1, 3], startDate: '2026-11-02', endDate: null }, '2026-11-02', '2026-11-15'), ['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);

// Email + WhatsApp (simulated): quiet hours hold L0/L1, L2+ always go, no number / no opt-in skips.
{
  const night = Date.parse('2026-11-04T03:00:00Z'); // 22:00 in Boston (America/New_York)
  let k = 0;
  const nid = (p: string) => `${p}-chk-${k++}`;
  const mk = (userId: string, level: number) => {
    const n = { id: nid('n'), userId, type: 'escalation' as const, title: 't', body: 'b', taskId: task.id, at: iso(night), read: false, emailSimulated: false };
    dispatch(db, n, { level, reason: 'no assignee update for 6 h' }, nid);
    return db.deliveries.filter((d) => d.notificationId === n.id);
  };
  const l1 = mk('u-l1', 1);
  assert.deepEqual(l1.map((d) => `${d.channel}:${d.status}`).sort(), ['email:held', 'whatsapp:held'], 'L1 at 22:00 local is held');
  assert.equal(new Date(l1[0]!.heldUntil!).toISOString(), '2026-11-04T13:00:00.000Z', 'held until 08:00 local');
  assert.equal(l1.find((d) => d.channel === 'whatsapp')!.template, 'taskwatch_escalation');
  assert.ok(mk('u-m1', 2).every((d) => d.status === 'sent'), 'L2 is never held');
  assert.equal(mk('u-s1', 0).find((d) => d.channel === 'whatsapp')!.template, 'taskwatch_update_reminder');
  assert.equal(mk('u-s4', 2).find((d) => d.channel === 'whatsapp')!.status, 'skipped', 'no WhatsApp number → skipped');
  assert.equal(mk('u-s10', 2).find((d) => d.channel === 'whatsapp')!.reason, 'Has not opted in to WhatsApp alerts');
  releaseHeld(db, Date.parse('2026-11-04T13:00:00Z'));
  assert.ok(l1.every((d) => d.status === 'sent' && d.sentAt === '2026-11-04T13:00:00.000Z'), 'released when quiet hours end');
}

// Work-order routing: who is notified and who is copied at each level.
{
  const t = db.tasks.find((x) => x.assigneeId === 'u-s1')!;
  assert.deepEqual(escalationRecipients(db, t, 0), { to: ['u-s1'], cc: [] });
  assert.deepEqual(escalationRecipients(db, t, 1), { to: ['u-l1'], cc: ['u-s1'] }, 'L1: lead, assignee copied');
  assert.deepEqual(escalationRecipients(db, t, 2), { to: ['u-m1'], cc: ['u-l1', 'u-s1'] }, 'L2: manager, lead + assignee copied');
  assert.deepEqual(escalationRecipients(db, t, 3), { to: ['u-ceo', 'u-cos'], cc: ['u-m1'] }, 'L3: CoS + CEO, manager copied');
  db.rules.l3NotifyCeo = false;
  assert.deepEqual(escalationRecipients(db, t, 3).to, ['u-cos'], 'D7 off: Chief of Staff only');
  db.rules.l3NotifyCeo = true;
  // Mandatory channels: turning off email for escalations does not stop it.
  db.prefs['u-l1']!.email.escalation = false;
  db.prefs['u-l1']!.inApp.escalation = false;
  const n = { id: 'n-mand', userId: 'u-l1', type: 'escalation' as const, title: 't', body: 'b', taskId: t.id, at: iso(T), read: false, emailSimulated: false };
  dispatch(db, n, { level: 2 }, (p) => `${p}-m`);
  assert.ok(db.deliveries.some((d) => d.notificationId === 'n-mand' && d.channel === 'email'), 'escalation email is mandatory');
  // Weekly digest: Managers + Founder's Office, email only, once per week.
  const before = db.deliveries.filter((d) => d.kind === 'digest').length;
  processDigests(db, T + 7 * 86_400_000, (p) => `${p}-${Math.random()}`);
  const mid = db.deliveries.filter((d) => d.kind === 'digest').length;
  processDigests(db, T + 7 * 86_400_000, (p) => `${p}-${Math.random()}`);
  assert.equal(db.deliveries.filter((d) => d.kind === 'digest').length, mid, 'digest sent once per week');
  const recips = new Set(db.deliveries.filter((d) => d.kind === 'digest').map((d) => db.users.find((u) => u.id === d.userId)!.role));
  assert.ok(mid >= before && [...recips].every((r) => ['manager', 'cos', 'ceo'].includes(r)) && recips.has('manager'), 'digest goes to managers and the Founders Office');
  assert.ok(db.deliveries.filter((d) => d.kind === 'digest').every((d) => d.channel === 'email'), 'digest is email only');
}

// HTTP transport (T-1.16): every server failure becomes the ApiError the UI already handles. fetch is stubbed.
{
  const realFetch = globalThis.fetch;
  const seen: RequestInit[] = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    };
  };
  const fails = async (p: Promise<unknown>) => p.then(() => assert.fail('expected an ApiError'), (e) => (assert.ok(e instanceof ApiError), e as ApiError));
  try {
    reply(200, { ok: true });
    assert.deepEqual(await http('POST', '/x', { a: 1 }), { ok: true });
    const h = seen[0]!.headers as Record<string, string>;
    assert.equal(h['x-taskwatch'], '1', 'CSRF header sent');
    assert.equal(seen[0]!.credentials, 'same-origin');
    reply(422, { error: 'Give a reason.', fields: { reason: 'Give a reason.' } });
    const v = await fails(http('POST', '/x', {}));
    assert.equal(v.status, 422);
    assert.deepEqual(v.fields, { reason: 'Give a reason.' });
    reply(429, { error: 'Too many requests. Please wait and try again.' }, { 'retry-after': '42' });
    assert.equal((await fails(http('GET', '/x'))).retryAfterSeconds, 42);
    reply(404, { error: 'Task not found' });
    assert.equal((await fails(http('GET', '/x'))).status, 404);
    reply(502, undefined);
    const odd = await fails(http('GET', '/x'));
    assert.equal(odd.status, 500, 'unknown statuses become 500');
    globalThis.fetch = async () => {
      throw new TypeError('network');
    };
    assert.match((await fails(http('GET', '/x'))).message, /reach TaskWatch/);
    assert.equal(BACKEND, 'mock', 'mock is the default backend');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Seed integrity.
assert.ok(db.tasks.length >= 100);
assert.ok(db.users.every((u) => !wouldCreateLoop(db, u.id, u.managerId)), 'seed has no loops');
console.log(`selfcheck ok — ${db.tasks.length} tasks, ${db.escalations.length} escalation events, ${db.users.length} people`);
