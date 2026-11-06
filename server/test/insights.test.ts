// Pure tests for the dashboard rules (DASHBOARD-FRD §1, DASH-01-AC-1…5, AC-9) and the TASK-10 stage.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityHeatmap, attention, buildDashboard, dayStart, health, healthOf, kpis, layoutFor, trend, escalationResponse, type DashTask, type DashboardInput } from '@taskwatch/shared/insights';
import { taskStage } from '../src/domain.js';

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const ME = 1;

let seq = 0;
const task = (o: Partial<DashTask> = {}): DashTask => ({
  id: ++seq, title: `Task ${seq}`, status: 'in_progress', priority: 'normal', assigneeId: 2, assigneeName: 'Asha', assignedBy: ME,
  teamId: 1, entityId: 'BAIS', createdAt: NOW - 10 * H, updatedAt: NOW - H, dueAt: NOW + 72 * H, completedAt: null,
  clockStartedAt: NOW - H, acknowledgedAt: NOW - 9 * H, level: -1, silenceLevel: -1, next: null, overdue: false, mayReview: false, ...o,
});

describe('DASH health buckets (§1.3)', () => {
  it('AC-2: level 0 due in 30 h, or level −1 due in 23 h, is at risk; level −1 due in 25 h is on track', () => {
    assert.equal(healthOf(task({ level: 0, dueAt: NOW + 30 * H }), NOW), 'atRisk');
    assert.equal(healthOf(task({ level: -1, dueAt: NOW + 23 * H }), NOW), 'atRisk');
    assert.equal(healthOf(task({ level: -1, dueAt: NOW + 25 * H }), NOW), 'onTrack');
  });
  it('overdue wins over escalated; closed tasks are not counted', () => {
    const h = health([task({ overdue: true, level: 2 }), task({ level: 1 }), task({ status: 'completed', completedAt: NOW - H })], NOW);
    assert.deepEqual(h, { onTrack: 0, atRisk: 0, escalated: 1, overdue: 1 });
  });
});

describe('DASH attention rules (§1.4)', () => {
  const only = (t: DashTask) => attention([t], [], NOW, ME).map((a) => [a.severity, a.reason]);
  it('AC-3: overdue Normal at L1 → one high "Overdue"; at L2 → one critical item, never both', () => {
    assert.deepEqual(only(task({ overdue: true, level: 1, dueAt: NOW - 5 * H })), [['high', 'Overdue']]);
    assert.deepEqual(only(task({ overdue: true, level: 2, dueAt: NOW - 5 * H })), [['critical', 'Task overdue']]);
  });
  it('AC-4: next level in 119 min is a high item; in 121 min it is not', () => {
    assert.deepEqual(only(task({ next: { level: 1, at: NOW + 119 * MIN } })), [['high', 'Reaches L1 Team lead soon']]);
    assert.deepEqual(only(task({ next: { level: 1, at: NOW + 121 * MIN } })), []);
  });
  it('AC-5: unacknowledged and created 2 h 1 min ago → medium; 1 h 59 min → nothing', () => {
    assert.deepEqual(only(task({ acknowledgedAt: null, createdAt: NOW - 121 * MIN })), [['medium', 'Not acknowledged']]);
    assert.deepEqual(only(task({ acknowledgedAt: null, createdAt: NOW - 119 * MIN })), []);
  });
  it('a submitted task past due reads "Past due (in review)"; a review waiting > 24 h counts only for its reviewer', () => {
    assert.deepEqual(only(task({ status: 'submitted', dueAt: NOW - 3 * H })), [['medium', 'Past due (in review)']]);
    assert.deepEqual(only(task({ status: 'submitted', clockStartedAt: NOW - 25 * H, mayReview: true })), [['high', 'Review waiting > 24 h']]);
    assert.deepEqual(only(task({ status: 'submitted', clockStartedAt: NOW - 25 * H, mayReview: false })), []);
  });
  it('a pending extension is listed only when the viewer may decide it; sorted by severity then level', () => {
    const t = task();
    assert.equal(attention([t], [{ id: 9, taskId: t.id, at: NOW - 3 * H, mayDecide: false }], NOW, ME).length, 0);
    const items = attention([t, task({ overdue: true, level: 3 })], [{ id: 9, taskId: t.id, at: NOW - 3 * H, mayDecide: true }], NOW, ME);
    assert.deepEqual(items.map((i) => i.severity), ['critical', 'medium']);
  });
});

