// T-1.2 guard: the shared ladder replaced luxon with Intl for quiet-hour times. Compare it with a luxon
// reference every 15 minutes across both 2026 US DST changes (and IST, which has none).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { isQuietTime, quietEndsAt } from '@taskwatch/shared/levels';

/** The previous server implementation (luxon), kept here only as the oracle. */
function luxonQuietEndsAt(zone: string, now: number, end: string): number {
  const [h, m] = end.split(':').map(Number);
  const local = DateTime.fromMillis(now, { zone });
  let c = local.set({ hour: h!, minute: m!, second: 0, millisecond: 0 });
  if (c <= local) c = c.plus({ days: 1 });
  return c.toMillis();
}
function luxonIsQuiet(zone: string, now: number, start: string, end: string): boolean {
  const l = DateTime.fromMillis(now, { zone });
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const x = l.hour * 60 + l.minute;
  const [s, e] = [mins(start), mins(end)];
  return s < e ? x >= s && x < e : x >= s || x < e;
}

const windows: Array<[string, string]> = [
  ['America/Los_Angeles', '2026-03-06T00:00:00Z'], // spring forward 2026-03-08
  ['America/Los_Angeles', '2026-10-30T00:00:00Z'], // fall back 2026-11-01
  ['America/New_York', '2026-03-06T00:00:00Z'],
  ['Asia/Kolkata', '2026-03-06T00:00:00Z'],
];

describe('shared quiet hours match the luxon reference across DST', () => {
  for (const [zone, from] of windows) {
    it(`${zone} from ${from.slice(0, 10)}`, () => {
      const start = Date.parse(from);
      for (let t = start; t < start + 5 * 86_400_000; t += 15 * 60_000) {
        // 02:30 is excluded: on spring-forward day it does not exist, and luxon's set().plus() then skips a
        // day's 02:30 (see the explicit gap test below).
        for (const end of ['08:00', '07:30', '00:00', '23:30']) {
          assert.equal(quietEndsAt(zone, t, end), luxonQuietEndsAt(zone, t, end), `${zone} ${new Date(t).toISOString()} end ${end}`);
        }
        assert.equal(isQuietTime(zone, t, '21:00', '08:00'), luxonIsQuiet(zone, t, '21:00', '08:00'), `${zone} ${new Date(t).toISOString()}`);
      }
    });
  }

  it('an end time inside the spring-forward gap resolves to just after the gap, then to the next real one', () => {
    const z = 'America/New_York'; // 2026-03-08 02:00 EST jumps to 03:00 EDT (07:00Z)
    assert.equal(new Date(quietEndsAt(z, Date.parse('2026-03-08T06:00:00Z'), '02:30')).toISOString(), '2026-03-08T07:30:00.000Z', '01:00 EST → 03:30 EDT');
    assert.equal(new Date(quietEndsAt(z, Date.parse('2026-03-08T07:30:00Z'), '02:30')).toISOString(), '2026-03-09T06:30:00.000Z', '03:30 EDT → next day 02:30 EDT');
  });
});
