// Pure tests for the performance formulas (PERFORMANCE-FRD §5; owner's worked examples, 2026-11-06).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { averageScore, baselineDue, isOnTime, isRatable, periodBounds, personScore, rankRows, shiftOf, taskOutcome, taskProgress, taskQuality, taskTimeliness, workingHours, workload, type ScoredTask } from '@taskwatch/shared/performance';
import { DEFAULT_STANDARD_TASKS, recommendedHours } from '@taskwatch/shared/standardTasks';

const H = 3_600_000;
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-12-01T00:00:00Z');
const NOW = new Date('2026-11-30T12:00:00Z');
const DUE = new Date('2026-11-10T12:00:00Z');

let seq = 0;
const task = (o: Partial<ScoredTask> = {}): ScoredTask => ({
  id: ++seq, status: 'completed', dueAt: DUE, completedAt: new Date(DUE.getTime() - H),
  target: null, achieved: null, outcomeScore: 100, qualityScore: null, reviewed: false,
  shortfallAccepted: null, reassignedAfterDue: false, scored: true, priority: 'normal', reworkCount: 0, submittedAt: null,
  estimatedHours: null, baselineDueAt: null, ...o,
});
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

describe('PERF outcome, timeliness, quality and score', () => {
  it('owner example O: 10/10, 40/50, 4/5 → 86.67', () => {
    const s = personScore([task({ target: 10, achieved: 10 }), task({ target: 50, achieved: 40 }), task({ target: 5, achieved: 4 })], FROM, TO, NOW);
    near(s.outcome, 86.667);
  });

  it('owner example T: 8 of 10 on time → 80', () => {
    const late = new Date(DUE.getTime() + H);
    const tasks = Array.from({ length: 10 }, (_, i) => task({ completedAt: i < 8 ? new Date(DUE.getTime() - H) : late }));
    assert.equal(personScore(tasks, FROM, TO, NOW).timeliness, 80);
  });

  it('D-173 Q: 0, 1 and 2 returns → 100, 60, 20 → 60; unreviewed tasks never count as 100; the typed rating is ignored', () => {
    const s = personScore([task({ reviewed: true, qualityScore: 10 }), task({ reviewed: true, reworkCount: 1 }), task({ reviewed: true, reworkCount: 2 }), task()], FROM, TO, NOW);
    assert.equal(s.quality, 60);
    assert.equal(taskQuality(task({ reviewed: true, reworkCount: 3 })), 0, 'three or more returns floor at 0');
    assert.equal(taskQuality(task()), null);
  });

  it('no quality reviews: the person is flagged', () => {
    const s = personScore([task({ target: 10, achieved: 8 })], FROM, TO, NOW);
    assert.ok(s.flags.includes('no_quality_reviews'));
  });

  it('Review Focus 1: achieved above target caps at 100; an open task past due with no achieved scores 0', () => {
    assert.equal(taskOutcome(task({ target: 100, achieved: 140 }), NOW), 100);
    assert.equal(taskOutcome(task({ status: 'in_progress', completedAt: null, target: 100, achieved: null }), NOW), 0);
    assert.equal(taskOutcome(task({ target: null, outcomeScore: null }), NOW), null, 'no number and not rated');
  });

  it('an accepted shortfall or delay is left out of outcome, timeliness and efficiency', () => {
    const late = new Date(DUE.getTime() + 5 * H);
    const s = personScore([task({ target: 10, achieved: 10 }), task({ target: 10, achieved: 5, completedAt: late, shortfallAccepted: true })], FROM, TO, NOW);
    assert.deepEqual([s.outcome, s.timeliness, s.efficiency], [100, 100, 100]);
  });

  it('Review Focus 5: a task reassigned after its due date is out of timeliness only', () => {
    const late = new Date(DUE.getTime() + 5 * H);
    const s = personScore([task({ target: 10, achieved: 10 }), task({ target: 10, achieved: 5, completedAt: late, reassignedAfterDue: true })], FROM, TO, NOW);
    assert.equal(s.timeliness, 100);
    near(s.outcome, 75);
  });

  it('an open task past its due date is late; one not yet due is not eligible', () => {
    assert.equal(isOnTime(task({ status: 'blocked', completedAt: null }), NOW), false);
    const notDue = task({ status: 'in_progress', completedAt: null, dueAt: new Date('2026-12-05T00:00:00Z') });
    assert.equal(personScore([notDue], FROM, new Date('2026-12-31T00:00:00Z'), NOW).eligible, 0);
  });

  it('cancelled, draft and pre-launch tasks are never scored', () => {
    const s = personScore([task({ status: 'cancelled' }), task({ status: 'draft' }), task({ scored: false })], FROM, TO, NOW);
    assert.equal(s.eligible, 0);
  });

  it('Review Focus 4: no eligible tasks → score null, not ranked', () => {
    const s = personScore([], FROM, TO, NOW);
    assert.deepEqual([s.score, s.ranked], [null, false]);
  });

  it('efficiency counts outcome only when on time, split by priority pressure', () => {
    const late = new Date(DUE.getTime() + H);
    const s = personScore([task({ target: 10, achieved: 10, priority: 'critical' }), task({ target: 10, achieved: 10, completedAt: late, priority: 'low' })], FROM, TO, NOW);
    assert.equal(s.efficiency, 50);
    assert.deepEqual(s.efficiencyByPressure, { high: 100, normal: 0 });
  });
});

