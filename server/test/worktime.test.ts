// ADR-0015 Task 1: one working-time clock (shared/worktime.ts). Pure, no database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { ALWAYS, makeWorkClock, scheduleOf, WALL_CLOCK, type Schedule } from '@taskwatch/shared/worktime';

const H = 3_600_000;
const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toMillis();
const IST = 'Asia/Kolkata';
const dayShift: Schedule = { zone: IST, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

describe('worktime', () => {
  it('counts only working hours: Fri 17:00 → Mon 10:00 is 2 h', () => {
    assert.equal(makeWorkClock(dayShift).elapsed(at('2026-11-13T17:00', IST), at('2026-11-16T10:00', IST)), 2 * H);
  });

  it('add skips nights and weekends: Fri 17:00 + 2 h = Mon 10:00', () => {
    assert.equal(makeWorkClock(dayShift).add(at('2026-11-13T17:00', IST), 2 * H), at('2026-11-16T10:00', IST));
  });

  it('an overnight schedule counts across midnight', () => {
    const night: Schedule = { zone: IST, days: [1, 2, 3, 4, 5], start: '20:00', end: '08:00' };
    // Tue 07:00–08:00 (Monday's shift) + Tue 20:00–21:00 (Tuesday's shift)
    assert.equal(makeWorkClock(night).elapsed(at('2026-11-17T07:00', IST), at('2026-11-17T21:00', IST)), 2 * H);
  });

  it('keeps 9 h per weekday across a DST change', () => {
    const la: Schedule = { zone: 'America/Los_Angeles', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
    // Fri 30 Oct + Mon 2 Nov; clocks fall back on Sun 1 Nov 2026
    assert.equal(makeWorkClock(la).elapsed(at('2026-10-30T00:00', la.zone), at('2026-11-03T00:00', la.zone)), 18 * H);
  });

  it('away time is not counted, and add steps over it', () => {
    const away = [{ from: at('2026-11-17T09:00', IST), to: at('2026-11-17T13:00', IST) }];
    const clock = makeWorkClock(dayShift, away);
    assert.equal(clock.elapsed(at('2026-11-17T09:00', IST), at('2026-11-17T18:00', IST)), 5 * H);
    assert.equal(clock.add(at('2026-11-17T09:00', IST), 1 * H), at('2026-11-17T14:00', IST));
  });

  it('ALWAYS and WALL_CLOCK equal plain clock time', () => {
    const [a, b] = [at('2026-11-13T17:00', IST), at('2026-11-16T10:00', IST)];
    assert.equal(makeWorkClock(ALWAYS).elapsed(a, b), b - a);
    assert.equal(makeWorkClock(ALWAYS).add(a, 5 * H), a + 5 * H);
    assert.equal(WALL_CLOCK.elapsed(a, b), b - a);
    assert.equal(WALL_CLOCK.add(a, 5 * H), a + 5 * H);
  });

  it('scheduleOf falls back to the organization and Mon–Fri', () => {
    const org = { timezone: IST, workdayStart: '09:00', workdayEnd: '18:00' };
    assert.deepEqual(scheduleOf({ timeZone: null, workDays: null, workStart: null, workEnd: null }, org), dayShift);
    assert.deepEqual(scheduleOf({ timeZone: 'UTC', workDays: [0, 6], workStart: '10:00', workEnd: '14:00' }, org), { zone: 'UTC', days: [0, 6], start: '10:00', end: '14:00' });
  });

  it('counts past 400 days (no silent cap)', () => {
    const from = at('2025-01-01T00:00', IST);
    const to = at('2026-06-01T00:00', IST);
    let weekdays = 0;
    for (let d = DateTime.fromMillis(from, { zone: IST }); d.toMillis() < to; d = d.plus({ days: 1 })) if (d.weekday <= 5) weekdays++;
    assert.equal(makeWorkClock(dayShift).elapsed(from, to), weekdays * 9 * H);
  });

  it('a 60-day span is cheap: 2000 elapsed + 2000 add under 1000 ms (uncached took ~2600 ms; reviewer I-3)', () => {
    const c = makeWorkClock(dayShift);
    const now = at('2026-11-23T10:00', IST);
    const from = now - 60 * 24 * H;
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      c.elapsed(from, now);
      c.add(from, 200 * H);
    }
    assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`);
  });
});
