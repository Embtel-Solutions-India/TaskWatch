// Pure tests for the shared recurrence rules (REC-04, D-9, D-45).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeRecurrence, occurrencesBetween, scheduleErrors, type RecurrenceRule } from '@taskwatch/shared/recurrence';

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({ frequency: 'daily', interval: 1, weekdays: [], startDate: '2026-01-01', endDate: null, ...r });

describe('REC-04 occurrence rules', () => {
  it('every N days counts from the start date and stops at the end date', () => {
    assert.deepEqual(occurrencesBetween(rule({ frequency: 'interval', interval: 3, endDate: '2026-01-08' }), '2025-12-30', '2026-01-31'), ['2026-01-01', '2026-01-04', '2026-01-07']);
  });

  it('REC-04-AC-3: weekly Mon+Thu every 2 weeks runs on weeks 0, 2, 4 only', () => {
    // 2026-01-05 is a Monday.
    const r = rule({ frequency: 'weekly', interval: 2, weekdays: [1, 4], startDate: '2026-01-05' });
    assert.deepEqual(occurrencesBetween(r, '2026-01-05', '2026-02-01'), ['2026-01-05', '2026-01-08', '2026-01-19', '2026-01-22']);
    assert.equal(describeRecurrence(r), 'Every 2 weeks on Mon, Thu');
  });

  it('REC-04-AC-4 / D-45: a monthly schedule from the 31st clamps to the month end', () => {
    const days = occurrencesBetween(rule({ frequency: 'monthly', startDate: '2026-01-31' }), '2026-01-01', '2026-04-30');
    assert.deepEqual(days, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    assert.ok(occurrencesBetween(rule({ frequency: 'monthly', startDate: '2028-01-31' }), '2028-02-01', '2028-02-29').includes('2028-02-29'), 'leap year');
  });

  it('REC-02 field rules carry the FRD messages', () => {
    const f = scheduleErrors({ ...rule({ frequency: 'weekly', interval: 0, startDate: '2026-02-01', endDate: '2026-01-01' }), title: 'abc', assigneeId: '', dueHour: 24 });
    assert.deepEqual(f, {
      title: 'Give the schedule a title of at least 4 characters.',
      assigneeId: 'Choose an assignee.',
      endDate: 'End date must be after the start date.',
      interval: 'Between 1 and 365.',
      weekdays: 'Pick at least one weekday.',
      dueHour: 'Between 0 and 23.',
    });
    assert.match(scheduleErrors({ ...rule({}), title: 'x'.repeat(128), assigneeId: 1, dueHour: 9 }).title ?? '', /under 128/, 'room for the " — YYYY-MM-DD" suffix');
  });
});