describe('D-173: Performance score = 0.5·Outcome + 0.3·Quality + 0.2·Timeliness', () => {
  // Owner's blog example: 4 h estimate, 5 PM deadline, returned once, accepted at 7 PM (submitted 7 PM).
  const blog = (o: Partial<ScoredTask> = {}) =>
    task({ outcomeScore: 100, reviewed: true, reworkCount: 1, estimatedHours: 4, submittedAt: new Date(DUE.getTime() + 2 * H), completedAt: new Date(DUE.getTime() + 2 * H), ...o });

  it('owner blog example: O 100, Q 60, T 50 → 78', () => {
    const s = personScore([blog()], FROM, TO, NOW);
    assert.deepEqual([s.outcome, s.quality, s.timeliness], [100, 60, 50]);
    near(s.score, 78);
  });

  it('timeliness: on time 100; late graded by the estimate, floor 0; late without an estimate 0', () => {
    assert.equal(taskTimeliness(task(), NOW), 100);
    assert.equal(taskTimeliness(blog(), NOW), 50);
    assert.equal(taskTimeliness(blog({ estimatedHours: 1 }), NOW), 0);
    assert.equal(taskTimeliness(blog({ estimatedHours: null }), NOW), 0);
    assert.equal(taskTimeliness(task({ status: 'in_progress', completedAt: null, estimatedHours: 8, dueAt: new Date(NOW.getTime() - 2 * H) }), NOW), 75, 'open and past due: graded up to now');
  });

  it('fairness: the employee’s own extension still counts; the giver’s change resets the deadline', () => {
    const five = new Date(DUE.getTime()), seven = new Date(DUE.getTime() + 2 * H), nine = new Date(DUE.getTime() + 4 * H);
    assert.equal(baselineDue(five, [{ dueAt: seven, own: true }]).getTime(), five.getTime(), 'own extension: still measured from 5 PM');
    assert.equal(baselineDue(five, [{ dueAt: seven, own: false }]).getTime(), seven.getTime(), 'giver scope change: new deadline, no penalty');
    assert.equal(baselineDue(five, [{ dueAt: seven, own: true }, { dueAt: nine, own: false }]).getTime(), nine.getTime());
    assert.equal(baselineDue(five, [{ dueAt: seven, own: false }, { dueAt: nine, own: true }]).getTime(), seven.getTime());
    // Due moved to 7 PM by the employee's extension, delivered at 7 PM: on time for display, 50 for timeliness.
    const t = blog({ dueAt: seven, baselineDueAt: five });
    assert.equal(isOnTime(t, NOW), true);
    assert.equal(taskTimeliness(t, NOW), 50);
    assert.equal(taskTimeliness(blog({ dueAt: seven, baselineDueAt: seven }), NOW), 100, 'giver moved it: on time');
  });

  it('a part with no data is left out and the rest re-weighted; no outcome → no score', () => {
    const s = personScore([blog({ reviewed: false })], FROM, TO, NOW);
    assert.equal(s.quality, null);
    near(s.score, (100 * 0.5 + 50 * 0.2) / 0.7);
    assert.equal(personScore([task({ outcomeScore: null })], FROM, TO, NOW).score, null);
  });

  it('equal weights by default reproduce the owner example: (100 + 80 + 80) ÷ 3 = 86.67', () => {
    const tasks = [task({ target: 10, achieved: 10, priority: 'critical' }), task({ target: 50, achieved: 40 }), task({ target: 5, achieved: 4, priority: 'low' })];
    near(personScore(tasks, FROM, TO, NOW).outcome, 86.667);
    near(personScore(tasks, FROM, TO, NOW, { critical: 1, high: 1, normal: 1, low: 1 }).outcome, 86.667);
  });

  it('Σ(outcome × weight) ÷ Σ(weight), the weight coming from the task priority', () => {
    const tasks = [task({ target: 10, achieved: 10, priority: 'critical' }), task({ target: 50, achieved: 40 }), task({ target: 5, achieved: 4 })];
    near(personScore(tasks, FROM, TO, NOW, { critical: 3, high: 2, normal: 1, low: 1 }).outcome, (100 * 3 + 80 + 80) / 5);
  });

  it('an accepted shortfall leaves the denominator; a task without a target counts its rated outcome', () => {
    const w = { critical: 3, high: 2, normal: 1, low: 1 };
    const s = personScore([task({ target: 10, achieved: 10 }), task({ target: 10, achieved: 2, priority: 'critical', shortfallAccepted: true }), task({ outcomeScore: 70, priority: 'high' })], FROM, TO, NOW, w);
    near(s.outcome, (100 * 1 + 70 * 2) / 3);
  });
});

