// Pure tests for every escalation rule in FO-2026-OPS-01 (WP-3 deliverable).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, type Priority } from '../src/domain.js';
import { computeLevel, isQuietTime, levelApplies, quietEndsAt, silenceThresholds, taskLevel } from '../src/engine/levels.js';
import { routeEscalation } from '../src/engine/routing.js';
import * as shared from '@taskwatch/shared/levels';
import { makeWorkClock } from '@taskwatch/shared/worktime';
import { DateTime } from 'luxon';
import { DEFAULT_REVIEW_SLA, PRE_DEADLINE_WARNING_MINUTES, SHIP_DEADLINE_DELAYS, START_NOTICE_MINUTES, VERTICAL_FIELDS, deadlineMilestones, diffPolicy, legacyDelays, resolvePolicy } from '@taskwatch/shared/policy';
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
    work: { zone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
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

  it('a lead marked away now is passed over: L1 goes straight to the manager; an away manager to the Founder’s Office', () => {
    assert.deepEqual(routeEscalation(dir, 5, 1, DEFAULT_RULES, new Set([4])), { to: [3], cc: [5] });
    assert.deepEqual(routeEscalation(dir, 5, 2, DEFAULT_RULES, new Set([4])), { to: [3], cc: [5] });
    assert.deepEqual(routeEscalation(dir, 5, 2, DEFAULT_RULES, new Set([3])), { to: [2, 1], cc: [4, 5] });
  });
});

describe('ADR-0014 policy: milestones and field-level inheritance', () => {
  const t0 = T0.getTime();
  const MIN = 60_000;

  it('ship delays reproduce today: L1 at due, L2 +24 h, L3 +72 h for every priority', () => {
    for (const p of ['critical', 'high', 'normal', 'low'] as Priority[]) {
      assert.deepEqual(deadlineMilestones(t0, p, { deadlineDelaysMinutes: SHIP_DEADLINE_DELAYS }), [t0, t0 + 24 * H, t0 + 72 * H]);
    }
    assert.deepEqual(DEFAULT_RULES.deadlineDelaysMinutes, SHIP_DEADLINE_DELAYS);
  });

  it('per-priority delays: Critical 30 min / 2 h', () => {
    const delays = { ...SHIP_DEADLINE_DELAYS, critical: [30, 120] as [number, number] };
    assert.deepEqual(deadlineMilestones(t0, 'critical', { deadlineDelaysMinutes: delays }), [t0, t0 + 30 * MIN, t0 + 2 * H]);
    assert.deepEqual(deadlineMilestones(t0, 'high', { deadlineDelaysMinutes: delays }), [t0, t0 + 24 * H, t0 + 72 * H]);
  });

  it('a sparse layer changes only its own leaves', () => {
    const r = resolvePolicy(DEFAULT_RULES, { deadlineDelaysMinutes: { critical: [30, 120] } });
    assert.deepEqual(r.deadlineDelaysMinutes.critical, [30, 120]);
    assert.deepEqual(r.deadlineDelaysMinutes.high, [1440, 4320]);
    assert.deepEqual(r.windowsHours, DEFAULT_RULES.windowsHours);
    assert.deepEqual(DEFAULT_RULES.deadlineDelaysMinutes.critical, [1440, 4320], 'the base is not mutated');
  });

  it('a vertical leaf wins; a global change shows through un-overridden leaves and never overwrites a customisation', () => {
    const vertical = { deadlineDelaysMinutes: { critical: [30, 120] as [number, number] }, windowsHours: { high: 12 } };
    const org2 = { deadlineDelaysMinutes: { critical: [60, 240] as [number, number], low: [2880, 7200] as [number, number] }, windowsHours: { high: 20, low: 96 } };
    const r = resolvePolicy(DEFAULT_RULES, org2, vertical);
    assert.deepEqual(r.deadlineDelaysMinutes.critical, [30, 120], 'customised: kept');
    assert.deepEqual(r.deadlineDelaysMinutes.low, [2880, 7200], 'inherited: follows the new global value');
    assert.equal(r.windowsHours.high, 12);
    assert.equal(r.windowsHours.low, 96);
  });

  it('arrays and tuples are leaves; null and undefined layers are skipped', () => {
    const r = resolvePolicy(DEFAULT_RULES, null, { multiples: [1, 2, 3, 4] }, undefined, { extraRecipients: { l2: [6] } });
    assert.deepEqual(r.multiples, [1, 2, 3, 4]);
    assert.deepEqual(r.extraRecipients, { l1: [], l2: [6], l3: [] });
  });

  it('a stored default with offsets but no delays keeps its timings', () => {
    assert.deepEqual(legacyDelays([0, 24, 72]), SHIP_DEADLINE_DELAYS);
    assert.deepEqual(legacyDelays([0, 12, 48]).critical, [720, 2880]);
  });

  it('constants and defaults (D-152 review SLA; system warnings)', () => {
    assert.deepEqual(DEFAULT_REVIEW_SLA, { critical: 30, high: 240, normal: 1440, low: 2880 });
    assert.deepEqual(DEFAULT_RULES.reviewSlaMinutes, DEFAULT_REVIEW_SLA);
    assert.equal(PRE_DEADLINE_WARNING_MINUTES, 10);
    assert.equal(START_NOTICE_MINUTES, 10);
    assert.deepEqual([...VERTICAL_FIELDS], ['windowsHours', 'multiples', 'deadlineDelaysMinutes', 'reviewSlaMinutes', 'extraRecipients']);
  });
});

