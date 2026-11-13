// ADR-0014 / US-05: which task the floating countdown shows (pure, shared with the client).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextCountdown, outsideWorkingHours, overlaps, scheduleLabel } from '@taskwatch/shared/schedule';

const MIN = 60_000;
const NOW = Date.parse('2026-11-12T12:00:00Z');
const task = (id: string, dueInMin: number, status = 'in_progress' as const) => ({ id, title: `Task ${id}`, status, dueAt: NOW + dueInMin * MIN });

describe('nextCountdown (US-05, D-149)', () => {
  it('nothing to show', () => {
    assert.deepEqual(nextCountdown([], NOW), { primary: null, others: [] });
  });

  it('a task enters the countdown exactly 10 minutes before it is due', () => {
    assert.equal(nextCountdown([task('a', 11)], NOW).primary, null);
    const c = nextCountdown([task('a', 10)], NOW);
    assert.equal(c.primary?.id, 'a');
    assert.equal(c.primary?.msLeft, 10 * MIN);
    assert.equal(c.primary?.overdue, false);
  });

  it('submitted, closed and draft tasks never show', () => {
    for (const status of ['submitted', 'completed', 'cancelled', 'draft'] as const) {
      assert.equal(nextCountdown([{ ...task('a', 5), status }], NOW).primary, null, status);
    }
    assert.equal(nextCountdown([{ ...task('a', 5), status: 'blocked' as const }], NOW).primary?.id, 'a', 'blocked still counts down');
  });

  it('overdue first (the oldest), then the soonest; the rest are listed in that order', () => {
    const c = nextCountdown([task('soon', 5), task('late', -3), task('older', -30), task('later', 9)], NOW);
    assert.equal(c.primary?.id, 'older');
    assert.deepEqual(c.others.map((x) => x.id), ['late', 'soon', 'later']);
    assert.ok(c.primary!.overdue);
    assert.equal(c.primary!.msLeft, -30 * MIN);
  });
});

describe('schedule helpers (US-01, US-04, D-151)', () => {
  const H = 3_600_000;
  const at = (h: number) => NOW + h * H;

  it('overlaps: tasks whose windows intersect another one', () => {
    const r = overlaps([
      { id: 'a', start: at(10), end: at(11) },
      { id: 'b', start: at(10.5), end: at(12) },
      { id: 'c', start: at(13), end: at(14) },
    ]);
    assert.deepEqual([...r].sort(), ['a', 'b']);
  });

  it('overlaps: touching windows do not overlap; a task without a start counts as its last hour', () => {
    assert.equal(overlaps([{ id: 'a', start: at(10), end: at(11) }, { id: 'b', start: at(11), end: at(12) }]).size, 0);
    assert.deepEqual([...overlaps([{ id: 'a', start: null, end: at(11) }, { id: 'b', start: at(10.5), end: at(12) }])].sort(), ['a', 'b']);
  });

  it('outsideWorkingHours in the person’s own zone', () => {
    const kolkata = (hh: number) => Date.parse(`2026-11-12T${String(hh).padStart(2, '0')}:00:00+05:30`);
    assert.equal(outsideWorkingHours(kolkata(22), 'Asia/Kolkata', '09:00', '18:00'), true);
    assert.equal(outsideWorkingHours(kolkata(10), 'Asia/Kolkata', '09:00', '18:00'), false);
    assert.equal(outsideWorkingHours(kolkata(18), 'Asia/Kolkata', '09:00', '18:00'), true, 'the end is outside');
  });

  it('"Scheduled" until the start time, then the usual label', () => {
    assert.equal(scheduleLabel({ status: 'assigned', startAt: at(1) }, NOW), 'Scheduled');
    assert.equal(scheduleLabel({ status: 'assigned', startAt: at(-1) }, NOW), null);
    assert.equal(scheduleLabel({ status: 'in_progress', startAt: at(1) }, NOW), null);
    assert.equal(scheduleLabel({ status: 'assigned', startAt: null }, NOW), null);
  });
});