describe('PERF ranking', () => {
  it('fewer than 5 eligible tasks are not ranked; ties share a rank and the next rank skips', () => {
    const five = Array.from({ length: 5 }, () => task());
    assert.equal(personScore(five.slice(0, 4), FROM, TO, NOW).ranked, false);
    assert.equal(personScore(five, FROM, TO, NOW).ranked, true);
    const rows = rankRows([
      { name: 'B', score: 90, ranked: true },
      { name: 'A', score: 90, ranked: true },
      { name: 'C', score: 80, ranked: true },
      { name: 'D', score: 99, ranked: false },
    ]);
    assert.deepEqual(rows.map((r) => [r.name, r.rank]), [['A', 1], ['B', 1], ['C', 3], ['D', null]]);
  });
});

describe('PERF progress and periods', () => {
  it('progress: achieved ÷ target with a target, the reported % without, 100 when completed, none when cancelled', () => {
    assert.equal(taskProgress({ status: 'in_progress', target: 150, achieved: 70, progress: 0 }), 47);
    assert.equal(taskProgress({ status: 'in_progress', target: null, achieved: null, progress: 30 }), 30);
    assert.equal(taskProgress({ status: 'completed', target: 150, achieved: 70, progress: 0 }), 100);
    assert.equal(taskProgress({ status: 'cancelled', target: null, achieved: null, progress: 30 }), null);
  });

  it('Review Focus 2: a task due Sunday 23:30 IST belongs to that week (Mon–Sun) in the organization zone', () => {
    const sunday = new Date('2026-11-08T18:00:00Z'); // 23:30 IST
    const { from, to } = periodBounds('week', sunday, 'Asia/Kolkata');
    assert.equal(from.toISOString(), '2026-11-01T18:30:00.000Z'); // Mon 2 Nov 00:00 IST
    assert.equal(to.toISOString(), '2026-11-08T18:30:00.000Z'); // Mon 9 Nov 00:00 IST
    assert.ok(sunday >= from && sunday < to);
    const m = periodBounds('month', sunday, 'Asia/Kolkata');
    assert.equal(m.from.toISOString(), '2026-10-31T18:30:00.000Z');
    assert.equal(m.to.toISOString(), '2026-11-30T18:30:00.000Z');
  });
});

