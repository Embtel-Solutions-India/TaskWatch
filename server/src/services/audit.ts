import type pg from 'pg';
import * as clock from '../clock.js';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { chainHash, normalize, type ChainBreak } from './activity.js';

/**
 * The admin audit log is one hash chain per organization (T-1.9, S-11, ADR-0010), its head in organizations.audit_head,
 * plus one platform chain (organization null, head in app_state) for platform events. Heads are locked per write.
 */
const PLATFORM_HEAD_KEY = 'platform_log_head';

/** Read a chain head, locking it when `forUpdate`. */
async function readHead(db: Db, organizationId: number | null, forUpdate: boolean): Promise<{ seq: number; hash: string } | undefined> {
  const lock = forUpdate ? ' for update' : '';
  const { rows } =
    organizationId === null
      ? await db.query('select value from app_state where key = $1' + lock, [PLATFORM_HEAD_KEY])
      : await db.query('select audit_head as value from organizations where id = $1' + lock, [organizationId]);
  return rows[0]?.value;
}

export interface AuditEntry {
  actorId: number | null;
  kind: string;
  target?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string | null;
  targetType?: 'task' | 'user' | 'role' | 'policy' | 'settings' | 'team' | 'recurrence' | 'demo' | 'auth' | null;
  taskId?: number | null;
  source?: 'ui' | 'system' | 'demo';
  context?: string;
  /** Which chain. Omitted: the actor's organization. null: the platform chain. Required when there is no actor. */
  organizationId?: number | null;
}

interface AuditRow {
  seq: number;
  at: Date;
  actor_id: number | null;
  kind: string;
  target: string | null;
  before: unknown;
  after: unknown;
  note: string | null;
  target_type: string | null;
  task_id: number | null;
  source: string;
  context: string;
}

/** Everything that is hashed: every stored column except the chain fields themselves. */
const material = (r: AuditRow) => ({
  seq: r.seq,
  at: r.at.toISOString(),
  actorId: r.actor_id,
  kind: r.kind,
  target: r.target,
  before: r.before,
  after: r.after,
  note: r.note,
  targetType: r.target_type,
  taskId: r.task_id,
  source: r.source,
  context: r.context,
});

/**
 * Append one row to the admin audit chain. Pass the caller's transaction client so the audit row commits with
 * the change it records; without one, a transaction of its own is used. This is the only writer of admin_log
 * (a trigger rejects rows that are not on the chain).
 */
export async function appendAdmin(client: pg.PoolClient | null, e: AuditEntry, at: Date = clock.now()): Promise<void> {
  if (!client) return tx((c) => appendAdmin(c, e, at));
  let org = e.organizationId;
  if (org === undefined) {
    if (e.actorId === null) throw new Error('appendAdmin: an entry without an actor must name its organization');
    org = (await client.query<{ organization_id: number }>('select organization_id from users where id = $1', [e.actorId])).rows[0]!.organization_id;
  }
  const head = await readHead(client, org, true);
  if (!head) throw new Error('The audit chain head is missing; run the database migrations');
  const row: AuditRow = {
    seq: head.seq + 1,
    at,
    actor_id: e.actorId,
    kind: e.kind,
    target: e.target ?? null,
    before: normalize(e.before),
    after: normalize(e.after),
    note: e.note ?? null,
    target_type: e.targetType ?? null,
    task_id: e.taskId ?? null,
    source: e.source ?? 'ui',
    context: e.context ?? '',
  };
  const hash = chainHash(head.hash, material(row));
  const json = (v: unknown) => (v === null ? null : JSON.stringify(v));
  await client.query(
    `insert into admin_log (at, actor_id, kind, target, before, after, note, target_type, task_id, source, context, seq, prev_hash, hash, organization_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [row.at, row.actor_id, row.kind, row.target, json(row.before), json(row.after), row.note, row.target_type, row.task_id, row.source, row.context, row.seq, head.hash, hash, org],
  );
  const newHead = JSON.stringify({ seq: row.seq, hash });
  if (org === null) await client.query('update app_state set value = $2 where key = $1', [PLATFORM_HEAD_KEY, newHead]);
  else await client.query('update organizations set audit_head = $2 where id = $1', [org, newHead]);
}

/** Recompute one chain: every position present, every link intact, every row unchanged, head matching. */
export async function verifyAdminChain(organizationId: number | null, db: Db = pool): Promise<{ rowsChecked: number; breaks: ChainBreak[] }> {
  const [{ rows }, headValue] = await Promise.all([
    db.query<AuditRow & { prev_hash: string; hash: string }>(
      'select * from admin_log where seq is not null and organization_id is not distinct from $1 order by seq',
      [organizationId],
    ),
    readHead(db, organizationId, false),
  ]);
  const breaks: ChainBreak[] = [];
  const at = (seq: number | null, problem: string) => breaks.push({ log: 'admin', taskId: null, organizationId, seq, problem });
  let prev = '';
  let expectedSeq = 1;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (seq !== expectedSeq) at(seq, `Missing row(s): expected seq ${expectedSeq}, found ${seq}`);
    if (r.prev_hash !== prev) at(seq, 'Link to previous row does not match');
    if (chainHash(r.prev_hash, material({ ...r, seq })) !== r.hash) at(seq, 'Row contents were altered after it was written');
    prev = r.hash;
    expectedSeq = seq + 1;
  }
  const h = headValue;
  if (!h) at(null, 'The audit chain head is missing');
  else if (h.seq !== rows.length || h.hash !== prev) at(null, 'Chain head does not match the audit rows (rows removed or added)');
  return { rowsChecked: rows.length, breaks };
}
