// Pure tests for the nine-report rules (REPORTS-FRD RPT-02) and their CSV columns (RPT-03).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashTask } from '@taskwatch/shared/insights';
import { buildReport, rangeBounds, REPORT_IDS, reportCsv, type ReportFilters, type ReportInput } from '@taskwatch/shared/reports';

const H = 3_600_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const F: ReportFilters = { from: '2026-11-01', to: '2026-11-10', teamId: '', userId: '', giverId: '', priority: '', status: '', level: '' };

let seq = 0;
const task = (o: Partial<DashTask> = {}): DashTask => ({
  id: ++seq, title: `Task ${seq}`, status: 'in_progress', priority: 'normal', assigneeId: 2, assigneeName: 'Asha', assignedBy: 1,
  teamId: 1, entityId: 'BAIS', createdAt: NOW - 48 * H, updatedAt: NOW - H, dueAt: NOW + 72 * H, completedAt: null,
  clockStartedAt: NOW - H, acknowledgedAt: null, level: -1, silenceLevel: -1, next: null, overdue: false, mayReview: false, ...o,
});
const input = (o: Partial<ReportInput> = {}): ReportInput => ({
  now: NOW, zone: 'UTC', scope: 'org', tasks: [], events: [], reviews: [], extensions: [], reassignments: [],
  teams: [{ id: 1, name: 'Ops' }],
  people: [{ id: 1, name: 'Giver', team: 'Ops', role: 'Manager' }, { id: 2, name: 'Asha', team: 'Ops', role: 'Staff' }],
  ...o,
});

describe('RPT-02 metrics', () => {
  it('AC-3: a task created before `from` and still open counts in Open now, not in Completion rate', () => {
    const r = buildReport(input({ tasks: [task({ createdAt: Date.parse('2026-10-01T00:00:00Z') }), task({ status: 'completed', completedAt: NOW - H })] }), F);
    assert.equal(r.summary.openNow, 1);
    assert.equal(r.summary.created, 1);
    assert.equal(r.summary.completionRate, 1);
    assert.equal(r.summary.onTimeRate, 1);
  });

  it('AC-4: an L0 event is not an escalation; an L1 event is', () => {
    const t = task();
    const r = buildReport(input({ tasks: [t], events: [{ taskId: t.id, level: 0, at: NOW - H, resolved: false }, { taskId: t.id, level: 1, at: NOW - H, resolved: true }] }), F);
    assert.equal(r.summary.escalations, 1);
    assert.deepEqual(r.escalationsByLevel.map((l) => [l.value, l.active]), [[1, 1], [1, 0], [0, 0], [0, 0]]);
    assert.equal(r.staffRows[0]!.escalations, 1);
  });

  it('compliance = active tasks inside the window ÷ active; empty range gives null rates', () => {
    const r = buildReport(input({ tasks: [task({ silenceLevel: -1 }), task({ silenceLevel: 0 }), task({ status: 'submitted', silenceLevel: 1 })] }), { ...F, from: '2026-11-09', to: '2026-11-09' });
    assert.equal(r.summary.compliance, 0.5);
    assert.equal(r.summary.openNow, 3);
    assert.equal(r.summary.completionRate, null);
  });

  it('filters: a person outside the data gives empty results; level "none" = on track', () => {
    assert.equal(buildReport(input({ tasks: [task()] }), { ...F, userId: '99' }).summary.openNow, 0);
    const r = buildReport(input({ tasks: [task(), task({ level: 1 })] }), { ...F, level: 'none' });
    assert.equal(r.summary.openNow, 1);
  });

  it('undecided reviews are not passed in; turnaround hours and sent-back rate', () => {
    const t = task();
    const r = buildReport(input({ tasks: [t], reviews: [{ taskId: t.id, round: 1, reviewer: 'Rev', decision: 'changes_requested', submittedAt: NOW - 10 * H, decidedAt: NOW - 4 * H }] }), F);
    assert.equal(r.summary.avgReviewHours, 6);
    assert.deepEqual(r.reviewers, [{ reviewer: 'Rev', reviews: 1, avgHours: 6, changesRate: 1 }]);
  });

  it('extension days are fractional; reassignments count per giver', () => {
    const t = task();
    const r = buildReport(
      input({
        tasks: [t],
        reassignments: [t.id, t.id],
        extensions: [{ id: 1, taskId: t.id, taskTitle: t.title, requester: 'Asha', decider: null, currentDue: NOW, requestedDue: NOW + 36 * H, at: NOW - H, reason: 'x', status: 'pending' }],
      }),
      F,
    );
    assert.equal(r.extensions[0]!.days, 1.5);
    assert.equal(r.extensions[0]!.decider, '—');
    assert.equal(r.giverRows[0]!.reassigned, 2);
  });
});

describe('RPT-02 date range in the viewer zone (D-5)', () => {
  it('from 00:00 to 23:59:59.999 local, for IST and PT', () => {
    const ist = rangeBounds({ from: '2026-11-05', to: '2026-11-05' }, 'Asia/Kolkata');
    assert.equal(new Date(ist.fromMs).toISOString(), '2026-11-04T18:30:00.000Z');
    assert.equal(new Date(ist.toMs).toISOString(), '2026-11-05T18:29:59.999Z');
    const pt = rangeBounds({ from: '2026-11-05', to: '2026-11-05' }, 'America/Los_Angeles');
    assert.equal(new Date(pt.fromMs).toISOString(), '2026-11-05T08:00:00.000Z');
    assert.equal(rangeBounds({ from: '', to: '' }, 'UTC').toMs, Infinity);
  });
});

describe('RPT-03 CSV columns', () => {
  it('every report has a header row; overdue due dates are in the viewer zone', () => {
    const r = buildReport(input({ tasks: [task({ overdue: true, dueAt: Date.parse('2026-11-09T20:00:00Z') })] }), F);
    for (const id of REPORT_IDS) assert.ok(reportCsv(id, r, 'UTC')[0]!.length >= 3, id);
    assert.deepEqual(reportCsv('overdue', r, 'Asia/Kolkata')[1]!.slice(4), ['2026-11-10 01:30', -1]);
  });
});
