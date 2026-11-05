import { DateTime } from 'luxon';
import * as clock from '../clock.js';
import { config } from '../config.js';
import type pg from 'pg';
import { LOCK_KEYS, pool, tx } from '../db/pool.js';
import { runEngine } from '../engine/engine.js';
import { dispatchDue } from '../notify/dispatcher.js';
import { systemAlertMessage } from '../notify/messages.js';
import { notify } from '../notify/notify.js';
import { verifyChains, type ChainResult } from '../services/activity.js';
import { verifyAdminChain } from '../services/audit.js';
import { maybeRunDigest } from '../services/digest.js';
import { getDirectory } from '../services/directory.js';
import { organizationIds } from '../services/organizations.js';
import { runRecurring } from '../services/recurring.js';
import { getRuleSet } from '../services/rules.js';

/**
 * Verify every hash chain (task chains, each organization's admin chain, the platform chain), record the result,
 * and alert each affected organization's Chief of Staff about its own breaks only.
 */
export async function runChainCheck(trigger: 'nightly' | 'manual'): Promise<ChainResult> {
  const orgs = await organizationIds();
  const [tasks, platform, ...admins] = await Promise.all([verifyChains(), verifyAdminChain(null), ...orgs.map((o) => verifyAdminChain(o))]);
  const breaks = [...tasks.breaks, ...platform.breaks, ...admins.flatMap((a) => a.breaks)];
  const rowsChecked = tasks.rowsChecked + platform.rowsChecked + admins.reduce((n, a) => n + a.rowsChecked, 0);
  const result: ChainResult = { ok: breaks.length === 0, tasksChecked: tasks.tasksChecked, rowsChecked, breaks };
  await pool.query(
    `insert into chain_checks (ran_at, trigger, ok, tasks_checked, rows_checked, breaks) values ($1,$2,$3,$4,$5,$6)`,
    [clock.now(), trigger, result.ok, result.tasksChecked, result.rowsChecked, JSON.stringify(result.breaks)],
  );
  if (platform.breaks.length) console.error(`SECURITY: platform audit chain has ${platform.breaks.length} problem(s)`, platform.breaks);
  const taskBreakIds = [...new Set(tasks.breaks.map((b) => b.taskId))];
  const { rows: taskOrgs } = await pool.query<{ id: number; organization_id: number }>('select id, organization_id from tasks where id = any($1)', [taskBreakIds]);
  for (const [i, org] of orgs.entries()) {
    const taskIds = taskOrgs.filter((t) => t.organization_id === org).map((t) => `#${t.id}`);
    const adminBroken = admins[i]!.breaks.length > 0;
    if (!taskIds.length && !adminBroken) continue;
    const count = tasks.breaks.filter((b) => taskIds.includes(`#${b.taskId}`)).length + admins[i]!.breaks.length;
    const where = [taskIds.length ? `task(s) ${taskIds.join(', ')}` : '', adminBroken ? 'the admin audit log' : ''].filter(Boolean).join(' and ');
    const text = `The ${trigger} audit-log check found ${count} problem(s) in ${where}. A log row was changed or removed directly in the database. Open TaskWatch › Audit for details.`;
    const dir = await getDirectory(org);
    const rules = (await getRuleSet(org)).defaults;
    await tx((c) =>
      notify(
        c,
        dir,
        rules,
        dir.withRole('cos').map((u) => ({ userId: u.id })),
        () => systemAlertMessage('chain_break', 'TaskWatch audit-log integrity alert', text),
      ),
    );
  }
  return result;
}

async function maybeRunNightlyCheck(): Promise<void> {
  const local = DateTime.fromJSDate(clock.now(), { zone: config.nightlyTimeZone });
  if (local.hour < 2) return;
  const { rowCount } = await pool.query(
    `insert into job_runs (job, run_key, ran_at) values ('chain_check', $1, $2) on conflict do nothing`,
    [local.toISODate(), clock.now()],
  );
  if (rowCount) await runChainCheck('nightly');
}

let leader: pg.PoolClient | null = null;

/**
 * Only one instance runs the background jobs: whichever holds the scheduler advisory lock. The lock lives on
 * its own connection, so if that instance dies the lock is released and another one takes over on its next tick.
 * ponytail: keeps one pool connection checked out for the process lifetime (pool max 10 → 9 for requests).
 */
export async function isLeader(): Promise<boolean> {
  if (leader) return true;
  const c = await pool.connect();
  try {
    const { rows } = await c.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEYS.scheduler]);
    if (!rows[0].ok) {
      c.release();
      return false;
    }
  } catch (err) {
    c.release(true);
    throw err;
  }
  c.on('error', () => {
    if (leader === c) resignLeadership();
  });
  leader = c;
  return true;
}

/** Drops the lock by closing its connection, so another instance can lead. */
export function resignLeadership(): void {
  leader?.release(true);
  leader = null;
}

function every(ms: number, name: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (await isLeader()) await fn();
    } catch (err) {
      console.error(`[${name}]`, err);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 1_000);
  return setInterval(tick, ms);
}

export function startScheduler(): () => void {
  const timers = [
    every(config.engineIntervalMs, 'engine', runEngine),
    every(config.dispatchIntervalMs, 'dispatcher', dispatchDue),
    every(60_000, 'recurring', runRecurring),
    every(60_000, 'digest', maybeRunDigest),
    every(60_000, 'chain-check', maybeRunNightlyCheck),
  ];
  return () => {
    timers.forEach(clearInterval);
    resignLeadership();
  };
}