describe('DASH KPI tiles, trend and response (§1.2, §1.5, §1.9)', () => {
  it('completion is "—" with no tasks due in the range', () => {
    const k = kpis([task({ dueAt: NOW + 200 * H })], NOW, 30, '/tasks/team');
    assert.equal(k.find((x) => x.key === 'completion')!.value, '—');
  });
  it('compliance counts active tasks updated within their window', () => {
    const k = kpis([task({ silenceLevel: -1 }), task({ silenceLevel: 0 }), task({ status: 'submitted' })], NOW, 30, '/tasks/team');
    assert.equal(k.find((x) => x.key === 'compliance')!.value, '50%');
  });
  it('bucket counts: trend 7/10/13, response 7/6/13', () => {
    assert.deepEqual([7, 30, 90].map((r) => trend([], NOW, r as 7, 'UTC').length), [7, 10, 13]);
    assert.deepEqual([7, 30, 90].map((r) => escalationResponse([], NOW, r as 7, 'UTC').length), [7, 6, 13]);
  });
});

describe('DASH day boundaries in the viewer zone (AC-9, D-5)', () => {
  it('a task due 20:00 UTC is due today for London and tomorrow for Kolkata', () => {
    const due = Date.parse('2026-11-10T20:00:00Z');
    assert.ok(due < dayStart('Europe/London', NOW, 1));
    assert.ok(due >= dayStart('Asia/Kolkata', NOW, 1));
  });
  it('the heatmap places an update by the viewer zone', () => {
    const at = Date.parse('2026-11-09T23:30:00Z'); // Monday 23:30 UTC = Tuesday 05:00 IST
    assert.equal(activityHeatmap([at], NOW, 'UTC')[0]![7], 1);
    assert.equal(activityHeatmap([at], NOW, 'Asia/Kolkata')[1]![1], 1);
  });
});

describe('DASH layouts (D-8) and payload', () => {
  it('the highest-ranked role picks the layout', () => {
    assert.equal(layoutFor(['staff', 'lead']), 'lead');
    assert.equal(layoutFor(['manager', 'cos']), 'executive');
    assert.equal(layoutFor(['staff']), 'staff');
  });
  const input = (o: Partial<DashboardInput>): DashboardInput => ({
    layout: 'staff', now: NOW, range: 30, zone: 'UTC', viewerId: 2, overloadThreshold: 8, scope: [], extensions: [], events: [], progressAt: [],
    people: [], teams: [], entities: [], ...o,
  });
  it('the staff layout covers only the viewer’s own tasks and drops the critical tile', () => {
    const d = buildDashboard(input({ scope: [task({ assigneeId: 2, overdue: true }), task({ assigneeId: 3, overdue: true })] }));
    assert.equal(d.layout, 'staff');
    if (d.layout !== 'staff') return;
    assert.equal(d.myDay.overdue.count, 1);
    assert.ok(!d.kpis.some((k) => k.key === 'critical'));
  });
  it('the executive layout reports entities and drops medium attention items below L1', () => {
    const d = buildDashboard(input({ layout: 'executive', viewerId: ME, scope: [task({ acknowledgedAt: null, createdAt: NOW - 5 * H }), task({ overdue: true, level: 1 })], entities: [{ id: 'BAIS', name: 'BAIS' }], teams: [{ id: 1, name: 'Ops', entityId: 'BAIS' }] }));
    if (d.layout !== 'executive') return assert.fail('layout');
    assert.deepEqual(d.attention.map((a) => a.severity), ['high']);
    assert.deepEqual([d.entities[0]!.active, d.entities[0]!.overdue, d.entities[0]!.escalated], [2, 1, 1]);
  });
});

describe('TASK-10 stage', () => {
  it('AC-1: L1 amber, L2 red, −1 on track; closed and draft have none', () => {
    assert.deepEqual([taskStage('in_progress', 1), taskStage('blocked', 2), taskStage('assigned', -1)], ['amber', 'red', 'on_track']);
    assert.deepEqual([taskStage('completed', 2), taskStage('draft', -1)], [null, null]);
  });
});