describe('ADR-0014 ladder: stored deadline milestones', () => {
  const MIN = 60_000;
  const due = at(10);
  const plus = (m: number) => new Date(due.getTime() + m * MIN);
  const stored: [Date, Date, Date] = [due, plus(30), plus(120)];

  it('progress never moves the deadline level', () => {
    const now = plus(31);
    const r = computeLevel({ priority: 'critical', clockStartedAt: now, dueAt: due, deadlineAt: stored }, DEFAULT_RULES, now);
    assert.equal(r.silenceLevel, -1, 'just updated: not silent');
    assert.equal(r.level, 2);
    assert.equal(r.reason, 'overdue');
  });

  it('stored milestones win over the rules; without them the rules give the milestones', () => {
    assert.equal(computeLevel({ priority: 'critical', clockStartedAt: plus(30), dueAt: due, deadlineAt: stored }, DEFAULT_RULES, plus(30)).level, 2);
    assert.equal(computeLevel({ priority: 'critical', clockStartedAt: plus(30), dueAt: due }, DEFAULT_RULES, plus(30)).level, 1, 'ship delays: L2 only at +24 h');
    assert.equal(computeLevel({ priority: 'critical', clockStartedAt: plus(120), dueAt: due, deadlineAt: stored }, DEFAULT_RULES, plus(120)).level, 3);
  });

  it('reachedAt and next come from the stored milestones', () => {
    const r = computeLevel({ priority: 'low', clockStartedAt: due, dueAt: due, deadlineAt: stored }, DEFAULT_RULES, plus(1));
    assert.equal(r.reachedAt[1], due.getTime());
    assert.equal(r.reachedAt[2], plus(30).getTime());
    assert.equal(r.reachedAt[3], plus(120).getTime());
    assert.deepEqual(r.next, { level: 2, at: plus(30) });
  });

  it('taskLevel reads the row’s milestones and falls back when they are null', () => {
    const row = { status: 'in_progress', priority: 'critical' as Priority, clock_started_at: plus(40), due_at: due };
    assert.equal(taskLevel({ ...row, deadline_l2_at: plus(30), deadline_l3_at: plus(120) }, DEFAULT_RULES, plus(40))!.level, 2);
    assert.equal(taskLevel({ ...row, deadline_l2_at: null, deadline_l3_at: null }, DEFAULT_RULES, plus(40))!.level, 1);
  });
});

