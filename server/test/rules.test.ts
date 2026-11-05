// Pure tests for every escalation rule in FO-2026-OPS-01 (WP-3 deliverable).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, type Priority } from '../src/domain.js';
import { computeLevel, isQuietTime, levelApplies, quietEndsAt, silenceThresholds } from '../src/engine/levels.js';
import { routeEscalation } from '../src/engine/routing.js';
import * as shared from '@taskwatch/shared/levels';
import { Directory, type DirUser } from '../src/services/directory.js';

const H = 3_600_000;
const T0 = new Date('2026-11-02T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);
const farDue = at(10_000);

function level(priority: Priority, silentHours: number, dueAt = farDue, now = at(silentHours)) {
  return computeLevel({ priority, clockStartedAt: T0, dueAt }, DEFAULT_RULES, now);
}

describe('D2/D3 — silence ladder per priority', () => {
  const table: Record<Priority, number[]> = {
    critical: [4, 6, 8, 12],
    high: [24, 36, 48, 72],
    normal: [48, 72, 96, 144],
    low: [72, 108, 144, 216],
  };
  for (const [priority, hours] of Object.entries(table) as Array<[Priority, number[]]>) {
    it(`${priority}: thresholds are ${hours.join(' / ')} h`, () => {
      assert.deepEqual(silenceThresholds(priority, DEFAULT_RULES), hours);
      hours.forEach((h, k) => {
        assert.equal(level(priority, h - 0.01).level, k - 1, `just before L${k}`);
        assert.equal(level(priority, h).level, k, `at L${k}`);
      });
    });
  }

  it('acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h', () => {
    assert.equal(level('critical', 3.99).level, -1);
    assert.equal(level('critical', 4).level, 0);
    assert.equal(level('critical', 6).level, 1);
    assert.equal(level('critical', 8).level, 2);
    assert.equal(level('critical', 12).level, 3);
    assert.equal(level('critical', 500).level, 3, 'L3 is the top');
  });
});

describe('Past-due rules', () => {
  const due = at(10);
  it('reaches at least L1 at the due time, L2 at +24 h and L3 at +72 h', () => {
    // Clock started at T0 for a Low task, so silence alone stays below L0 until 72 h.
    assert.equal(computeLevel({ priority: 'low', clockStartedAt: at(9.99), dueAt: due }, DEFAULT_RULES, at(9.99)).level, -1);
    assert.equal(computeLevel({ priority: 'low', clockStartedAt: at(10), dueAt: due }, DEFAULT_RULES, at(10)).level, 1);
    assert.equal(computeLevel({ priority: 'low', clockStartedAt: at(34), dueAt: due }, DEFAULT_RULES, at(34)).level, 2);
    assert.equal(computeLevel({ priority: 'low', clockStartedAt: at(82), dueAt: due }, DEFAULT_RULES, at(82)).level, 3);
  });

  it('applies even when updates continue (clock just reset)', () => {
    const r = computeLevel({ priority: 'critical', clockStartedAt: at(40), dueAt: due }, DEFAULT_RULES, at(40));
    assert.equal(r.silenceLevel, -1);
    assert.equal(r.overdueLevel, 2);
    assert.equal(r.level, 2);
    assert.equal(r.reason, 'overdue');
  });

  it('a task sits at the highest level any rule gives it', () => {
    // 13 h silent on a Critical task (L3 by silence) that is only 1 h past due (L1).
    const r = computeLevel({ priority: 'critical', clockStartedAt: T0, dueAt: at(12) }, DEFAULT_RULES, at(13));
    assert.equal(r.level, 3);
    assert.equal(r.reason, 'silence');
  });

  it('extending the due date drops the past-due level', () => {
    const before = computeLevel({ priority: 'high', clockStartedAt: at(30), dueAt: at(5) }, DEFAULT_RULES, at(30));
    const after = computeLevel({ priority: 'high', clockStartedAt: at(30), dueAt: at(60) }, DEFAULT_RULES, at(30));
    assert.equal(before.level, 2);
    assert.equal(after.level, -1);
  });
});

describe('Level bookkeeping', () => {
  it('L0 applies only while the assignee is silent; L1+ whenever the task sits at or above', () => {
    const overdueOnly = computeLevel({ priority: 'critical', clockStartedAt: at(30), dueAt: at(5) }, DEFAULT_RULES, at(30));
    assert.equal(levelApplies(0, overdueOnly), false);
    assert.equal(levelApplies(1, overdueOnly), true);
    assert.equal(levelApplies(2, overdueOnly), true);
    assert.equal(levelApplies(3, overdueOnly), false);
  });

  it('predicts the next climb', () => {
    const r = level('critical', 5);
    assert.equal(r.level, 0);
    assert.deepEqual(r.next, { level: 1, at: at(6) });
    assert.equal(level('critical', 13).next, null);
  });

  it('honours edited windows and multiples (per-entity rules)', () => {
    const cfg = { ...DEFAULT_RULES, windowsHours: { ...DEFAULT_RULES.windowsHours, critical: 2 }, multiples: [1, 2, 3, 4] as [number, number, number, number] };
    assert.deepEqual(silenceThresholds('critical', cfg), [2, 4, 6, 8]);
    assert.equal(computeLevel({ priority: 'critical', clockStartedAt: T0, dueAt: farDue }, cfg, at(6)).level, 2);
  });
});

describe('D4 — quiet hours 21:00–08:00 in the recipient zone', () => {
  const { start, end } = DEFAULT_RULES.quietHours;
  // 2026-11-02 16:00 UTC = 21:30 IST = 08:00 PT
  const t = new Date('2026-11-02T16:00:00Z');
  it('is quiet in IST and not in PT at the same instant', () => {
    assert.equal(isQuietTime('Asia/Kolkata', t, start, end), true);
    assert.equal(isQuietTime('America/Los_Angeles', t, start, end), false);
  });
  it('boundaries: 20:59 not quiet, 21:00 quiet, 07:59 quiet, 08:00 not quiet', () => {
    const ist = (hhmm: string) => new Date(`2026-11-03T${hhmm}:00+05:30`);
    assert.equal(isQuietTime('Asia/Kolkata', ist('20:59'), start, end), false);
    assert.equal(isQuietTime('Asia/Kolkata', ist('21:00'), start, end), true);
    assert.equal(isQuietTime('Asia/Kolkata', ist('07:59'), start, end), true);
    assert.equal(isQuietTime('Asia/Kolkata', ist('08:00'), start, end), false);
  });
  it('held alerts are released at 08:00 local', () => {
    assert.equal(quietEndsAt('Asia/Kolkata', t, end).toISOString(), '2026-11-03T02:30:00.000Z');
    assert.equal(quietEndsAt('America/Los_Angeles', new Date('2026-11-03T06:00:00Z'), end).toISOString(), '2026-11-03T16:00:00.000Z');
  });
});

function user(id: number, roles: DirUser['roles'], managerId: number | null, extra: Partial<DirUser> = {}): DirUser {
  return {
    id,
    name: `U${id}`,
    email: `u${id}@example.com`,
    phone: null,
    whatsapp: null,
    title: null,
    entityId: 'X',
    roles,
    managerId,
    timeZone: 'Asia/Kolkata',
    quietStart: null,
    quietEnd: null,
    whatsappOptIn: true,
    active: true,
    teamId: null,
    organizationId: 1,
    ...extra,
  };
}

describe('D-24 / D-25 — Blocked and In review (T-5.1)', () => {
  it('D-24: Blocked puts the task at L1 at once, with reason "blocked"; L0 does not apply without silence', () => {
    const r = computeLevel({ priority: 'high', clockStartedAt: T0, dueAt: farDue, blocked: true }, DEFAULT_RULES, at(0));
    assert.equal(r.level, 1);
    assert.equal(r.reason, 'blocked');
    assert.ok(!levelApplies(0, r) && levelApplies(1, r) && !levelApplies(2, r));
    assert.equal(r.next?.level, 2, 'silence still climbs past L1 while blocked');
  });

  it('D-24: silence or past due above L1 wins over Blocked', () => {
    const silent = computeLevel({ priority: 'critical', clockStartedAt: T0, dueAt: farDue, blocked: true }, DEFAULT_RULES, at(8));
    assert.deepEqual([silent.level, silent.reason], [2, 'silence']);
    const late = computeLevel({ priority: 'high', clockStartedAt: at(30), dueAt: at(5), blocked: true }, DEFAULT_RULES, at(30));
    assert.deepEqual([late.level, late.reason], [2, 'overdue']);
  });

  it('D-25: In review pauses silence but keeps the past-due floor', () => {
    const quiet = computeLevel({ priority: 'critical', clockStartedAt: T0, dueAt: farDue, silencePaused: true }, DEFAULT_RULES, at(100));
    assert.equal(quiet.level, -1, 'no silence level while in review');
    assert.deepEqual(quiet.next, { level: 1, at: farDue }, 'the next climb is the due time, not a silence threshold');
    const late = computeLevel({ priority: 'critical', clockStartedAt: T0, dueAt: at(10), silencePaused: true }, DEFAULT_RULES, at(10 + 24));
    assert.deepEqual([late.level, late.reason, late.silenceLevel], [2, 'overdue', -1], 'WF-04-AC-3: the floor still applies');
    assert.equal(late.next?.level, 3);
    assert.equal(late.next?.at.getTime(), at(10 + 72).getTime());
  });
});

describe('POL-02 — the simulator and the engine run one ladder (T-5.8)', () => {
  it('POL-02-AC-1: for every priority × silence × past-due combination the client module equals the server engine', () => {
    for (const priority of ['critical', 'high', 'normal', 'low'] as const) {
      const w = DEFAULT_RULES.windowsHours[priority];
      for (const silent of [0, w, 1.5 * w, 2 * w, 3 * w]) {
        for (const overdue of [-1, 0, 24, 72]) {
          const t0 = at(1_000);
          const input = { priority, clockStartedAt: new Date(t0.getTime() - silent * H), dueAt: new Date(t0.getTime() - overdue * H) };
          const server = computeLevel(input, DEFAULT_RULES, t0);
          const client = shared.computeLevel({ priority, clockStartedAt: input.clockStartedAt.getTime(), dueAt: input.dueAt.getTime() }, DEFAULT_RULES, t0.getTime());
          assert.deepEqual([server.level, server.reason], [client.level, client.reason], `${priority} silent ${silent} h, overdue ${overdue} h`);
        }
      }
    }
  });
});

describe('Alert routing (reporting lines)', () => {
  // 1 CEO ← 2 CoS ← 3 manager ← 4 lead ← 5 staff;  2 ← 6 lead (no manager) ← 7 staff;  3 ← 8 staff (no lead)
  const base = [
    user(1, ['ceo'], null),
    user(2, ['cos'], 1),
    user(3, ['manager'], 2),
    user(4, ['lead'], 3),
    user(5, ['staff'], 4),
    user(6, ['lead'], 2),
    user(7, ['staff'], 6),
    user(8, ['staff'], 3),
  ];
  const dir = new Directory(base);

  it('L0 → assignee; L1 → team lead (assignee cc); L2 → manager (lead, assignee cc); L3 → CoS + CEO (manager cc)', () => {
    assert.deepEqual(routeEscalation(dir, 5, 0, DEFAULT_RULES), { to: [5], cc: [] });
    assert.deepEqual(routeEscalation(dir, 5, 1, DEFAULT_RULES), { to: [4], cc: [5] });
    assert.deepEqual(routeEscalation(dir, 5, 2, DEFAULT_RULES), { to: [3], cc: [4, 5] });
    assert.deepEqual(routeEscalation(dir, 5, 3, DEFAULT_RULES), { to: [2, 1], cc: [3] });
  });

  it('D7 off: L3 reaches only the Chief of Staff', () => {
    assert.deepEqual(routeEscalation(dir, 5, 3, { ...DEFAULT_RULES, l3NotifyCeo: false }), { to: [2], cc: [3] });
  });

  it('no manager above a lead: L2 falls through to the Founder’s Office, routed like L3 (D-28)', () => {
    assert.deepEqual(routeEscalation(dir, 7, 1, DEFAULT_RULES), { to: [6], cc: [7] });
    assert.deepEqual(routeEscalation(dir, 7, 2, DEFAULT_RULES), { to: [2, 1], cc: [6, 7] });
    assert.deepEqual(routeEscalation(dir, 7, 2, { ...DEFAULT_RULES, l3NotifyCeo: false }), { to: [2], cc: [6, 7] }, 'D7 off: Chief of Staff only');
  });

  it('ESC-04: a person holding lead and manager takes both levels; no one is both to and cc', () => {
    const d3 = new Directory([...base, user(10, ['lead', 'manager'], 2), user(11, ['staff'], 10)]);
    assert.deepEqual(routeEscalation(d3, 11, 1, DEFAULT_RULES), { to: [10], cc: [11] });
    assert.deepEqual(routeEscalation(d3, 11, 2, DEFAULT_RULES), { to: [10], cc: [11] });
  });

  it('no team lead: L1 goes to the manager', () => {
    assert.deepEqual(routeEscalation(dir, 8, 1, DEFAULT_RULES), { to: [3], cc: [8] });
  });

  it('a lead’s own task skips to the next level up', () => {
    assert.deepEqual(routeEscalation(dir, 4, 1, DEFAULT_RULES), { to: [3], cc: [4] });
  });

  it('archived people are skipped', () => {
    const d2 = new Directory(base.map((u) => (u.id === 4 ? { ...u, active: false } : u)));
    assert.deepEqual(routeEscalation(d2, 5, 1, DEFAULT_RULES), { to: [3], cc: [5] });
  });
});
