import type pg from 'pg';
import * as clock from '../clock.js';
import { HOUR, MINUTE } from '../clock.js';
import { PRE_DEADLINE_WARNING_MINUTES, START_NOTICE_MINUTES } from '@taskwatch/shared/policy';
import { pool, tx } from '../db/pool.js';
import { LEVEL_LABELS, formatHours, ladderSql, type RulesConfig } from '../domain.js';
import { formatInZone } from '../notify/format.js';
import { escalationMessage, inAppNotice, type TaskInfo } from '../notify/messages.js';
import { notify } from '../notify/notify.js';
import { appendLog } from '../services/activity.js';
import { getDirectory, type Directory } from '../services/directory.js';
import { getRuleSet, type RuleSet } from '../services/rules.js';
import { awayIntervals, awayNow, clockFor } from '../services/worktime.js';
import { levelApplies, taskLevel, type LevelResult } from './levels.js';
import { founderOffice, routeEscalation } from './routing.js';

/**
 * R2 (D-145): the reviewer's manager, else the Founder's Office (the same fall-through as the ladder). A manager
 * marked away now (`away`) is passed over.
 */
function reviewerLine(dir: Directory, reviewerId: number, rules: RulesConfig, away: ReadonlySet<number>): number[] {
  const m = dir.get(reviewerId)?.managerId;
  const manager = m != null ? dir.get(m) : undefined;
  return manager?.active && !away.has(manager.id) ? [manager.id] : founderOffice(dir, rules).map((u) => u.id).filter((id) => id !== reviewerId);
}

/** An inactive reviewer, or one marked away now, cannot act: their line is told instead (L1 absent: straight to L2). */
const reviewerOut = (dir: Directory, reviewerId: number, away: ReadonlySet<number>) => !dir.get(reviewerId)?.active || away.has(reviewerId);

/** The people below the Founder's Office an escalation or review notice for this task may reach, for `awayNow`. */
const lineOf = (dir: Directory, assigneeId: number | null, reviewerId: number) =>
  [...(assigneeId ? dir.ancestors(assigneeId) : []), ...dir.ancestors(reviewerId), dir.get(reviewerId)].filter((u) => !!u);

interface ActiveEscalation {
  id: number;
  task_id: number;
  level: number;
  last_alert_at: Date;
  snooze_until: Date | null;
}

/** ESC-05: the repeat period, or 0 when repeats are off. */
const repeatEvery = (t: any, cfg: RulesConfig): number =>
  cfg.repeatAfterWindows > 0 ? cfg.repeatAfterWindows * cfg.windowsHours[t.priority as keyof RulesConfig['windowsHours']] * HOUR : 0;

function repeatDue(e: ActiveEscalation, t: any, cfg: RulesConfig, now: Date): boolean {
  const every = repeatEvery(t, cfg);
  if (!every) return false;
  if (e.snooze_until && now < e.snooze_until) return false; // the escalation was acknowledged
  if (t.snooze_until && now < t.snooze_until) return false; // WF-01-AC-2: the assignee acknowledged the task
  return now.getTime() - e.last_alert_at.getTime() >= every;
}

/** A repeat is stamped at the last whole-period boundary, so the cadence does not drift with engine timing (ESC-05). */
function repeatStamp(e: ActiveEscalation, every: number, now: Date): Date {
  const last = e.last_alert_at.getTime();
  return new Date(last + Math.floor((now.getTime() - last) / every) * every);
}

/** Limit a run to one organization, or one entity in it (a rules change re-evaluates only what it governs). */
export interface EngineScope {
  organizationId: number;
  entityId?: string;
}

/**
 * FR-8: evaluate every open task. Cheap in-memory pass first; a task is only locked and
 * written when its level changes, a level must fire or clear, or a repeat alert is due.
 * One task's failure is logged and does not stop the others (ESC-08-AC-3).
 */