describe('PERF workload', () => {
  // Monday 2 Nov 2026, 10:00 IST; 09:00–18:00 = 9 h a day, 45 h over 5 working days (Mon–Fri).
  const opts = { now: new Date('2026-11-02T04:30:00Z'), zone: 'Asia/Kolkata', workdayStart: '09:00', workdayEnd: '18:00' };
  const open = (hours: number | null, dueDay: number, priority: ScoredTask['priority'] = 'normal', status: ScoredTask['status'] = 'in_progress') =>
    ({ status, dueAt: new Date(Date.UTC(2026, 10, dueDay, 10)), estimatedHours: hours, priority });

  it('load % = estimated hours due within 5 working days ÷ capacity; bands; critical share; no-estimate count', () => {
    const w = workload([open(10, 3, 'critical'), open(30, 6), open(null, 4), open(8, 20)], opts);
    assert.equal(w.capacityHours, 45);
    near(w.loadPercent, (40 / 45) * 100);
    assert.equal(w.band, 'normal');
    near(w.highShare, 25);
    assert.equal(w.noEstimate, 1);
    assert.equal(w.openHours, 48, 'all open estimated hours, any due date');
    assert.equal(workload([open(50, 3)], opts).band, 'overloaded');
    assert.equal(workload([open(10, 3)], opts).band, 'light');
  });

  it('counts overdue and blocked open tasks; closed tasks are not load', () => {
    const w = workload([open(2, 1, 'normal', 'blocked'), open(5, 3, 'normal', 'completed')], opts);
    assert.deepEqual([w.overdue, w.blocked, w.openHours], [1, 1, 2]);
  });
});

describe("PERF isRatable (the giver's Rate step)", () => {
  const base = { status: 'completed' as const, reviewRequired: false, scored: true, target: null, outcomeScore: null, shortfallReason: null, shortfallAccepted: null, blockedReason: null, dueAt: DUE };
  it('a finished unreviewed task without a target and no outcome score waits for a rating', () => {
    assert.equal(isRatable(base, NOW), true);
    assert.equal(isRatable({ ...base, outcomeScore: 80 }, NOW), false);
    assert.equal(isRatable({ ...base, reviewRequired: true }, NOW), false, 'rated in the review');
    assert.equal(isRatable({ ...base, scored: false }, NOW), false, 'pre-launch');
  });
  it('an undecided shortfall waits; a decided one does not', () => {
    const short = { ...base, target: 150, outcomeScore: null, shortfallReason: 'List ran out' };
    assert.equal(isRatable(short, NOW), true);
    assert.equal(isRatable({ ...short, shortfallAccepted: false }, NOW), false);
  });
  it('an open task past due with a block reason may be accepted; before the due date it may not', () => {
    const open = { ...base, status: 'blocked' as const, target: 10, blockedReason: 'CRM down' };
    assert.equal(isRatable(open, NOW), true);
    assert.equal(isRatable({ ...open, dueAt: new Date(NOW.getTime() + H) }, NOW), false);
  });
});

