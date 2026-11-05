// Audit log view (T-4.13; AUD-01, AUD-02, C-5). One read-only list over both append-only logs — admin_log (rules,
// directory, admin) and activity_log (task events) — for the caller's organization only. Nothing here writes a log row.
import * as clock from '../clock.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { runChainCheck } from '../jobs/scheduler.js';
import { LEGACY_KIND, presentValues, type ChainBreak } from './activity.js';
import type { DirUser } from './directory.js';
import { csvRows } from './exports.js';

export const AUDIT_SOURCES = ['ui', 'system', 'demo'] as const;
export const AUDIT_CAP = 500;

export interface AuditFilters {
  from?: Date;
  to?: Date;
  actorId?: number | 'system';
  /** A prefix such as `task.` or `staff.` */
  action?: string;
  teamId?: number;
  source?: (typeof AUDIT_SOURCES)[number];
  taskId?: number;
}

// Task events are shown as `task.<kind>` under the new kind names (DATABASE_DESIGN §4.3), so filters match what is shown.
const TASK_ACTION = `'task.' || case l.kind ${Object.entries(LEGACY_KIND).map(([k, v]) => `when '${k}' then '${v}'`).join(' ')} else l.kind end`;

/** AUD-01: newest first, filtered and capped on the server; `truncated` when the cap was hit. */
export async function listAudit(viewer: DirUser, f: AuditFilters) {
  const params: unknown[] = [viewer.organizationId];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (f.from) where.push(`x.at >= ${p(f.from)}`);
  if (f.to) where.push(`x.at < ${p(f.to)}`);
  if (f.actorId === 'system') where.push('x.actor_id is null');
  else if (f.actorId) where.push(`x.actor_id = ${p(f.actorId)}`);
  if (f.action) where.push(`x.action like ${p(`${f.action.replace(/[%_\\]/g, '\\$&')}%`)}`);
  if (f.teamId) where.push(`x.team_id = ${p(f.teamId)}`);
  if (f.source) where.push(`x.source = ${p(f.source)}`);
  if (f.taskId) where.push(`x.task_id = ${p(f.taskId)}`);
  const { rows } = await pool.query(
    `select x.* from (
       select 'a' || l.id as id, l.at, l.actor_id, u.name as actor_name, l.kind as action, l.target_type, l.target as target_id, l.task_id,
              l.before, l.after, l.note, l.source, l.context, null::int as team_id
         from admin_log l left join users u on u.id = l.actor_id
        where l.organization_id = $1
       union all
       select 't' || l.id, l.at, l.actor_id, u.name, ${TASK_ACTION}, 'task', l.task_id::text, l.task_id,
              l.before, l.after, l.body, case when l.actor_id is null then 'system' else 'ui' end, t.title, t.team_id
         from activity_log l join tasks t on t.id = l.task_id left join users u on u.id = l.actor_id
        where t.organization_id = $1
     ) x
     ${where.length ? `where ${where.join(' and ')}` : ''}
     order by x.at desc, x.id desc
     limit ${AUDIT_CAP + 1}`,
    params,
  );
  const items = rows.slice(0, AUDIT_CAP).map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    taskId: r.task_id,
    prev: presentValues(r.before),
    next: presentValues(r.after),
    note: r.note,
    source: r.source,
    context: r.context,
  }));
  return { items, truncated: rows.length > AUDIT_CAP };
}

/** AUD-01-AC-5: the same rows as CSV, formula-guarded. */
export async function auditCsv(viewer: DirUser, f: AuditFilters): Promise<string> {
  const { items } = await listAudit(viewer, f);
  const json = (v: unknown) => (v == null ? '' : JSON.stringify(v));
  return csvRows([
    ['Time (UTC)', 'Actor', 'Action', 'Target type', 'Target', 'Task', 'Before', 'After', 'Note', 'Source', 'Context'],
    ...items.map((i) => [new Date(i.at).toISOString(), i.actor?.name ?? 'System', i.action, i.targetType, i.targetId, i.taskId, json(i.prev), json(i.next), i.note, i.source, i.context]),
  ]);
}

/** Only the caller's organization's breaks: its tasks and its admin chain (never another organization's or the platform's). */
async function ownBreaks(viewer: DirUser, breaks: ChainBreak[]): Promise<ChainBreak[]> {
  const taskIds = breaks.filter((b) => b.log === 'task' && b.taskId).map((b) => b.taskId);
  const { rows } = await pool.query<{ id: number }>('select id from tasks where id = any($1) and organization_id = $2', [taskIds, viewer.organizationId]);
  const mine = new Set(rows.map((r) => r.id));
  return breaks.filter((b) => (b.log === 'task' ? mine.has(b.taskId!) : b.organizationId === viewer.organizationId));
}

/** AUD-02: past checks, each showing only this organization's breaks. */
export async function integrityChecks(viewer: DirUser) {
  const { rows } = await pool.query('select ran_at, trigger, breaks from chain_checks order by ran_at desc limit 20');
  return Promise.all(
    rows.map(async (r) => {
      const breaks = await ownBreaks(viewer, r.breaks);
      return { ranAt: r.ran_at, trigger: r.trigger, ok: breaks.length === 0, breaks };
    }),
  );
}

// ponytail: per-process throttle; with several instances use the job_runs table (one row per 5-minute slot).
let running = false;
let lastRun = 0;

/** AUD-02 manual run (D-16): one at a time, at most one per 5 minutes; answers with this organization's result. */
export async function runIntegrityCheck(viewer: DirUser) {
  const t = Date.now();
  if (running || t - lastRun < 5 * 60_000) throw new HttpError(429, 'An integrity check ran recently. Try again in a few minutes.', undefined, 300);
  running = true;
  lastRun = t;
  try {
    const result = await runChainCheck('manual');
    const breaks = await ownBreaks(viewer, result.breaks);
    return { ranAt: clock.now(), ok: breaks.length === 0, breaks };
  } finally {
    running = false;
  }
}

/** Test hook: the throttle is per process and would otherwise leak between tests. */
export const resetIntegrityThrottle = () => {
  lastRun = 0;
};