describe('ADR-0014 rules saved before the change (no deadline delays)', () => {
  const { deadlineDelaysMinutes: _drop, ...old } = DEFAULT_RULES;
  const due = at(10);

  it('the ladder uses the stored past-due offsets instead of crashing', () => {
    const rules = { ...old, overdueOffsetsHours: [0, 12, 48] as [number, number, number] } as unknown as typeof DEFAULT_RULES;
    assert.equal(shared.computeLevel({ priority: 'normal', clockStartedAt: at(22).getTime(), dueAt: due.getTime() }, rules, at(22).getTime()).level, 2, 'L2 at due + 12 h');
  });

  it('with neither delays nor offsets, the shipped delays apply', () => {
    const { overdueOffsetsHours: _o, ...bare } = old;
    const rules = bare as unknown as typeof DEFAULT_RULES;
    assert.equal(shared.computeLevel({ priority: 'normal', clockStartedAt: at(34).getTime(), dueAt: due.getTime() }, rules, at(34).getTime()).level, 2, 'L2 at due + 24 h');
  });
});

describe('ADR-0014 diffPolicy: what a vertical stores', () => {
  it('only the leaves that differ from the global policy, for vertical fields only', () => {
    const edited = {
      ...DEFAULT_RULES,
      windowsHours: { ...DEFAULT_RULES.windowsHours, critical: 2 },
      deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, high: [240, 1440] as [number, number] },
      extraRecipients: { l1: [], l2: [7], l3: [] },
      quietHours: { enabled: false, start: '22:00', end: '07:00' },
    };
    assert.deepEqual(diffPolicy(edited, DEFAULT_RULES), {
      windowsHours: { critical: 2 },
      deadlineDelaysMinutes: { high: [240, 1440] },
      extraRecipients: { l2: [7] },
    });
  });

  it('nothing changed: an empty object (the vertical inherits everything)', () => {
    assert.deepEqual(diffPolicy(DEFAULT_RULES, DEFAULT_RULES), {});
  });

  it('a tuple that changed is stored whole', () => {
    assert.deepEqual(diffPolicy({ ...DEFAULT_RULES, multiples: [1, 2, 3, 4] }, DEFAULT_RULES), { multiples: [1, 2, 3, 4] });
  });
});

describe('D-160 working-time ladder (ADR-0015)', () => {
  const IST = 'Asia/Kolkata';
  const at = (iso: string) => DateTime.fromISO(iso, { zone: IST }).toMillis();
  const dayShift = makeWorkClock({ zone: IST, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
  const far = at('2026-12-31T00:00'); // due well after: only silence matters

  it('a Normal task does not climb over the weekend', () => {
    const r = shared.computeLevel({ priority: 'normal', clockStartedAt: at('2026-11-13T17:00'), dueAt: far, silenceClock: dayShift }, DEFAULT_RULES, at('2026-11-16T08:59'));
    assert.equal(r.silenceLevel, -1);
  });

  it('a Critical task climbs over the weekend as today (wall clock)', () => {
    const r = shared.computeLevel({ priority: 'critical', clockStartedAt: at('2026-11-13T17:00'), dueAt: far }, DEFAULT_RULES, at('2026-11-16T08:59'));
    assert.equal(r.silenceLevel, 3);
  });

  it('silence reachedAt is counted in working time', () => {
    // Normal window 48 h: L0 after 48 working hours from Fri 17:00 (1 h Fri, then 9 h a day)
    const r = shared.computeLevel({ priority: 'normal', clockStartedAt: at('2026-11-13T17:00'), dueAt: far, silenceClock: dayShift }, DEFAULT_RULES, at('2026-11-16T09:00'));
    assert.equal(r.reachedAt[0], dayShift.add(at('2026-11-13T17:00'), 48 * 3_600_000));
  });

  it('L2 and L3 count working minutes after the due time', () => {
    const due = at('2026-11-13T17:00');
    const [l1, l2, l3] = deadlineMilestones(due, 'normal', { deadlineDelaysMinutes: SHIP_DEADLINE_DELAYS }, dayShift);
    assert.equal(l1, due);
    assert.equal(l2, dayShift.add(due, 1440 * 60_000));
    assert.equal(l3, dayShift.add(due, 4320 * 60_000));
    assert.ok(l2 > due + 1440 * 60_000, 'later than plain clock time');
  });
});