export async function runEngine(scope?: EngineScope): Promise<{ checked: number; changed: number }> {
  const now = clock.now();
  const params: unknown[] = [];
  const where = [ladderSql('t')];
  if (scope) {
    params.push(scope.organizationId);
    where.push(`t.organization_id = $${params.length}`);
    if (scope.entityId) {
      params.push(scope.entityId);
      where.push(`t.entity_id = $${params.length}`);
    }
  }
  const { rows: tasks } = await pool.query(
    `select id, organization_id, entity_id, priority, status, due_at, deadline_l2_at, deadline_l3_at, start_at, assigned_at, clock_started_at, level, title, assignee_id, assigner_id, reviewer_id, snooze_until,
            (select r.submitted_at from reviews r where r.task_id = t.id and r.decision is null) as review_submitted_at,
            (select r.round from reviews r where r.task_id = t.id and r.decision is null) as review_round
       from tasks t where ${where.join(' and ')}`,
    params,
  );
  const { rows: active } = await pool.query<ActiveEscalation>(
    `select id, task_id, level, last_alert_at, snooze_until from escalations where cleared_at is null and task_id = any($1)`,
    [tasks.map((t) => t.id)],
  );
  const byTask = new Map<number, ActiveEscalation[]>();
  for (const e of active) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);

  // ADR-0015: each assignee's working time and away marks, loaded once per run.
  const dirs = new Map<number, Directory>();
  const sets = new Map<number, RuleSet>(); // one version check per organization per run, not one per task
  for (const org of new Set(tasks.map((t) => t.organization_id as number))) {
    dirs.set(org, await getDirectory(org));
    sets.set(org, await getRuleSet(org));
  }
  const assigneeOf = (t: { organization_id: number; assignee_id: number | null }) => (t.assignee_id ? dirs.get(t.organization_id)?.get(t.assignee_id) : undefined);
  const people = [...new Map(tasks.map((t) => assigneeOf(t)).filter((u) => !!u).map((u) => [u!.id, u!])).values()];
  const earliest = tasks.reduce((m, t) => Math.min(m, t.clock_started_at.getTime()), now.getTime());
  const away = await awayIntervals(pool, people, new Date(earliest), now);

  let changed = 0;
  for (const t of tasks) {
    const cfg = sets.get(t.organization_id)!.for(t.entity_id);
    const r = taskLevel(t, cfg, now, clockFor(assigneeOf(t), t.priority, away.get(t.assignee_id) ?? []))!; // the query selects only ladder statuses
    const act = byTask.get(t.id) ?? [];
    const activeLevels = new Set(act.map((e) => e.level));
    const needsWork =
      r.level !== t.level ||
      act.some((e) => !levelApplies(e.level, r)) ||
      [0, 1, 2, 3].some((k) => levelApplies(k, r) && !activeLevels.has(k)) ||
      act.some((e) => e.level === r.level && repeatDue(e, t, cfg, now));
    if (!needsWork) continue;
    try {
      await tx((c) => applyLevel(c, t.id, dirs.get(t.organization_id), sets.get(t.organization_id)));
      changed++;
    } catch (err) {
      console.error(`[engine] task ${t.id}`, err);
    }
  }
  await sendDueNotices(tasks, now, dirs, sets);
  return { checked: tasks.length, changed };
}

type NoticeJob = 'due_soon' | 'deadline_warning' | 'start_notice' | 'review_r1' | 'review_r2';

/**
 * The one-shot notices for the assignee, each sent once per due date (or start time); a new date re-arms it.
 * `job_runs` keys them by task and date, so many runs or two instances still send each once.
 * - ESC-07 / D-143: due-soon `dueSoonHours` before the due time, only when the task was assigned before that moment.
 * - US-05: the 10-minute pre-deadline warning, unless the work is submitted or the task was assigned inside the window
 *   (the assignment notice then says how long is left).
 * - D-144: the start notice 10 minutes before a scheduled start, while the task is still Open.
 * There is no separate overdue notice any more: L1 at the due time copies the assignee and the giver (ADR-0014 §9).
 */
