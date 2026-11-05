// Organizations (ADR-0010). Requests take the organization from the signed-in user's row; jobs loop over these.
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

export async function organizationIds(db: Db = pool): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>('select id from organizations where active order by id');
  return rows.map((r) => r.id);
}

export async function getOrganization(id: number, db: Db = pool): Promise<{ id: number; name: string }> {
  const { rows } = await db.query<{ id: number; name: string }>('select id, name from organizations where id = $1', [id]);
  return rows[0]!;
}