describe('PERF final review C1: a reviewed task is on time when it was submitted in time', () => {
  it('approval after the due date does not make the assignee late', () => {
    const t = task({ reviewed: true, qualityScore: 90, submittedAt: new Date(DUE.getTime() - H), completedAt: new Date(DUE.getTime() + 20 * H) });
    assert.equal(isOnTime(t, NOW), true);
  });
  it('a task waiting in review past its due date is on time if it was submitted before the due date', () => {
    const t = task({ status: 'submitted', completedAt: null, submittedAt: new Date(DUE.getTime() - H) });
    assert.equal(isOnTime(t, NOW), true);
    assert.equal(isOnTime({ ...t, submittedAt: new Date(DUE.getTime() + H) }, NOW), false, 'submitted late is late');
  });
});

describe('D-125: working hours and the standard-task catalog', () => {
  const NY = 'America/New_York';
  const IST = 'Asia/Kolkata';
  const day = { start: '09:00', end: '18:00' };
  const at = (iso: string) => new Date(iso);

  it('counts only the shift on weekdays: Mon 16:00 → Tue 11:00 New York is 2 + 2 = 4 h', () => {
    assert.equal(workingHours(at('2026-11-09T21:00:00Z'), at('2026-11-10T16:00:00Z'), NY, day), 4);
  });

  it('skips the weekend: Fri 17:00 → Mon 10:00 New York is 1 + 1 = 2 h', () => {
    assert.equal(workingHours(at('2026-11-13T22:00:00Z'), at('2026-11-16T15:00:00Z'), NY, day), 2);
  });

  it('a night shift (20:00–08:00) crosses midnight: Mon 19:00 → Tue 09:00 IST is 12 h', () => {
    assert.equal(workingHours(at('2026-11-09T13:30:00Z'), at('2026-11-10T03:30:00Z'), IST, { start: '20:00', end: '08:00' }), 12);
  });

  it('outside the shift, or a reversed range, counts nothing', () => {
    assert.equal(workingHours(at('2026-11-09T23:30:00Z'), at('2026-11-10T13:00:00Z'), NY, day), 0, '18:30 → 08:00');
    assert.equal(workingHours(at('2026-11-10T16:00:00Z'), at('2026-11-09T16:00:00Z'), NY, day), 0);
  });

  it('own quiet hours (D-105) give the shift; otherwise the organization workday', () => {
    assert.deepEqual(shiftOf({ quietStart: '08:00', quietEnd: '20:00' }, { workdayStart: '09:00', workdayEnd: '18:00' }), { start: '20:00', end: '08:00' });
    assert.deepEqual(shiftOf({ quietStart: null, quietEnd: null }, { workdayStart: '09:00', workdayEnd: '18:00' }), { start: '09:00', end: '18:00' });
    // Review fix: a day worker's do-not-disturb at night (22:00–07:00) is not a night shift.
    assert.deepEqual(shiftOf({ quietStart: '22:00', quietEnd: '07:00' }, { workdayStart: '09:00', workdayEnd: '18:00' }), { start: '09:00', end: '18:00' });
  });

  it('the catalog holds every PDF row, and the recommendation is the average scaled to the quantity', () => {
    assert.equal(DEFAULT_STANDARD_TASKS.length, 82);
    const calls = DEFAULT_STANDARD_TASKS.find((t) => t.name === '100 cold calls')!;
    assert.equal(recommendedHours(calls), 6.25, '(240 + 498) ÷ 2 = 369 min ≈ 6.15 h → 6.25');
    assert.equal(recommendedHours(calls, 50), 3);
    const post = DEFAULT_STANDARD_TASKS.find((t) => t.name === 'Social media post creation and upload')!;
    assert.equal(recommendedHours(post, 10), 10);
    assert.equal(recommendedHours(DEFAULT_STANDARD_TASKS.find((t) => t.name === 'CRM lead entry')!), 0.25, 'never under a quarter hour');
  });
});

describe('Leaderboard analytics', () => {
  it('a team average leaves out people without a score and rounds to one decimal', () => {
    assert.deepEqual(averageScore([100, 80, null, 86.67]), { average: 88.9, scored: 3 });
    assert.deepEqual(averageScore([null, null]), { average: null, scored: 0 });
  });
});
