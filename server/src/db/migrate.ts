import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_KEYS, pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Applies pending migrations. Instances starting together wait on one advisory lock, so they never race. */
export async function migrate(): Promise<string[]> {
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [LOCK_KEYS.migrate]);
    return await applyPending();
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [LOCK_KEYS.migrate]).catch(() => {});
    lock.release();
  }
}

async function applyPending(): Promise<string[]> {
  await pool.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const { rows } = await pool.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(name) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
      return pool.end();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