export function noticesDue(
  t: { status: string; priority: string; due_at: Date; start_at: Date | null; assigned_at: Date; review_submitted_at?: Date | null },
  cfg: Pick<RulesConfig, 'dueSoonHours' | 'reviewSlaMinutes'>,
  now: Date,
): NoticeJob[] {
  const dueSoonHours = cfg.dueSoonHours;
  const n = now.getTime();
  const due = t.due_at.getTime();
  const assigned = t.assigned_at.getTime();
  const out: NoticeJob[] = [];
  const soon = due - dueSoonHours * HOUR;
  if (n >= soon && n < due && soon >= assigned) out.push('due_soon');
  const warn = due - PRE_DEADLINE_WARNING_MINUTES * MINUTE;
  if (n >= warn && n < due && warn >= assigned && t.status !== 'submitted') out.push('deadline_warning');
  if (t.start_at && t.status === 'assigned') {
    const start = t.start_at.getTime();
    const notice = start - START_NOTICE_MINUTES * MINUTE;
    if (n >= notice && n < start && notice >= assigned) out.push('start_notice');
  }
  // D-145: the reviewer's own deadline, from the pending round's submission: R1 at the SLA, R2 at twice the SLA.
  if (t.status === 'submitted' && t.review_submitted_at) {
    const sla = cfg.reviewSlaMinutes[t.priority as keyof RulesConfig['reviewSlaMinutes']] * MINUTE;
    const sub = t.review_submitted_at.getTime();
    if (n >= sub + sla) out.push('review_r1');
    if (n >= sub + 2 * sla) out.push('review_r2');
  }
  return out;
}

function noticeMessage(job: NoticeJob, t: any, zone: string, copied = false) {
  if (job === 'review_r1') return inAppNotice('review_r1', t.id, `Review overdue: “${t.title}”`, `“${t.title}” has been waiting for your review since ${formatInZone(t.review_submitted_at, zone)}.`);
  if (job === 'review_r2') {
    return inAppNotice('review_r2', t.id, `Review still pending: “${t.title}”`, `${copied ? 'Copied: ' : ''}“${t.title}” has been waiting for review since ${formatInZone(t.review_submitted_at, zone)}.`);
  }
  if (job === 'start_notice') return inAppNotice('start_notice', t.id, `Starts soon: “${t.title}”`, `“${t.title}” is scheduled to start ${formatInZone(t.start_at, zone)}.`);
  if (job === 'deadline_warning') return inAppNotice('deadline_warning', t.id, `10 minutes left: “${t.title}”`, `“${t.title}” is due ${formatInZone(t.due_at, zone)}. Submit it before then.`);
  return inAppNotice('due_soon', t.id, `Due soon: “${t.title}”`, `“${t.title}” is due ${formatInZone(t.due_at, zone)}.`);
}

async function sendDueNotices(tasks: any[], now: Date, dirs: Map<number, Directory>, sets: Map<number, RuleSet>): Promise<void> {
  const candidates: { t: any; job: NoticeJob; key: string }[] = [];
  for (const t of tasks) {
    const cfg = sets.get(t.organization_id)!.for(t.entity_id);
    for (const job of noticesDue(t, cfg, now)) {
      const at = job === 'start_notice' ? t.start_at.toISOString() : job.startsWith('review_') ? `r${t.review_round}` : t.due_at.toISOString();
      candidates.push({ t, job, key: `${t.id}@${at}` });
    }
  }
  if (!candidates.length) return;
  const { rows } = await pool.query<{ job: string; run_key: string }>(
    `select job, run_key from job_runs where job in ('due_soon', 'overdue') and run_key = any($1)`,
    [candidates.map((x) => x.key)],
  );
  const sent = new Set(rows.map((r) => `${r.job}|${r.run_key}`));
  for (const { t, job, key } of candidates) {
    if (sent.has(`${job}|${key}`)) continue;
    try {
      await tx(async (c) => {
        const { rowCount } = await c.query(`insert into job_runs (job, run_key, ran_at) values ($1, $2, $3) on conflict do nothing`, [job, key, now]);
        if (!rowCount) return; // already sent (another instance)
        const dir = dirs.get(t.organization_id)!;
        const rules = sets.get(t.organization_id)!.for(t.entity_id);
        const reviewer = t.reviewer_id ?? t.assigner_id;
        const away = job.startsWith('review_') ? await awayNow(c, lineOf(dir, null, reviewer), now) : new Set<number>();
        // R1 goes to the reviewer, unless they are inactive or away: then straight to their line, as R2 does.
        const line = () => [...reviewerLine(dir, reviewer, rules, away).map((userId) => ({ userId })), { userId: reviewer, copied: true }];
        const to =
          job === 'review_r1'
            ? reviewerOut(dir, reviewer, away) ? line() : [{ userId: reviewer }]
            : job === 'review_r2'
              ? line()
              : [{ userId: t.assignee_id }];
        await notify(c, dir, rules, to, (u, copied) => noticeMessage(job, t, u.timeZone, copied));
      });
    } catch (err) {
      console.error(`[engine] ${job} notice for task ${t.id}`, err);
    }
  }
}

