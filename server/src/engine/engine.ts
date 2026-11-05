import type pg from 'pg';
import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { pool, tx } from '../db/pool.js';
import { LEVEL_LABELS, formatHours, ladderSql, type RulesConfig } from '../domain.js';
import { formatInZone } from '../notify/format.js';
import { escalationMessage, inAppNotice, type TaskInfo } from '../notify/messages.js';
import { notify } from '../notify/notify.js';
import { appendLog } from '../services/activity.js';
import { getDirectory, type Directory } from '../services/directory.js';
import { getRuleSet } from '../services/rules.js';
import { levelApplies, taskLevel, type LevelResult } from './levels.js';
import { routeEscalation } from './routing.js';

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
  if (e.snooze_until && now < e.snooze_until) return false;
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
    `select id, organization_id, entity_id, priority, status, due_at, clock_started_at, level, title, assignee_id, assigner_id
       from tasks t where ${where.join(' and ')}`,
    params,
  );
  const { rows: active } = await pool.query<ActiveEscalation>(
    `select id, task_id, level, last_alert_at, snooze_until from escalations where cleared_at is null and task_id = any($1)`,
    [tasks.map((t) => t.id)],
  );
  const byTask = new Map<number, ActiveEscalation[]>();
  for (const e of active) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);

  let changed = 0;
  for (const t of tasks) {
    const cfg = (await getRuleSet(t.organization_id)).for(t.entity_id); // cached per organization
    const r = taskLevel(t, cfg, now)!; // the query selects only ladder statuses
    const act = byTask.get(t.id) ?? [];
    const activeLevels = new Set(act.map((e) => e.level));
    const needsWork =
      r.level !== t.level ||
      act.some((e) => !levelApplies(e.level, r)) ||
      [0, 1, 2, 3].some((k) => levelApplies(k, r) && !activeLevels.has(k)) ||
      act.some((e) => e.level === r.level && repeatDue(e, t, cfg, now));
    if (!needsWork) continue;
    try {
      await tx((c) => applyLevel(c, t.id));
      changed++;
    } catch (err) {
      console.error(`[engine] task ${t.id}`, err);
    }
  }
  await sendDueNotices(tasks, now);
  return { checked: tasks.length, changed };
}

/**
 * ESC-07: one due-soon notice (assignee) and one overdue notice (assignee and giver) per due date; a new due date
 * re-arms both. `job_runs` keys them by task and due date, so many runs or two instances still send each once.
 * In-app only: escalation L1 already reaches the lead and copies the assignee by email at the due time.
 */
async function sendDueNotices(tasks: any[], now: Date): Promise<void> {
  const candidates: { t: any; job: 'due_soon' | 'overdue'; key: string }[] = [];
  for (const t of tasks) {
    const cfg = (await getRuleSet(t.organization_id)).for(t.entity_id);
    const dueMs = t.due_at.getTime();
    const job = now.getTime() >= dueMs ? 'overdue' : now.getTime() >= dueMs - cfg.dueSoonHours * HOUR ? 'due_soon' : null;
    if (job) candidates.push({ t, job, key: `${t.id}@${t.due_at.toISOString()}` });
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
        const dir = await getDirectory(t.organization_id);
        const rules = (await getRuleSet(t.organization_id)).for(t.entity_id);
        const to = job === 'overdue' ? [...new Set<number>([t.assignee_id, t.assigner_id])] : [t.assignee_id];
        await notify(c, dir, rules, to.map((userId) => ({ userId })), (u) =>
          job === 'overdue'
            ? inAppNotice('overdue', t.id, `Past due: “${t.title}”`, `“${t.title}” was due ${formatInZone(t.due_at, u.timeZone)}.`)
            : inAppNotice('due_soon', t.id, `Due soon: “${t.title}”`, `“${t.title}” is due ${formatInZone(t.due_at, u.timeZone)}.`),
        );
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
export async function applyLevel(c: pg.PoolClient, taskId: number, dirArg?: Directory): Promise<LevelResult | null> {
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

  const rules = (await getRuleSet(t.organization_id)).for(t.entity_id);
  const r = taskLevel(t, rules, now);
  if (!r) {
    if (act.length) await c.query('update escalations set cleared_at = $2 where task_id = $1 and cleared_at is null', [taskId, now]);
    if (t.level !== -1) await c.query('update tasks set level = -1, level_reason = null where id = $1', [taskId]);
    return null;
  }

  const dir = dirArg ?? (await getDirectory(t.organization_id));
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
  for (let k = 0; k <= 3; k++) {
    if (!levelApplies(k, r) || activeLevels.has(k)) continue;
    const reason = k === 0 ? 'silence' : r.overdueLevel >= k ? 'overdue' : r.silenceLevel >= k ? 'silence' : 'blocked';
    const route = routeEscalation(dir, t.assignee_id, k, rules);
    // reached_at: when the threshold was crossed (BR-25), never later than now; cycle: the clock start it belongs to.
    const reachedAt = new Date(Math.min(r.reachedAt[k]!, now.getTime()));
    const { rows: ins } = await c.query<{ id: number }>(
      `insert into escalations (task_id, level, reason, assignee_id, fired_at, last_alert_at, organization_id, reached_at, cycle_started_at)
       values ($1,$2,$3,$4,$5,$5,$6,$7,$8) returning id`,
      [taskId, k, reason, t.assignee_id, now, t.organization_id, reachedAt, t.clock_started_at],
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
