// End-to-end API (T-2.7): an isolated database "taskwatch_e2e", rebuilt from the migrations on every run, port 4100,
// It never touches the dev database or the dev servers (4000/5173).
import pg from 'pg';
import { e2eDatabaseUrl, E2E_PASSWORD, MANAGER, STAFF } from './fixtures.js';

const url = new URL(e2eDatabaseUrl(process.env.DATABASE_URL));
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  API_PORT: '4100',
  APP_URL: 'http://localhost:5180',
  DEMO_TOOLS: 'false',
});
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WHATSAPP_TOKEN', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];

{
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  if (!(await admin.query(`select 1 from pg_database where datname = 'taskwatch_e2e'`)).rowCount) await admin.query('create database taskwatch_e2e');
  await admin.end();
}

const { pool } = await import('../server/src/db/pool.js');
const { migrate } = await import('../server/src/db/migrate.js');
const { hashPassword } = await import('../server/src/services/auth.js');
await pool.query('drop schema public cascade; create schema public;'); // this throwaway database only
await migrate();

await pool.query(`insert into entities (id, name, organization_id) values ('BAIS', 'Bay Area Immigration Services', 1)`);
for (const [p, roles] of [
  [STAFF, ['staff']],
  [MANAGER, ['manager']],
] as const) {
  const id = p.id;
  await pool.query(`insert into users (id, name, email, entity_id, roles, time_zone, created_at, organization_id) values ($1,$2,$3,'BAIS',$4,'Asia/Kolkata',now(),1)`, [
    id,
    p.name,
    p.email,
    roles,
  ]);
  await pool.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [id, await hashPassword(E2E_PASSWORD)]);
}
await import('../server/src/index.js');