/**
 * Bring one task's escalations in line with the rules. Call inside a transaction; it locks
 * the task row. Used by the engine and right after anything that moves the clock.
 */
export async function applyLevel(c: pg.PoolClient, taskId: number, dirArg?: Directory, setArg?: RuleSet): Promise<LevelResult | null> {
  const now = clock.now();
  const { rows } = await c.query(
    `select t.*, e.name as entity_name from tasks t join entities e on e.id = t.entity_id where t.id = $1 for update of t`,
    [taskId],
  );
  const t = rows[0];
  if (!t) return null;
  const { rows: act } = await c.query<ActiveEscalation>(
    `select id, task_id, level, last_alert_at, snooze_until from escalations where task_id = $1 and cleared_at is null order by level`,
    [taskId],
  );

  const rules = (setArg ?? (await getRuleSet(t.organization_id))).for(t.entity_id);
  const dir = dirArg ?? (await getDirectory(t.organization_id));
  const worker = t.assignee_id ? dir.get(t.assignee_id) : undefined;
  const away = worker ? ((await awayIntervals(c, [worker], t.clock_started_at, now)).get(worker.id) ?? []) : [];
  const r = taskLevel(t, rules, now, clockFor(worker, t.priority, away));
  if (!r) {
    if (act.length) await c.query('update escalations set cleared_at = $2 where task_id = $1 and cleared_at is null', [taskId, now]);
    if (t.level !== -1) await c.query('update tasks set level = -1, level_reason = null where id = $1', [taskId]);
    return null;
  }

  const { rows: pending } = await c.query<{ submitted_at: Date }>('select submitted_at from reviews where task_id = $1 and decision is null', [taskId]);
  const reviewSubmittedAt = pending[0]?.submitted_at ?? null;
  const info: TaskInfo = { id: t.id, title: t.title, priority: t.priority, dueAt: t.due_at, entityName: t.entity_name };
  const assignee = dir.must(t.assignee_id);

  // Drop levels whose conditions no longer hold, so they can fire again later.
  const cleared = act.filter((e) => !levelApplies(e.level, r));
  if (cleared.length) {
    await c.query('update escalations set cleared_at = $2 where id = any($1)', [cleared.map((e) => e.id), now]);
  }
  if (r.level < t.level) {
    await appendLog(
      c,
      {
        taskId,
        actorId: null,
        kind: 'deescalation',
        body: r.level < 0 ? 'Back on track' : `Dropped back to ${LEVEL_LABELS[r.level]}`,
        before: { level: t.level },
        after: { level: r.level },
      },
      now,
    );
  }

  // Fire each applicable level that has not fired in this climb.
  const activeLevels = new Set(act.filter((e) => !cleared.includes(e)).map((e) => e.level));
  const toFire = [0, 1, 2, 3].filter((k) => levelApplies(k, r) && !activeLevels.has(k));
  const reviewer = t.reviewer_id ?? t.assigner_id;
  // Whoever is marked away now is passed over like a missing role: an absent L1 sends the escalation to L2.
  const outNow = toFire.length ? await awayNow(c, lineOf(dir, t.assignee_id, reviewer), now) : new Set<number>();
  for (const k of toFire) {
    const reason = k === 0 ? 'silence' : r.overdueLevel >= k ? 'overdue' : r.silenceLevel >= k ? 'silence' : 'blocked';
    const route = routeEscalation(dir, t.assignee_id, k, rules, outNow);
    // D-145: handed in on time and waiting for review, the delay is the reviewer's: they are told, and it is theirs.
    // A reviewer who is inactive or away cannot act, so their line is told instead (the delay stays the reviewer's).
    const accountable = t.status === 'submitted' && reviewSubmittedAt && reviewSubmittedAt.getTime() <= t.due_at.getTime() ? 'reviewer' : 'assignee';
    if (accountable === 'reviewer') {
      const targets = reviewerOut(dir, reviewer, outNow) ? reviewerLine(dir, reviewer, rules, outNow) : [reviewer];
      route.cc = route.cc.filter((id) => !targets.includes(id));
      for (const id of targets) if (!route.to.includes(id)) route.to.push(id);
    }
    if (k >= 1) {
      // ADR-0014 §9: from L1 up the giver is copied (this replaces the separate overdue notice), and so are the
      // vertical's extra recipients for that level (D-142). Nobody is both to and cc, and the assignee is already copied.
      const extra = [t.assigner_id, ...rules.extraRecipients[`l${k}` as 'l1' | 'l2' | 'l3']];
      for (const id of extra) if (id !== t.assignee_id && !route.to.includes(id) && !route.cc.includes(id) && dir.get(id)?.active) route.cc.push(id);
    }
    // reached_at: when the threshold was crossed (BR-25), never later than now; cycle: the clock start it belongs to.
    const reachedAt = new Date(Math.min(r.reachedAt[k]!, now.getTime()));
    const { rows: ins } = await c.query<{ id: number }>(
      `insert into escalations (task_id, level, reason, assignee_id, fired_at, last_alert_at, organization_id, reached_at, cycle_started_at, accountable)
       values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9) returning id`,
      [taskId, k, reason, t.assignee_id, now, t.organization_id, reachedAt, t.clock_started_at, accountable],
    );
    const escalationId = ins[0]!.id;
    for (const id of route.to) {
      await c.query(`insert into escalation_recipients (escalation_id, user_id, kind) values ($1,$2,'to')`, [escalationId, id]);
    }
    for (const id of route.cc) {
      await c.query(`insert into escalation_recipients (escalation_id, user_id, kind) values ($1,$2,'cc')`, [escalationId, id]);
    }
    const why =
      reason === 'overdue'
        ? `past due${r.overdueHours >= 1 ? ` by ${formatHours(r.overdueHours)}` : ''}`
        : reason === 'blocked'
          ? 'marked Blocked'
          : `no assignee update for ${formatHours(r.silentHours)}`;
    await appendLog(
      c,
      {
        taskId,
        actorId: null,
        kind: 'escalation',
        body: `${k === 0 ? 'Reminder' : 'Escalated'}: ${LEVEL_LABELS[k]} — ${why}`,
        after: {
          level: k,
          reason,
          to: route.to.map((id) => ({ id, name: dir.get(id)?.name })),
          cc: route.cc.map((id) => ({ id, name: dir.get(id)?.name })),
        },
      },
      now,
    );
    // A Blocked L1 is announced by the block action itself (with its reason, per blockedAlertsLead); not twice.
    if (reason === 'blocked') continue;
    await notify(
      c,
      dir,
      rules,
      [...route.to.map((userId) => ({ userId })), ...route.cc.map((userId) => ({ userId, copied: true }))],
      (_u, copied) => ({ ...escalationMessage(k, info, assignee, r, copied), escalationId }),
    );
  }

  // Repeat alerts for the top level until acknowledged (an acknowledgement snoozes them).
  const top = act.find((e) => e.level === r.level && !cleared.includes(e));
  if (top && repeatDue(top, t, rules, now)) {
    const { rows: to } = await c.query<{ user_id: number }>(
      `select user_id from escalation_recipients where escalation_id = $1 and kind = 'to'`,
      [top.id],
    );
    await c.query('update escalations set last_alert_at = $2 where id = $1', [top.id, repeatStamp(top, repeatEvery(t, rules), now)]);
    await notify(
      c,
      dir,
      rules,
      to.map((x) => ({ userId: x.user_id })),
      () => ({ ...escalationMessage(top.level, info, assignee, r, false, true), escalationId: top.id }),
    );
  }

  if (r.level !== t.level || r.reason !== t.level_reason) {
    await c.query('update tasks set level = $2, level_reason = $3 where id = $1', [taskId, r.level, r.reason]);
  }
  return r;
}
