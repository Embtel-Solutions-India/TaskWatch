import pg from 'pg';
import { config } from '../config.js';

// Return BIGINT/COUNT values as numbers (all our counts fit comfortably).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

/** Postgres advisory-lock keys, one per cross-instance singleton (T-1.17). */
export const LOCK_KEYS = { scheduler: 731_001, migrate: 731_002 } as const;

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
