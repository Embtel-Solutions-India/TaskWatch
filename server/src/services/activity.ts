import crypto from 'node:crypto';
import type pg from 'pg';
import * as clock from '../clock.js';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

export type LogKind =
  | 'created'
  | 'update'
  | 'comment'
  | 'status'
  | 'due_change'
  | 'reassign'
  | 'escalation'
  | 'deescalation'
  | 'ack'
  // Written under the client's names from Phase 4 on (no legacy form to map).
  | 'assigned'
  | 'edited'
  | 'acknowledged'
  | 'review_submitted'
  | 'review_decided'
  | 'completed'
  | 'cancelled'
  | 'reopened'
  | 'extension_requested'
  | 'extension_decided'
  | 'comment_edited'
  | 'comment_deleted'
  | 'attachment_added'
  | 'attachment_removed';

/**
 * DATABASE_DESIGN §4.3: log rows are immutable and hashed, so rows keep the kind and status names they were written
 * with; the API shows them under the new names (T-4.0). The hash is over the stored values, so chains still verify.
 */
export const LEGACY_KIND: Record<string, string> = {
  update: 'progress',
  status: 'status_changed',
  reassign: 'reassigned',
  ack: 'escalation_acknowledged',
  escalation: 'escalated',
  due_change: 'due_changed',
};
const LEGACY_STATUS: Record<string, string> = { open: 'assigned', done: 'completed' };
export const presentKind = (kind: string): string => LEGACY_KIND[kind] ?? kind;
export function presentValues(v: unknown): unknown {
  if (!v || typeof v !== 'object' || !('status' in v)) return v;
  const s = (v as { status: unknown }).status;
  return typeof s === 'string' && s in LEGACY_STATUS ? { ...v, status: LEGACY_STATUS[s] } : v;
}

export interface LogEntry {
  taskId: number;
  actorId: number | null;
  kind: LogKind;
  body?: string | null;
  before?: unknown;
  after?: unknown;
}

/** JSON with object keys sorted at every depth, so jsonb round-trips hash identically. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function normalize(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** The one hashing rule for every evidence chain: sha256 over the previous hash and the row's canonical JSON. */
export function chainHash(prevHash: string, material: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(`${prevHash}\n${canonical(material)}`).digest('hex');
}

export function hashRow(
  prevHash: string,
  row: { taskId: number; seq: number; at: Date; actorId: number | null; kind: string; body: string | null; before: unknown; after: unknown },
): string {
  return chainHash(prevHash, {
    taskId: row.taskId,
    seq: row.seq,
    at: row.at.toISOString(),
    actorId: row.actorId,
    kind: row.kind,
    body: row.body,
    before: row.before,
    after: row.after,
  });
}

/**
 * Append one row to a task's evidence chain. The caller must hold the task row lock
 * (select ... for update) inside the same transaction so sequence numbers never race.
 */
export async function appendLog(client: pg.PoolClient, entry: LogEntry, at: Date = clock.now()): Promise<number> {
  const { rows } = await client.query<{ log_seq: number; log_head: string }>(
    'select log_seq, log_head from tasks where id = $1',
    [entry.taskId],
  );
  if (!rows[0]) throw new Error(`Task ${entry.taskId} not found`);
  const seq = rows[0].log_seq + 1;
  const prevHash = rows[0].log_head;
  const row = {
    taskId: entry.taskId,
    seq,
    at,
    actorId: entry.actorId,
    kind: entry.kind,
    body: entry.body ?? null,
    before: normalize(entry.before),
    after: normalize(entry.after),
  };
  const hash = hashRow(prevHash, row);
  const inserted = await client.query<{ id: number }>(
    `insert into activity_log (task_id, seq, at, actor_id, kind, body, before, after, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [row.taskId, seq, at, row.actorId, row.kind, row.body, JSON.stringify(row.before), JSON.stringify(row.after), prevHash, hash],
  );
  await client.query('update tasks set log_seq = $2, log_head = $3 where id = $1', [entry.taskId, seq, hash]);
  return inserted.rows[0]!.id;
}

export interface ChainBreak {
  /** Which chain: a task's activity log, or the global admin audit log (taskId null). */
  log: 'task' | 'admin';
  taskId: number | null;
  /** Admin chains: whose (null = the platform chain). Lets each organization see only its own breaks. */
  organizationId?: number | null;
  seq: number | null;
  problem: string;
}

export interface ChainResult {
  ok: boolean;
  tasksChecked: number;
  rowsChecked: number;
  breaks: ChainBreak[];
}

/** Recompute every hash for the given tasks (or all tasks) and compare with what is stored. */
export async function verifyChains(db: Db = pool, taskIds?: number[]): Promise<ChainResult> {
  const tasks = await db.query<{ id: number; log_seq: number; log_head: string }>(
    taskIds ? 'select id, log_seq, log_head from tasks where id = any($1) order by id' : 'select id, log_seq, log_head from tasks order by id',
    taskIds ? [taskIds] : [],
  );
  const logs = await db.query(
    taskIds
      ? 'select * from activity_log where task_id = any($1) order by task_id, seq'
      : 'select * from activity_log order by task_id, seq',
    taskIds ? [taskIds] : [],
  );
  const byTask = new Map<number, any[]>();
  for (const r of logs.rows) {
    const list = byTask.get(r.task_id) ?? [];
    list.push(r);
    byTask.set(r.task_id, list);
  }

  const breaks: ChainBreak[] = [];
  for (const t of tasks.rows) {
    const rows = byTask.get(t.id) ?? [];
    let prev = '';
    let expectedSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectedSeq) {
        breaks.push({ log: 'task', taskId: t.id, seq: r.seq, problem: `Missing row(s): expected seq ${expectedSeq}, found ${r.seq}` });
      }
      if (r.prev_hash !== prev) {
        breaks.push({ log: 'task', taskId: t.id, seq: r.seq, problem: 'Link to previous row does not match' });
      }
      const recomputed = hashRow(r.prev_hash, {
        taskId: r.task_id,
        seq: r.seq,
        at: r.at,
        actorId: r.actor_id,
        kind: r.kind,
        body: r.body,
        before: r.before,
        after: r.after,
      });
      if (recomputed !== r.hash) {
        breaks.push({ log: 'task', taskId: t.id, seq: r.seq, problem: 'Row contents were altered after it was written' });
      }
      prev = r.hash;
      expectedSeq = r.seq + 1;
    }
    if (rows.length !== t.log_seq || prev !== t.log_head) {
      breaks.push({ log: 'task', taskId: t.id, seq: null, problem: 'Chain head does not match the task record (rows removed or added)' });
    }
  }
  return { ok: breaks.length === 0, tasksChecked: tasks.rows.length, rowsChecked: logs.rows.length, breaks };
}
