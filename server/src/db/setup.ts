import pg from 'pg';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';
import { seed } from './seed.js';

/** Create the database if it does not exist, apply migrations, and seed an empty directory. */
async function setup(): Promise<void> {
  const url = new URL(config.databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`Unsupported database name "${name}"`);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!rowCount) {
    await admin.query(`create database "${name}"`);
    console.log(`Created database ${name}`);
  }
  await admin.end();

  const applied = await migrate();
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema is up to date.');

  const { rows } = await pool.query('select count(*) as n from users');
  if (rows[0].n === 0 && config.isProd) console.log('Empty production directory: seed it by hand (docs/08-operations/DEPLOYMENT.md), never with the demo data.');
  else if (rows[0].n === 0) await seed();
  else console.log('Directory already has people; skipping sample data. Use `npm run db:seed -- --reset` to start over.');
}

setup()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
