// Integration tests for the acceptance criteria in FO-2026-OPS-01, run through the real HTTP API
// against a throwaway database: TEST_DATABASE_URL, or else DATABASE_URL's server and credentials with the
// database name forced to taskwatch_test (so the tests can never wipe the real database).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { makeWorkClock } from '@taskwatch/shared/worktime';
import { DateTime } from 'luxon';
import pg from 'pg';

process.env.NODE_ENV = 'test';
process.env.ALLOW_DEV_LOGIN = 'true'; // the suite signs in through the dev login
delete process.env.DEMO_TOOLS; // D-47 default (off); the demo-clock tests switch it on themselves
{
  const fallback = new URL(process.env.DATABASE_URL ?? 'postgres://localhost:5432/taskwatch');
  fallback.pathname = '/taskwatch_test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? fallback.toString();
}
for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'WHATSAPP_TOKEN', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];

const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
{
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
  if (!rowCount) await admin.query(`create database "${dbName}"`);
  await admin.end();
}

const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { createApp } = await import('../src/app.js');
const clock = await import('../src/clock.js');
const { runEngine } = await import('../src/engine/engine.js');
const { runChainCheck } = await import('../src/jobs/scheduler.js');
const { appendAdmin } = await import('../src/services/audit.js');
const { hashPassword } = await import('../src/services/auth.js');
const { dispatchDue, setDispatcherEnabled } = await import('../src/notify/dispatcher.js');
const { setPushSender } = await import('../src/notify/push.js');
const { config } = await import('../src/config.js');
const webpush = await import('web-push');
const { invalidateDirectory } = await import('../src/services/directory.js');
const { invalidateRules } = await import('../src/services/rules.js');
const { runRecurring } = await import('../src/services/recurring.js');
const { maybeRunDigest } = await import('../src/services/digest.js');
const { getDirectory } = await import('../src/services/directory.js');
const { formatInZone } = await import('../src/notify/format.js');
const { DEFAULT_RULES, ladderSql } = await import('../src/domain.js');

const H = 3_600_000;
const MIN = 60_000;
let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

// Reporting lines: CEO(1) ← CoS(2) ← Manager A(3) ← Lead A(4) ← Staff A1(5), A2(6)
//                                ← Manager B(7) ← Lead B(8) ← Staff B1(9)
/** Expected-value queries: open work = not closed and not a draft (ADR-0003, T-4.0). */
const OPEN = `status not in ('completed', 'cancelled', 'draft')`;
const U = { ceo: 1, cos: 2, mgrA: 3, leadA: 4, staffA1: 5, staffA2: 6, mgrB: 7, leadB: 8, staffB1: 9 };
/** Test data only: put a fixture person back on their original line and out of any department (D-130 re-places movers). */
async function restoreLine(id: number, managerId: number) {
  await pool.query('update users set manager_id = $2, team_id = null where id = $1', [id, managerId]);
  invalidateDirectory();
}

/** Test data only: forget organization 1's saved role matrix, so the shared defaults apply again. */
async function resetRoleMatrix() {
  await pool.query('delete from role_permissions where organization_id = 1');
  await pool.query('update organizations set role_matrix_saved_at = null where id = 1');
  invalidateDirectory(); // direct SQL bypasses saveRolePermissions, which normally clears the cached matrix
}

let now = new Date('2026-11-02T03:00:00Z');
function setNow(d: Date) {
  now = d;
  clock.setFixed(d);
}
const advance = (ms: number) => setNow(new Date(now.getTime() + ms));

before(async () => {
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await migrate();
  setDispatcherEnabled(false);
  setNow(now);
  for (const [id, name] of [['FO', "Founder's Office"], ['BAIS', 'BAIS'], ['EMB', 'Embtel']]) {
    await pool.query('insert into entities (id, name, organization_id) values ($1,$2,1)', [id, name]);
  }
  const people: Array<[number, string, string, string[], number | null, string, string | null]> = [
    [1, 'CEO', 'FO', ['ceo'], null, 'America/Los_Angeles', null],
    [2, 'Chief of Staff', 'FO', ['cos'], 1, 'America/Los_Angeles', null],
    [3, 'Manager A', 'BAIS', ['manager'], 2, 'America/Los_Angeles', '+14155550103'],
    [4, 'Lead A', 'BAIS', ['lead'], 3, 'Asia/Kolkata', '+14155550104'],
    [5, 'Staff A1', 'BAIS', ['staff'], 4, 'Asia/Kolkata', '+14155550105'],
    [6, 'Staff A2', 'BAIS', ['staff'], 4, 'America/Los_Angeles', null],
    [7, 'Manager B', 'EMB', ['manager'], 2, 'Asia/Kolkata', null],
    [8, 'Lead B', 'EMB', ['lead'], 7, 'Asia/Kolkata', null],
    [9, 'Staff B1', 'EMB', ['staff'], 8, 'Asia/Kolkata', null],
  ];
  for (const [id, name, entity, roles, manager, tz, phone] of people) {
    await pool.query(
      `insert into users (id, name, email, phone, whatsapp, entity_id, roles, manager_id, time_zone, created_at, whatsapp_opt_in, organization_id, title) values ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,true,1,$10)`, // fixture people have agreed to WhatsApp (D-75: no implicit consent)
      [id, name, `user${id}@example.com`, phone, entity, roles, manager, tz, now, name], // STAFF-02 requires a job title
    );
  }
  // Fixtures use explicit ids (1–9 here, 66–75, 79 and 900 in later suites); people created through the API start after them.
  await pool.query(`select setval('users_id_seq', 1000)`);
  await pool.query(`insert into sla_rules (organization_id, scope, config, updated_at) values (1, 'default', $1, $2)`, [JSON.stringify(DEFAULT_RULES), now]);
  // ADR-0015: fixture verticals count every hour, so suites written before working time keep their behaviour.
  await pool.query(`update entities set work_days = '{0,1,2,3,4,5,6}', work_start = '00:00', work_end = '24:00'`);
  invalidateDirectory();
  invalidateRules();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  clock.setFixed(null);
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
});

class Client {
  constructor(readonly cookie: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-taskwatch': '1' }) {
    const res = await fetch(base + path, {
      method,
      headers: { ...headers, cookie: this.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, body: json as any };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  put = (p: string, b: unknown = {}) => this.req('PUT', p, b);
}

const sessions = new Map<number, Client>();
async function as(userId: number): Promise<Client> {
  const cached = sessions.get(userId);
  if (cached) return cached;
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-taskwatch': '1' },
    body: JSON.stringify({ userId }),
  });
  assert.equal(res.status, 200, 'dev login');
  // express-session sends the headers before the session row is saved and ends the body after. Reading the body
  // waits for the save; otherwise the next request can race it and get 401 (seen under parallel test load).
  await res.text();
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const c = new Client(cookie);
  sessions.set(userId, c);
  return c;
}

function localIn(hoursFromNow: number, tz: string): string {
  const d = new Date(now.getTime() + hoursFromNow * H);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** TASK-01 body fields for a local due moment 'YYYY-MM-DDTHH:mm' (the caller's zone, D-5). */
const due = (local: string) => ({ dueDate: local.slice(0, 10), dueTime: local.slice(11, 16) });
/** PERF: every new or edited (non-draft) task names its estimated effort and purpose. */
const M = { estimatedHours: 1, purpose: 'support' } as const;

/** Creates a task through the API. The entity is derived from the assignee (D-63); `_entityId` is kept for the call sites. */
async function newTask(by: number, to: number, priority: string, dueInHours: number, _entityId = 'BAIS', title = 'Test task'): Promise<number> {
  const c = await as(by);
  const tz = (await getDirectory(1)).must(by).timeZone;
  const res = await c.post('/api/tasks', { ...M, title, category: 'Operations', assigneeId: to, priority, ...due(localIn(dueInHours, tz)), instructions: '' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.task.id;
}

async function taskLevel(id: number): Promise<number> {
  const { rows } = await pool.query('select level from tasks where id = $1', [id]);
  return rows[0].level;
}

/** How many in-app notices of one kind a person got about a task. */
const inapp = async (taskId: number, userId: number, event: string) =>
  (await pool.query(`select count(*)::int n from notifications where task_id = $1 and user_id = $2 and event = $3 and channel = 'inapp'`, [taskId, userId, event])).rows[0].n as number;

async function activeEscalations(id: number) {
  const { rows } = await pool.query(
    `select e.level, array_agg(r.user_id order by r.user_id) filter (where r.kind = 'to') as "to"
       from escalations e join escalation_recipients r on r.escalation_id = e.id
      where e.task_id = $1 and e.cleared_at is null group by e.id order by e.level`,
    [id],
  );
  return rows as Array<{ level: number; to: number[] }>;
}

describe('Scheduler leadership (T-1.17)', () => {
  it('only the holder of the advisory lock runs jobs; leadership passes on when it is released', async () => {
    const { isLeader, resignLeadership } = await import('../src/jobs/scheduler.js');
    const { LOCK_KEYS } = await import('../src/db/pool.js');
    // Another instance holds the lock: this one must stay idle.
    const other = await pool.connect();
    await other.query('select pg_advisory_lock($1)', [LOCK_KEYS.scheduler]);
    assert.equal(await isLeader(), false);
    // The other instance goes away: this one takes over and keeps it.
    await other.query('select pg_advisory_unlock($1)', [LOCK_KEYS.scheduler]);
    other.release();
    assert.equal(await isLeader(), true);
    assert.equal(await isLeader(), true);
    const probe = await pool.connect();
    const { rows } = await probe.query('select pg_try_advisory_lock($1) as ok', [LOCK_KEYS.scheduler]);
    probe.release();
    assert.equal(rows[0].ok, false, 'nobody else can take it while this instance leads');
    resignLeadership();
  });

  it('migrations started concurrently by two instances both succeed without racing', async () => {
    assert.deepEqual(await Promise.all([migrate(), migrate()]), [[], []]);
  });
});

describe('Password sign-in (T-2.1, AUTH-01b)', () => {
  /** POST /api/auth/login; returns status, body and the session cookie it set (if any). */
  async function login(email: string, password: string, cookie = '') {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-taskwatch': '1', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ email, password }),
    });
    const body: any = await res.json(); // also waits for the session save (see as())
    return { status: res.status, body, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '', retryAfter: res.headers.get('retry-after') };
  }
  const PW = 'correct horse 42';
  async function giveUser(id: number, roles: string[], opts: { active?: boolean } = {}) {
    await pool.query(
      `insert into users (id, name, email, entity_id, roles, manager_id, time_zone, created_at, active, organization_id) values ($1,$2,$3,'BAIS',$4,null,'Asia/Kolkata',$5,$6,1)
       on conflict (id) do nothing`,
      [id, `Auth ${id}`, `auth${id}@example.com`, roles, now, opts.active ?? true],
    );
    await pool.query(
      `insert into user_credentials (user_id, password_hash) values ($1,$2)
       on conflict (user_id) do update set password_hash = excluded.password_hash`,
      [id, await hashPassword(PW)],
    );
    invalidateDirectory();
  }

  it('AUTH-01-AC-1/5: a staff member signs in, the session id changes, and /api/me then works', async () => {
    await giveUser(60, ['staff']);
    const before = (await login('auth60@example.com', 'wrong password')).cookie; // a session-less failure sets no cookie
    assert.equal(before, '');
    // A throwaway existing session (not one cached by as(): signing in regenerates and so ends it).
    const dev = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskwatch': '1' }, body: JSON.stringify({ userId: 60 }) });
    await dev.text();
    const pre = dev.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await new Client(pre).get('/api/me')).status, 200);
    const r = await login('AUTH60@Example.com ', PW, pre); // mixed case and spaces in the email
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.ok(r.cookie && r.cookie !== pre, 'session regenerated');
    assert.equal((await new Client(pre).get('/api/me')).status, 401, 'the old session no longer works (fixation defence)');
    const me = await new Client(r.cookie).get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, 60);
    const { rows } = await pool.query(`select kind, target, context from admin_log where kind = 'sign_in' and target = 'user:60' and context = 'password'`);
    assert.deepEqual(rows[0], { kind: 'sign_in', target: 'user:60', context: 'password' }, 'sign-in audited (S-10)');
  });

  it('AUTH-01-AC-2: unknown email and wrong password are indistinguishable', async () => {
    await giveUser(61, ['staff']);
    const unknown = await login('nobody@example.com', PW);
    const wrong = await login('auth61@example.com', 'not the password');
    assert.equal(unknown.status, 401);
    assert.deepEqual({ s: unknown.status, b: unknown.body }, { s: wrong.status, b: wrong.body });
    assert.deepEqual(unknown.body, { error: 'That email and password combination is not recognized.' });
  });

  it('AUTH-01-AC-3: a deactivated account with the right password gets 403 and no session', async () => {
    await giveUser(62, ['staff'], { active: false });
    const r = await login('auth62@example.com', PW);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'This account is deactivated. Contact your Chief of Staff.');
    assert.equal(r.cookie, '');
  });

  it('D-94: a manager signs in with the password alone (no second factor); the 2FA endpoints no longer exist', async () => {
    await giveUser(63, ['lead', 'manager']); // not 'ceo': an extra CEO would join every L3 route in later tests
    const r = await login('auth63@example.com', PW);
    assert.deepEqual({ s: r.status, b: r.body }, { s: 200, b: { ok: true } });
    assert.equal((await new Client(r.cookie).get('/api/me')).body.user.id, 63);
    for (const path of ['/api/auth/2fa/verify', '/api/auth/2fa/enroll/start', '/api/people/63/reset-2fa']) {
      assert.equal((await (await as(U.cos)).post(path)).status, 404, path);
    }
  });

  it('AUTH-01-AC-6: after 5 failures the account is throttled — even the right password gets 429 with Retry-After', async () => {
    await giveUser(66, ['staff']);
    for (let i = 0; i < 5; i++) assert.equal((await login('auth66@example.com', `wrong ${i}`)).status, 401);
    const r = await login('auth66@example.com', PW);
    assert.equal(r.status, 429);
    assert.equal(r.body.error, 'Too many attempts. Try again later.');
    assert.ok(Number(r.retryAfter) > 0 && Number(r.retryAfter) <= 900);
  });

  it('T-2.2: every way in is audited and recorded; the Google callback does not exist while Google is off', async () => {
    const dev = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskwatch': '1' }, body: JSON.stringify({ userId: U.mgrB }) });
    await dev.text();
    const { rows: audit } = await pool.query(`select context, source from admin_log where kind = 'sign_in' and target = $1 order by seq desc limit 1`, [`user:${U.mgrB}`]);
    assert.deepEqual(audit[0], { context: 'dev', source: 'demo' });
    const { rows: tries } = await pool.query(`select method, ok from login_attempts where user_id = $1 order by id desc limit 1`, [U.mgrB]);
    assert.deepEqual(tries[0], { method: 'dev', ok: true });
    assert.equal((await fetch(`${base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' })).status, 404);
  });

  /** Age a session's clocks in the session store, as if time had passed (no real waiting). */
  async function ageSession(cookie: string, field: 'lastSeenAt' | 'signedInAt', msAgo: number) {
    const sid = decodeURIComponent(cookie.split('=')[1]!).replace(/^s:/, '').replace(/\.[^.]*$/, '');
    const { rowCount } = await pool.query(`update "session" set sess = jsonb_set(sess::jsonb, $2, to_jsonb($3::bigint))::json where sid = $1`, [
      sid,
      `{${field}}`,
      Date.now() - msAgo,
    ]);
    assert.equal(rowCount, 1, 'session row found');
  }

  it('TC-AUTH-02-01: sign-out ends the session, clears the cookie and is audited', async () => {
    await giveUser(68, ['staff']);
    const s = await login('auth68@example.com', PW);
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'x-taskwatch': '1', cookie: s.cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') ?? '', /^tw\.sid=;.*Expires=Thu, 01 Jan 1970/, 'cookie cleared (S-6)');
    assert.deepEqual((await new Client(s.cookie).get('/api/me')).body, { error: 'Please sign in' }, 'AUTH-02-AC-1');
    const { rows } = await pool.query(`select count(*)::int n from admin_log where kind = 'sign_out' and target = 'user:68'`);
    assert.equal(rows[0].n, 1);
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'x-taskwatch': '1' } })).status, 200, 'fine when not signed in');
  });

  it('TC-AUTH-03-01/02: the idle timeout comes from Settings; activity keeps a session alive only up to the 12 h cap', async () => {
    await giveUser(69, ['staff']);
    await pool.query(`update organizations set settings = '{"sessionTimeoutMinutes": 5}' where id = 1`); // ADR-0010: settings per organization
    try {
      const idle = await login('auth69@example.com', PW);
      await ageSession(idle.cookie, 'lastSeenAt', 4 * 60_000);
      assert.equal((await new Client(idle.cookie).get('/api/me')).status, 200, 'inside the 5 min setting');
      await ageSession(idle.cookie, 'lastSeenAt', 6 * 60_000);
      assert.deepEqual((await new Client(idle.cookie).get('/api/me')).body, { error: 'SESSION_EXPIRED' }, 'AC-1 and AC-4: setting applies');
      assert.deepEqual((await new Client(idle.cookie).get('/api/me')).body, { error: 'Please sign in' }, 'then the session is gone');
      const busy = await login('auth69@example.com', PW);
      await ageSession(busy.cookie, 'signedInAt', 11 * 3_600_000);
      assert.equal((await new Client(busy.cookie).get('/api/me')).status, 200, 'active and under 12 h');
      await ageSession(busy.cookie, 'signedInAt', 12 * 3_600_000 + 60_000);
      assert.deepEqual((await new Client(busy.cookie).get('/api/me')).body, { error: 'SESSION_EXPIRED' }, 'AC-2: absolute cap');
    } finally {
      await pool.query(`update organizations set settings = '{}' where id = 1`); // test data only: back to the shared defaults
    }
  });

  it('AUTH-03-AC-3: deactivation takes effect on the very next request (no cache)', async () => {
    await giveUser(70, ['staff']);
    const s = await login('auth70@example.com', PW);
    const c = new Client(s.cookie);
    assert.equal((await c.get('/api/me')).status, 200);
    await pool.query('update users set active = false where id = 70'); // directly, bypassing any cache invalidation
    assert.deepEqual((await c.get('/api/me')).body, { error: 'Your account has been deactivated.' });
  });

  /** POST a public auth endpoint without a session. */
  const anon = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskwatch': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  /** Run fn while capturing the dev console line that carries the reset link (no SMTP in tests). */
  async function captureResetLink(fn: () => Promise<unknown>): Promise<string | null> {
    const real = console.log;
    let link: string | null = null;
    console.log = (...a: unknown[]) => {
      const m = String(a.join(' ')).match(/password reset link for \S+: (\S+)/);
      if (m) link = m[1]!;
      else real(...a);
    };
    try {
      await fn();
      // forgot answers before the email goes out (no timing oracle), so wait briefly for the link
      for (let i = 0; i < 40 && !link; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      console.log = real;
    }
    return link;
  }
  const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

  it('AUTH-04-AC-1/6: forgot answers the same for known and unknown emails; the token is emailed only, never stored or shown', async () => {
    await giveUser(71, ['staff']);
    let known: any;
    const link = await captureResetLink(async () => (known = await anon('/auth/password/forgot', { email: 'AUTH71@example.com' })));
    const unknown = await anon('/auth/password/forgot', { email: 'nobody71@example.com' });
    assert.deepEqual(known, unknown);
    assert.deepEqual(known, { status: 200, body: { ok: true } });
    assert.ok(link, 'link delivered (dev console stands in for email)');
    const token = tokenOf(link!);
    const { rows } = await pool.query(`select token_hash, expires_at - created_at as ttl from password_reset_tokens where user_id = 71`);
    assert.equal(rows.length, 1, 'only the known email gets a token');
    assert.deepEqual(rows[0].token_hash, crypto.createHash('sha256').update(token).digest(), 'only the hash is stored');
    const outbox = JSON.stringify((await (await as(U.cos)).get('/api/deliveries')).body);
    assert.ok(outbox.includes('Password reset link (redacted)') && !outbox.includes(token), 'delivery log never shows the token');
    assert.deepEqual((await anon('/auth/password/forgot', { email: 'not-an-email' })).body.fields, { email: 'Enter a valid email address.' });
  });

  it('AUTH-04-AC-2/4/5: each password rule has its message; a token works once and ends every other session', async () => {
    await giveUser(72, ['staff']);
    const session = (await login('auth72@example.com', PW)).cookie;
    const token = tokenOf((await captureResetLink(() => anon('/auth/password/forgot', { email: 'auth72@example.com' })))!);
    const rule = async (password: string, confirm = password) => (await anon('/auth/password/reset', { token, password, confirm })).body.fields;
    assert.deepEqual(await rule('short1'), { password: 'Use at least 10 characters.' });
    assert.deepEqual(await rule('onlyletterslong'), { password: 'Use letters and at least one number.' });
    assert.deepEqual(await rule('newpassword9', 'newpassword8'), { confirm: 'The passwords do not match.' });
    assert.deepEqual(await anon('/auth/password/reset', { token, password: 'newpassword9', confirm: 'newpassword9' }), { status: 200, body: { ok: true } });
    assert.equal((await new Client(session).get('/api/me')).status, 401, 'AC-5: other sessions ended');
    assert.equal((await login('auth72@example.com', 'newpassword9')).status, 200, 'new password works');
    assert.equal((await login('auth72@example.com', PW)).status, 401, 'old password no longer works');
    const again = await anon('/auth/password/reset', { token, password: 'another1pass', confirm: 'another1pass' });
    assert.deepEqual(again, { status: 400, body: { error: 'This reset link is invalid or has expired. Request a new one.' } }, 'AC-2: single use');
  });

  it('AUTH-04-AC-3: a token older than an hour is refused', async () => {
    await giveUser(73, ['staff']);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(`insert into password_reset_tokens (token_hash, user_id, created_at, expires_at) values ($1, 73, now() - interval '61 minutes', now() - interval '1 minute')`, [
      crypto.createHash('sha256').update(token).digest(),
    ]);
    assert.equal((await anon('/auth/password/reset', { token, password: 'newpassword9', confirm: 'newpassword9' })).status, 400);
  });

  it('D-172: the onboarding email needs manage_staff, sends a 7-day set-password link, keeps sessions, and is audited', async () => {
    await giveUser(79, ['staff']);
    const held = (await login('auth79@example.com', PW)).cookie;
    assert.equal((await (await as(U.leadA)).post('/api/people/79/onboarding-email')).status, 403, 'lead lacks manage_staff');
    const link = await captureResetLink(async () => assert.equal((await (await as(U.cos)).post('/api/people/79/onboarding-email')).status, 200));
    assert.match(link!, /[?&]welcome=1$/, 'the page shows first-time wording');
    const { rows } = await pool.query(`select created_by, round(extract(epoch from expires_at - created_at) / 3600) as hours from password_reset_tokens where user_id = 79`);
    assert.deepEqual(rows.map((r) => ({ by: r.created_by, hours: Number(r.hours) })), [{ by: U.cos, hours: 168 }]);
    assert.equal((await new Client(held).get('/api/me')).status, 200, 'sessions kept');
    const outbox = JSON.stringify((await (await as(U.cos)).get('/api/deliveries')).body);
    assert.ok(outbox.includes('Welcome email with a set-password link (redacted)') && !outbox.includes(tokenOf(link!)), 'delivery log never shows the token');
    assert.equal((await pool.query(`select 1 from admin_log where kind = 'onboarding_sent' and target = 'user:79'`)).rowCount, 1);
    assert.deepEqual((await anon('/auth/password/reset', { token: tokenOf(link!), password: 'firstpass99', confirm: 'firstpass99' })).body, { ok: true }, 'the link sets the password');
  });

  it('AUTH-05: reset access needs manage_staff, sends a link and ends sessions; a CoS only by a CoS; D-98 scope', async () => {
    await giveUser(74, ['manager']);
    const held = (await login('auth74@example.com', PW)).cookie;
    assert.equal((await (await as(U.leadA)).post('/api/people/74/reset-access')).status, 403, 'lead lacks manage_staff');
    const link = await captureResetLink(async () => assert.equal((await (await as(U.cos)).post('/api/people/74/reset-access')).status, 200));
    assert.ok(link);
    const { rows } = await pool.query(`select created_by from password_reset_tokens where user_id = 74`);
    assert.deepEqual(rows[0], { created_by: U.cos }, 'token issued by the CoS');
    assert.equal((await new Client(held).get('/api/me')).status, 401, 'sessions ended');
    // A non-CoS holding manage_staff may not reset a CoS.
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@taskwatch/shared/permissions');
    try {
      assert.equal((await (await as(U.cos)).put('/api/roles/manager', { permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'manage_staff'] })).status, 200);
      const r = await (await as(U.mgrA)).post(`/api/people/${U.cos}/reset-access`);
      assert.deepEqual({ s: r.status, e: r.body.error }, { s: 403, e: 'Only a Chief of Staff can reset another Chief of Staff.' });
      // D-98: a non-CoS may reset only themselves and people below them.
      const other = await (await as(U.mgrA)).post(`/api/people/${U.staffB1}/reset-access`);
      assert.deepEqual({ s: other.status, e: other.body.error }, { s: 403, e: 'You can only reset access for yourself or people below you in the reporting line.' });
      assert.equal((await (await as(U.mgrA)).post(`/api/people/${U.staffA2}/reset-access`)).status, 200, 'below them');
      sessions.delete(U.staffA2); // their sessions were ended
      assert.equal((await (await as(U.mgrA)).post(`/api/people/${U.mgrA}/reset-access`)).status, 200, 'themselves (owner, 2026-11-06)');
      sessions.delete(U.mgrA);
    } finally {
      await resetRoleMatrix();
    }
  });

  it('SA-6: a parallel burst cannot outrun the throttle (in-memory cap before any hash)', async () => {
    await giveUser(75, ['staff']);
    const codes = (await Promise.all(Array.from({ length: 12 }, (_, i) => login('auth75@example.com', `wrong ${i}`)))).map((r) => r.status);
    assert.ok(codes.filter((c) => c === 429).length >= 2, `at most 10 per email per 15 min reach the hash; got ${codes}`);
  });

  it('missing fields get the FRD messages inline (KI-18 rule)', async () => {
    const res: any = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-taskwatch': '1' }, body: '{}' })).json();
    assert.deepEqual(res.fields, { email: 'Enter your work email.', password: 'Enter your password.' });
  });
});

describe('Bootstrap: GET /api/me (T-1.15, AUTH-06)', () => {
  it('TC-AUTH-06-01: returns the caller, their effective permissions, settings, rules, badges and server time — nothing about anyone else', async () => {
    const res = await (await as(U.staffA1)).get('/api/me');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.equal(b.user.id, U.staffA1);
    assert.deepEqual(b.user.roles, ['staff']);
    assert.equal(b.user.entityId, 'BAIS');
    assert.equal(b.user.timezone, 'Asia/Kolkata');
    assert.deepEqual(b.user.manager, { id: U.leadA, name: 'Lead A' });
    assert.deepEqual(b.permissions, ['update_assigned_tasks']);
    assert.equal(b.settings.orgName, 'Vertical', 'KI-23: the organization name, one source');
    assert.deepEqual(b.organization, { id: 1, name: 'Vertical' }, "ADR-0010: the caller's own organization");
    assert.ok(b.settings.categories.includes('Operations'));
    assert.equal(b.rules.dueSoonHours, 24, 'D-48: dueSoonHours in the rules');
    for (const k of ['unread', 'escalations', 'reviews', 'extensions']) assert.equal(typeof b.badges[k], 'number', k);
    assert.ok(!Number.isNaN(Date.parse(b.serverTime)));
    const text = JSON.stringify(b);
    for (const other of [U.leadA, U.mgrA, U.cos, U.staffB1]) assert.ok(!text.includes(`user${other}@example.com`), `no email of user ${other}`);
  });

  it('effective permissions follow the role matrix: lead without reassign (D-29), CEO read-only (D-33), CoS everything', async () => {
    const perms = async (id: number) => (await (await as(id)).get('/api/me')).body.permissions as string[];
    const lead = await perms(U.leadA);
    assert.ok(lead.includes('assign_tasks') && !lead.includes('reassign_tasks'));
    assert.deepEqual(await perms(U.ceo), ['view_tasks', 'view_team_reports', 'view_org_reports', 'view_audit_logs']);
    assert.equal((await perms(U.cos)).length, 15);
  });

  it('the escalation badge is scoped: the lead sees it, another team does not, the assignee does not count their own', async () => {
    const badge = async (id: number) => (await (await as(id)).get('/api/me')).body.badges.escalations as number;
    const before = { lead: await badge(U.leadA), other: await badge(U.staffB1), assignee: await badge(U.staffA1) };
    const start = now;
    await newTask(U.leadA, U.staffA1, 'critical', 100);
    setNow(new Date(start.getTime() + 6 * H + MIN)); // past L1 for Critical
    await runEngine();
    assert.equal(await badge(U.leadA), before.lead + 1, 'lead sees the new L1');
    assert.equal(await badge(U.staffB1), before.other, 'other team unaffected');
    assert.equal(await badge(U.staffA1), before.assignee, 'assignee does not count their own task');
  });

  it('TC-AUTH-06-02: a saved role matrix replaces the defaults on the next request', async () => {
    try {
      assert.equal((await (await as(U.cos)).put('/api/roles/staff', { permissions: ['update_assigned_tasks', 'create_tasks'] })).status, 200);
      const staff = (await (await as(U.staffA1)).get('/api/me')).body.permissions;
      assert.deepEqual(staff, ['create_tasks', 'update_assigned_tasks']);
    } finally {
      await resetRoleMatrix();
    }
  });
});

describe('Security', () => {
  it('rejects state-changing requests without the TaskWatch header', async () => {
    const c = await as(U.leadA);
    const res = await c.req('POST', '/api/tasks', {}, {});
    assert.equal(res.status, 403);
  });

  it('a staff member cannot see another team’s tasks — tested through the API', async () => {
    const id = await newTask(U.leadB, U.staffB1, 'normal', 48, 'EMB', 'Embtel-only task');
    const staffA = await as(U.staffA1);
    // A task outside your scope is indistinguishable from one that does not exist (D-35): same 404, same body.
    const missing = await staffA.get('/api/tasks/999999');
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.deepEqual(await staffA.get(`/api/tasks/${id}`), missing);
    const list = await staffA.get('/api/tasks?view=open');
    assert.equal(list.status, 200);
    assert.ok(!list.body.items.some((t: any) => t.id === id), 'not in list');
    const missingComment = await staffA.post('/api/tasks/999999/comments', { body: 'hi' });
    assert.equal(missingComment.status, 404);
    assert.deepEqual(await staffA.post(`/api/tasks/${id}/comments`, { body: 'hi' }), missingComment, 'mutations do not leak either');
    assert.deepEqual(await (await as(U.mgrA)).get(`/api/tasks/${id}`), missing, 'other manager');
    assert.equal((await (await as(U.mgrB)).get(`/api/tasks/${id}`)).status, 200, 'own manager');
    assert.equal((await (await as(U.cos)).get(`/api/tasks/${id}`)).status, 200, 'Chief of Staff');
    assert.equal((await (await as(U.ceo)).get(`/api/tasks/${id}`)).status, 200, 'CEO');
  });

  it('only the assignee can post updates; staff cannot assign', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 48);
    // A peer cannot see a teammate's task, so it is reported as missing (D-35), not as forbidden.
    const peer = await as(U.staffA2);
    assert.deepEqual(await peer.post(`/api/tasks/${id}/comments`, { body: 'x' }), await peer.post('/api/tasks/999999/comments', { body: 'x' }), 'peer cannot comment');
    assert.equal((await peer.post(`/api/tasks/${id}/comments`, { body: 'x' })).status, 404);
    const res = await (await as(U.leadA)).req('POST', `/api/tasks/${id}/updates`, { body: 'Not my task' });
    assert.equal(res.status, 403, 'a lead cannot post an assignee update');
    const staff = await as(U.staffA1);
    assert.equal((await staff.post('/api/tasks', { ...M, title: 'Peer task', category: 'Operations', assigneeId: U.staffA2, priority: 'low', ...due(localIn(10, 'Asia/Kolkata')) })).status, 403);
  });

  it('rejects A-numbers and other ID numbers in task text', async () => {
    const c = await as(U.leadA);
    const res = await c.post('/api/tasks', { ...M, title: 'Biometrics for A123-456-789', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due(localIn(30, 'Asia/Kolkata')) });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /A-number/);
  });

  it('activity log rows cannot be edited or deleted, by any endpoint or directly', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'low', 72);
    const c = await as(U.cos);
    assert.equal((await c.req('DELETE', `/api/tasks/${id}`)).status, 404);
    assert.equal((await c.req('PUT', `/api/tasks/${id}/log/1`, { body: 'x' })).status, 404);
    await assert.rejects(pool.query('update activity_log set body = $1 where task_id = $2', ['edited', id]), /append-only/);
    await assert.rejects(pool.query('delete from activity_log where task_id = $1', [id]), /append-only/);
    await assert.rejects(pool.query('truncate activity_log cascade'), /append-only/);
  });

  it('the hash check flags a row altered directly in the database', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'low', 72, 'BAIS', 'Tamper target');
    assert.equal((await runChainCheck('manual')).ok, true);
    // Simulate a DBA bypassing the trigger.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(`update activity_log set body = 'rewritten history' where task_id = $1 and seq = 1`, [id]);
      await client.query('commit');
    } finally {
      client.release();
    }
    const result = await runChainCheck('manual');
    assert.equal(result.ok, false);
    assert.ok(result.breaks.some((b) => b.taskId === id && b.seq === 1));
    const { rows } = await pool.query(`select count(*) as n from notifications where event = 'chain_break' and user_id = $1`, [U.cos]);
    assert.ok(rows[0].n > 0, 'Chief of Staff alerted');
    const detail = await (await as(U.cos)).get(`/api/tasks/${id}`);
    assert.equal(detail.body.chain.ok, false);
  });

  it('the admin audit log is hash-chained: API writes are chained, tampering is flagged, unchained inserts are refused (T-1.9)', async () => {
    // A real admin action writes a chained row.
    assert.equal((await (await as(U.cos)).req('PUT', '/api/rules/default', { config: DEFAULT_RULES, note: 'chain test' })).status, 200);
    const { rows: viaApi } = await pool.query(`select seq from admin_log where kind = 'rules_change' and note = 'chain test'`);
    assert.ok(viaApi[0]?.seq > 0, 'API audit row has a chain position');
    // Writers with and without a caller transaction share one chain.
    await appendAdmin(null, { actorId: U.cos, kind: 'chain_probe', note: 'one' });
    const c = await pool.connect();
    try {
      await c.query('begin');
      await appendAdmin(c, { actorId: U.cos, kind: 'chain_probe', note: 'two', after: { nested: { b: 1, a: [2, 3] } } });
      await c.query('commit');
    } finally {
      c.release();
    }
    const { rows: probe } = await pool.query(`select seq from admin_log where kind = 'chain_probe' order by seq`);
    assert.equal(probe[1].seq, probe[0].seq + 1, 'consecutive positions');
    // Earlier tests deliberately break a task chain, so only the admin-chain breaks are asserted here.
    const adminBreaks = (r: Awaited<ReturnType<typeof runChainCheck>>) => r.breaks.filter((b) => b.log === 'admin');
    assert.deepEqual(adminBreaks(await runChainCheck('manual')), [], 'clean chain verifies');

    // A DBA bypasses the append-only trigger and rewrites a row.
    const t = await pool.connect();
    try {
      await t.query('begin');
      await t.query('set local session_replication_role = replica');
      await t.query(`update admin_log set note = 'rewritten' where seq = $1`, [probe[0].seq]);
      await t.query('commit');
    } finally {
      t.release();
    }
    const after = await runChainCheck('manual');
    assert.ok(adminBreaks(after).some((b) => b.seq === probe[0].seq && /altered/.test(b.problem)), 'altered row flagged at its position');
    const { rows: alerts } = await pool.query(`select body from notifications where event = 'chain_break' and user_id = $1 and channel = 'inapp' order by id desc limit 1`, [U.cos]);
    assert.match(alerts[0].body, /admin audit log/, 'Chief of Staff told which log broke');

    // Nothing can be added beside the chain.
    await assert.rejects(pool.query(`insert into admin_log (at, kind) values (now(), 'sneaky')`), /audit chain/);
  });
});

describe('Escalation engine', () => {
  it('acceptance: Critical with no update reaches L0 at 4 h, L1 at 6 h, L2 at 8 h, L3 at 12 h — each within 5 minutes, each once', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA1, 'critical', 48);
    const expectTo = [[U.staffA1], [U.leadA], [U.mgrA], [U.ceo, U.cos]];
    for (const [k, h] of [4, 6, 8, 12].entries()) {
      setNow(new Date(start.getTime() + h * H - MIN));
      await runEngine();
      assert.equal(await taskLevel(id), k - 1, `one minute before L${k}`);
      setNow(new Date(start.getTime() + h * H + 4 * MIN + 59_000));
      await runEngine();
      assert.equal(await taskLevel(id), k, `L${k} within 5 minutes`);
      const esc = await activeEscalations(id);
      assert.deepEqual(esc.find((e) => e.level === k)?.to, [...expectTo[k]!].sort((a, b) => a - b), `L${k} recipients`);
    }
    advance(30 * MIN);
    await runEngine();
    const { rows } = await pool.query('select level, count(*) as n from escalations where task_id = $1 group by level order by level', [id]);
    assert.deepEqual(rows.map((r) => [r.level, r.n]), [[0, 1], [1, 1], [2, 1], [3, 1]], 'each level fired exactly once');
    const l3 = await pool.query(`select channel from notifications where task_id = $1 and event = 'L3' and user_id = $2 order by channel`, [id, U.cos]);
    assert.deepEqual(l3.rows.map((r) => r.channel), ['email', 'inapp'], 'L3 reaches the Chief of Staff on every channel (D-106: no WhatsApp)');

    // A lead's comment does not reset the clock…
    const lead = await as(U.leadA);
    assert.equal((await lead.post(`/api/tasks/${id}/comments`, { body: 'Please update.' })).status, 201);
    await runEngine();
    assert.equal(await taskLevel(id), 3, 'comment does not reset');

    // …an assignee update does, and the task can climb again later.
    const staff = await as(U.staffA1);
    assert.equal((await staff.req('POST', `/api/tasks/${id}/updates`, { body: 'On it now.' })).status, 201);
    assert.equal(await taskLevel(id), -1, 'assignee update drops the task back down');
    assert.equal((await activeEscalations(id)).length, 0);
    advance(4 * H + MIN);
    await runEngine();
    assert.equal(await taskLevel(id), 0, 'climbs again');
    const again = await pool.query('select count(*) as n from escalations where task_id = $1 and level = 0', [id]);
    assert.equal(again.rows[0].n, 2);
  });

  it('past due reaches L1 at the due time, L2 at +24 h and L3 at +72 h whatever updates were posted; extending clears it', async () => {
    const id = await newTask(U.leadA, U.staffA2, 'normal', 10);
    const staff = await as(U.staffA2);
    const dueMs = now.getTime() + 10 * H;
    for (const [h, want] of [[0, 1], [24, 2], [72, 3]] as const) {
      setNow(new Date(dueMs + h * H + MIN));
      assert.equal((await staff.req('POST', `/api/tasks/${id}/updates`, { body: `Update at due+${h}h` })).status, 201);
      await runEngine();
      assert.equal(await taskLevel(id), want, `due + ${h} h`);
    }
    const mgr = await as(U.mgrA);
    const res = await mgr.post(`/api/tasks/${id}/due`, { ...due(localIn(48, 'America/Los_Angeles')), reason: 'Client delay' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await taskLevel(id), -1, 'extension drops the past-due level');
    const log = await pool.query(`select before, after, body from activity_log where task_id = $1 and kind = 'due_change'`, [id]);
    assert.ok(log.rows[0].before.dueAt && log.rows[0].after.dueAt && log.rows[0].body === 'Client delay', 'old/new/reason logged');
  });

  it('marking a task Blocked alerts the team lead immediately', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'high', 48);
    const staff = await as(U.staffA1);
    assert.equal((await staff.req('POST', `/api/tasks/${id}/updates`, { body: '', status: 'blocked' })).status, 400, 'reason required');
    assert.equal((await staff.req('POST', `/api/tasks/${id}/updates`, { body: 'Waiting on client passport', status: 'blocked' })).status, 201);
    const { rows } = await pool.query(`select channel, status from notifications where task_id = $1 and event = 'blocked' and user_id = $2`, [id, U.leadA]);
    assert.ok(rows.some((r) => r.channel === 'inapp' && r.status === 'sent'), 'in-app alert to lead');
    assert.ok(rows.some((r) => r.channel === 'email'), 'email queued to lead');
  });

  it('a team lead can extend a due date once; a manager can extend again', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 24);
    const lead = await as(U.leadA);
    assert.equal((await lead.post(`/api/tasks/${id}/due`, { ...due(localIn(48, 'Asia/Kolkata')), reason: 'More docs' })).status, 200);
    assert.equal((await lead.post(`/api/tasks/${id}/due`, { ...due(localIn(72, 'Asia/Kolkata')), reason: 'Again' })).status, 403);
    assert.equal((await (await as(U.mgrA)).post(`/api/tasks/${id}/due`, { ...due(localIn(96, 'America/Los_Angeles')), reason: 'Approved' })).status, 200);
  });

  it('acknowledging pauses repeat alerts for 12 h but does not reset the clock', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA2, 'critical', 100);
    setNow(new Date(start.getTime() + 12 * H + MIN));
    await runEngine();
    assert.equal(await taskLevel(id), 3);
    const { rows: esc } = await pool.query('select id from escalations where task_id = $1 and level = 3 and cleared_at is null', [id]);
    const { rows: l1 } = await pool.query('select id from escalations where task_id = $1 and level = 1 and cleared_at is null', [id]);
    assert.equal((await (await as(U.staffA2)).post(`/api/escalations/${l1[0].id}/ack`, { note: 'x' })).status, 403, 'copied assignee cannot acknowledge');
    const outsider = await as(U.staffB1);
    assert.deepEqual(
      await outsider.post(`/api/escalations/${l1[0].id}/ack`, { note: 'x' }),
      await outsider.post('/api/escalations/999999/ack', { note: 'x' }),
      'an escalation on a task you cannot see is reported as missing (D-35)',
    );
    const cos = await as(U.cos);
    assert.equal((await cos.post(`/api/escalations/${esc[0].id}/ack`, { note: 'Calling the manager now' })).status, 200);
    assert.equal(await taskLevel(id), 3, 'clock not reset');

    const repeats = async () =>
      (await pool.query(`select count(*) as n from notifications where task_id = $1 and event = 'repeat' and user_id = $2 and channel = 'inapp'`, [id, U.cos])).rows[0].n;
    setNow(new Date(start.getTime() + 20 * H));
    await runEngine();
    assert.equal(await repeats(), 0, 'no repeat while acknowledged');
    setNow(new Date(start.getTime() + 24 * H + 2 * MIN));
    await runEngine();
    assert.equal(await repeats(), 1, 'repeats resume after 12 h');
  });

  it('reassigning restarts the clock for the new assignee', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'critical', 24);
    advance(7 * H);
    await runEngine();
    assert.equal(await taskLevel(id), 1);
    const res = await (await as(U.mgrA)).post(`/api/tasks/${id}/reassign`, { toId: U.staffA2, reason: 'Workload' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await taskLevel(id), -1);
    const { rows } = await pool.query('select assignee_id, clock_started_at from tasks where id = $1', [id]);
    assert.equal(rows[0].assignee_id, U.staffA2);
    assert.equal(rows[0].clock_started_at.getTime(), now.getTime());
    assert.equal((await (await as(U.leadA)).post(`/api/tasks/${id}/reassign`, { toId: U.staffA1, reason: 'x' })).status, 403, 'leads cannot reassign');
  });
});

describe('Time zones and quiet hours', () => {
  it('the same due time entered in IST and PT is stored as one UTC instant and shown correctly in each zone', async () => {
    setNow(new Date('2026-11-20T03:00:00Z'));
    const lead = await as(U.leadA); // IST
    const cos = await as(U.cos); // PT
    const a = await lead.post('/api/tasks', { ...M, title: 'IST entry', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due('2026-11-25T17:30') });
    const b = await cos.post('/api/tasks', { ...M, title: 'PT entry', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due('2026-11-25T04:00') });
    const { rows } = await pool.query('select due_at from tasks where id = any($1) order by id', [[a.body.task.id, b.body.task.id]]);
    assert.equal(rows[0].due_at.toISOString(), '2026-11-25T12:00:00.000Z');
    assert.equal(rows[1].due_at.toISOString(), '2026-11-25T12:00:00.000Z');
    assert.equal(formatInZone(rows[0].due_at, 'Asia/Kolkata'), 'Wed 25 Nov, 5:30 PM IST');
    assert.equal(formatInZone(rows[0].due_at, 'America/Los_Angeles'), 'Wed 25 Nov, 4:00 AM PT');
  });

  it('holds L0/L1 WhatsApp and email during the recipient’s quiet hours; L2 always goes out', async () => {
    // Created 17:00 IST. L0 at 21:00 IST and L1 at 23:00 IST are quiet for IST recipients; L2 at 01:00 IST goes to a PT manager.
    setNow(new Date('2026-12-01T11:30:00Z'));
    const id = await newTask(U.leadA, U.staffA1, 'critical', 48);
    setNow(new Date('2026-12-01T15:31:00Z'));
    await runEngine();
    setNow(new Date('2026-12-01T17:31:00Z'));
    await runEngine();
    setNow(new Date('2026-12-01T19:31:00Z'));
    await runEngine();
    const { rows } = await pool.query(
      `select event, user_id, channel, status, send_after from notifications where task_id = $1 and event in ('L0','L1','L2') and channel <> 'inapp' and user_id in ($2,$3,$4) order by event, channel`,
      [id, U.staffA1, U.leadA, U.mgrA],
    );
    const find = (event: string, user: number, channel: string) => rows.find((r) => r.event === event && r.user_id === user && r.channel === channel);
    assert.ok(!rows.some((r) => r.channel === 'whatsapp'), 'D-106: nothing queues WhatsApp');
    assert.equal(find('L0', U.staffA1, 'email')?.status, 'held');
    assert.equal(find('L0', U.staffA1, 'email')?.send_after.toISOString(), '2026-12-02T02:30:00.000Z', 'released 08:00 IST');
    assert.equal(find('L1', U.leadA, 'email')?.status, 'pending', 'D-147: a Critical L1 is never held');
    assert.equal(find('L2', U.mgrA, 'email')?.status, 'pending', 'L2 is never held');
    const inapp = await pool.query(`select status from notifications where task_id = $1 and event = 'L1' and user_id = $2 and channel = 'inapp'`, [id, U.leadA]);
    assert.equal(inapp.rows[0].status, 'sent', 'in-app is immediate');
  });
});

describe('Dashboards', () => {
  it('FR-11 accountability: entity figures match a manual count', async () => {
    const res = await (await as(U.cos)).get('/api/reports/accountability?days=30');
    assert.equal(res.status, 200);
    const bais = res.body.byEntity.find((e: any) => e.entityId === 'BAIS');
    const { rows } = await pool.query(
      `select count(*) filter (where ${OPEN}) as open, count(*) filter (where ${OPEN} and level >= 2) as red,
              count(*) filter (where ${OPEN} and level between 0 and 1) as amber, count(*) filter (where status = 'blocked') as blocked
         from tasks where entity_id = 'BAIS'`,
    );
    assert.deepEqual([bais.open, bais.red, bais.amber, bais.blocked], [rows[0].open, rows[0].red, rows[0].amber, rows[0].blocked]);
    const csv = await fetch(`${base}/api/reports/accountability/export.csv?days=30`, { headers: { cookie: (await as(U.cos)).cookie } });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /By entity/);
    const pdf = await fetch(`${base}/api/reports/accountability/export.pdf?days=30`, { headers: { cookie: (await as(U.cos)).cookie } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });

  it('FR-11 accountability: a lead’s report covers only themselves and their line; staff get 403 (RPT-01-AC-1, D-123)', async () => {
    const res = await (await as(U.leadB)).get('/api/reports/accountability?days=30');
    assert.equal(res.status, 200);
    for (const p of res.body.byPerson) assert.ok(![U.mgrB, U.leadA, U.staffA1, U.cos].includes(p.userId), `person ${p.userId}`);
    assert.equal((await (await as(U.staffB1)).get('/api/reports/accountability?days=30')).status, 403);
  });

  it('RPT-01…04: report scope, options, payload, CSV and validation', async () => {
    const staff = await as(U.staffB1);
    for (const path of ['/api/reports', '/api/reports/scope', '/api/reports/options', '/api/reports/completion/export.csv', '/api/reports/accountability/export.pdf']) {
      assert.equal((await staff.get(path)).status, 403, path);
    }
    const lead = await as(U.leadB);
    const cos = await as(U.cos);
    assert.deepEqual((await lead.get('/api/reports/scope')).body, { scope: 'team' });
    assert.deepEqual((await cos.get('/api/reports/scope')).body, { scope: 'org' });

    // RPT-04-AC-1: a lead's options are their line (plus themselves as giver) and those people's teams.
    const opts = (await lead.get('/api/reports/options')).body;
    const ppl = opts.people.map((p: any) => p.id);
    const giv = opts.givers.map((p: any) => p.id);
    assert.ok(ppl.includes(U.staffB1) && !ppl.includes(U.staffA1) && !ppl.includes(U.leadB), 'people');
    assert.ok(giv.includes(U.leadB) && !giv.includes(U.mgrB) && !giv.includes(U.staffB1), 'givers');

    // RPT-01-AC-2: whatever filter is sent, a lead never gets a task outside what they may see.
    const { rows: visible } = await pool.query(`select id from tasks where status <> 'draft' and (assignee_id = any($1) or assigner_id = $2 or created_by = $2 or reviewer_id = $2)`, [[U.leadB, U.staffB1], U.leadB]);
    const ids = new Set(visible.map((r) => r.id));
    for (const q of ['', `?userId=${U.staffA1}`, '?from=2020-01-01']) {
      const r = await lead.get(`/api/reports${q}`);
      assert.equal(r.status, 200, q);
      for (const t of r.body.overdue) assert.ok(ids.has(t.id), `task ${t.id} via ${q}`);
      if (q.includes('userId')) assert.equal(r.body.summary.openNow, 0);
    }

    // RPT-02-AC-1 (partial): org Open now equals a count of open non-draft tasks.
    const org = (await cos.get('/api/reports?from=2020-01-01')).body;
    const { rows } = await pool.query(`select count(*)::int as n from tasks where status in ('assigned','in_progress','blocked','changes_requested','reopened','submitted')`);
    assert.equal(org.summary.openNow, rows[0].n);
    assert.equal(org.scope, 'org');
    // RPT-02-AC-6: no contact details anywhere in the payload.
    assert.doesNotMatch(JSON.stringify(org), /@example\.com|\+1415|"email"|"phone"/);

    // RPT-02-AC-2 and filter validation.
    const bad = await cos.get('/api/reports?from=2026-11-05&to=2026-11-01');
    assert.equal(bad.status, 422);
    assert.ok(bad.body.fields.from);
    assert.equal((await cos.get('/api/reports?from=nope')).status, 422);
    assert.equal((await cos.get('/api/reports?teamId=999999')).status, 422);
    assert.equal((await cos.get('/api/reports?surprise=1')).status, 422);
    assert.equal((await cos.get('/api/reports/accountability?days=8')).status, 422);
    // RPT-02-AC-5
    assert.equal((await cos.get('/api/reports/unknown/export.csv')).status, 404);

    // RPT-03-AC-1: CSV columns and numbers equal the screen.
    const csv = await fetch(`${base}/api/reports/teams/export.csv?from=2020-01-01`, { headers: { cookie: cos.cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition') ?? '', /taskwatch-report-teams-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = (await csv.text()).replace(/^\uFEFF/, '').trim().split('\n');
    assert.equal(lines[0], 'Department,Created,Completed,Completion,On-time,Open now,Overdue now,Escalations');
    assert.equal(lines.length - 1, org.teamRows.length);
  });

  /** Every task a dashboard payload names: briefs ({title, assignee}) and `taskId` fields, wherever they sit. */
  const namedTasks = (body: unknown) => {
    const out: { id: number; assigneeId?: number }[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, any>;
      if ('title' in o && o.assignee && typeof o.id === 'number') out.push({ id: o.id, assigneeId: o.assignee.id });
      if (typeof o.taskId === 'number') out.push({ id: o.taskId });
      Object.values(o).forEach(walk);
    };
    walk(body);
    return out;
  };
  const OPEN_STATUSES = ['assigned', 'in_progress', 'blocked', 'changes_requested', 'reopened', 'submitted'];

  it('DASH-01-AC-7 (WO AC-8): the executive dashboard’s entity counts match a manual count', async () => {
    await newTask(U.leadA, U.staffA1, 'high', 30, 'BAIS', 'Dashboard count sample');
    const cos = await as(U.cos);
    const res = await cos.get('/api/dashboard?range=30&entity=BAIS');
    assert.equal(res.status, 200);
    assert.equal(res.body.layout, 'executive');
    const bais = res.body.entities.find((e: any) => e.id === 'BAIS');
    const rows = (await cos.get('/api/tasks?scope=all&view=all')).body.items.filter((t: any) => t.entityId === 'BAIS' && OPEN_STATUSES.includes(t.status));
    assert.deepEqual(
      [bais.active, bais.overdue, bais.escalated],
      [rows.length, rows.filter((t: any) => t.overdue).length, rows.filter((t: any) => t.level >= 1).length],
    );
    const { rows: sql } = await pool.query(`select count(*)::int n from tasks where entity_id = 'BAIS' and ${OPEN}`);
    assert.equal(bais.active, sql[0].n);
    const baisIds = new Set((await cos.get('/api/tasks?scope=all&view=all')).body.items.filter((t: any) => t.entityId === 'BAIS').map((t: any) => t.id));
    assert.ok(namedTasks({ attention: res.body.attention, entities: res.body.entities }).every((t) => baisIds.has(t.id)), 'the entity filter holds');
  });

  it('DASH-03-AC-1/3 (WO AC-6): a staff dashboard names only that person’s own tasks', async () => {
    await newTask(U.leadB, U.staffB1, 'normal', 10, 'EMB', 'Staff B1 dashboard task');
    const staff = await as(U.staffB1);
    const res = await staff.get('/api/dashboard?range=7');
    assert.equal(res.status, 200);
    assert.equal(res.body.layout, 'staff');
    assert.equal(res.body.scopeLabel, 'Your assigned work');
    const visible = new Set((await staff.get('/api/tasks?scope=all&view=all')).body.items.map((t: any) => t.id));
    const named = namedTasks(res.body);
    assert.ok(named.length > 0, 'the staff dashboard shows the person’s task');
    for (const t of named) {
      assert.ok(visible.has(t.id), `task ${t.id} is visible to the staff member`);
      if (t.assigneeId !== undefined) assert.equal(t.assigneeId, U.staffB1);
    }
    for (const k of ['staff', 'staffByRole', 'orgMini', 'recentAdmin', 'workload']) assert.equal(res.body[k], undefined, `no ${k} for staff`);
    assert.ok(res.body.me && 'loadPercent' in res.body.me, 'PERF-07 tiles');
  });

  it('DASH-01: only organization-wide viewers filter by entity; range and entity are validated', async () => {
    const lead = await as(U.leadA);
    assert.deepEqual((await lead.get('/api/dashboard?entity=BAIS')).body, { error: "You don't have permission to filter by entity." });
    const bad = await lead.get('/api/dashboard?range=15');
    assert.equal(bad.status, 422);
    assert.equal(bad.body.fields.range, 'Choose 7, 30 or 90 days.');
    assert.equal((await (await as(U.cos)).get('/api/dashboard?entity=NOPE')).status, 422);
    const ceo = await (await as(U.ceo)).get('/api/dashboard?entity=EMB');
    assert.equal(ceo.status, 200, 'D-33: the CEO is organization-wide');
    assert.deepEqual(ceo.body.entities.map((e: any) => e.id), ['EMB']);
  });

  it('DASH-03-AC-2: a lead’s dashboard covers their line and carries no organization-wide staff figures', async () => {
    const lead = await as(U.leadA);
    const res = await lead.get('/api/dashboard');
    assert.equal(res.body.layout, 'lead');
    assert.equal(res.body.scopeLabel, 'Your reporting line · 2 people');
    for (const k of ['staff', 'staffByRole', 'orgMini', 'recentAdmin']) assert.equal(res.body[k], undefined);
    assert.equal(res.body.l3Banner, null, 'DASH-01-AC-6: the L3 banner is for the Founder’s Office only');
    assert.ok(res.body.workload.every((w: any) => [U.staffA1, U.staffA2].includes(w.id)));
    const visible = new Set((await lead.get('/api/tasks?scope=all&view=all')).body.items.map((t: any) => t.id));
    assert.ok(namedTasks(res.body).every((t) => visible.has(t.id)));
  });

  it('DASH-02: the team overview lists exactly the transitive reports; staff get 403', async () => {
    const mgr = await (await as(U.mgrA)).get('/api/team/overview');
    assert.equal(mgr.status, 200);
    assert.deepEqual(mgr.body.people.map((p: any) => p.id).sort(), [U.leadA, U.staffA1, U.staffA2]);
    assert.equal(mgr.body.directCount, 1);
    assert.ok(mgr.body.workload.length <= 14);
    assert.ok(mgr.body.workload.every((w: any, i: number, a: any[]) => i === 0 || a[i - 1].open >= w.open), 'sorted by open tasks');
    const { rows } = await pool.query(`select count(*)::int n from tasks where assignee_id = any($1) and ${OPEN}`, [[U.leadA, U.staffA1, U.staffA2]]);
    assert.equal(mgr.body.stats.open, rows[0].n);
    assert.ok(!JSON.stringify(mgr.body).includes('@example.com'), 'no contact details');
    assert.deepEqual((await (await as(U.staffA1)).get('/api/team/overview')).body, { error: "You don't have permission to view your team." });
  });

  it('TASK-10: summary tiles add up, and every row carries its stage', async () => {
    for (const who of [U.staffA1, U.leadA, U.cos]) {
      const c = await as(who);
      const s = (await c.get('/api/tasks/summary')).body;
      assert.equal(s.open, s.onTrack + s.amber + s.red, `TASK-10-AC-2 for user ${who}`);
      for (const t of (await c.get('/api/tasks?scope=all&view=all')).body.items as any[]) {
        const expected = ['completed', 'cancelled', 'draft'].includes(t.status) ? null : t.level >= 2 ? 'red' : t.level >= 0 ? 'amber' : 'on_track';
        assert.equal(t.stage, expected, `stage of task ${t.id}`);
      }
    }
  });

  it('SRCH-01: scoped to what the caller may see, capped, without contact details', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'low', 72, 'BAIS', 'Search target alpha');
    const staffB = await as(U.staffB1);
    assert.deepEqual((await staffB.get(`/api/search?q=${id}`)).body.tasks, [], 'SRCH-01-AC-1: another team’s task id finds nothing');
    const lead = await as(U.leadA);
    assert.equal((await lead.get(`/api/search?q=TW-${id}`)).body.tasks[0].id, id, 'exact id first');
    assert.equal((await lead.get('/api/search?q=search%20target')).body.tasks[0].title, 'Search target alpha');

    const names = async (c: Client, q: string) => (await c.get(`/api/search?q=${encodeURIComponent(q)}`)).body.people.map((p: any) => p.name);
    assert.deepEqual(await names(lead, 'Lead B'), [], 'SRCH-01-AC-3: a peer lead is out of scope');
    assert.deepEqual(await names(lead, 'Manager A'), ['Manager A'], 'one’s own manager is found');

    const all = await lead.get('/api/search?q=a');
    assert.ok(all.body.tasks.length <= 8 && all.body.people.length <= 6, 'SRCH-01-AC-2');
    assert.ok(!JSON.stringify(all.body).includes('@example.com'), 'SRCH-01-AC-5: no email');
    assert.ok(!all.body.people.some((p: any) => 'email' in p || 'phone' in p));

    const pct = (await lead.get('/api/search?q=%25')).body;
    assert.deepEqual([pct.tasks, pct.people, pct.teams], [[], [], []], 'SRCH-01-AC-4: % is literal');
    assert.deepEqual((await lead.get('/api/search?q=')).body, { tasks: [], people: [], teams: [] });
    const long = await lead.get(`/api/search?q=${'x'.repeat(101)}`);
    assert.equal(long.status, 422);
    assert.equal(long.body.fields.q, 'Search text is too long.');
    assert.deepEqual((await (await as(U.staffA1)).get('/api/search?q=a')).body.teams, [], 'teams only for those who supervise');
  });
});

describe('Recurring schedules (REC-01…04)', () => {
  const IST = 'Asia/Kolkata';
  /** The next IST calendar day at `hour`:00 IST; moves the clock forward only. */
  const nextIstDay = (hour: number) => {
    const d = DateTime.fromJSDate(now, { zone: IST }).plus({ days: 1 }).startOf('day').set({ hour });
    setNow(d.toJSDate());
    return d.toISODate()!;
  };
  const schedule = (o: Record<string, unknown> = {}) => ({
    title: 'Daily bank reconciliation', category: 'Operations', priority: 'normal', assigneeId: U.staffA1,
    frequency: 'daily', interval: 1, startDate: DateTime.fromJSDate(now, { zone: IST }).toISODate(), dueHour: 17, ...M, ...o,
  });
  const generated = async (sid: number) =>
    (await pool.query(`select id, title, due_at, occurrence_date::text as day, assigner_id, status from tasks where recurring_id = $1 order by id`, [sid])).rows;
  let sid = 0;

  it('REC-02-AC-5, REC-04-AC-1/2/5/7: a daily schedule makes one task per day in the assignee’s zone', async () => {
    const day = nextIstDay(9);
    const res = await (await as(U.leadA)).post('/api/recurring', schedule({ startDate: day }));
    assert.equal(res.status, 201);
    assert.equal(res.body.generated, 1, 'today’s occurrence is created in the same request');
    sid = res.body.id;
    const [t] = await generated(sid);
    assert.equal(t.title, `Daily bank reconciliation — ${day}`);
    assert.equal(t.day, day);
    assert.equal(t.due_at.getTime(), DateTime.fromISO(`${day}T17:00`, { zone: IST }).toMillis(), '17:00 IST');
    assert.equal(t.assigner_id, U.leadA, 'the owner is the giver');
    assert.equal(t.status, 'assigned');
    const note = await pool.query(`select 1 from notifications where task_id = $1 and user_id = $2 and channel = 'inapp'`, [t.id, U.staffA1]);
    assert.equal(note.rowCount, 1, 'the assignment notification');
    assert.equal(await runRecurring(), 0, 'a second run the same day makes nothing');

    const next = nextIstDay(8);
    const [a, b] = await Promise.all([runRecurring(), runRecurring()]);
    assert.equal(a + b, 1, 'two scheduler instances together make one task');
    assert.deepEqual((await generated(sid)).map((x) => x.day), [day, next]);
  });

  it('REC-02-AC-1/2/6: field rules, scope and the sensitive-ID guard', async () => {
    const lead = await as(U.leadA);
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ title: 'abc' }, 'title', 'Give the schedule a title of at least 4 characters.'],
      [{ frequency: 'weekly', weekdays: [] }, 'weekdays', 'Pick at least one weekday.'],
      [{ interval: 0 }, 'interval', 'Between 1 and 365.'],
      [{ interval: 366 }, 'interval', 'Between 1 and 365.'],
      [{ startDate: '2027-02-01', endDate: '2027-01-01' }, 'endDate', 'End date must be after the start date.'],
      [{ dueHour: 24 }, 'dueHour', 'Between 0 and 23.'],
      [{ category: 'Gardening' }, 'category', 'Choose a category.'],
      [{ assigneeId: U.staffB1 }, 'assigneeId', 'You can only assign to people below you in the reporting line.'],
    ];
    for (const [patch, field, msg] of cases) {
      const res = await lead.post('/api/recurring', schedule(patch));
      assert.equal(res.status, 422, field);
      assert.equal(res.body.fields?.[field], msg, field);
    }
    assert.equal((await lead.post('/api/recurring', schedule({ title: 'Biometrics for A123-456-789' }))).status, 422, 'C-6');
    assert.equal((await lead.post('/api/recurring', { ...schedule(), extra: 1 })).status, 422, 'unknown field');
    const { rows } = await pool.query(`select count(*)::int as n from recurring_tasks`);
    assert.equal(rows[0].n, 1, 'nothing was saved');
  });

  it('REC-01-AC-1…5 and REC-02-AC-3: who sees and who may edit', async () => {
    assert.equal((await (await as(U.staffA1)).get('/api/recurring')).status, 403, 'no create_tasks');
    const row = async (u: number) => (await (await as(u)).get('/api/recurring')).body.find((r: any) => r.id === sid);
    assert.equal((await row(U.leadA)).canEdit, true, 'owner');
    assert.equal((await row(U.mgrA)).canEdit, false, 'the assignee is below the manager');
    assert.equal((await row(U.cos)).canEdit, true, 'CoS');
    assert.equal(await row(U.leadB), undefined, 'another branch sees nothing');
    const r = await row(U.leadA);
    const today = DateTime.fromJSDate(now, { zone: IST }).toISODate()!;
    assert.equal(r.next.length, 3);
    assert.ok(r.next.every((d: string) => d > today), 'REC-01-AC-4: after today in the assignee’s zone');
    assert.equal(r.summary, 'Every day');
    assert.equal(r.instances, 2);

    const edit = schedule({ title: 'Daily bank reconciliation (all accounts)' });
    const mgr = await (await as(U.mgrA)).req('PUT', `/api/recurring/${sid}`, edit);
    assert.deepEqual([mgr.status, mgr.body.error], [403, 'Only the owner can edit this schedule.']);
    assert.deepEqual(await (await as(U.leadB)).req('PUT', `/api/recurring/${sid}`, edit), await (await as(U.leadB)).req('PUT', '/api/recurring/999999', edit), 'not visible = missing');
    assert.equal((await (await as(U.leadA)).req('PUT', `/api/recurring/${sid}`, edit)).status, 200);
    assert.equal((await generated(sid)).length, 2, 'an edit never duplicates today’s task');
  });

  it('REC-03, D-45: pause stops generation, resume does not backfill, delete is soft and keeps tasks', async () => {
    const lead = await as(U.leadA);
    assert.equal((await (await as(U.mgrA)).post(`/api/recurring/${sid}/active`, { active: false })).status, 403);
    assert.equal((await lead.post(`/api/recurring/${sid}/active`, { active: false })).status, 200);
    nextIstDay(9);
    assert.equal(await runRecurring(), 0, 'REC-03-AC-1: paused');
    nextIstDay(9);
    const resumed = await lead.post(`/api/recurring/${sid}/active`, { active: true });
    assert.deepEqual(resumed.body, { ok: true, generated: 1 }, 'today only, the paused day is not backfilled');
    assert.equal((await generated(sid)).length, 3);

    assert.equal((await (await as(U.mgrA)).req('DELETE', `/api/recurring/${sid}`)).status, 403);
    assert.equal((await lead.req('DELETE', `/api/recurring/${sid}`)).status, 204);
    const { rows } = await pool.query('select deleted_at, active from recurring_tasks where id = $1', [sid]);
    assert.ok(rows[0].deleted_at, 'REC-03-AC-2: the row stays');
    assert.equal(rows[0].active, false);
    assert.equal((await generated(sid)).length, 3, 'generated tasks are kept');
    assert.equal((await lead.get('/api/recurring')).body.some((r: any) => r.id === sid), false, 'archived schedules are hidden');
    assert.equal((await lead.req('DELETE', `/api/recurring/${sid}`)).status, 404, 'deleting twice');
    const audit = await pool.query(`select kind from admin_log where target = $1 order by seq`, [`recurrence:${sid}`]);
    assert.deepEqual(audit.rows.map((x) => x.kind), ['recurrence.created', 'recurrence.updated', 'recurrence.paused', 'recurrence.resumed', 'recurrence.deleted'], 'REC-03-AC-3, REC-02-AC-4');
  });

  it('REC-04-AC-6, D-46: an occurrence the owner may no longer assign is skipped and logged once', async () => {
    nextIstDay(8);
    const tomorrow = DateTime.fromJSDate(now, { zone: IST }).plus({ days: 1 }).toISODate();
    const res = await (await as(U.leadA)).post('/api/recurring', schedule({ title: 'Weekly file audit', frequency: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: tomorrow }));
    assert.deepEqual([res.status, res.body.generated], [201, 0], 'starts tomorrow');
    await pool.query('update recurring_tasks set assignee_id = $2 where id = $1', [res.body.id, U.staffB1]); // test data: the assignee moved out of scope
    const day = nextIstDay(9);
    assert.equal(await runRecurring(), 0);
    assert.equal((await generated(res.body.id)).length, 0);
    assert.equal(await runRecurring(), 0);
    const log = await pool.query(`select note, source from admin_log where kind = 'recurring_skipped' and target = $1`, [`recurrence:${res.body.id}`]);
    assert.equal(log.rowCount, 1, 'logged once, not on every run');
    assert.equal(log.rows[0].source, 'system');
    assert.match(log.rows[0].note, new RegExp(`^${day}: You can only assign to people below you`));
  });
});

describe('Organizations (T-3.0, ADR-0010): no data or link crosses an organization', () => {
  it('a second organization has its own directory, and the database refuses links across organizations', async () => {
    await pool.query(`insert into organizations (id, name) values (2, 'Other Org') on conflict do nothing`);
    await pool.query(`insert into entities (id, name, organization_id) values ('OTH', 'Other entity', 2) on conflict do nothing`);
    await pool.query(
      `insert into users (id, name, email, entity_id, roles, time_zone, created_at, organization_id) values (900, 'Other CoS', 'cos900@example.com', 'OTH', '{cos}', 'UTC', now(), 2)
       on conflict do nothing`,
    );
    invalidateDirectory();
    assert.ok(!(await getDirectory(1)).get(900), 'organization 1 never sees organization 2 people');
    assert.deepEqual((await getDirectory(2)).all().map((u) => u.id), [900]);
    const crossLink = (sql: string, params: unknown[]) => pool.query(sql, params).then(() => 'inserted', (e) => e.code);
    assert.equal(await crossLink(`update users set manager_id = 900 where id = $1`, [U.staffA1]), '23503', 'manager in another organization');
    assert.equal(
      await crossLink(
        `insert into tasks (title, entity_id, assignee_id, assigner_id, created_by, reviewer_id, priority, instructions, due_at, original_due_at, created_at, assigned_at, clock_started_at, updated_at, organization_id)
         values ('x', 'BAIS', 900, $1, $1, $1, 'normal', '', now(), now(), now(), now(), now(), now(), 1)`,
        [U.mgrA],
      ),
      '23503',
      'assignee in another organization',
    );
    const other = await as(900);
    assert.deepEqual((await other.get('/api/me')).body.organization, { id: 2, name: 'Other Org' });
    assert.ok(!(await other.get('/api/tasks/options/assignees')).body.some((u: { id: number }) => u.id !== 900), 'assignable people stay inside the organization');
  });
});

describe('Role matrix (T-3.1; ROLE-01, ROLE-02)', () => {
  it('TC-ROLE-01-01: needs manage_roles; the defaults and active-role counts of the caller\'s organization; CoS shown as everything', async () => {
    const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import('@taskwatch/shared/permissions');
    const denied = await (await as(U.mgrA)).get('/api/roles');
    assert.deepEqual(denied, { status: 403, body: { error: "You don't have permission to manage roles." } });
    const res = await (await as(U.cos)).get('/api/roles');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.matrix, { ...DEFAULT_ROLE_PERMISSIONS, cos: [...PERMISSIONS] }, 'ROLE-01-AC-2/3');
    const { rows } = await pool.query(`select unnest(roles) r, count(*)::int n from users where organization_id = 1 and active group by 1`);
    for (const { r, n } of rows) assert.equal(res.body.counts[r], n, `count for ${r}`);
    assert.equal(res.body.counts.cos, rows.find((x: { r: string }) => x.r === 'cos')?.n);
  });

  it('TC-ROLE-02-01: CoS column locked; unknown role 404; unknown permissions dropped; the diff is audited; effect on the next request', async () => {
    const cos = await as(U.cos);
    try {
      assert.deepEqual(await cos.put('/api/roles/cos', { permissions: [] }), {
        status: 403,
        body: { error: 'Chief of Staff always has full platform authority and cannot be edited.' },
      });
      assert.equal((await cos.put('/api/roles/admin', { permissions: [] })).status, 404);
      assert.equal((await cos.put('/api/roles/lead', { permissions: 'view_tasks' })).status, 422);
      const before = (await cos.get('/api/roles')).body.matrix;
      const res = await cos.put('/api/roles/manager', { permissions: [...before.manager, 'manage_roles', 'not_a_permission'] });
      assert.equal(res.status, 200);
      assert.ok(res.body.manager.includes('manage_roles') && !res.body.manager.includes('not_a_permission'), 'ROLE-02-AC-3');
      assert.deepEqual(res.body.lead, before.lead, 'saving one role leaves the others as they were');
      const { rows } = await pool.query(`select kind, target, before, after from admin_log where kind = 'role.permissions_changed' order by seq desc limit 1`);
      assert.deepEqual(rows[0], { kind: 'role.permissions_changed', target: 'role:manager', before: { removed: [] }, after: { added: ['manage_roles'] } }, 'ROLE-02-AC-4');
      const mgr = await as(U.mgrA);
      assert.equal((await mgr.get('/api/roles')).status, 200, 'granted: works on the next request');
      await cos.put('/api/roles/manager', { permissions: before.manager });
      assert.equal((await mgr.get('/api/roles')).status, 403, 'revoked: refused on the next request (S-9)');
    } finally {
      await resetRoleMatrix();
    }
  });

  it('emptying every editable role keeps them empty: the defaults never come back on their own', async () => {
    const cos = await as(U.cos);
    try {
      for (const role of ['ceo', 'manager', 'lead', 'staff']) assert.equal((await cos.put(`/api/roles/${role}`, { permissions: [] })).status, 200);
      assert.deepEqual((await (await as(U.mgrA)).get('/api/me')).body.permissions, []);
    } finally {
      await resetRoleMatrix();
    }
  });
});

describe('Server authorization on the shared rules (T-3.2; TASK-04, SEC-1, AC-6)', () => {
  it('TC-TASK-04-02: for every fixture user the task list is exactly what the shared canViewTask allows', async () => {
    const { canViewTask } = await import('@taskwatch/shared/permissions');
    invalidateDirectory();
    const dir = await getDirectory(1);
    const { rows } = await pool.query(
      `select id, assignee_id, assigner_id, created_by, reviewer_id from tasks where organization_id = 1 and ${OPEN}`,
    );
    for (const id of Object.values(U)) {
      const viewer = dir.must(id);
      const expected = rows
        .filter((t) => canViewTask(dir.org, viewer, { assigneeId: t.assignee_id, assignedBy: t.assigner_id, createdBy: t.created_by ?? t.assigner_id, reviewerId: t.reviewer_id }))
        .map((t) => t.id)
        .sort((a, b) => a - b);
      const listed = ((await (await as(id)).get('/api/tasks?view=open')).body.items as { id: number }[]).map((t) => t.id).sort((a, b) => a - b);
      assert.deepEqual(listed, expected, `user ${id}`);
    }
    assert.equal(((await (await as(U.ceo)).get('/api/tasks?view=open')).body.items as unknown[]).length, rows.length, 'D-33: the CEO sees the whole organization');
  });

  it('task rights follow the role matrix on the next request: no assign_tasks, no assigning; no view_tasks, no team tasks', async () => {
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@taskwatch/shared/permissions');
    const cos = await as(U.cos);
    const lead = await as(U.leadA);
    const teamTask = await newTask(U.mgrA, U.staffA1, 'low', 40, 'BAIS', 'Team task for T-3.2');
    try {
      assert.ok((await lead.get(`/api/tasks/${teamTask}`)).status === 200, 'lead sees a report\'s task given by the manager');
      await cos.put('/api/roles/lead', { permissions: DEFAULT_ROLE_PERMISSIONS.lead.filter((p) => p !== 'assign_tasks' && p !== 'view_tasks') });
      const created = await lead.post('/api/tasks', { ...M, title: 'Should fail', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due(localIn(30, 'Asia/Kolkata')) });
      assert.equal(created.status, 403, 'assign_tasks removed');
      assert.deepEqual((await (await as(U.leadA)).get('/api/tasks/options/assignees')).body, [], 'nobody to assign to');
      assert.deepEqual(await lead.get(`/api/tasks/${teamTask}`), await lead.get('/api/tasks/999999'), 'view_tasks removed: same 404 as a missing task');
    } finally {
      await resetRoleMatrix();
    }
    assert.equal((await lead.get(`/api/tasks/${teamTask}`)).status, 200, 'defaults back');
  });

  it('TC-SEC1-01 (organization part): another organization\'s Chief of Staff sees none of these tasks, by list or by id', async () => {
    const other = await as(900); // created in the Organizations suite above
    assert.deepEqual((await other.get('/api/tasks?view=open')).body, { items: [], truncated: false });
    const { rows } = await pool.query(`select id from tasks where organization_id = 1 limit 1`);
    assert.deepEqual(await other.get(`/api/tasks/${rows[0].id}`), await other.get('/api/tasks/999999'));
    const { rows: sched } = await pool.query(`select id from recurring_tasks where organization_id = 1 limit 1`);
    assert.ok(sched[0], 'fixture: organization 1 has a recurring schedule');
    assert.deepEqual((await other.get('/api/recurring')).body, [], 'schedules: none from organization 1');
    assert.deepEqual(await other.post(`/api/recurring/${sched[0].id}/active`, { active: false }), await other.post('/api/recurring/999999/active', { active: false }));
    // KI-39: reset access never reaches another organization's people.
    assert.deepEqual(await other.post(`/api/people/${U.staffA1}/reset-access`), await other.post('/api/people/999999/reset-access'));
    const outbox = (await other.get('/api/deliveries')).body;
    const org1 = new Set((await pool.query('select id from users where organization_id = 1')).rows.map((r) => r.id));
    assert.ok(!outbox.items.some((d: any) => org1.has(d.recipient.id)), 'delivery log: nothing from organization 1');
  });
});

describe('Staff directory and profile (T-3.3; STAFF-01, STAFF-04)', () => {
  const ids = (b: { items: { id: number }[] }) => b.items.map((u) => u.id).sort((a, b) => a - b);

  it('STAFF-01-AC-1/2: manage_staff sees the whole organization with contact details; a lead sees self, reports and managers, without others\' contacts', async () => {
    const { rows } = await pool.query(`select id from users where organization_id = 1 order by id`);
    const all = (await (await as(U.cos)).get('/api/people')).body;
    assert.deepEqual(ids(all), rows.map((r) => r.id), 'every person, active and inactive');
    assert.equal(all.items.find((u: any) => u.id === U.staffA1).email, `user${U.staffA1}@example.com`);
    const lead = (await (await as(U.leadA)).get('/api/people')).body;
    assert.deepEqual(ids(lead), [U.ceo, U.cos, U.mgrA, U.leadA, U.staffA1, U.staffA2]);
    for (const u of lead.items) {
      if (u.id === U.leadA) assert.equal(u.email, `user${U.leadA}@example.com`, 'own contact details');
      else assert.ok(!('email' in u) && !('phone' in u) && !('whatsapp' in u), `no contact details for ${u.id}`);
    }
  });

  it('the directory says who signs in with Google (no password: no reset; a password already set keeps working) and who uses a password', async () => {
    const saved = { ...config.google };
    const domains = (await pool.query('select google_domains from organizations where id = 1')).rows[0].google_domains as string[];
    const hasPw = async (id: number) => (await pool.query('select 1 from user_credentials where user_id = $1 and password_hash is not null', [id])).rowCount! > 0;
    const { rows } = await pool.query(`select id from users where organization_id = 1 and email like '%@example.com' order by id`);
    const withPw: number[] = [], without: number[] = [];
    for (const r of rows) ((await hasPw(r.id)) ? withPw : without).push(r.id);
    const signIn = async (id: number) => (await (await as(U.cos)).get('/api/people')).body.items.find((u: any) => u.id === id).signIn;
    try {
      Object.assign(config.google, { enabled: true });
      await pool.query(`update organizations set google_domains = '{example.com}' where id = 1`);
      assert.ok(withPw.length && without.length, 'fixtures hold people with and without a password');
      assert.equal(await signIn(without[0]!), 'google', 'allowed domain, no password: Google only');
      assert.equal(await signIn(withPw[0]!), 'both', 'allowed domain with a password already set: Google + password');
      await pool.query(`update organizations set google_domains = '{other.example}' where id = 1`);
      assert.equal(await signIn(without[0]!), 'password', 'not on an allowed domain');
      Object.assign(config.google, { enabled: false });
      await pool.query(`update organizations set google_domains = '{example.com}' where id = 1`);
      assert.equal(await signIn(without[0]!), 'password', 'Google sign-in switched off');
    } finally {
      Object.assign(config.google, saved);
      await pool.query('update organizations set google_domains = $1 where id = 1', [domains]);
    }
    const lead = (await (await as(U.leadA)).get('/api/people')).body.items.find((u: any) => u.id === U.staffA1);
    assert.ok(!('signIn' in lead), 'travels with the contact details only');
  });

  it('STAFF-01-AC-3: open and overdue counts match a manual count', async () => {
    const row = (await (await as(U.cos)).get('/api/people')).body.items.find((u: any) => u.id === U.staffA1);
    const { rows } = await pool.query(
      `select count(*) filter (where ${OPEN})::int open, count(*) filter (where ${OPEN} and due_at < $2)::int overdue from tasks where assignee_id = $1`,
      [U.staffA1, now],
    );
    assert.deepEqual({ open: row.openTasks, overdue: row.overdueTasks }, rows[0]);
  });

  it('STAFF-04-AC-1/2/3/4: own and manager profiles open, a peer elsewhere is missing; only visible tasks; permissions are the role union; no foreign contacts', async () => {
    const staff = await as(U.staffA1);
    assert.equal((await staff.get(`/api/people/${U.staffA1}`)).status, 200, 'own profile');
    const mgr = await staff.get(`/api/people/${U.leadA}`);
    assert.equal(mgr.status, 200, 'manager profile');
    assert.ok(!('email' in mgr.body.user), 'AC-4: no contact details of the manager');
    assert.deepEqual(await staff.get(`/api/people/${U.staffB1}`), await staff.get('/api/people/999999'), 'AC-1: another team = missing');
    const visible = new Set(
      [...(await staff.get('/api/tasks?view=open')).body.items, ...(await staff.get('/api/tasks?view=closed')).body.items].map((t: { id: number }) => t.id),
    );
    const p = mgr.body;
    for (const t of [...p.assigned, ...p.created, ...p.escalations.map((e: any) => ({ id: e.taskId })), ...p.activity.map((a: any) => ({ id: a.taskId }))]) {
      assert.ok(visible.has(t.id), `AC-2: task ${t.id} is visible to the viewer`);
    }
    assert.deepEqual(p.reports.map((r: any) => r.id).sort(), [U.staffA1], 'reports filtered to what the viewer may see');
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@taskwatch/shared/permissions');
    assert.deepEqual([...p.permissions].sort(), [...DEFAULT_ROLE_PERMISSIONS.lead].sort(), 'AC-3');
  });

  it('another organization sees only itself in the directory, and organization 1 profiles are missing', async () => {
    const other = await as(900);
    assert.deepEqual(ids((await other.get('/api/people')).body), [900]);
    assert.deepEqual(await other.get(`/api/people/${U.staffA1}`), await other.get('/api/people/999999'));
  });
});

describe('Create and edit people (T-3.4; STAFF-02, STAFF-05, D-75, D-99)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Test Person',
    email: 'test.person@example.com',
    title: 'Analyst',
    roles: ['staff'],
    entityId: 'BAIS',
    teamId: null,
    location: '',
    phone: null,
    whatsapp: null,
    whatsappOptIn: false,
    timezone: '',
    ...over,
  });
  /** The edit body for a person as the directory returns them (the caller manages staff). */
  const inputOf = (r: any) => ({
    name: r.name,
    email: r.email,
    title: r.title,
    roles: r.roles,
    entityId: r.entityId,
    teamId: r.teamId,
    location: r.location,
    phone: r.phone,
    whatsapp: r.whatsapp,
    whatsappOptIn: r.whatsappOptIn && !!r.whatsapp, // fixture rows are opted in without a number; the dialog would make the CoS untick it
    timezone: r.timezone,
  });
  const row = async (id: number) => (await (await as(U.cos)).get(`/api/people/${id}`)).body.user;

  it('STAFF-02-AC-1: each rule answers 422 on its own field with the FRD message', async () => {
    const cos = await as(U.cos);
    const fields = async (over: Record<string, unknown>) => (await cos.post('/api/people', body(over))).body.fields;
    assert.deepEqual(await fields({ name: '  ' }), { name: "Enter the person's name." });
    assert.deepEqual(await fields({ name: 'Ana', email: 'not-an-email' }), { email: 'Enter a valid email address.' }, 'D-136: a single name is a full name');
    assert.deepEqual(await fields({ email: 'not-an-email' }), { email: 'Enter a valid email address.' });
    assert.deepEqual(await fields({ title: ' ' }), { title: 'Enter a job title.' });
    assert.deepEqual(await fields({ roles: [] }), { roles: 'Choose a role.' });
    assert.deepEqual(await fields({ whatsapp: '12345' }), { whatsapp: 'Use international format, e.g. +14155550123.' });
    assert.deepEqual(await fields({ whatsappOptIn: true }), { whatsappOptIn: 'Add a WhatsApp number before opting in.' });
    assert.deepEqual(await fields({ timezone: 'Mars/Base' }), { timezone: 'Unknown time zone' });
    assert.deepEqual(await fields({ entityId: 'NOPE' }), { entityId: 'Choose a vertical.' });
    assert.equal((await cos.post('/api/people', { ...body(), managerId: U.leadA })).status, 422, 'ADR-0011: no managerId; the line is automatic');
    const { rows } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('Embtel team', 'EMB', 1) returning id`);
    assert.deepEqual(await fields({ teamId: rows[0].id }), { teamId: 'Choose a department in this vertical.' });
    assert.equal((await cos.post('/api/people', { ...body(), isAdmin: true })).status, 422, 'unknown fields are refused');
  });

  it('creates with defaults, normalised WhatsApp and an audit row; STAFF-02-AC-2: the same email in other case is a 422, not a 500', async () => {
    const cos = await as(U.cos);
    const res = await cos.post('/api/people', body({ email: 'New.Person@Example.com', whatsapp: '+1 (415) 555-0123', whatsappOptIn: true }));
    assert.equal(res.status, 201);
    const b = res.body;
    assert.deepEqual(
      { email: b.email, whatsapp: b.whatsapp, optIn: b.whatsappOptIn, location: b.location, tz: b.timezone, status: b.status },
      { email: 'new.person@example.com', whatsapp: '+14155550123', optIn: true, location: 'Remote', tz: 'America/New_York', status: 'active' },
    );
    const { rows } = await pool.query(`select kind, context from admin_log where target = $1`, [`user:${b.id}`]);
    assert.deepEqual(rows, [{ kind: 'staff.created', context: 'new.person@example.com' }]);
    const dup = await cos.post('/api/people', body({ email: 'NEW.PERSON@example.COM' }));
    assert.deepEqual({ status: dup.status, fields: dup.body.fields }, { status: 422, fields: { email: 'Another account already uses this email.' } });
  });

  it("STAFF-02-AC-3/4: roles need manage_roles, never one's own, and the last active Chief of Staff keeps the role", async () => {
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@taskwatch/shared/permissions');
    const cos = await as(U.cos);
    assert.deepEqual((await cos.put(`/api/people/${U.cos}`, { ...inputOf(await row(U.cos)), roles: ['cos', 'ceo'] })).body, {
      error: 'You cannot change your own role.',
    });
    try {
      await cos.put('/api/roles/manager', { permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'manage_staff'] });
      const mgr = await as(U.mgrA);
      assert.deepEqual((await mgr.post('/api/people', body({ email: 'c1@example.com', roles: ['cos'] }))).body, {
        error: "You don't have permission to grant Chief of Staff.",
      });
      const staff = inputOf(await row(U.staffA2));
      assert.deepEqual((await mgr.put(`/api/people/${U.staffA2}`, { ...staff, roles: ['lead'] })).body, { error: "You don't have permission to change roles." });
      assert.deepEqual((await row(U.staffA2)).roles, ['staff'], 'nothing changed');
      await cos.put('/api/roles/manager', { permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'manage_staff', 'manage_roles'] });
      const last = await mgr.put(`/api/people/${U.cos}`, { ...inputOf(await row(U.cos)), roles: ['ceo'] });
      assert.deepEqual({ s: last.status, e: last.body.error }, { s: 409, e: 'The organization must keep at least one active Chief of Staff.' });
    } finally {
      await resetRoleMatrix();
    }
  });

  it('D-130: a new person is placed automatically (no department, no general manager: the CoS); role changes are audited', async () => {
    const cos = await as(U.cos);
    const id = (await cos.post('/api/people', body({ email: 'two.roles@example.com' }))).body.id;
    assert.equal((await cos.put(`/api/people/${id}`, { ...inputOf(await row(id)), roles: ['lead', 'staff'] })).status, 200);
    const { rows } = await pool.query(`select before, after from admin_log where target = $1 and kind = 'staff.role_changed'`, [`user:${id}`]);
    assert.deepEqual(rows, [{ before: { roles: ['staff'] }, after: { roles: ['lead', 'staff'] } }]);
    assert.equal((await row(id)).managerId, U.cos, 'BAIS has no general manager in the fixture');
  });

  it("STAFF-05-AC-1 / STAFF-02-AC-6: two roles give exactly the union, on the person's next request", async () => {
    const { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } = await import('@taskwatch/shared/permissions');
    const cos = await as(U.cos);
    const id = (await cos.post('/api/people', body({ email: 'union.person@example.com' }))).body.id;
    const person = await as(id);
    assert.deepEqual((await person.get('/api/me')).body.permissions, ['update_assigned_tasks']);
    await cos.put(`/api/people/${id}`, { ...inputOf(await row(id)), roles: ['lead', 'staff'] });
    const union = PERMISSIONS.filter((p) => DEFAULT_ROLE_PERMISSIONS.lead.includes(p) || DEFAULT_ROLE_PERMISSIONS.staff.includes(p));
    assert.deepEqual((await person.get('/api/me')).body.permissions, union);
  });

  it("D-99: an email change ends the person's sessions and tells the old address", async () => {
    const cos = await as(U.cos);
    const id = (await cos.post('/api/people', body({ email: 'old.address@example.com' }))).body.id;
    const session = await as(id);
    assert.equal((await session.get('/api/me')).status, 200);
    assert.equal((await cos.put(`/api/people/${id}`, { ...inputOf(await row(id)), email: 'new.address@example.com' })).status, 200);
    assert.equal((await new Client(session.cookie).get('/api/me')).status, 401, 'signed out everywhere');
    const { rows } = await pool.query(`select address, event from notifications where user_id = $1 and channel = 'email'`, [id]);
    assert.deepEqual(rows, [{ address: 'old.address@example.com', event: 'email_changed' }]);
    const { rows: audit } = await pool.query(`select before, after from admin_log where target = $1 and kind = 'staff.email_changed'`, [`user:${id}`]);
    assert.deepEqual(audit, [{ before: { email: 'old.address@example.com' }, after: { email: 'new.address@example.com' } }]);
  });
});

describe('Activate and deactivate (T-3.5; STAFF-03)', () => {
  it('STAFF-03-AC-1/2/4: deactivating ends the session at once, reports open tasks, keeps the row; reactivating restores; both audited', async () => {
    const cos = await as(U.cos);
    const held = await as(U.staffA2);
    assert.equal((await held.get('/api/me')).status, 200);
    const { rows: open } = await pool.query(`select count(*)::int n from tasks where assignee_id = $1 and ${OPEN}`, [U.staffA2]);
    try {
      assert.deepEqual((await cos.post(`/api/people/${U.staffA2}/status`, { status: 'inactive' })).body, { openTasks: open[0].n });
      assert.equal((await new Client(held.cookie).get('/api/me')).status, 401, 'AC-1');
      const { rows } = await pool.query('select active, archived_at is not null as archived from users where id = $1', [U.staffA2]);
      assert.deepEqual(rows, [{ active: false, archived: true }], 'AC-4: archived, not deleted');
    } finally {
      assert.equal((await cos.post(`/api/people/${U.staffA2}/status`, { status: 'active' })).status, 200);
      sessions.delete(U.staffA2); // that cached session was ended; later tests sign in afresh
      await restoreLine(U.staffA2, U.leadA); // D-130 re-placed them; later tests use the fixture line
    }
    const { rows: back } = await pool.query('select active, archived_at from users where id = $1', [U.staffA2]);
    assert.deepEqual(back, [{ active: true, archived_at: null }]);
    const { rows: audit } = await pool.query(`select kind, before, after from admin_log where target = $1 and kind like 'staff.%activated' order by seq`, [`user:${U.staffA2}`]);
    assert.deepEqual(audit, [
      { kind: 'staff.deactivated', before: { status: 'active' }, after: { status: 'inactive' } },
      { kind: 'staff.activated', before: { status: 'inactive' }, after: { status: 'active' } },
    ]);
  });

  it('STAFF-03-AC-5: not oneself (403), not the last active Chief of Staff (409), not without manage_staff (403), unknown id 404', async () => {
    const { DEFAULT_ROLE_PERMISSIONS } = await import('@taskwatch/shared/permissions');
    const cos = await as(U.cos);
    assert.deepEqual((await cos.post(`/api/people/${U.cos}/status`, { status: 'inactive' })).body, { error: 'You cannot deactivate your own account.' });
    assert.equal((await (await as(U.leadA)).post(`/api/people/${U.staffA1}/status`, { status: 'inactive' })).status, 403);
    assert.equal((await cos.post('/api/people/999999/status', { status: 'inactive' })).status, 404);
    assert.equal((await cos.post(`/api/people/${U.staffA1}/status`, { status: 'archived' })).status, 422);
    try {
      await cos.put('/api/roles/manager', { permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'manage_staff'] });
      const last = await (await as(U.mgrA)).post(`/api/people/${U.cos}/status`, { status: 'inactive' });
      assert.deepEqual({ s: last.status, e: last.body.error }, { s: 409, e: 'The organization must keep at least one active Chief of Staff.' });
    } finally {
      await resetRoleMatrix();
    }
  });
});

describe('Organisation view and placement (T-3.6; ORG-01, ORG-02)', () => {
  it('ORG-01: entities and teams of the caller\'s organization only, the visible people with load counts, the overload threshold', async () => {
    const cos = (await (await as(U.cos)).get('/api/org')).body;
    assert.deepEqual(cos.entities.map((e: { id: string }) => e.id).sort(), ['BAIS', 'EMB', 'FO'], 'no entity of organization 2');
    assert.ok(cos.teams.every((t: { entityId: string }) => ['BAIS', 'EMB', 'FO'].includes(t.entityId)));
    assert.equal(cos.overloadThreshold, 6);
    const people = (await (await as(U.cos)).get('/api/people')).body.items;
    assert.deepEqual(cos.people.map((p: { id: number }) => p.id), people.map((p: { id: number }) => p.id));
    const leadClient = await as(U.leadA);
    const lead = (await leadClient.get('/api/org')).body;
    const leadPeople = (await leadClient.get('/api/people')).body.items;
    assert.deepEqual(lead.people.map((p: { id: number }) => p.id), leadPeople.map((p: { id: number }) => p.id), 'the same canViewUser scope as the directory');
    assert.ok(!lead.people.some((p: { id: number }) => p.id === U.staffB1), 'not another line');
  });

  it('ORG-02 / D-130: placement moves the department only, inside the vertical; the reporting line follows the department lead', async () => {
    const cos = await as(U.cos);
    const { rows: emb } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('Embtel placement', 'EMB', 1) returning id`);
    const bad = await cos.put(`/api/people/${U.staffA2}/placement`, { teamId: emb[0].id });
    assert.deepEqual({ s: bad.status, f: bad.body.fields }, { s: 422, f: { teamId: 'Choose a department in this vertical.' } });
    assert.equal((await cos.put(`/api/people/${U.staffA2}/placement`, { managerId: U.mgrA })).status, 422, 'no managerId');
    const { rows: led } = await pool.query(`insert into teams (name, entity_id, lead_id, organization_id) values ('BAIS led', 'BAIS', $1, 1) returning id`, [U.leadA]);
    try {
      const moved = await cos.put(`/api/people/${U.staffA2}/placement`, { teamId: led[0].id });
      assert.deepEqual([moved.body.teamId, moved.body.managerId], [led[0].id, U.leadA], 'reports to the department lead');
      const { rows: audit } = await pool.query(`select kind from admin_log where target = $1 order by seq desc limit 1`, [`user:${U.staffA2}`]);
      assert.equal(audit[0].kind, 'staff.team_changed', 'the line was already the lead: no manager change to audit');
    } finally {
      await restoreLine(U.staffA2, U.leadA);
    }
  });

  it('ORG-02-AC-3: a manager with manage_team moves a report between teams, but nobody outside the line and no reporting lines', async () => {
    // ADR-0011: departments led by Lead A, so moving Staff A1 between them keeps them in Manager A's line (D-130).
    const { rows } = await pool.query(`insert into teams (name, entity_id, lead_id, organization_id) values ('BAIS one', 'BAIS', $1, 1), ('BAIS two', 'BAIS', $1, 1) returning id`, [U.leadA]);
    const mgr = await as(U.mgrA);
    try {
      assert.equal((await mgr.put(`/api/people/${U.staffA1}/placement`, { teamId: rows[0].id })).body.teamId, rows[0].id);
      assert.equal((await mgr.put(`/api/people/${U.staffA1}/placement`, { teamId: rows[1].id })).body.teamId, rows[1].id);
      assert.deepEqual((await mgr.put(`/api/people/${U.staffB1}/placement`, { teamId: rows[0].id })).body, { error: 'You cannot move this person between departments.' });
      assert.equal((await mgr.put(`/api/people/${U.staffA1}/placement`, { managerId: U.mgrA })).status, 422, 'no managerId');
    } finally {
      await restoreLine(U.staffA1, U.leadA);
    }
  });
});

describe('Verticals and departments (ADR-0011; D-129…D-131)', () => {
  const person = (email: string, roles: string[], entityId: string, teamId: number | null = null) => ({ name: `Test ${email.split('@')[0]}`, email, title: 'Test', roles, entityId, teamId });
  const line = async (id: number) => (await pool.query('select manager_id, entity_id, team_id from users where id = $1', [id])).rows[0];

  it('only manage_staff manages verticals; codes and names are checked; a general manager needs the Manager role', async () => {
    const cos = await as(U.cos);
    assert.equal((await (await as(U.mgrA)).post('/api/entities', { id: 'NOPE', name: 'Nope' })).status, 403);
    assert.deepEqual((await cos.post('/api/entities', { id: 'b', name: 'Bad code' })).body.fields, { id: 'Use 2–10 capital letters or digits, e.g. BAIS.' });
    assert.deepEqual((await cos.post('/api/entities', { id: 'BAIS', name: 'Taken' })).body.fields, { id: 'This code or name is already in use.' });
    assert.deepEqual((await cos.post('/api/entities', { id: 'VX', name: 'Vertical X', headId: U.staffB1 })).body.fields, { headId: 'Choose someone with the Manager role.' });
    assert.equal((await cos.post('/api/entities', { id: 'VX', name: 'Vertical X', extra: 1 })).status, 422, 'unknown fields are refused');
  });

  it('D-130 end to end: GM → CoS, lead → GM, member → lead, else GM, else CoS; changes follow the structure and are audited', async () => {
    const cos = await as(U.cos);
    assert.equal((await cos.post('/api/entities', { id: 'TV', name: 'Test Vertical' })).status, 201);
    const gm = (await cos.post('/api/people', person('tv.gm@example.com', ['manager'], 'TV'))).body.id;
    const lead = (await cos.post('/api/people', person('tv.lead@example.com', ['lead'], 'TV'))).body.id;
    assert.equal((await line(gm)).manager_id, U.cos, 'no GM yet: the CoS');
    assert.equal((await cos.put('/api/entities/TV', { name: 'Test Vertical', headId: gm })).status, 204);
    const sales = (await cos.post('/api/teams', { entityId: 'TV', name: 'Sales', leadId: lead })).body.id;
    const marketing = (await cos.post('/api/teams', { entityId: 'TV', name: 'Marketing' })).body.id;
    assert.deepEqual((await cos.post('/api/teams', { entityId: 'TV', name: 'sales' })).body.fields, { name: 'This vertical already has a department with this name.' });
    const seller = (await cos.post('/api/people', person('tv.seller@example.com', ['staff'], 'TV', sales))).body.id;
    const marketer = (await cos.post('/api/people', person('tv.marketer@example.com', ['staff'], 'TV', marketing))).body.id;
    assert.deepEqual(
      [(await line(gm)).manager_id, (await line(lead)).manager_id, (await line(seller)).manager_id, (await line(marketer)).manager_id],
      [U.cos, gm, lead, gm],
      'GM → CoS, lead → GM, member → lead, member without a lead → GM',
    );
    // The GM sees the whole vertical through the line.
    const seen = (await (await as(gm)).get('/api/people')).body.items.map((p: { id: number }) => p.id);
    assert.ok([lead, seller, marketer].every((id) => seen.includes(id)), 'the general manager sees the vertical');
    // The department loses its lead: its people move to the GM. The vertical loses its GM: everyone to the CoS.
    assert.equal((await cos.put(`/api/teams/${sales}`, { name: 'Sales', leadId: null })).status, 204);
    assert.equal((await line(seller)).manager_id, gm);
    assert.equal((await cos.put('/api/entities/TV', { name: 'Test Vertical', headId: null })).status, 204);
    assert.deepEqual([(await line(seller)).manager_id, (await line(marketer)).manager_id, (await line(lead)).manager_id], [U.cos, U.cos, U.cos]);
    const { rows: audit } = await pool.query(`select after from admin_log where kind = 'staff.manager_changed' and target = $1 order by seq desc limit 1`, [`user:${seller}`]);
    assert.deepEqual(audit[0].after, { managerId: U.cos, automatic: true });
    // Never deleted: a department or vertical with active people cannot be archived.
    assert.equal((await cos.post(`/api/teams/${marketing}/archive`)).status, 409);
    assert.equal((await cos.post('/api/entities/TV/archive')).status, 409);
    for (const id of [gm, lead, seller, marketer]) await cos.post(`/api/people/${id}/status`, { status: 'inactive' });
    assert.equal((await cos.post(`/api/teams/${marketing}/archive`)).status, 204);
    assert.equal((await cos.post('/api/teams', { entityId: 'TV', name: 'Marketing' })).status, 201, 'review fix #6: an archived name is free again');
    // The vertical is archived next, so its new department goes with it.
    assert.equal((await cos.post('/api/entities/TV/archive')).status, 204);
    assert.ok(!(await cos.get('/api/entities')).body.some((e: { id: string }) => e.id === 'TV'), 'archived verticals leave the pickers');
  });
});

describe('Review fixes 2026-11-11: no stale posts, no reporting loops', () => {
  it('#1/#2: a lead moved to another department leaves the old one; swapping two leads never loops', async () => {
    const cos = await as(U.cos);
    assert.equal((await cos.post('/api/entities', { id: 'LV', name: 'Loop Vertical' })).status, 201);
    const mk = async (email: string, roles: string[]) => (await cos.post('/api/people', { name: `Test ${email.split('@')[0]}`, email, title: 'Test', roles, entityId: 'LV' })).body.id;
    const a = await mk('lv.a@example.com', ['lead']);
    const b = await mk('lv.b@example.com', ['lead']);
    const t1 = (await cos.post('/api/teams', { entityId: 'LV', name: 'One', leadId: a })).body.id;
    const t2 = (await cos.post('/api/teams', { entityId: 'LV', name: 'Two', leadId: b })).body.id;
    const member = (await cos.post('/api/people', { name: 'Test Member', email: 'lv.m@example.com', title: 'Test', roles: ['staff'], entityId: 'LV', teamId: t1 })).body.id;
    const mgr = async (id: number) => (await pool.query('select manager_id from users where id = $1', [id])).rows[0].manager_id;
    const lead = async (t: number) => (await pool.query('select lead_id from teams where id = $1', [t])).rows[0].lead_id;
    assert.equal(await mgr(member), a);
    // A moves into Two: One loses its lead, its member is re-placed (no GM: the CoS), A reports to B.
    assert.equal((await cos.put(`/api/people/${a}/placement`, { teamId: t2 })).status, 200);
    assert.deepEqual([await lead(t1), await mgr(member), await mgr(a)], [null, U.cos, b]);
    // B moves into One: B now leads nothing there, so B reports to the CoS, and A (still in Two, which lost B) too.
    assert.equal((await cos.put(`/api/people/${b}/placement`, { teamId: t1 })).status, 200);
    assert.deepEqual([await lead(t2), await mgr(b), await mgr(a)], [null, U.cos, U.cos], 'no A↔B loop');
    // Making A the lead of One takes nothing stale along: B (in One) now reports to A.
    assert.equal((await cos.put(`/api/teams/${t1}`, { name: 'One', leadId: a })).status, 204);
    assert.deepEqual([await mgr(a), await mgr(b)], [U.cos, a]);
  });
});

describe('D-137: a lead may run several departments in one vertical', () => {
  it('keeps the home department, sees and receives both, refuses a second vertical, re-homes on loss or archive, leaves all on demotion', async () => {
    const cos = await as(U.cos);
    for (const [id, name] of [['MV', 'Multi Vertical'], ['OV', 'Other Vertical']]) assert.equal((await cos.post('/api/entities', { id, name })).status, 201);
    const mk = async (email: string, roles: string[], entityId = 'MV', teamId: number | null = null) =>
      (await cos.post('/api/people', { name: `Test ${email.split('@')[0]}`, email, title: 'Test', roles, entityId, teamId })).body.id as number;
    const gm = await mk('mv.gm@example.com', ['manager']);
    assert.equal((await cos.put('/api/entities/MV', { name: 'Multi Vertical', headId: gm })).status, 204);
    const p = await mk('mv.p@example.com', ['lead']);
    const q = await mk('mv.q@example.com', ['lead']);
    const row = async (id: number) => (await pool.query('select manager_id, entity_id, team_id from users where id = $1', [id])).rows[0];
    const lead = async (t: number) => (await pool.query('select lead_id from teams where id = $1', [t])).rows[0].lead_id;

    // P leads One (home) and then Two: P stays in One, both departments' people report to P, P to the GM.
    const one = (await cos.post('/api/teams', { entityId: 'MV', name: 'One', leadId: p })).body.id;
    const two = (await cos.post('/api/teams', { entityId: 'MV', name: 'Two', leadId: p })).body.id;
    const m1 = await mk('mv.m1@example.com', ['staff'], 'MV', one);
    const m2 = await mk('mv.m2@example.com', ['staff'], 'MV', two);
    assert.deepEqual([await lead(one), await lead(two)], [p, p]);
    assert.deepEqual(await row(p), { manager_id: gm, entity_id: 'MV', team_id: one }, 'home department kept');
    assert.deepEqual([(await row(m1)).manager_id, (await row(m2)).manager_id], [p, p]);
    const seen = (await (await as(p)).get('/api/people')).body.items.map((x: { id: number }) => x.id);
    assert.ok(seen.includes(m1) && seen.includes(m2), 'scope covers both departments');
    const boards = (await (await as(p)).get('/api/performance/teams')).body.map((t: { id: number }) => t.id);
    assert.ok(boards.includes(one) && boards.includes(two), 'both team boards');

    // A department in another vertical is refused, and nothing changes.
    const refused = await cos.post('/api/teams', { entityId: 'OV', name: 'Far', leadId: p });
    assert.equal(refused.status, 422);
    assert.match(refused.body.fields.leadId, /one vertical/);
    assert.equal((await pool.query(`select 1 from teams where entity_id = 'OV' and name = 'Far'`)).rowCount, 0);
    assert.deepEqual(await row(p), { manager_id: gm, entity_id: 'MV', team_id: one });
    // A lead from another vertical who leads nothing there still moves in (as before).
    const r = await mk('mv.r@example.com', ['lead'], 'OV');
    const three = (await cos.post('/api/teams', { entityId: 'MV', name: 'Three', leadId: r })).body.id;
    assert.deepEqual(await row(r), { manager_id: gm, entity_id: 'MV', team_id: three });

    // P loses One (their home) to Q: P moves home to Two and keeps leading it; One's people now report to Q.
    assert.equal((await cos.put(`/api/teams/${one}`, { name: 'One', leadId: q })).status, 204);
    assert.deepEqual(await row(p), { manager_id: gm, entity_id: 'MV', team_id: two }, 're-homed to the department still led');
    assert.deepEqual([(await row(m1)).manager_id, (await row(m2)).manager_id, (await row(q)).team_id], [q, p, one]);

    // P runs Two (home) and Four; archiving Two moves P to Four instead of blocking, once Two's member has moved.
    const four = (await cos.post('/api/teams', { entityId: 'MV', name: 'Four', leadId: p })).body.id;
    assert.equal((await cos.put(`/api/people/${m2}/placement`, { teamId: four })).status, 200);
    assert.equal((await cos.post(`/api/teams/${two}/archive`)).status, 204);
    assert.deepEqual(await row(p), { manager_id: gm, entity_id: 'MV', team_id: four });
    assert.deepEqual([await lead(four), (await row(m2)).manager_id], [p, p]);

    // P runs Four and Five; losing the Team Lead role leaves both, and their people go to the GM.
    const five = (await cos.post('/api/teams', { entityId: 'MV', name: 'Five', leadId: p })).body.id;
    const demote = await cos.put(`/api/people/${p}`, { name: 'Test mv.p', email: 'mv.p@example.com', title: 'Test', roles: ['staff'], entityId: 'MV', teamId: four });
    assert.equal(demote.status, 200);
    assert.deepEqual([await lead(four), await lead(five), (await row(m2)).manager_id], [null, null, gm]);
  });
});

describe('ADR-0011: same department name in two verticals', () => {
  it('lists spanning verticals say "Sales · CODE"; a list inside one vertical keeps "Sales"', async () => {
    const cos = await as(U.cos);
    for (const id of ['SA', 'SB']) assert.equal((await cos.post('/api/entities', { id, name: `Sales Vertical ${id}` })).status, 201);
    const mk = async (email: string, roles: string[], entityId: string, teamId: number | null = null) =>
      (await cos.post('/api/people', { name: `Test ${email.split('@')[0]}`, email, title: 'Test', roles, entityId, teamId })).body.id as number;
    const lead = await mk('sa.lead@example.com', ['lead'], 'SA');
    const sa = (await cos.post('/api/teams', { entityId: 'SA', name: 'Sales', leadId: lead })).body.id;
    const sb = (await cos.post('/api/teams', { entityId: 'SB', name: 'Sales' })).body.id;
    assert.ok(sa && sb, 'the same name is allowed in two verticals');
    await mk('sa.m@example.com', ['staff'], 'SA', sa);
    await mk('sb.m@example.com', ['staff'], 'SB', sb);
    const named = (list: { id: number; name: string }[]) => Object.fromEntries(list.filter((t) => t.id === sa || t.id === sb).map((t) => [t.id, t.name]));

    const want = { [sa]: 'Sales · SA', [sb]: 'Sales · SB' };
    assert.deepEqual(named((await cos.get('/api/reports/options')).body.teams), want, 'report filter');
    assert.deepEqual(named((await cos.get('/api/performance/teams')).body), want, 'performance picker');
    assert.deepEqual(named((await cos.get('/api/search?q=Sales')).body.teams), want, 'search');
    // The lead sees only their own vertical: plain names.
    assert.deepEqual(named((await (await as(lead)).get('/api/reports/options')).body.teams), { [sa]: 'Sales' });
  });
});

describe('System settings (T-3.7; SET-01)', () => {
  const valid = () => ({
    orgName: 'Vertical',
    timezone: 'America/New_York',
    workdayStart: '09:00',
    workdayEnd: '18:00',
    sessionTimeoutMinutes: 60,
    overloadThreshold: 6,
    digestDay: 1,
    digestHour: 9,
    categories: ['Operations', 'Finance'],
    retentionYears: 7,
    emailSimulation: true,
    whatsappSimulation: true,
  });

  it('SET-01-AC-4: everyone reads the public subset; manage_system_settings reads everything; writing needs it', async () => {
    const staff = (await (await as(U.staffA1)).get('/api/settings')).body;
    assert.deepEqual(Object.keys(staff).sort(), ['categories', 'orgName', 'overloadThreshold', 'standardTasks', 'timezone', 'workdayEnd', 'workdayStart']);
    const full = (await (await as(U.cos)).get('/api/settings')).body;
    assert.equal(full.retentionYears, 7);
    assert.equal(full.orgName, 'Vertical', 'KI-23: the organization\'s own name');
    assert.deepEqual((await (await as(U.leadA)).put('/api/settings', valid())).body, { error: "You don't have permission to change system settings." });
  });

  it('D-135: the CoS keeps the Google sign-in domains (organization column), validated, lower-cased, kept when left out, audited', async () => {
    const cos = await as(U.cos);
    assert.deepEqual((await cos.put('/api/settings', { ...valid(), googleDomains: ['not a domain'] })).body.fields, { 'googleDomains.0': 'Give a domain like example.com.' });
    assert.equal((await cos.put('/api/settings', { ...valid(), googleDomains: ['Example.COM', 'example.com', 'second.example.org'] })).status, 200);
    const col = async () => (await pool.query('select google_domains from organizations where id = 1')).rows[0].google_domains;
    assert.deepEqual(await col(), ['example.com', 'second.example.org']);
    assert.equal((await cos.put('/api/settings', valid())).status, 200);
    assert.deepEqual((await cos.get('/api/settings')).body.googleDomains, ['example.com', 'second.example.org'], 'an older client keeps the list');
    const { rows } = await pool.query(`select after from admin_log where kind = 'settings.updated' and after ? 'googleDomains' order by id desc limit 1`);
    assert.deepEqual(rows[0].after.googleDomains, ['example.com', 'second.example.org']);
    await cos.put('/api/settings', { ...valid(), googleDomains: [] });
    assert.deepEqual(await col(), [], 'back to the server default');
  });

  it('SET-01-AC-1: each rule answers 422 on its own field', async () => {
    const cos = await as(U.cos);
    const fields = async (over: Record<string, unknown>) => (await cos.put('/api/settings', { ...valid(), ...over })).body.fields;
    assert.deepEqual(await fields({ orgName: '  ' }), { orgName: 'Organization name is required.' });
    assert.deepEqual(await fields({ sessionTimeoutMinutes: 4 }), { sessionTimeoutMinutes: 'Between 5 and 480 minutes.' });
    assert.deepEqual(await fields({ overloadThreshold: 51 }), { overloadThreshold: 'Between 1 and 50.' });
    assert.deepEqual(await fields({ digestDay: 7 }), { digestDay: 'Between 0 and 6.' });
    assert.deepEqual(await fields({ digestHour: 24 }), { digestHour: 'Between 0 and 23.' });
    assert.deepEqual(await fields({ timezone: 'Mars/Base' }), { timezone: 'Unknown time zone' });
    assert.deepEqual(await fields({ workdayStart: '9am' }), { workdayStart: 'Use HH:MM (24-hour)' });
    assert.deepEqual(await fields({ workdayStart: '18:00', workdayEnd: '09:00' }), { workdayEnd: 'The workday must end after it starts.' });
    assert.deepEqual(await fields({ categories: [' ', ''] }), { categories: 'Keep at least one category.' });
    assert.deepEqual(await fields({ priorityWeights: { critical: 0, high: 1, normal: 1, low: 11 } }), { 'priorityWeights.critical': 'Between 1 and 10.', 'priorityWeights.low': 'Between 1 and 10.' });
    assert.equal((await cos.put('/api/settings', { ...valid(), priorityWeights: { critical: 2, high: 1, normal: 1, low: 1, urgent: 5 } })).status, 422, 'unknown priority');
  });

  it('D-124: priority weights are saved, audited, shown on the leaderboard and kept when a save leaves them out', async () => {
    const cos = await as(U.cos);
    // Test data: users start without a team, so Lead A joins a fresh one for the leaderboard check. Restored afterwards.
    const { rows: was } = await pool.query('select team_id from users where id = $1', [U.leadA]);
    const { rows: made } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('Weights A', 'BAIS', 1) returning id`);
    await pool.query('update users set team_id = $1 where id = $2', [made[0].id, U.leadA]);
    invalidateDirectory();
    try {
      const w = { critical: 3, high: 2, normal: 1, low: 1 };
      assert.deepEqual((await cos.put('/api/settings', { ...valid(), priorityWeights: w })).body.priorityWeights, w);
      const { rows } = await pool.query(`select after from admin_log where kind = 'settings.updated' order by seq desc limit 1`);
      assert.deepEqual(rows[0].after.priorityWeights, w, 'audited (the save body also changes categories)');
      assert.deepEqual((await cos.put('/api/settings', valid())).body.priorityWeights, w, 'left out: unchanged');
      const board = (await (await as(U.leadA)).get(`/api/performance/leaderboard?teamId=${made[0].id}&period=month`)).body;
      assert.deepEqual(board.weights, w, `visible on the leaderboard: ${JSON.stringify(board).slice(0, 200)}`);
      // D-173: ranked on 0.5·O + 0.3·Q + 0.2·T, a missing part left out and the rest re-weighted.
      for (const r of board.rows) {
        const parts = [[r.outcome, 0.5], [r.quality, 0.3], [r.timeliness, 0.2]].filter(([v]) => v !== null) as [number, number][];
        const expected = r.outcome === null ? null : parts.reduce((a, [v, k]) => a + v * k, 0) / parts.reduce((a, [, k]) => a + k, 0);
        assert.equal(r.score, expected, 'ranked on the Performance score');
      }
    } finally {
      await pool.query(`update organizations set name = 'Vertical', settings = '{}' where id = 1`); // test data only
      await pool.query('update users set team_id = $2 where id = $1', [U.leadA, was[0].team_id]);
      invalidateDirectory();
    }
  });

  it('SET-01-AC-2/5: retention stays 7, categories are trimmed and de-duplicated, the name is the organization\'s, and only changed keys are audited', async () => {
    const cos = await as(U.cos);
    try {
      const saved = (await cos.put('/api/settings', { ...valid(), orgName: 'Vertical Group', retentionYears: 3, sessionTimeoutMinutes: 45, categories: [' Finance ', 'Finance', 'Ops'] })).body;
      assert.deepEqual(
        { name: saved.orgName, retention: saved.retentionYears, timeout: saved.sessionTimeoutMinutes, categories: saved.categories },
        { name: 'Vertical Group', retention: 7, timeout: 45, categories: ['Finance', 'Ops'] },
      );
      assert.deepEqual((await cos.get('/api/me')).body.organization, { id: 1, name: 'Vertical Group' });
      const { rows } = await pool.query(`select before, after from admin_log where kind = 'settings.updated' order by seq desc limit 1`);
      assert.deepEqual(Object.keys(rows[0].after).sort(), ['categories', 'orgName', 'sessionTimeoutMinutes']);
      assert.deepEqual(rows[0].before.orgName, 'Vertical');
    } finally {
      await pool.query(`update organizations set name = 'Vertical', settings = '{}' where id = 1`); // test data only
    }
  });
});

describe('Cutover to the new task model (T-4.0; ADR-0003)', () => {
  it('a new task is stored as assigned with its creator, reviewer and team; legacy log kinds read under the new names', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30, 'BAIS', 'Cutover check');
    const { rows } = await pool.query('select status, created_by, reviewer_id, updated_at is not null as updated from tasks where id = $1', [id]);
    assert.deepEqual(rows[0], { status: 'assigned', created_by: U.leadA, reviewer_id: U.leadA, updated: true });
    const staff = await as(U.staffA1);
    assert.equal((await staff.post(`/api/tasks/${id}/updates`, { body: 'Started on it', status: 'in_progress' })).status, 201);
    const d = (await staff.get(`/api/tasks/${id}`)).body;
    const progress = d.activities.find((a: { body: string }) => a.body === 'Started on it');
    assert.equal(progress.kind, 'progress', 'stored as the legacy "update", shown as "progress" (DATABASE_DESIGN §4.3)');
    assert.deepEqual(progress.before, { status: 'assigned' });
    assert.equal(d.chain.ok, true, 'the hash chain still verifies');
  });

  it('completing and reopening store the new statuses; tasks can never be deleted', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'low', 40, 'BAIS', 'Close and reopen');
    const mgr = await as(U.mgrA);
    assert.equal((await (await as(U.staffA1)).post(`/api/tasks/${id}/complete`, { note: 'Finished offline' })).status, 200);
    assert.equal((await pool.query('select status, completed_at is not null as c from tasks where id = $1', [id])).rows[0].status, 'completed');
    assert.equal((await mgr.post(`/api/tasks/${id}/reopen`, { reason: 'Needs another pass', ...due(localIn(30, 'Asia/Kolkata')) })).status, 200);
    assert.deepEqual((await pool.query('select status, completed_at from tasks where id = $1', [id])).rows[0], { status: 'reopened', completed_at: null });
    // KI-38: the legacy status route, which bypassed the workflow and review, is gone.
    assert.equal((await mgr.post(`/api/tasks/${id}/status`, { status: 'done', note: 'Skip review' })).status, 404);
    await assert.rejects(pool.query('delete from tasks where id = $1', [id]), /archived, never deleted/);
  });
});

describe('Task lists, actions and pickers (T-4.1; TASK-04, TASK-08, WF-10)', () => {
  const ids = (b: { items: { id: number }[] }) => b.items.map((t) => t.id).sort((a, c) => a - c);

  it('TC-TASK-04-01/02/04: scope permissions, scope contents, no contact details in rows', async () => {
    const staff = await as(U.staffA1);
    assert.deepEqual((await staff.get('/api/tasks?scope=team')).body, { error: "You don't have permission to view team tasks." });
    assert.deepEqual((await staff.get('/api/tasks?scope=assigned_by_me')).body, { error: "You don't have permission to see tasks you assigned." });
    assert.equal((await staff.get('/api/tasks?scope=everything')).status, 422);
    const mine = (await staff.get('/api/tasks?scope=mine')).body;
    assert.equal(mine.truncated, false);
    const { rows: own } = await pool.query(`select id from tasks where assignee_id = $1 and status <> 'draft' order by id`, [U.staffA1]);
    assert.deepEqual(ids(mine), own.map((r) => r.id), 'mine: every status, not drafts');
    const lead = (await (await as(U.leadA)).get('/api/tasks?scope=team')).body;
    invalidateDirectory();
    const reports = [...(await getDirectory(1)).descendants(U.leadA)]; // earlier suites add people under Lead A
    const { rows: team } = await pool.query(`select id from tasks where assignee_id = any($1) and status <> 'draft' order by id`, [reports]);
    assert.deepEqual(ids(lead), team.map((r) => r.id), 'TASK-04-AC-2: exactly the reports\' non-draft tasks');
    assert.ok(!JSON.stringify(lead).includes('@example.com') && !JSON.stringify(lead).includes('+1415'), 'TASK-04-AC-4: no email or phone');
  });

  it('WF-10: each row carries the viewer\'s allowed actions from the shared rules', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30, 'BAIS', 'Actions check');
    const actionsFor = async (who: number) => (await (await as(who)).get('/api/tasks?scope=all&view=open')).body.items.find((t: { id: number }) => t.id === id).actions as string[];
    const assignee = await actionsFor(U.staffA1);
    for (const a of ['acknowledge', 'start', 'progress', 'block', 'complete', 'request_extension', 'comment', 'attach']) assert.ok(assignee.includes(a), `assignee: ${a}`);
    for (const a of ['reassign', 'cancel', 'edit']) assert.ok(!assignee.includes(a), `assignee may not ${a}`);
    const manager = await actionsFor(U.mgrA);
    for (const a of ['reassign', 'cancel', 'edit']) assert.ok(manager.includes(a), `manager: ${a}`);
    assert.ok(!manager.includes('progress'), 'only the assignee posts progress');
    const lead = await actionsFor(U.leadA);
    assert.ok(lead.includes('reassign'), 'D-133: the giver reassigns their own task (D-29 still holds for tasks they did not give: see "reassigning restarts the clock")');
  });

  it('TC-TASK-08-01: assignee options are the assignable people with their load', async () => {
    const lead = (await (await as(U.leadA)).get('/api/tasks/options/assignees')).body;
    invalidateDirectory();
    const dir = await getDirectory(1);
    const expected = [U.leadA, ...dir.descendants(U.leadA)].filter((id) => dir.get(id)?.active).sort((a, b) => a - b);
    assert.deepEqual(lead.map((u: { id: number }) => u.id).sort((a: number, b: number) => a - b), expected, 'self and active reports (D-32)');
    assert.ok(lead.every((u: { openCount: unknown }) => typeof u.openCount === 'number'));
    assert.deepEqual((await (await as(U.staffA1)).get('/api/tasks/options/assignees')).body, []);
  });
});

describe('Task detail (T-4.2; TASK-05)', () => {
  it('TC-TASK-05-01…03: the contract shape, only the people on the task, actions and a verified chain', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'high', 30, 'BAIS', 'Detail check');
    const d = (await (await as(U.staffA1)).get(`/api/tasks/${id}`)).body;
    for (const k of ['task', 'actions', 'activities', 'comments', 'updates', 'attachments', 'reviews', 'extensions', 'assignments', 'escalations', 'parent', 'children', 'recurrence', 'people', 'rules', 'chain']) {
      assert.ok(k in d, `has ${k}`);
    }
    assert.equal(d.task.id, id);
    assert.deepEqual(Object.keys(d.people).map(Number).sort(), [U.leadA, U.staffA1].sort(), 'only the people this task involves');
    assert.ok(!JSON.stringify(d).includes('@example.com'), 'no email addresses');
    assert.ok(d.actions.includes('progress'));
    assert.equal(d.chain.ok, true);
  });
});

describe('Create, draft, publish, edit (T-4.3, T-4.4; TASK-01…03, EXT-04)', () => {
  const body = (over: Record<string, unknown> = {}) => ({ ...M, title: 'Prepare filing', category: 'Operations', assigneeId: U.staffA1, priority: 'normal', ...due(localIn(30, 'Asia/Kolkata')), ...over });

  it('TASK-01-AC-3/4: each rule answers 422 with its message; staff get 403', async () => {
    const lead = await as(U.leadA);
    const fields = async (over: Record<string, unknown>) => (await lead.post('/api/tasks', body(over))).body.fields;
    assert.deepEqual(await fields({ title: 'Abc' }), { title: 'Give the task a title of at least 4 characters.' });
    assert.deepEqual(await fields({ title: 'x'.repeat(141) }), { title: 'Keep the title under 140 characters.' });
    assert.deepEqual(await fields({ category: 'Gardening' }), { category: 'Choose a category.' });
    assert.deepEqual(await fields({ assigneeId: U.staffB1 }), { assigneeId: 'You can only assign to people below you in the reporting line.' });
    assert.deepEqual(await fields({ ...due(localIn(-2, 'Asia/Kolkata')) }), { dueDate: 'The due time must be in the future.' });
    assert.deepEqual(await fields({ startDate: localIn(200, 'Asia/Kolkata').slice(0, 10) }), { startDate: 'The scheduled start must be before the due time.' });
    assert.deepEqual(await fields({ parentId: 999999 }), { parentId: 'Pick a parent task you can see.' });
    assert.deepEqual(await fields({ dueDate: 'soon' }), { dueDate: 'Enter a valid date.' });
    assert.equal((await lead.post('/api/tasks', { ...body(), createdAt: '2020-01-01' })).status, 422, 'client timestamps are refused');
    assert.deepEqual((await (await as(U.staffA1)).post('/api/tasks', body())).body, { error: "You don't have permission to create tasks." });
  });

  it('TASK-01-AC-1/5/6: server times, created + assigned log rows, entity from the assignee, notification sent', async () => {
    const res = await (await as(U.leadA)).post('/api/tasks', body({ title: 'Server time check' }));
    assert.equal(res.status, 201);
    const t = res.body.task;
    assert.deepEqual({ status: t.status, entity: t.entityId, same: t.createdAt === t.clockStartedAt }, { status: 'assigned', entity: 'BAIS', same: true });
    assert.equal(new Date(t.createdAt).getTime(), now.getTime());
    const { rows } = await pool.query(`select kind from activity_log where task_id = $1 order by seq`, [t.id]);
    assert.deepEqual(rows.map((r) => r.kind), ['created', 'assigned']);
    const { rows: n } = await pool.query(`select count(*)::int n from notifications where task_id = $1 and user_id = $2 and channel = 'inapp'`, [t.id, U.staffA1]);
    assert.equal(n[0].n, 1, 'TASK-01-AC-2');
  });

  it('D-133: the giver discards a draft; it vanishes for everyone, stays in the database, and is audited; assigned tasks cannot be discarded', async () => {
    const lead = await as(U.leadA);
    const d = (await lead.post('/api/tasks', { ...body({ title: 'Draft to discard' }), draft: true })).body.task;
    assert.ok(d.actions.includes('discard'), 'the giver is offered Delete');
    assert.equal((await (await as(U.mgrA)).post(`/api/tasks/${d.id}/discard`, {})).status, 403, 'an overseer is not the giver');
    assert.equal((await lead.post(`/api/tasks/${d.id}/discard`, { reason: 'x' })).status, 422, 'no body');
    assert.equal((await lead.post(`/api/tasks/${d.id}/discard`, {})).status, 204);
    assert.equal((await lead.get(`/api/tasks/${d.id}`)).status, 404, 'gone from the detail page');
    assert.ok(!(await lead.get('/api/tasks?scope=assigned_by_me')).body.items.some((t: { id: number }) => t.id === d.id), 'gone from lists');
    assert.equal((await (await as(U.cos)).get(`/api/tasks/${d.id}`)).status, 404, 'gone for the Founder\'s Office too');
    const { rows } = await pool.query('select discarded_at is not null as discarded from tasks where id = $1', [d.id]);
    assert.deepEqual(rows, [{ discarded: true }], 'kept in the database (never deleted)');
    const { rows: audit } = await pool.query(`select kind from admin_log where target = $1`, [`task:${d.id}`]);
    assert.deepEqual(audit.map((a) => a.kind), ['task.draft_discarded']);
    const live = (await lead.post('/api/tasks', body({ title: 'Assigned, not discardable' }))).body.task;
    assert.ok(!live.actions.includes('discard'));
    assert.equal((await lead.post(`/api/tasks/${live.id}/discard`, {})).status, 403, 'an assigned task is cancelled, not discarded');
  });

  it('TASK-02: a draft has no assignment, notification or clock; publishing assigns it now; a past due date blocks publishing', async () => {
    const lead = await as(U.leadA);
    const d = (await lead.post('/api/tasks', { ...body({ title: 'Draft task' }), draft: true })).body.task;
    assert.equal(d.status, 'draft');
    const counts = async () => (await pool.query(`select (select count(*)::int from assignments where task_id = $1) a, (select count(*)::int from notifications where task_id = $1) n`, [d.id])).rows[0];
    assert.deepEqual(await counts(), { a: 0, n: 0 }, 'TASK-02-AC-1');
    assert.ok(!(await (await as(U.staffA1)).get('/api/tasks?scope=mine')).body.items.some((t: { id: number }) => t.id === d.id), 'TASK-02-AC-4');
    assert.equal((await (await as(U.staffA1)).post(`/api/tasks/${d.id}/publish`)).status, 403, 'only the giver publishes');
    advance(H);
    const p = (await lead.post(`/api/tasks/${d.id}/publish`)).body.task;
    assert.equal(p.status, 'assigned');
    assert.equal(new Date(p.clockStartedAt).getTime(), now.getTime(), 'TASK-02-AC-3');
    assert.deepEqual(await counts(), { a: 1, n: (await counts()).n }, 'an assignment record');
    assert.ok((await counts()).n > 0, 'the assignee is notified');
    const late = (await lead.post('/api/tasks', { ...body({ title: 'Late draft' }), ...due(localIn(2, 'Asia/Kolkata')), draft: true })).body.task;
    advance(3 * H);
    assert.deepEqual((await lead.post(`/api/tasks/${late.id}/publish`)).body.fields, { dueDate: 'Move the due date into the future before assigning.' });
  });

  it('TASK-03: a title edit keeps the clock; an assignee change restarts it; a closed task cannot be edited; no self-parent', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'normal', 40, 'BAIS', 'Edit check');
    const mgr = await as(U.mgrA);
    const current = (await mgr.get(`/api/tasks/${id}`)).body.task;
    // After advance(H), localIn(39) names the same minute as the original localIn(40): the due date is unchanged.
    const edit = (over: Record<string, unknown>) => mgr.put(`/api/tasks/${id}`, { ...M, title: current.title, category: 'Operations', assigneeId: current.assigneeId, priority: current.priority, ...due(localIn(39, 'America/Los_Angeles')), ...over });
    const before = current.clockStartedAt;
    advance(H);
    const e1 = await edit({ title: 'Edit check renamed' });
    assert.equal(e1.status, 200, JSON.stringify(e1.body));
    assert.equal(e1.body.task.clockStartedAt, before, 'TASK-03-AC-1');
    const e2 = await edit({ title: 'Edit check renamed', assigneeId: U.staffA2 });
    assert.equal(e2.status, 200, JSON.stringify(e2.body));
    assert.deepEqual({ who: e2.body.task.assigneeId, clock: new Date(e2.body.task.clockStartedAt).getTime(), ack: e2.body.task.acknowledgedAt }, { who: U.staffA2, clock: now.getTime(), ack: null }, 'TASK-03-AC-2');
    assert.deepEqual((await edit({ parentId: id })).body.fields, { parentId: 'A task cannot be its own parent.' });
    await mgr.post(`/api/tasks/${id}/cancel`, { reason: 'No longer needed' });
    assert.equal((await edit({})).status, 403, 'TASK-03-AC-4');
  });

  it('EXT-04: an earlier date is a 422 on dueDate; the reason is required', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'normal', 40);
    const mgr = await as(U.mgrA);
    assert.deepEqual((await mgr.post(`/api/tasks/${id}/due`, { ...due(localIn(20, 'America/Los_Angeles')), reason: 'Sooner' })).body.fields, { dueDate: 'The new due date must be later than the current one' });
    assert.deepEqual((await mgr.post(`/api/tasks/${id}/due`, { ...due(localIn(60, 'America/Los_Angeles')), reason: '' })).body.fields, { reason: 'Give a reason for the new due date' });
  });
});

describe('Acknowledge, start, progress, block (T-4.5, T-4.6; WF-01…03, WF-11)', () => {
  it('WF-01/02: acknowledging and starting never move the clock; a second acknowledgement is refused', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    const clock0 = (await staff.get(`/api/tasks/${id}`)).body.task.clockStartedAt;
    advance(H);
    const a = await staff.post(`/api/tasks/${id}/acknowledge`);
    assert.equal(a.status, 200);
    assert.ok(a.body.task.acknowledgedAt && a.body.task.clockStartedAt === clock0, 'WF-01-AC-1');
    assert.equal((await staff.post(`/api/tasks/${id}/acknowledge`)).status, 403, 'WF-01-AC-3');
    assert.equal((await (await as(U.leadA)).post(`/api/tasks/${id}/start`)).status, 403, 'only the assignee starts');
    const s = (await staff.post(`/api/tasks/${id}/start`)).body.task;
    assert.deepEqual({ status: s.status, clock: s.clockStartedAt }, { status: 'in_progress', clock: clock0 }, 'WF-02-AC-1');
  });

  it('WF-03: progress resets the clock and records the first update once; message and percent rules; only the assignee', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    assert.deepEqual((await staff.post(`/api/tasks/${id}/progress`, { message: 'abc', percent: 101 })).body.fields, {
      message: 'Describe what changed (at least 5 characters).',
      percent: 'Progress must be between 0 and 100.',
    });
    assert.equal((await (await as(U.leadA)).post(`/api/tasks/${id}/progress`, { message: 'Not my task' })).status, 403, 'WF-03-AC-4');
    advance(2 * H);
    const t = (await staff.post(`/api/tasks/${id}/progress`, { message: 'Drafted the forms', percent: 40 })).body.task;
    assert.deepEqual({ clock: new Date(t.clockStartedAt).getTime(), status: t.status, progress: t.progress }, { clock: now.getTime(), status: 'in_progress', progress: 40 }, 'WF-03-AC-1');
    const first = (await pool.query('select first_update_at from assignments where task_id = $1', [id])).rows[0].first_update_at.getTime();
    advance(H);
    await staff.post(`/api/tasks/${id}/progress`, { message: 'Filed the forms' });
    assert.equal((await pool.query('select first_update_at from assignments where task_id = $1', [id])).rows[0].first_update_at.getTime(), first, 'WF-03-AC-3');
  });

  it('WF-11: Blocked needs a reason, alerts the lead, can not repeat; progress unblocks and clears the reason', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    assert.deepEqual((await staff.post(`/api/tasks/${id}/block`, { reason: 'wait' })).body.fields, { reason: 'Say what is blocking the task (at least 5 characters).' });
    const b = (await staff.post(`/api/tasks/${id}/block`, { reason: 'Waiting on the client' })).body.task;
    assert.deepEqual({ status: b.status, reason: b.blockedReason }, { status: 'blocked', reason: 'Waiting on the client' });
    const { rows } = await pool.query(`select count(*)::int n from notifications where task_id = $1 and user_id = $2 and event = 'blocked'`, [id, U.leadA]);
    assert.ok(rows[0].n > 0, 'WF-11-AC-1: the lead is alerted');
    assert.equal((await staff.post(`/api/tasks/${id}/block`, { reason: 'Still waiting here' })).status, 403, 'already blocked');
    const u = (await staff.post(`/api/tasks/${id}/progress`, { message: 'Client replied, resuming' })).body.task;
    assert.deepEqual({ status: u.status, reason: u.blockedReason }, { status: 'in_progress', reason: null }, 'WF-11-AC-4');
  });
});

describe('Submit, complete, review (T-4.7; WF-04…06)', () => {
  it('rounds, the review rules, send-back restarts the clock, approval completes; a second decision is a 409', async () => {
    const lead = await as(U.leadA);
    const t = (await lead.post('/api/tasks', { ...M, title: 'Reviewed work', category: 'Operations', assigneeId: U.staffA1, priority: 'normal', ...due(localIn(30, 'Asia/Kolkata')), reviewRequired: true })).body.task;
    const staff = await as(U.staffA1);
    await staff.post(`/api/tasks/${t.id}/start`);
    assert.deepEqual((await staff.post(`/api/tasks/${t.id}/complete`)).body, { error: 'This task requires review approval before it can be completed.' });
    assert.deepEqual((await staff.post(`/api/tasks/${t.id}/submit`, { note: 'ok' })).body.fields, { note: 'Summarize what you are submitting.' });
    assert.equal((await staff.post(`/api/tasks/${t.id}/submit`, { note: 'First draft ready' })).body.task.status, 'submitted');
    assert.deepEqual((await staff.post(`/api/tasks/${t.id}/review`, { decision: 'approved' })).body, { error: 'You cannot review your own work.' });
    assert.deepEqual((await lead.post(`/api/tasks/${t.id}/review`, { decision: 'changes_requested', comment: '' })).body.fields, { comment: 'Explain what needs to change.' });
    advance(H);
    const back = (await lead.post(`/api/tasks/${t.id}/review`, { decision: 'changes_requested', comment: 'Add the cover letter' })).body.task;
    assert.deepEqual({ status: back.status, clock: new Date(back.clockStartedAt).getTime() }, { status: 'changes_requested', clock: now.getTime() }, 'WF-06-AC-1');
    await staff.post(`/api/tasks/${t.id}/start`);
    await staff.post(`/api/tasks/${t.id}/submit`, { note: 'Second draft ready' });
    const { rows } = await pool.query('select round from reviews where task_id = $1 order by round', [t.id]);
    assert.deepEqual(rows.map((r) => r.round), [1, 2], 'WF-04-AC-1');
    // PERF: approval carries the reviewer's quality score, and an outcome score when the task has no target.
    const done = (await lead.post(`/api/tasks/${t.id}/review`, { decision: 'approved', qualityScore: 90, outcomeScore: 90 })).body.task;
    assert.deepEqual({ status: done.status, progress: done.progress }, { status: 'completed', progress: 100 });
    assert.deepEqual((await (await as(U.mgrA)).post(`/api/tasks/${t.id}/review`, { decision: 'approved' })).body, { error: 'There is no pending submission to review.' });
    assert.deepEqual((await staff.get('/api/reviews')).body, { error: "You don't have permission to review tasks." });
  });

  it('WF-05 (R-2): Done straight from Open when no review is required; escalations resolve', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'critical', 30);
    advance(7 * H);
    await runEngine();
    assert.ok((await taskLevel(id)) >= 0);
    const t = (await (await as(U.staffA1)).post(`/api/tasks/${id}/complete`, { note: 'Done early' })).body.task;
    assert.deepEqual({ status: t.status, progress: t.progress, level: t.level }, { status: 'completed', progress: 100, level: -1 });
    const { rows } = await pool.query('select count(*)::int n from escalations where task_id = $1 and cleared_at is null', [id]);
    assert.equal(rows[0].n, 0, 'WF-05-AC-1');
  });
});

describe('Reassign, cancel, reopen (T-4.8; WF-07…09)', () => {
  it('WF-07: each validation message; the reassigner becomes the giver', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const mgr = await as(U.mgrA);
    const f = async (b: Record<string, unknown>) => (await mgr.post(`/api/tasks/${id}/reassign`, b)).body.fields;
    assert.deepEqual(await f({ reason: 'Moving it on' }), { toId: 'Choose the new assignee.' });
    assert.deepEqual(await f({ toId: U.staffA1, reason: 'Moving it on' }), { toId: 'Choose someone other than the current assignee.' });
    assert.deepEqual(await f({ toId: U.staffB1, reason: 'Moving it on' }), { toId: 'That person is outside your assignment scope.' });
    assert.deepEqual(await f({ toId: U.staffA2, reason: 'no' }), { reason: 'Give a reason for the reassignment.' });
    const t = (await mgr.post(`/api/tasks/${id}/reassign`, { toId: U.staffA2, reason: 'Workload balance' })).body.task;
    assert.deepEqual({ who: t.assigneeId, giver: t.assignedBy }, { who: U.staffA2, giver: U.mgrA });
  });

  it('WF-08/09: cancel needs a reason and is final; reopen needs a reason and a future date', async () => {
    const lead = await as(U.leadA);
    const a = await newTask(U.leadA, U.staffA1, 'normal', 30);
    assert.deepEqual((await lead.post(`/api/tasks/${a}/cancel`, { reason: 'no' })).body.fields, { reason: 'A cancellation reason is required.' });
    assert.equal((await lead.post(`/api/tasks/${a}/cancel`, { reason: 'Client withdrew' })).body.task.status, 'cancelled');
    assert.equal((await lead.post(`/api/tasks/${a}/reopen`, { reason: 'Client is back', ...due(localIn(50, 'Asia/Kolkata')) })).status, 403, 'WF-08-AC-1 / WF-09-AC-3');
    const b = await newTask(U.leadA, U.staffA1, 'normal', 30);
    await (await as(U.staffA1)).post(`/api/tasks/${b}/complete`);
    assert.deepEqual((await lead.post(`/api/tasks/${b}/reopen`, { reason: 'Missed a page', ...due(localIn(-5, 'Asia/Kolkata')) })).body.fields, { dueDate: 'Set a new due date in the future.' });
    advance(H);
    const r = (await lead.post(`/api/tasks/${b}/reopen`, { reason: 'Missed a page', ...due(localIn(50, 'Asia/Kolkata')) })).body.task;
    assert.deepEqual({ status: r.status, clock: new Date(r.clockStartedAt).getTime(), done: r.completedAt }, { status: 'reopened', clock: now.getTime(), done: null }, 'WF-09-AC-1');
  });
});

describe('Extensions (T-4.9; EXT-01…03, D-27)', () => {
  it('request rules, one pending at a time, own request refused, rejection needs a note, approval moves the due date once', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    const req = (b: Record<string, unknown>) => staff.post(`/api/tasks/${id}/extensions`, b);
    const later = localIn(80, 'Asia/Kolkata');
    assert.deepEqual((await req({ requestedDate: later.slice(0, 10), reason: 'short' })).body.fields, { reason: 'Explain why (at least 10 characters).' });
    assert.deepEqual((await req({ requestedDate: localIn(10, 'Asia/Kolkata').slice(0, 10), requestedTime: localIn(10, 'Asia/Kolkata').slice(11, 16), reason: 'Waiting for documents' })).body.fields, { requestedDate: 'The new date must be later than the current due date.' });
    const created = await req({ requestedDate: later.slice(0, 10), requestedTime: later.slice(11, 16), reason: 'Waiting for documents' });
    assert.equal(created.status, 201);
    const extId = created.body.id;
    const dueBefore = (await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime();
    assert.equal((await req({ requestedDate: later.slice(0, 10), reason: 'Waiting for more documents' })).status, 403, 'EXT-01-AC-1');
    assert.equal((await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime(), dueBefore, 'EXT-01-AC-2');
    const queue = (await (await as(U.mgrA)).get('/api/extensions?status=pending')).body;
    assert.ok(queue.find((x: any) => x.ext.id === extId).canDecide, 'EXT-03: the manager may decide');
    assert.ok(!(await (await as(U.staffB1)).get('/api/extensions?status=all')).body.some((x: any) => x.ext.id === extId), 'EXT-03-AC-1');
    assert.deepEqual((await staff.post(`/api/extensions/${extId}/decision`, { approve: true })).body, { error: 'You cannot approve your own extension request.' });
    assert.deepEqual((await (await as(U.mgrA)).post(`/api/extensions/${extId}/decision`, { approve: false })).body.fields, { note: 'Give the assignee a reason.' });
    const ok = await (await as(U.mgrA)).post(`/api/extensions/${extId}/decision`, { approve: true, note: 'Fine' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(new Date(ok.body.task.dueAt).getTime(), new Date(ok.body.extension.requested_due).getTime());
    assert.deepEqual((await (await as(U.mgrA)).post(`/api/extensions/${extId}/decision`, { approve: true })).body, { error: 'This request has already been decided.' });
  });
});

/** Multipart POST through the real API (uploads); `files` are [name, bytes]. */
async function upload(c: Client, path: string, fields: Record<string, string>, files: Array<[string, string]>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [name, bytes] of files) form.append('files', new Blob([Buffer.from(bytes, 'latin1')]), name);
  const res = await fetch(base + path, { method: 'POST', headers: { 'x-taskwatch': '1', cookie: c.cookie }, body: form });
  return { status: res.status, body: (await res.json()) as any };
}
const PDF = '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n';
const storedFiles = async () => (await import('node:fs')).readdirSync((await import('../src/config.js')).config.uploadDir).length;

describe('Comments (T-4.10; CMT-01…03, D-74, D-12)', () => {
  it('CMT-01: never moves the clock; the assignee may comment; limits, replies, A-numbers', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const clock0 = (await pool.query('select clock_started_at from tasks where id = $1', [id])).rows[0].clock_started_at.getTime();
    advance(H);
    const lead = await as(U.leadA);
    const c1 = await lead.post(`/api/tasks/${id}/comments`, { body: 'Please attach the receipt.' });
    assert.equal(c1.status, 201);
    assert.equal((await (await as(U.staffA1)).post(`/api/tasks/${id}/comments`, { body: 'Will do today.' })).status, 201, 'D-74');
    assert.equal((await pool.query('select clock_started_at from tasks where id = $1', [id])).rows[0].clock_started_at.getTime(), clock0, 'CMT-01-AC-1');
    assert.deepEqual((await lead.post(`/api/tasks/${id}/comments`, { body: '  ' })).body.fields, { body: 'Write a comment first.' });
    assert.deepEqual((await lead.post(`/api/tasks/${id}/comments`, { body: 'x'.repeat(4001) })).body.fields, { body: 'Comments are limited to 4000 characters.' });
    assert.equal((await lead.post(`/api/tasks/${id}/comments`, { body: 'See A123-456-789' })).status, 422, 'CMT-01-AC-4');
    const reply = await lead.post(`/api/tasks/${id}/comments`, { body: 'A reply', parentId: c1.body.comment.id });
    assert.equal(reply.status, 201);
    assert.deepEqual((await lead.post(`/api/tasks/${id}/comments`, { body: 'Reply to a reply', parentId: reply.body.comment.id })).body.fields, { parentId: 'Reply to a comment on this task.' });
    const { rows } = await pool.query(`select body, actor_id from activity_log where task_id = $1 and kind = 'comment' order by seq limit 1`, [id]);
    assert.deepEqual(rows[0], { body: 'Please attach the receipt.', actor_id: U.leadA }, 'CMT-01-AC-2');
  });

  it('CMT-01-AC-3: @Full Name notifies only people who can see the task', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    await (await as(U.leadA)).post(`/api/tasks/${id}/comments`, { body: '@Manager A and @Staff B1, please look.' });
    const { rows } = await pool.query(`select user_id from notifications where task_id = $1 and event = 'mention' and channel = 'inapp' order by user_id`, [id]);
    assert.deepEqual(rows.map((r) => r.user_id), [U.mgrA]);
  });

  it('CMT-02/03: edit and delete keep the original in the log; only the author edits; author or CoS deletes', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const lead = await as(U.leadA);
    const cid = (await lead.post(`/api/tasks/${id}/comments`, { body: 'Original text' })).body.comment.id;
    assert.deepEqual((await (await as(U.cos)).put(`/api/comments/${cid}`, { body: 'Hijack' })).body, { error: 'You can only edit your own comments.' }, 'CMT-02-AC-2');
    assert.deepEqual((await lead.put(`/api/comments/${cid}`, { body: '' })).body.fields, { body: 'A comment cannot be empty.' });
    assert.equal((await lead.put(`/api/comments/${cid}`, { body: 'Corrected text' })).body.comment.body, 'Corrected text');
    assert.deepEqual((await (await as(U.staffA1)).req('DELETE', `/api/comments/${cid}`)).body, { error: 'You can only delete your own comments.' });
    assert.equal((await (await as(U.cos)).req('DELETE', `/api/comments/${cid}`)).status, 200, 'a CoS may delete');
    assert.equal((await lead.req('DELETE', `/api/comments/${cid}`)).status, 404, 'twice');
    const d = (await lead.get(`/api/tasks/${id}`)).body;
    assert.deepEqual(d.comments.find((c: { id: number }) => c.id === cid), { id: cid, authorId: U.leadA, parentId: null, body: null, at: d.comments[0].at, editedAt: d.comments[0].editedAt, deleted: true }, 'CMT-03-AC-1');
    const { rows } = await pool.query(`select kind, body, before from activity_log where task_id = $1 and kind like 'comment%' order by seq`, [id]);
    assert.deepEqual(rows.map((r) => r.kind), ['comment', 'comment_edited', 'comment_deleted']);
    assert.equal(rows[0].body, 'Original text', 'CMT-02-AC-1: the original stays');
  });
});

describe('Attachments (T-4.11; ATT-01…03, D-13, D-69, S-4)', () => {
  it('ATT-01: type from the bytes, hash round-trip, a log row; rejected uploads leave nothing on disk', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    const before = await storedFiles();
    assert.deepEqual((await upload(staff, `/api/tasks/${id}/attachments`, {}, [['tool.exe', 'MZ\x90\x00binary']])).body.fields, {
      files: 'tool.exe is not an allowed file type (Office documents, PDF, images, text or CSV).',
    });
    assert.equal((await upload(await as(U.staffB1), `/api/tasks/${id}/attachments`, {}, [['a.pdf', PDF]])).status, 404, 'outsider');
    assert.deepEqual((await upload(staff, `/api/tasks/${id}/attachments`, {}, [])).body.fields, { files: 'Choose at least one file.' });
    assert.equal(await storedFiles(), before, 'ATT-01-AC-1: nothing written');
    const up = await upload(staff, `/api/tasks/${id}/attachments`, {}, [['scan.pdf', PDF]]);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const att = up.body.attachments[0];
    assert.equal(att.mime, 'application/pdf', 'ATT-01-AC-4');
    const dl = await fetch(`${base}/api/tasks/${id}/attachments/${att.id}`, { headers: { cookie: staff.cookie } });
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), att.sha256, 'ATT-01-AC-2');
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    const { rows } = await pool.query(`select after from activity_log where task_id = $1 and kind = 'attachment_added'`, [id]);
    assert.equal(rows[0].after.sha256, att.sha256, 'ATT-01-AC-3');
  });

  it('ATT-02/03: inline only for safe types; removal by uploader or overseer, never on a closed task; the file is kept', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const staff = await as(U.staffA1);
    const lead = await as(U.leadA);
    const [txt, csv] = (await upload(staff, `/api/tasks/${id}/attachments`, {}, [['notes.txt', 'plain notes'], ['data.csv', 'a,b\n1,2']])).body.attachments;
    const disposition = async (aid: number) => (await fetch(`${base}/api/tasks/${id}/attachments/${aid}?inline=1`, { headers: { cookie: staff.cookie } })).headers.get('content-disposition')!;
    assert.match(await disposition(txt.id), /^inline/);
    assert.match(await disposition(csv.id), /^attachment/, 'ATT-02-AC-2');
    const leadFile = (await upload(lead, `/api/tasks/${id}/attachments`, {}, [['brief.pdf', PDF]])).body.attachments[0];
    assert.deepEqual((await staff.req('DELETE', `/api/attachments/${leadFile.id}`)).body, { error: 'Only the uploader or a task supervisor can remove this file.' }, 'ATT-03-AC-3');
    assert.equal((await staff.req('DELETE', `/api/attachments/${txt.id}`)).status, 200, 'uploader');
    assert.equal((await (await as(U.ceo)).req('DELETE', `/api/attachments/${csv.id}`)).status, 403, 'D-33: the read-only CEO cannot remove files (KI-40)');
    assert.equal((await lead.req('DELETE', `/api/attachments/${csv.id}`)).status, 200, 'overseer');
    const d = (await staff.get(`/api/tasks/${id}`)).body;
    assert.deepEqual(d.attachments.map((a: { id: number }) => a.id), [leadFile.id], 'ATT-03-AC-1: hidden');
    const { rows } = await pool.query('select storage_key, removed_at is not null as removed from attachments where id = $1', [txt.id]);
    const fs = await import('node:fs');
    const { config: cfg } = await import('../src/config.js');
    assert.ok(rows[0].removed && fs.existsSync(`${cfg.uploadDir}/${rows[0].storage_key}`), 'the bytes are kept');
    await staff.post(`/api/tasks/${id}/complete`);
    assert.equal((await lead.req('DELETE', `/api/attachments/${leadFile.id}`)).status, 403, 'closed task');
    assert.equal((await upload(staff, `/api/tasks/${id}/attachments`, {}, [['late.pdf', PDF]])).status, 403, 'no uploads on a closed task');
  });
});

describe('Calendar and bulk actions (T-4.12; TASK-06, TASK-07)', () => {
  it('TASK-06: days are whole days in each viewer\'s zone; drafts never appear', async () => {
    const lead = await as(U.leadA); // IST
    const t = (await lead.post('/api/tasks', { ...M, title: 'Calendar task', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due(localIn(72, 'Asia/Kolkata')) })).body.task;
    const draft = (await lead.post('/api/tasks', { ...M, title: 'Calendar draft', category: 'Operations', assigneeId: U.staffA1, priority: 'low', ...due(localIn(72, 'Asia/Kolkata')), draft: true })).body.task;
    const ist = localIn(72, 'Asia/Kolkata').slice(0, 10);
    const pt = localIn(72, 'America/Los_Angeles').slice(0, 10);
    const ids = (b: any) => b.items.map((x: { id: number }) => x.id);
    const leadDay = (await lead.get(`/api/tasks?scope=all&dueFrom=${ist}&dueTo=${ist}`)).body;
    assert.ok(ids(leadDay).includes(t.id) && !ids(leadDay).includes(draft.id), 'TASK-06-AC-2');
    assert.ok(ids((await (await as(U.cos)).get(`/api/tasks?scope=all&dueFrom=${pt}&dueTo=${pt}`)).body).includes(t.id), 'TASK-06-AC-1: the PT day');
    assert.equal((await lead.get(`/api/tasks?scope=all&dueFrom=${ist}&dueTo=2000-01-01`)).status, 422);
  });

  it('TASK-07: each id on its own; invisible and not-allowed ids are skipped alike; the reason rule', async () => {
    const mine = [await newTask(U.leadA, U.staffA1, 'low', 30), await newTask(U.leadA, U.staffA1, 'low', 30), await newTask(U.leadA, U.staffA2, 'low', 30)];
    const closed = await newTask(U.leadA, U.staffA1, 'low', 30);
    await (await as(U.staffA1)).post(`/api/tasks/${closed}/complete`);
    const other = await newTask(U.leadB, U.staffB1, 'low', 30);
    const lead = await as(U.leadA);
    assert.deepEqual((await lead.post('/api/tasks/bulk/cancel', { ids: mine, reason: 'nope' })).body.fields, { reason: 'A cancellation reason is required.' });
    const r = (await lead.post('/api/tasks/bulk/cancel', { ids: [...mine, closed, other], reason: 'Client withdrew' })).body;
    assert.deepEqual(r, { done: mine, skipped: [closed, other] }, 'TASK-07-AC-1/3');
    const { rows } = await pool.query(`select count(*)::int n from notifications where task_id = any($1) and event = 'cancelled' and channel = 'inapp'`, [mine]);
    assert.equal(rows[0].n, 3, 'TASK-07-AC-2: each assignee told');
    const toAck = [await newTask(U.leadA, U.staffA1, 'low', 30), await newTask(U.leadA, U.staffA1, 'low', 30)];
    assert.deepEqual((await (await as(U.staffA1)).post('/api/tasks/bulk/acknowledge', { ids: [...toAck, other] })).body, { done: toAck, skipped: [other] });
  });
});

describe('Audit log and integrity (T-4.13; AUD-01, AUD-02)', () => {
  it('AUD-01: needs view_audit_logs; both logs, own organization only; server-side filters; formula-guarded CSV', async () => {
    assert.deepEqual((await (await as(U.staffA1)).get('/api/audit')).body, { error: "You don't have permission to view audit logs." });
    const id = await newTask(U.leadA, U.staffA1, 'low', 30, 'BAIS', 'Audit check');
    await (await as(U.leadA)).post(`/api/tasks/${id}/comments`, { body: '=HYPERLINK("x")' });
    const cos = await as(U.cos);
    const all = (await cos.get('/api/audit')).body;
    assert.ok(all.items.some((i: any) => i.action.startsWith('task.')) && all.items.some((i: any) => !i.action.startsWith('task.')), 'both logs');
    assert.ok(!all.items.some((i: any) => i.actor?.id === 900), 'nothing from organization 2');
    const forTask = (await cos.get(`/api/audit?taskId=${id}&action=task.`)).body.items;
    assert.deepEqual(forTask.map((i: any) => i.action).sort(), ['task.assigned', 'task.comment', 'task.created']);
    assert.ok(forTask.every((i: any) => i.at && 'prev' in i && 'next' in i), 'AUD-01-AC-3');
    const csv = await (await fetch(`${base}/api/audit/export.csv?taskId=${id}`, { headers: { cookie: cos.cookie } })).text();
    assert.ok(csv.startsWith('Time (UTC),Actor,Action') && csv.includes(`'=HYPERLINK`), 'AUD-01-AC-5: formula guard');
    assert.equal((await cos.get('/api/audit?from=2026-12-02&to=2026-12-01')).status, 422);
  });

  it('AUD-02: a manual check is recorded and throttled; results show only this organization', async () => {
    const { resetIntegrityThrottle } = await import('../src/services/auditView.js');
    resetIntegrityThrottle();
    const cos = await as(U.cos);
    const run = await cos.post('/api/audit/chain-check');
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(typeof run.body.ok, 'boolean');
    assert.deepEqual((await cos.post('/api/audit/chain-check')).body, { error: 'An integrity check ran recently. Try again in a few minutes.' });
    const checks = (await cos.get('/api/audit/integrity')).body.checks;
    assert.equal(checks[0].trigger, 'manual', 'AUD-02-AC-4');
    resetIntegrityThrottle();
  });
});

describe('Escalation engine on the new model (T-5.1–T-5.3; ESC-01…06a, D-24, D-25)', () => {
  it('D-24: Blocked puts the task at L1 for the lead, announced once; unblocking clears it', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'high', 100);
    const staff = await as(U.staffA1);
    assert.equal((await staff.post(`/api/tasks/${id}/block`, { reason: 'Waiting on the client' })).status, 200);
    assert.equal(await taskLevel(id), 1);
    assert.deepEqual((await activeEscalations(id)).map((e) => [e.level, e.to]), [[1, [U.leadA]]], 'L1 to the lead; no L0 without silence');
    const { rows } = await pool.query(`select reason, reached_at, cycle_started_at from escalations where task_id = $1 and cleared_at is null`, [id]);
    assert.equal(rows[0].reason, 'blocked');
    assert.ok(rows[0].reached_at && rows[0].cycle_started_at, 'event model: reached time and cycle recorded');
    assert.deepEqual([await inapp(id, U.leadA, 'blocked'), await inapp(id, U.leadA, 'L1')], [1, 0], 'one alert, not a second L1 notice');
    await runEngine();
    assert.equal(await taskLevel(id), 1, 'the engine keeps it at L1');
    assert.equal((await staff.post(`/api/tasks/${id}/progress`, { message: 'Client replied, resuming' })).status, 200);
    assert.equal(await taskLevel(id), -1);
    assert.equal((await activeEscalations(id)).length, 0);
  });

  it('D-25 / WF-04-AC-3: In review pauses silence, but the past-due floor still climbs', async () => {
    const start = now;
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const t = (await lead.post('/api/tasks', { ...M, title: 'Reviewed and late', category: 'Operations', assigneeId: U.staffA1, priority: 'critical', ...due(localIn(10, 'Asia/Kolkata')), reviewRequired: true })).body.task;
    await staff.post(`/api/tasks/${t.id}/start`);
    assert.equal((await staff.post(`/api/tasks/${t.id}/submit`, { note: 'Ready for a look' })).status, 200);
    setNow(new Date(start.getTime() + 9 * H));
    await runEngine();
    assert.equal(await taskLevel(t.id), -1, 'no silence escalation while in review');
    const { rows: d } = await pool.query('select due_at from tasks where id = $1', [t.id]);
    setNow(new Date(d[0].due_at.getTime() + 24 * H + MIN));
    await runEngine();
    assert.equal(await taskLevel(t.id), 2, 'past due + 24 h');
    const { rows } = await pool.query(`select level, reason from escalations where task_id = $1 and cleared_at is null order by level`, [t.id]);
    assert.deepEqual(rows.map((r) => [r.level, r.reason]), [[1, 'overdue'], [2, 'overdue']]);
    const v = (await staff.get(`/api/tasks/${t.id}`)).body.task;
    assert.deepEqual([v.status, v.level, v.overdue], ['submitted', 2, false], 'the floor climbs, but in review is never "overdue" (H3, DASHBOARD-FRD §1.1)');
  });

  it('ESC-03-AC-2 / BR-25: a jump fires L1 and L2 together, each stamped with its own crossing time', async () => {
    const id = await newTask(U.leadA, U.staffA2, 'low', 10);
    const { rows: d } = await pool.query('select due_at from tasks where id = $1', [id]);
    const dueMs = d[0].due_at.getTime();
    setNow(new Date(dueMs + 25 * H));
    await runEngine();
    const { rows } = await pool.query(`select level, reason, reached_at from escalations where task_id = $1 and cleared_at is null order by level`, [id]);
    assert.deepEqual(
      rows.map((r) => [r.level, r.reason, r.reached_at.getTime()]),
      [[1, 'overdue', dueMs], [2, 'overdue', dueMs + 24 * H]],
      'no L0 without silence',
    );
  });

  it('ESC-05: the top level re-alerts its "to" recipients once per window, on the window boundary; copies get no repeats', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA1, 'critical', 500);
    const fired = start.getTime() + 12 * H + 2 * MIN;
    setNow(new Date(fired));
    await runEngine();
    assert.equal(await taskLevel(id), 3);
    setNow(new Date(fired + 4 * H - MIN));
    await runEngine();
    assert.equal(await inapp(id, U.cos, 'repeat'), 0, 'not before one window');
    setNow(new Date(fired + 4 * H + 3 * MIN));
    await runEngine();
    assert.deepEqual([await inapp(id, U.cos, 'repeat'), await inapp(id, U.ceo, 'repeat'), await inapp(id, U.mgrA, 'repeat')], [1, 1, 0], 'to recipients only');
    const { rows } = await pool.query('select last_alert_at from escalations where task_id = $1 and level = 3 and cleared_at is null', [id]);
    assert.equal(rows[0].last_alert_at.getTime(), fired + 4 * H, 'stamped on the boundary, so the cadence does not drift');
    setNow(new Date(fired + 8 * H + MIN));
    await runEngine();
    assert.equal(await inapp(id, U.cos, 'repeat'), 2);
  });

  it('ESC-06 / 06a: acknowledgement needs a note, answers {event, task}, tells the assignee, happens once, not after resolution', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA2, 'high', 500);
    setNow(new Date(start.getTime() + 36 * H + MIN));
    await runEngine();
    assert.equal(await taskLevel(id), 1);
    const { rows: l1 } = await pool.query('select id from escalations where task_id = $1 and level = 1 and cleared_at is null', [id]);
    const url = `/api/escalations/${l1[0].id}/ack`;
    const lead = await as(U.leadA);
    assert.deepEqual((await lead.post(url, { note: '   ' })).body.fields, { note: 'Add a note with your acknowledgement' }, 'ESC-06a-AC-1');
    for (const [body, why] of [[{ note: 'x'.repeat(1001) }, '1001 characters'], [{ note: 'See A123-456-789' }, 'sensitive id'], [{ note: 'ok', extra: 1 }, 'unknown field']] as const) {
      assert.equal((await lead.post(url, body)).status, 422, why);
    }
    assert.equal((await pool.query('select acknowledged_at from escalations where id = $1', [l1[0].id])).rows[0].acknowledged_at, null, 'rejections change nothing');

    const ok = await lead.post(url, { note: 'Spoke to the assignee; done by Friday' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.event.id, ok.body.event.ackNote, ok.body.event.canAcknowledge], [l1[0].id, 'Spoke to the assignee; done by Friday', false]);
    assert.deepEqual([ok.body.task.id, ok.body.task.level], [id, 1], 'ESC-06-AC-1: level unchanged');
    assert.ok(!ok.body.task.actions.includes('ack_escalation'), 'nothing left to acknowledge');
    assert.equal((await lead.post(url, { note: 'Again' })).status, 409, 'already acknowledged');
    const log = await pool.query(`select body, actor_id from activity_log where task_id = $1 and kind = 'ack'`, [id]);
    assert.deepEqual(log.rows, [{ body: 'Spoke to the assignee; done by Friday', actor_id: U.leadA }], 'ESC-06-AC-5 / 06a-AC-2');
    assert.deepEqual([await inapp(id, U.staffA2, 'escalation_ack'), await inapp(id, U.leadA, 'escalation_ack')], [1, 0], 'the assignee is told; the actor is not');
    const detail = (await lead.get(`/api/tasks/${id}`)).body.escalations.find((e: any) => e.id === l1[0].id);
    assert.equal(detail.ackNote, 'Spoke to the assignee; done by Friday');

    assert.equal((await (await as(U.staffA2)).post(`/api/tasks/${id}/progress`, { message: 'Back on it now' })).status, 200);
    assert.equal((await (await as(U.cos)).post(url, { note: 'Late look' })).status, 409, 'a resolved escalation cannot be acknowledged');
  });
});

describe('Notices, workspace, engine run, policies (T-5.4–T-5.7; ESC-07…09, POL-01, POL-03)', () => {
  it('ESC-07 (D-143, ADR-0014 §9): one due-soon notice per due date for a long task; the overdue notice is folded into L1, which copies the giver', async () => {
    const id = await newTask(U.mgrA, U.staffA1, 'low', 30);
    const dueOf = async () => (await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime() as number;
    setNow(new Date((await dueOf()) - 24 * H + MIN));
    await runEngine();
    await runEngine();
    assert.deepEqual([await inapp(id, U.staffA1, 'due_soon'), await inapp(id, U.leadA, 'due_soon')], [1, 0], 'due soon: the assignee, once');
    setNow(new Date((await dueOf()) + MIN));
    await runEngine();
    await runEngine();
    assert.deepEqual([await inapp(id, U.staffA1, 'overdue'), await inapp(id, U.mgrA, 'overdue')], [0, 0], 'no separate overdue notice');
    const { rows: l1 } = await pool.query(
      `select r.user_id, r.kind from escalations e join escalation_recipients r on r.escalation_id = e.id where e.task_id = $1 and e.level = 1 order by r.user_id`,
      [id],
    );
    assert.deepEqual(l1.map((r) => [r.user_id, r.kind]), [[U.mgrA, 'cc'], [U.leadA, 'to'], [U.staffA1, 'cc']], 'L1: lead to; assignee and giver copied');
    const res = await (await as(U.mgrA)).post(`/api/tasks/${id}/due`, { ...due(localIn(40, 'America/Los_Angeles')), reason: 'Client delay' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    setNow(new Date((await dueOf()) - 24 * H + MIN));
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'due_soon'), 2, 'ESC-07-AC-2: re-armed for the new date');
  });

  it('ESC-09: escalated tasks in scope, never the caller’s own, names only, server filters, canAck parity', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA1, 'high', 500);
    setNow(new Date(start.getTime() + 36 * H + MIN));
    await runEngine();
    assert.deepEqual((await (await as(U.staffA1)).get('/api/escalations')).body, { error: "You don't have permission to view escalations." });
    const lead = await as(U.leadA);
    const res = await lead.get('/api/escalations?status=all');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.rows.find((r: any) => r.task.id === id);
    assert.deepEqual([row.level, row.status, row.canAck, typeof row.ackEventId], [1, 'active', true, 'number']);
    assert.deepEqual(row.recipients, ['Lead A', 'cc Staff A1']);
    assert.ok(res.body.rows.every((r: any) => r.task.assigneeId !== U.leadA), 'not the caller’s own tasks');
    assert.ok(!JSON.stringify(res.body).includes('@example.com'), 'ESC-09-AC-3: no email addresses');
    assert.ok(!(await (await as(U.leadB)).get('/api/escalations?status=all')).body.rows.some((r: any) => r.task.id === id), 'ESC-09-AC-1: another team cannot see it');
    assert.ok((await lead.get('/api/escalations?level=1&priority=high')).body.rows.some((r: any) => r.task.id === id));
    assert.ok(!(await lead.get('/api/escalations?level=2')).body.rows.some((r: any) => r.task.id === id));
    assert.equal((await lead.get('/api/escalations?status=bogus')).status, 422);

    assert.equal((await lead.post(`/api/escalations/${row.ackEventId}/ack`, { note: 'Looking into it' })).status, 200, 'ESC-09-AC-2: canAck matches the endpoint');
    const after = (await lead.get('/api/escalations?status=all')).body.rows.find((r: any) => r.task.id === id);
    assert.deepEqual([after.canAck, after.ackEventId], [false, null], 'nothing left for the lead (L0 is the assignee’s)');
  });

  it('ESC-08: run the engine now — needs manage_escalation_policies, answers the caller’s organization only', async () => {
    assert.equal((await (await as(U.leadA)).post('/api/admin/engine/run')).status, 403);
    const res = await (await as(U.cos)).post('/api/admin/engine/run');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows } = await pool.query(`select count(*)::int n from tasks t where organization_id = 1 and ${ladderSql('t')}`);
    assert.equal(res.body.checked, rows[0].n);
  });

  it('POL-01: anyone reads, only manage_escalation_policies writes; each rule answers 422 under its key; saving re-evaluates on the request and is audited', async () => {
    const cos = await as(U.cos);
    const lead = await as(U.leadA);
    assert.equal((await lead.get('/api/rules')).status, 200, 'POL-01-AC-4: everyone reads');
    assert.deepEqual((await lead.put('/api/rules/default', { config: DEFAULT_RULES })).body, { error: "You don't have permission to change escalation policies." });
    const bad = async (patch: object, key: string) => {
      const r = await cos.put('/api/rules/default', { config: { ...DEFAULT_RULES, ...patch } });
      assert.equal(r.status, 422, key);
      assert.ok(r.body.fields?.[key], `${key}: ${JSON.stringify(r.body)}`);
    };
    await bad({ windowsHours: { ...DEFAULT_RULES.windowsHours, critical: 721 } }, 'w_critical');
    await bad({ multiples: [1, 1.5, 1.5, 3] }, 'multiples');
    await bad({ overdueOffsetsHours: [0, 24, 24] }, 'offsets');
    await bad({ ackSnoozeHours: 73 }, 'ackSnoozeHours');
    await bad({ dueSoonHours: 0 }, 'dueSoonHours');
    assert.equal((await cos.put('/api/rules/default', { config: DEFAULT_RULES, note: 'See A123-456-789' })).status, 422, 'note: sensitive-ID guard');

    const start = now;
    const id = await newTask(U.leadA, U.staffA1, 'critical', 500);
    setNow(new Date(start.getTime() + 3 * H));
    await runEngine();
    assert.equal(await taskLevel(id), -1);
    const two = { ...DEFAULT_RULES, windowsHours: { ...DEFAULT_RULES.windowsHours, critical: 2 } };
    assert.equal((await cos.put('/api/rules/default', { config: two, note: 'Tighter critical' })).status, 200);
    assert.equal(await taskLevel(id), 1, 'POL-01-AC-2: 3 h silent ≥ 2 h × 1.5, on the save request');
    const { rows } = await pool.query(`select before, after, note from admin_log where kind = 'rules_change' and target = 'default' order by id desc limit 1`);
    assert.deepEqual([rows[0].before.windowsHours.critical, rows[0].after.windowsHours.critical, rows[0].after.l3NotifyCeo, rows[0].note], [4, 2, true, 'Tighter critical'], 'POL-01-AC-3');
    assert.equal((await cos.put('/api/rules/default', { config: DEFAULT_RULES })).status, 200);
    assert.equal(await taskLevel(id), -1, 'back down with the default');
  });

  it('POL-03: an override changes only its entity’s windows and multiples; reset follows the default; the default cannot be removed', async () => {
    const cos = await as(U.cos);
    const start = now;
    const bais = await newTask(U.leadA, U.staffA1, 'critical', 500);
    const emb = await newTask(U.leadB, U.staffB1, 'critical', 500);
    setNow(new Date(start.getTime() + 2 * H + MIN));
    const cfg = { windowsHours: { ...DEFAULT_RULES.windowsHours, critical: 2 }, multiples: DEFAULT_RULES.multiples };
    assert.equal((await cos.put('/api/rules/BAIS', { config: { ...cfg, quietHours: DEFAULT_RULES.quietHours } })).status, 422, 'D-48: windows and multiples only');
    assert.deepEqual((await cos.put('/api/rules/NOPE', { config: cfg })).body, { error: 'Unknown entity' });
    assert.equal((await cos.put('/api/rules/BAIS', { config: cfg, note: 'BAIS is faster' })).status, 200);
    await runEngine();
    assert.deepEqual([await taskLevel(bais), await taskLevel(emb)], [0, -1], 'POL-03-AC-1');
    const r = (await cos.get('/api/rules')).body;
    assert.deepEqual([r.overrides.BAIS.windowsHours.critical, r.overrides.BAIS.ackSnoozeHours], [2, DEFAULT_RULES.ackSnoozeHours], 'other fields follow the default');
    assert.equal((await cos.req('DELETE', '/api/rules/BAIS')).status, 204);
    assert.equal(await taskLevel(bais), -1, 'POL-03-AC-2: follows the default on the same request');
    assert.deepEqual((await cos.req('DELETE', '/api/rules/default')).body, { error: 'The default rules cannot be removed.' }, 'POL-03-AC-3');
    const log = await pool.query(`select before, after from admin_log where kind = 'rules_change' and target = 'BAIS' order by id`);
    assert.deepEqual(log.rows.map((x) => [x.before === null, x.after === null]), [[true, false], [false, true]], 'POL-03-AC-4');
  });
});

describe('Notifications (Phase 6: T-6.1–T-6.4)', () => {
  const rowsOf = async (taskId: number, userId: number, event: string) =>
    (await pool.query(`select channel, status, error, send_after from notifications where task_id = $1 and user_id = $2 and event = $3 order by channel`, [taskId, userId, event])).rows;

  it('NTF-01: own inbox only, unread count, mark read/unread, read-all count, type filter, delivery tags, paging', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'high', 48);
    const staff = await as(U.staffA1);
    const inbox = (await staff.get('/api/notifications')).body;
    const mine = (await pool.query(`select count(*)::int n from notifications where user_id = $1 and channel = 'inapp' and read_at is null`, [U.staffA1])).rows[0].n;
    assert.equal(inbox.unread, mine, 'NTF-01-AC-1');
    const item = inbox.items.find((n: any) => n.taskId === id);
    assert.deepEqual([item.type, item.read, item.deliveries], ['assignment', false, [{ channel: 'email', status: 'pending' }]], 'NTF-01-AC-4, D-106');
    assert.equal((await (await as(U.staffA2)).req('PATCH', `/api/notifications/${item.id}`, { read: true })).status, 404, 'NTF-01-AC-2');
    assert.equal((await staff.req('PATCH', `/api/notifications/${item.id}`, { read: 'yes' })).status, 422);
    assert.equal((await staff.req('PATCH', `/api/notifications/${item.id}`, { read: true })).status, 204);
    assert.equal((await staff.get('/api/notifications')).body.unread, mine - 1);
    assert.equal((await staff.req('PATCH', `/api/notifications/${item.id}`, { read: false })).status, 204);
    assert.equal((await staff.get('/api/notifications')).body.unread, mine);
    assert.ok((await staff.get('/api/notifications?type=assignment')).body.items.every((n: any) => n.type === 'assignment'));
    assert.equal((await staff.get('/api/notifications?type=nope')).status, 422);
    const page = (await staff.get('/api/notifications?limit=1')).body;
    const rest = (await staff.get(`/api/notifications?limit=100&before=${page.next}`)).body;
    assert.ok(page.items.length === 1 && !rest.items.some((n: any) => n.id === page.items[0].id), 'paging');
    assert.equal((await staff.post('/api/notifications/read-all', {})).body.count, mine, 'NTF-01-AC-3');
    assert.equal((await staff.post('/api/notifications/read-all', {})).body.count, 0);
  });

  it('NTF-04: defaults, mandatory types stay on, channels independent (D-43), WhatsApp key validated, audited', async () => {
    const lead = await as(U.leadA);
    const got = (await lead.get('/api/me/notification-prefs')).body;
    assert.deepEqual([got.prefs.inApp.progress, got.prefs.email.progress, got.prefs.email.assignment, got.whatsappAvailable], [true, false, true, false], 'defaults; D-106');
    assert.ok(got.mandatory.includes('blocked'), 'D-42');
    assert.equal((await lead.put('/api/me/notification-prefs', { inApp: {}, email: {}, whatsapp: { progress: true } })).status, 422, 'NTF-04-AC-3');
    assert.equal((await lead.put('/api/me/notification-prefs', { inApp: { progress: false }, email: { progress: true, assignment: false }, whatsapp: {} })).status, 204);
    const saved = (await lead.get('/api/me/notification-prefs')).body.prefs;
    assert.deepEqual([saved.inApp.progress, saved.email.progress, saved.email.assignment], [false, true, true], 'mandatory stored on');
    const id = await newTask(U.leadA, U.staffA1, 'high', 48);
    assert.equal((await (await as(U.staffA1)).req('POST', `/api/tasks/${id}/updates`, { body: 'Halfway there.' })).status, 201);
    assert.deepEqual((await rowsOf(id, U.leadA, 'progress')).map((r) => r.channel), ['email'], 'NTF-04-AC-2 + D-43: email without in-app');
    const mgr = await as(U.mgrA);
    assert.equal((await mgr.put('/api/me/notification-prefs', { inApp: {}, email: { assignment: false }, whatsapp: {} })).status, 204);
    const t2 = await newTask(U.mgrA, U.leadA, 'high', 48);
    assert.deepEqual((await rowsOf(t2, U.leadA, 'assigned')).map((r) => r.channel), ['email', 'inapp'], 'NTF-04-AC-1: mandatory ignores prefs');
    const audit = await pool.query(`select count(*)::int n from admin_log where kind = 'preferences.updated' and actor_id = $1`, [U.leadA]);
    assert.equal(audit.rows[0].n, 1, 'NTF-04-AC-4');
    await lead.put('/api/me/notification-prefs', { inApp: {}, email: {}, whatsapp: {} });
  });

  it('D-105: a personal quiet window overrides the organization’s, in the person’s zone', async () => {
    const cos = await as(U.cos);
    // ADR-0011: in a department led by Lead A, so the person reports to Lead A and Lead A may assign them (D-130).
    const { rows: dept } = await pool.query(`insert into teams (name, entity_id, lead_id, organization_id) values ('BAIS night', 'BAIS', $1, 1) returning id`, [U.leadA]);
    const body = { name: 'Night Shift', email: 'night.shift@example.com', title: 'Analyst', roles: ['staff'], entityId: 'BAIS', teamId: dept[0].id, timezone: 'Asia/Kolkata' };
    assert.deepEqual((await cos.post('/api/people', { ...body, quietStart: '08:00' })).body.fields, { quietEnd: 'Set both quiet-hours times, or neither.' });
    assert.deepEqual((await cos.post('/api/people', { ...body, quietStart: '8am', quietEnd: '20:00' })).body.fields, { quietStart: 'Use HH:MM (24-hour)' });
    const pid = (await cos.post('/api/people', { ...body, quietStart: '08:00', quietEnd: '20:00' })).body.id;
    const u = (await cos.get(`/api/people/${pid}`)).body.user;
    assert.deepEqual([u.quietStart, u.quietEnd], ['08:00', '20:00']);
    setNow(new Date('2026-12-10T01:29:00Z')); // 06:59 IST
    const id = await newTask(U.leadA, pid, 'critical', 48);
    setNow(new Date('2026-12-10T05:31:00Z')); // 11:01 IST: outside the organization's 21:00–08:00, inside the person's 08:00–20:00
    await runEngine();
    const [email, inappRow] = await rowsOf(id, pid, 'L0');
    assert.deepEqual([email.channel, email.status, email.error, email.send_after.toISOString()], ['email', 'held', 'Quiet hours 08:00–20:00 (IST)', '2026-12-10T14:30:00.000Z'], 'released 20:00 IST');
    assert.equal(inappRow.status, 'sent', 'in-app never held');
  });

  it('NTF-02-AC-5: the dispatcher reclaims a row stuck in sending after 10 min; D-106 leaves WhatsApp rows alone', async () => {
    const ins = (status: string, channel: string, claimedAgo: number | null) =>
      pool
        .query(
          `insert into notifications (user_id, event, channel, status, address, subject, body, send_after, created_at, claimed_at, attempts, organization_id)
           values ($1, 'L1', $2, $3, 'x@example.com', 's', 'b', $4, $4, $5, 1, 1) returning id`,
          [U.leadA, channel, status, now, claimedAgo === null ? null : new Date(now.getTime() - claimedAgo)],
        )
        .then((r) => r.rows[0].id as number);
    const stuck = await ins('sending', 'email', 11 * MIN);
    const busy = await ins('sending', 'email', 5 * MIN);
    const wa = await ins('pending', 'whatsapp', null);
    setDispatcherEnabled(true);
    try {
      await dispatchDue(1000);
    } finally {
      setDispatcherEnabled(false);
    }
    const st = async (id: number) => (await pool.query('select status from notifications where id = $1', [id])).rows[0].status;
    assert.deepEqual([await st(stuck), await st(busy), await st(wa)], ['simulated', 'sending', 'pending']);
  });

  it('ADR-0012: Web Push: own subscriptions only, a push row per browser-enabled person and pref, sent, gone browsers revoked', async () => {
    const staff = await as(U.staffA2);
    const endpoint = 'https://push.example.com/send/staff-a2';
    const keys = { p256dh: 'BPk3', auth: 'a1' };
    assert.equal((await staff.post('/api/push/subscribe', { endpoint: 'http://push.example.com/x', keys })).status, 422, 'https only');
    assert.equal((await staff.post('/api/push/subscribe', { endpoint, keys, extra: 1 })).status, 422, 'strict');
    assert.equal((await staff.post('/api/push/subscribe', { endpoint, keys })).status, 204);
    const active = async () => (await pool.query('select user_id from push_subscriptions where endpoint = $1 and revoked_at is null', [endpoint])).rows;
    assert.deepEqual(await active(), [{ user_id: U.staffA2 }]);
    assert.equal((await (await as(U.leadA)).post('/api/push/unsubscribe', { endpoint })).status, 204);
    assert.equal((await active()).length, 1, 'nobody revokes another person’s browser');

    const id = await newTask(U.leadA, U.staffA2, 'high', 48);
    assert.deepEqual((await rowsOf(id, U.staffA2, 'assigned')).map((r) => r.channel), ['email', 'inapp', 'push'], 'everything in the bell');
    assert.deepEqual((await rowsOf(id, U.staffA1, 'assigned')).length, 0);
    assert.equal((await staff.put('/api/me/notification-prefs', { inApp: {}, email: {}, whatsapp: {}, push: { progress: false } })).status, 204);
    assert.equal((await staff.put('/api/me/notification-prefs', { inApp: {}, email: {}, whatsapp: {} })).status, 204, 'an older client without push');
    assert.equal((await staff.get('/api/me/notification-prefs')).body.prefs.push.progress, false, 'kept when not sent');

    const saved = { ...config.push };
    const vapid = webpush.generateVAPIDKeys();
    Object.assign(config.push, { enabled: true, publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: 'mailto:test@example.com' });
    const sent: string[] = [];
    setPushSender(async (sub) => void sent.push(sub.endpoint));
    setDispatcherEnabled(true);
    try {
      await dispatchDue(1000);
      assert.equal((await rowsOf(id, U.staffA2, 'assigned'))[2].status, 'sent');
      assert.ok(sent.includes(endpoint));
      setPushSender(async () => Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 })));
      assert.deepEqual((await staff.post('/api/push/test', {})).body, { simulated: false, delivered: 0, gone: 1, noBrowser: false });
      assert.equal((await active()).length, 0, '410 revokes');
    } finally {
      setDispatcherEnabled(false);
      setPushSender(null);
      Object.assign(config.push, saved);
    }
    await staff.put('/api/me/notification-prefs', { inApp: {}, email: {}, whatsapp: {}, push: {} });
  });
});

describe('Delivery log and weekly digest (Phase 6: T-6.7, T-6.8)', () => {
  it('DLV-01/02: permission, CoS sees the organization, others their own, copied flag, own history capped at 30', async () => {
    assert.equal((await (await as(U.staffA1)).get('/api/deliveries')).status, 403, 'DLV-01-AC-1');
    const cos = (await (await as(U.cos)).get('/api/deliveries')).body;
    assert.ok(cos.items.some((d: any) => d.recipient.id !== U.cos), 'D-52: CoS sees other people');
    assert.deepEqual(cos.integrations, { email: 'simulated', whatsapp: 'off' }, 'NTF-06 status, D-106; no credential values');
    assert.ok(cos.items.every((d: any) => d.channel !== 'inapp'));
    const { rows: cc } = await pool.query(
      `select n.id from notifications n join escalation_recipients r on r.escalation_id = n.escalation_id and r.user_id = n.user_id
        where r.kind = 'cc' and n.channel = 'email' and n.organization_id = 1 order by n.id desc limit 1`,
    );
    assert.ok(cc[0], 'fixture: an escalation email to a copied recipient');
    assert.equal(cos.items.find((d: any) => d.id === cc[0].id)?.copied, true, 'DLV-01-AC-5');
    const ceo = (await (await as(U.ceo)).get('/api/deliveries')).body;
    assert.ok(ceo.items.every((d: any) => d.recipient.id === U.ceo), 'D-52: anyone but a CoS sees only their own');
    const mine = (await (await as(U.staffA1)).get('/api/me/deliveries')).body.items;
    assert.ok(mine.length <= 30 && mine.every((d: any) => d.recipient.id === U.staffA1), 'DLV-02-AC-1');
  });

  it('NTF-05: manual send permissions and audit; one digest per recipient per week at Monday 09:00 IST', async () => {
    assert.equal((await (await as(U.mgrA)).post('/api/admin/digest', { scope: 'all' })).status, 403, 'NTF-05-AC-5');
    assert.equal((await (await as(U.staffA1)).post('/api/admin/digest', { scope: 'me' })).status, 403, 'NTF-05-AC-4');
    assert.equal((await (await as(U.mgrA)).post('/api/admin/digest', { scope: 'me' })).body.sent, 1, 'preview to oneself');
    const sent = (await (await as(U.cos)).post('/api/admin/digest', { scope: 'all' })).body.sent;
    const { rows: rec } = await pool.query(`select count(*)::int n from users where organization_id = 1 and active and roles && array['manager','cos','ceo']`);
    assert.equal(sent, rec[0].n, 'every recipient of the caller’s organization');
    const audit = await pool.query(`select after from admin_log where kind = 'digest.sent_manually' and actor_id = $1 order by id desc limit 1`, [U.cos]);
    assert.deepEqual(audit.rows[0].after, { recipients: sent });

    const digests = async () => (await pool.query(`select count(*)::int n from notifications where event = 'digest' and organization_id = 1 and created_at = $1`, [now])).rows[0].n;
    setNow(new Date('2026-12-14T03:29:00Z')); // Monday 08:59 IST
    await maybeRunDigest();
    assert.equal(await digests(), 0, '08:59 IST: not yet');
    setNow(new Date('2026-12-14T03:30:00Z')); // Monday 09:00 IST
    await maybeRunDigest();
    assert.equal(await digests(), rec[0].n, 'NTF-05-AC-1');
    await maybeRunDigest();
    assert.equal(await digests(), rec[0].n, 'a second run the same week sends none');
    const { rows } = await pool.query(`select u.roles from notifications n join users u on u.id = n.user_id where n.event = 'digest' and n.created_at = $1`, [now]);
    assert.ok(rows.every((r) => r.roles.some((x: string) => ['manager', 'cos', 'ceo'].includes(x))), 'NTF-05-AC-4');
  });
});

describe('Performance (PERF): measured tasks, ratings, scores, workload', () => {
  const IST = 'Asia/Kolkata';
  const measured = (o: Record<string, unknown> = {}) => ({
    title: 'Follow-up emails to CA attorneys', category: 'Operations', assigneeId: U.staffA1, priority: 'normal',
    ...due(localIn(30, IST)), target: 150, unit: 'emails', estimatedHours: 2, purpose: 'revenue', ...o,
  });

  it('PERF Task 2: a task carries target, unit, estimate and purpose; the API requires estimate and purpose', async () => {
    const lead = await as(U.leadA);
    const res = await lead.post('/api/tasks', measured());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      [res.body.task.target, res.body.task.unit, res.body.task.estimatedHours, res.body.task.purpose, res.body.task.achieved],
      [150, 'emails', 2, 'revenue', null],
    );
    const { rows } = await pool.query('select scored from tasks where id = $1', [res.body.task.id]);
    assert.equal(rows[0].scored, true, 'new tasks are scored');
    const fields = async (o: Record<string, unknown>) => (await lead.post('/api/tasks', measured(o))).body.fields;
    assert.deepEqual(await fields({ estimatedHours: undefined }), { estimatedHours: 'Between 0.25 and 200 hours.' });
    assert.deepEqual(await fields({ purpose: undefined }), { purpose: 'Choose revenue or support.' });
    assert.deepEqual(await fields({ unit: '' }), { unit: 'Name the unit, e.g. emails.' });
    assert.deepEqual(await fields({ target: 0 }), { target: 'Enter a target above 0.' });
    assert.deepEqual(await fields({ estimatedHours: 300 }), { estimatedHours: 'Between 0.25 and 200 hours.' });
    // A draft may leave them out; publishing requires them.
    const draft = await lead.post('/api/tasks', measured({ estimatedHours: undefined, purpose: undefined, draft: true }));
    assert.equal(draft.status, 201);
    assert.deepEqual((await lead.post(`/api/tasks/${draft.body.task.id}/publish`)).body.fields, { estimatedHours: 'Between 0.25 and 200 hours.', purpose: 'Choose revenue or support.' });
  });

  it('PERF Task 2: a schedule carries the measured fields to each generated task', async () => {
    const day = DateTime.fromJSDate(now, { zone: IST }).plus({ days: 1 }).startOf('day').set({ hour: 9 });
    setNow(day.toJSDate());
    const res = await (await as(U.leadA)).post('/api/recurring', {
      title: 'Daily outreach batch', category: 'Operations', priority: 'normal', assigneeId: U.staffA1, frequency: 'daily', interval: 1,
      startDate: day.toISODate(), dueHour: 17, target: 50, unit: 'emails', estimatedHours: 1.5, purpose: 'revenue',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = await pool.query('select target, unit, estimated_hours, purpose from tasks where recurring_id = $1', [res.body.id]);
    assert.deepEqual(t.rows[0], { target: 50, unit: 'emails', estimated_hours: 1.5, purpose: 'revenue' });
  });

  it('PERF Task 3: reporting achieved updates progress and counts as an update; finishing short or late needs a reason', async () => {
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const id = (await lead.post('/api/tasks', measured({ title: 'Outreach batch A' }))).body.task.id;
    const before = (await pool.query('select clock_started_at from tasks where id = $1', [id])).rows[0].clock_started_at;
    advance(MIN);
    const p = await staff.post(`/api/tasks/${id}/progress`, { message: 'Sent the first batch', achieved: 70 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([p.body.task.achieved, p.body.task.progress], [70, 47]);
    const after = (await pool.query('select clock_started_at from tasks where id = $1', [id])).rows[0].clock_started_at;
    assert.ok(after > before, 'the silence clock restarted');
    assert.deepEqual((await staff.post(`/api/tasks/${id}/complete`, { achieved: 140 })).body.fields, { shortfallReason: 'Explain the shortfall or delay.' });
    const done = await staff.post(`/api/tasks/${id}/complete`, { achieved: 140, result: '6 replies, 2 consultations booked', shortfallReason: '10 addresses bounced' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual([done.body.task.status, done.body.task.achieved, done.body.task.result, done.body.task.shortfallReason], ['completed', 140, '6 replies, 2 consultations booked', '10 addresses bounced']);
    // Late but on target still needs a reason.
    const late = (await lead.post('/api/tasks', measured({ title: 'Outreach batch B', ...due(localIn(2, IST)) }))).body.task.id;
    advance(3 * H);
    assert.deepEqual((await staff.post(`/api/tasks/${late}/complete`, { achieved: 150 })).body.fields, { shortfallReason: 'Explain the shortfall or delay.' });
    assert.equal((await staff.post(`/api/tasks/${late}/complete`, { achieved: 150, shortfallReason: 'CRM import was down' })).status, 200);
    // A task without a target has nothing to report against.
    const plain = (await lead.post('/api/tasks', measured({ title: 'Write the blog', target: null, unit: '' }))).body.task.id;
    assert.deepEqual((await staff.post(`/api/tasks/${plain}/progress`, { message: 'Draft half done', achieved: 3 })).body.fields, { achieved: 'This task has no target to report against.' });
  });

  it('Leaderboard analytics: 8-week trend for the team; a team comparison only for viewers who see several teams; 404 outside scope', async () => {
    // Test data: two fresh teams (users start without one); Lead A and Staff A1 join the first. Restored afterwards.
    const { rows: before } = await pool.query('select id, team_id from users where id = any($1)', [[U.leadA, U.staffA1]]);
    const { rows: made } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('Analytics A', 'BAIS', 1), ('Analytics B', 'BAIS', 1) returning id`);
    const [teamA, teamB] = made.map((t) => t.id);
    await pool.query('update users set team_id = $1 where id = any($2)', [teamA, [U.leadA, U.staffA1]]);
    invalidateDirectory();
    try {
      const lead = (await (await as(U.leadA)).get(`/api/performance/analytics?teamId=${teamA}&period=month`)).body;
      assert.equal(lead.trend.length, 8, JSON.stringify(lead));
      assert.ok(lead.trend.every((w: any) => 'average' in w && typeof w.scored === 'number' && new Date(w.from) < new Date(w.to)));
      // The comparison appears only for viewers who may open more than one team board (D-117 / D-128). Other tests can
      // leave Lead A with reports in a second department, so the expectation follows the lead's own team list.
      const leadTeams = (await (await as(U.leadA)).get('/api/performance/teams')).body.map((t: { id: number }) => t.id).sort();
      assert.deepEqual(lead.teams.map((t: { id: number }) => t.id).sort(), leadTeams.length > 1 ? leadTeams : [], 'comparison only across the teams the lead may see');
      const cos = (await (await as(U.cos)).get(`/api/performance/analytics?teamId=${teamA}&period=month`)).body;
      assert.ok(cos.teams.length > 1, 'the Founder\'s Office compares every team');
      const avgs = cos.teams.map((t: any) => t.average ?? -1);
      assert.deepEqual(avgs, [...avgs].sort((a: number, b: number) => b - a), 'best average first');
      assert.equal((await (await as(U.staffA1)).get(`/api/performance/analytics?teamId=${teamB}&period=month`)).status, 404, 'another team');
    } finally {
      for (const r of before) await pool.query('update users set team_id = $2 where id = $1', [r.id, r.team_id]); // test data only
      invalidateDirectory();
    }
  });

  it('D-125: over the standard working time needs a reason, posted as a comment; the reviewer sees worked vs standard', async () => {
    const { rows: who } = await pool.query('select time_zone, quiet_start, quiet_end from users where id = $1', [U.staffA1]);
    assert.equal(who[0].quiet_start, null, 'this check uses the organization workday');
    // Monday 10:00 in the assignee's zone: inside the 09:00–18:00 workday.
    const monday = DateTime.fromJSDate(now, { zone: who[0].time_zone }).plus({ weeks: 1 }).startOf('week').set({ hour: 10 });
    setNow(monday.toJSDate());
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const id = (await lead.post('/api/tasks', measured({ title: 'Overtime check', estimatedHours: 1, ...due(localIn(48, IST)) }))).body.task.id;
    advance(2 * H);
    assert.deepEqual((await staff.get(`/api/tasks/${id}`)).body.time, { worked: 2, standard: 1 });
    assert.deepEqual((await staff.post(`/api/tasks/${id}/complete`, { achieved: 150 })).body.fields, {
      shortfallReason: 'Took 2.0 working hours against a 1 h standard: explain the delay.',
    });
    assert.equal((await staff.post(`/api/tasks/${id}/complete`, { achieved: 150, shortfallReason: 'Client changed the list twice' })).status, 200);
    const d = (await lead.get(`/api/tasks/${id}`)).body;
    assert.deepEqual(d.time, { worked: 2, standard: 1 }, 'frozen at completion');
    assert.ok(d.comments.some((c: { body: string }) => c.body === 'Reason for delay or shortfall: Client changed the list twice'), 'posted in the task chat');
    // Within the standard: no reason asked.
    const quick = (await lead.post('/api/tasks', measured({ title: 'Quick check', estimatedHours: 3, ...due(localIn(48, IST)) }))).body.task.id;
    advance(H);
    assert.equal((await staff.post(`/api/tasks/${quick}/complete`, { achieved: 150 })).status, 200);
    // Waiting in review is the reviewer's time: 1 h work, 3 h in review, 0.5 h rework → 1.5 h worked.
    setNow(monday.plus({ days: 1 }).toJSDate());
    const reviewed = (await lead.post('/api/tasks', measured({ title: 'Reviewed overtime check', estimatedHours: 2, reviewRequired: true, ...due(localIn(48, IST)) }))).body.task.id;
    assert.equal((await staff.post(`/api/tasks/${reviewed}/start`)).status, 200, 'submit needs In progress');
    advance(H);
    assert.equal((await staff.post(`/api/tasks/${reviewed}/submit`, { note: 'First draft ready', achieved: 150 })).status, 200);
    advance(3 * H);
    assert.equal((await lead.post(`/api/tasks/${reviewed}/review`, { decision: 'changes_requested', comment: 'Add the summary' })).status, 200);
    advance(30 * MIN);
    assert.deepEqual((await staff.get(`/api/tasks/${reviewed}`)).body.time, { worked: 1.5, standard: 2 });
    // A cancelled task shows no running clock.
    assert.equal((await lead.post(`/api/tasks/${reviewed}/cancel`, { reason: 'No longer needed' })).status, 200);
    assert.equal((await lead.get(`/api/tasks/${reviewed}`)).body.time, null);
  });

  it('PERF Task 4 / D-173: approving a review needs an outcome score without a target; quality comes from returns', async () => {
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const id = (await lead.post('/api/tasks', measured({ title: 'Draft the PERM brief', target: null, unit: '', reviewRequired: true }))).body.task.id;
    await staff.post(`/api/tasks/${id}/start`);
    assert.equal((await staff.post(`/api/tasks/${id}/submit`, { note: 'Brief ready for review' })).status, 200);
    assert.deepEqual((await lead.post(`/api/tasks/${id}/review`, { decision: 'approved' })).body.fields, {
      outcomeScore: 'Give an outcome score from 0 to 100.',
    });
    // One return for corrections, then approval without any quality number.
    assert.equal((await lead.post(`/api/tasks/${id}/review`, { decision: 'changes_requested', comment: 'Add the missing sections' })).status, 200);
    await staff.post(`/api/tasks/${id}/start`);
    assert.equal((await staff.post(`/api/tasks/${id}/submit`, { note: 'Sections added, ready again' })).status, 200);
    const ok = await lead.post(`/api/tasks/${id}/review`, { decision: 'approved', outcomeScore: 85 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.task.status, ok.body.task.outcomeScore], ['completed', 85]);
    const day = (d: number) => DateTime.now().setZone(IST).plus({ days: d }).toISODate();
    const mine = await staff.get(`/api/performance/people/${U.staffA1}?period=custom&from=${day(-1)}&to=${day(60)}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    const row = mine.body.tasks.find((t: { id: number }) => t.id === id);
    assert.ok(row, 'the reviewed task is in the breakdown');
    assert.deepEqual([row.reviewed, row.reworkCount, row.quality, row.timeliness], [true, 1, 60, 100], 'one return → quality 60; delivered early → timeliness 100');
  });

  it('PERF Task 4: the giver rates a finished task and decides on a shortfall; others may not', async () => {
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const plain = (await lead.post('/api/tasks', measured({ title: 'Write the weekly blog', target: null, unit: '' }))).body.task.id;
    const done = await staff.post(`/api/tasks/${plain}/complete`, {});
    assert.deepEqual([done.body.task.awaitingRating, done.body.actions.includes('rate')], [true, false], 'the assignee cannot rate');
    assert.equal((await (await as(U.mgrA)).post(`/api/tasks/${plain}/rate`, { outcomeScore: 50 })).status, 403, 'a supervisor who did not give it');
    const rated = await lead.post(`/api/tasks/${plain}/rate`, { outcomeScore: 80 });
    assert.equal(rated.status, 200, JSON.stringify(rated.body));
    assert.deepEqual([rated.body.task.outcomeScore, rated.body.task.awaitingRating], [80, false]);
    assert.deepEqual((await lead.post(`/api/tasks/${plain}/rate`, {})).body.fields, { _: 'Give an outcome score or decide on the shortfall.' });
    // A shortfall is accepted (or not) by the giver; the decision is recorded.
    const short = (await lead.post('/api/tasks', measured({ title: 'Outreach batch C' }))).body.task.id;
    await staff.post(`/api/tasks/${short}/complete`, { achieved: 120, shortfallReason: 'List ran out' });
    assert.equal((await lead.post(`/api/tasks/${short}/rate`, { shortfallAccepted: true })).status, 200);
    const { rows } = await pool.query('select shortfall_accepted, shortfall_decided_by from tasks where id = $1', [short]);
    assert.deepEqual(rows[0], { shortfall_accepted: true, shortfall_decided_by: U.leadA });
    // A blocked task past its due date: the giver may accept the delay while it is still open.
    const blocked = (await lead.post('/api/tasks', measured({ title: 'Outreach batch D', ...due(localIn(1, IST)) }))).body.task.id;
    await staff.post(`/api/tasks/${blocked}/block`, { reason: 'CRM import access missing' });
    advance(2 * H);
    const open = await lead.post(`/api/tasks/${blocked}/rate`, { shortfallAccepted: true });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.task.shortfallAccepted, true);
  });

  it('PERF Task 5: team leaderboard, breakdown and workload follow the access rules and the formulas', async () => {
    advance(60 * 24 * H); // past every earlier test's due dates, so only this test's tasks fall in the periods below
    // Test data: two fresh teams. Staff A2 (and Lead A) in Perf A, Staff B1 in Perf B.
    const { rows: teams } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('Perf A', 'BAIS', 1), ('Perf B', 'EMB', 1) returning id`);
    const [teamA, teamB] = teams.map((t) => t.id);
    await pool.query('update users set team_id = $1 where id = any($2)', [teamA, [U.staffA2, U.leadA]]);
    await pool.query('update users set team_id = $1 where id = $2', [teamB, U.staffB1]);
    invalidateDirectory();
    const lead = await as(U.leadA);
    const a2 = await as(U.staffA2);
    const PT = 'America/Los_Angeles';
    for (let i = 0; i < 5; i++) {
      const id = (await lead.post('/api/tasks', measured({ title: `Perf task ${i}`, assigneeId: U.staffA2, target: 10, ...due(localIn(30, PT)) }))).body.task.id;
      assert.equal((await a2.post(`/api/tasks/${id}/complete`, { achieved: 10 })).status, 200);
    }
    const range = (d: number) => DateTime.fromJSDate(now, { zone: 'America/New_York' }).plus({ days: d }).toISODate();
    const q = `period=custom&from=${range(-1)}&to=${range(5)}`;
    const board = await lead.get(`/api/performance/leaderboard?teamId=${teamA}&${q}`);
    assert.equal(board.status, 200, JSON.stringify(board.body));
    assert.deepEqual(board.body.weights, { critical: 1, high: 1, normal: 1, low: 1 }, 'D-124: priority weights, equal by default');
    const row = board.body.rows.find((r: any) => r.userId === U.staffA2);
    assert.deepEqual([row.outcome, row.timeliness, row.quality, row.score, row.eligible, row.rank], [100, 100, null, 100, 5, 1]);
    assert.ok(row.flags.includes('no_quality_reviews'));
    const leadRow = board.body.rows.find((r: any) => r.userId === U.leadA);
    assert.deepEqual([leadRow.score, leadRow.rank], [null, null], 'no eligible tasks: no score, not ranked');

    // Who sees which board (FRD §3).
    assert.equal((await a2.get(`/api/performance/leaderboard?teamId=${teamA}&${q}`)).status, 200, 'own team');
    const missing = await a2.get(`/api/performance/leaderboard?teamId=999999&${q}`);
    assert.deepEqual(await a2.get(`/api/performance/leaderboard?teamId=${teamB}&${q}`), missing, 'another team = not found');
    assert.equal((await (await as(U.leadB)).get(`/api/performance/leaderboard?teamId=${teamA}&${q}`)).status, 404, 'not in their reporting line');
    assert.equal((await (await as(U.mgrA)).get(`/api/performance/leaderboard?teamId=${teamA}&${q}`)).status, 200, 'a manager above the team');
    assert.equal((await (await as(U.cos)).get(`/api/performance/leaderboard?teamId=${teamB}&${q}`)).status, 200, 'the CoS sees every team');
    assert.equal((await (await as(900)).get(`/api/performance/leaderboard?teamId=${teamA}&${q}`)).status, 404, 'never across organizations');
    // The team picker lists only the boards the viewer may open.
    assert.deepEqual((await a2.get('/api/performance/teams')).body.map((t: any) => t.id), [teamA], 'staff: own team only');
    assert.ok((await (await as(U.cos)).get('/api/performance/teams')).body.some((t: any) => t.id === teamB), 'CoS: every team');

    // Breakdown: an employee may open only their own; the tasks behind the score are listed.
    const mine = await a2.get(`/api/performance/people/${U.staffA2}?${q}`);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.tasks.length, 5);
    assert.equal((await a2.get(`/api/performance/people/${U.leadA}?${q}`)).status, 404);

    // Review Focus 3: an extended due date moves the task into the new date's period.
    const moved = (await lead.post('/api/tasks', measured({ title: 'Moves to next week', assigneeId: U.staffA2, ...due(localIn(30, PT)) }))).body.task.id;
    assert.equal((await lead.post(`/api/tasks/${moved}/due`, { ...due(localIn(24 * 9, PT)), reason: 'Client asked for more time' })).status, 200);
    await a2.post(`/api/tasks/${moved}/complete`, { achieved: 150 });
    const ids = async (from: number, to: number) => (await a2.get(`/api/performance/people/${U.staffA2}?period=custom&from=${range(from)}&to=${range(to)}`)).body.tasks.map((t: any) => t.id);
    assert.ok(!(await ids(-1, 5)).includes(moved), 'not in the original period');
    assert.ok((await ids(6, 12)).includes(moved), 'in the new period');

    // Workload: estimated hours of open work, against working hours.
    const open = (await lead.post('/api/tasks', measured({ title: 'Big open job', assigneeId: U.staffA2, estimatedHours: 30, ...due(localIn(30, PT)) }))).body.task.id;
    assert.ok(open);
    const wl = await lead.get(`/api/workload?teamId=${teamA}`);
    assert.equal(wl.status, 200, JSON.stringify(wl.body));
    const w = wl.body.rows.find((r: any) => r.userId === U.staffA2);
    assert.ok(w.openHours >= 30 && ['light', 'normal', 'overloaded'].includes(w.band));
    const picker = (await lead.get('/api/tasks/options/assignees')).body.find((u: any) => u.id === U.staffA2);
    assert.ok(picker.load && typeof picker.load.loadPercent === 'number', 'the assignee picker shows load');
  });

  it('PERF final review I1–I3: review scores are logged; no shortfall decision without a reason; reopening clears the ratings', async () => {
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    // I1: the review's scores are in the tamper-evident activity log.
    const r = (await lead.post('/api/tasks', measured({ title: 'Reviewed report', target: null, unit: '', reviewRequired: true }))).body.task.id;
    await staff.post(`/api/tasks/${r}/start`);
    await staff.post(`/api/tasks/${r}/submit`, { note: 'Report ready for review' });
    assert.equal((await lead.post(`/api/tasks/${r}/review`, { decision: 'approved', qualityScore: 70, outcomeScore: 60 })).status, 200);
    const log = await pool.query(`select after from activity_log where task_id = $1 and kind = 'review_decided' order by seq desc limit 1`, [r]);
    assert.deepEqual([log.rows[0].after.qualityScore, log.rows[0].after.outcomeScore], [70, 60]);
    // I2: a shortfall decision needs a shortfall or delay reason to decide on.
    const plain = (await lead.post('/api/tasks', measured({ title: 'On-time plain task', target: null, unit: '' }))).body.task.id;
    await staff.post(`/api/tasks/${plain}/complete`, {});
    assert.deepEqual((await lead.post(`/api/tasks/${plain}/rate`, { shortfallAccepted: true })).body.fields, { shortfallAccepted: 'There is no shortfall or delay reason to decide on.' });
    // I3: reopening clears the ratings and the reason, so the new round is judged afresh.
    const short = (await lead.post('/api/tasks', measured({ title: 'Outreach batch E' }))).body.task.id;
    await staff.post(`/api/tasks/${short}/complete`, { achieved: 100, shortfallReason: 'List ran out' });
    await lead.post(`/api/tasks/${short}/rate`, { shortfallAccepted: true });
    assert.equal((await lead.post(`/api/tasks/${short}/reopen`, { reason: 'Client sent more contacts', ...due(localIn(48, IST)) })).status, 200);
    const { rows } = await pool.query('select shortfall_reason, shortfall_accepted, shortfall_decided_by, outcome_score, quality_score from tasks where id = $1', [short]);
    assert.deepEqual(rows[0], { shortfall_reason: null, shortfall_accepted: null, shortfall_decided_by: null, outcome_score: null, quality_score: null });
  });
});

describe('Demo clock (T-10.1; DEMO-01, D-17, D-47)', () => {
  it('TC-DEMO-01-01: with demo tools off, POST /api/dev/clock is 404 for everyone (CoS included) and /me reports demo: null', async () => {
    const { config: cfg } = await import('../src/config.js');
    assert.equal(cfg.demoTools, false, 'off unless DEMO_TOOLS=true');
    for (const id of [U.cos, U.mgrA]) assert.equal((await (await as(id)).post('/api/dev/clock', { advanceHours: 1 })).status, 404, `user ${id}: 404, not 403`);
    assert.equal((await (await as(U.cos)).get('/api/me')).body.demo, null);
  });

  it('TC-DEMO-01-02: with demo tools on, a non-CoS gets 403; the CoS moves the clock, audited before/after; bad input is 422', async () => {
    const { config: cfg } = await import('../src/config.js');
    const cos = await as(U.cos);
    (cfg as { demoTools: boolean }).demoTools = true;
    try {
      assert.equal((await (await as(U.mgrA)).post('/api/dev/clock', { advanceHours: 1 })).status, 403);
      for (const bad of [{ advanceHours: -1 }, { advanceHours: 721 }, { advanceHours: 1, extra: true }]) assert.equal((await cos.post('/api/dev/clock', bad)).status, 422, JSON.stringify(bad));
      const r = await cos.post('/api/dev/clock', { advanceHours: 6 });
      assert.equal(r.status, 200);
      assert.equal(r.body.offsetHours, 6);
      assert.equal((await cos.get('/api/me')).body.demo.offsetHours, 6, 'G-8: /me carries the offset for the banner');
      const { rows } = await pool.query(`select before, after, source from admin_log where kind = 'demo_clock' order by seq desc limit 1`);
      assert.deepEqual(rows[0], { before: { offsetHours: 0 }, after: { offsetHours: 6 }, source: 'demo' });
      assert.equal((await cos.post('/api/dev/clock', { reset: true })).body.offsetHours, 0);
    } finally {
      (cfg as { demoTools: boolean }).demoTools = false;
      (await import('../src/clock.js')).setOffsetMs(0);
    }
  });
});

describe('Review fixes 2026-11-07 (H1, H2, H3, H5)', () => {
  it('H1 / SEC-9: placement needs a placement permission even with nothing to change, and a team move returns no contact details', async () => {
    const empty = await (await as(U.staffA1)).put(`/api/people/${U.cos}/placement`, {});
    assert.deepEqual([empty.status, empty.body], [403, { error: 'You cannot move this person between departments.' }], 'an empty body is no free read');
    const { rows } = await pool.query(`insert into teams (name, entity_id, organization_id) values ('BAIS H1', 'BAIS', 1) returning id`);
    try {
      const moved = await (await as(U.mgrA)).put(`/api/people/${U.staffA1}/placement`, { teamId: rows[0].id });
      assert.equal(moved.status, 200);
      for (const k of ['email', 'phone', 'whatsapp']) assert.ok(!(k in moved.body), `no ${k} without manage_staff`);
    } finally {
      await restoreLine(U.staffA1, U.leadA);
    }
  });

  it('H2 / WF-01-AC-2: the assignee acknowledging the task pauses repeat alerts until snoozeUntil', async () => {
    const start = now;
    const id = await newTask(U.leadA, U.staffA2, 'critical', 100);
    setNow(new Date(start.getTime() + 12 * H + MIN));
    await runEngine();
    assert.equal(await taskLevel(id), 3);
    assert.equal((await (await as(U.staffA2)).post(`/api/tasks/${id}/acknowledge`)).status, 200);
    const repeats = async () =>
      (await pool.query(`select count(*)::int as n from notifications where task_id = $1 and event = 'repeat' and user_id = $2 and channel = 'inapp'`, [id, U.cos])).rows[0].n;
    setNow(new Date(start.getTime() + 20 * H)); // two 4 h repeat periods after L3
    await runEngine();
    assert.equal(await repeats(), 0, 'no repeat while the task is acknowledged');
    setNow(new Date(start.getTime() + 24 * H + 2 * MIN));
    await runEngine();
    assert.equal(await repeats(), 1, 'repeats resume after ackSnoozeHours');
  });

  it('H3 / DASHBOARD-FRD §1.1: a task in review is never overdue; an active one past due is', async () => {
    const lead = await as(U.leadA);
    const staff = await as(U.staffA1);
    const mk = async (title: string) => (await lead.post('/api/tasks', { ...M, title, category: 'Operations', assigneeId: U.staffA1, priority: 'normal', ...due(localIn(2, 'Asia/Kolkata')), reviewRequired: true })).body.task.id as number;
    const inReview = await mk('H3 in review');
    const running = await mk('H3 running');
    await staff.post(`/api/tasks/${inReview}/start`);
    assert.equal((await staff.post(`/api/tasks/${inReview}/submit`, { note: 'Handed in for review' })).body.task.status, 'submitted');
    advance(3 * H);
    assert.equal((await lead.get(`/api/tasks/${inReview}`)).body.task.overdue, false, 'in review');
    assert.equal((await lead.get(`/api/tasks/${running}`)).body.task.overdue, true, 'active and past due');
  });

  it('H5: a recurring schedule saves with unit: null, the shape the API itself answers', async () => {
    const res = await (await as(U.leadA)).post('/api/recurring', {
      title: 'H5 weekly check', category: 'Operations', priority: 'normal', assigneeId: U.staffA1, frequency: 'daily', interval: 1,
      startDate: DateTime.fromJSDate(now, { zone: 'Asia/Kolkata' }).plus({ days: 1 }).toISODate(), dueHour: 17, ...M, target: null, unit: null,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { rows } = await pool.query('select unit from recurring_tasks where id = $1', [res.body.id]);
    assert.ok(!rows[0].unit, 'no unit stored');
  });
});

describe('ADR-0014 deadline milestones are stored on the task (D-140, D-146)', () => {
  const row = async (id: number) =>
    (await pool.query('select due_at, deadline_l2_at, deadline_l3_at, policy_version, status from tasks where id = $1', [id])).rows[0] as {
      due_at: Date; deadline_l2_at: Date | null; deadline_l3_at: Date | null; policy_version: string | null; status: string;
    };
  const gaps = (r: { due_at: Date; deadline_l2_at: Date | null; deadline_l3_at: Date | null }) => [
    (r.deadline_l2_at!.getTime() - r.due_at.getTime()) / MIN,
    (r.deadline_l3_at!.getTime() - r.due_at.getTime()) / MIN,
  ];
  const setDefault = async (config: unknown, note: string) => assert.equal((await (await as(U.cos)).put('/api/rules/default', { config, note })).status, 200);
  const body = (over: Record<string, unknown> = {}) => ({ ...M, title: 'Milestones', category: 'Operations', assigneeId: U.staffA1, priority: 'critical', ...due(localIn(3, 'Asia/Kolkata')), ...over });

  before(() => setDefault(DEFAULT_RULES, 'ADR-0014 tests: ship values'));
  after(() => setDefault(DEFAULT_RULES, 'ADR-0014 tests: restore'));

  it('stamps on create with the ship delays (L2 +24 h, L3 +72 h) and the policy version', async () => {
    const id = (await (await as(U.leadA)).post('/api/tasks', body())).body.task.id as number;
    const r = await row(id);
    assert.deepEqual(gaps(r), [1440, 4320]);
    const v = (await pool.query(`select version from sla_rules where organization_id = 1 and scope = 'default'`)).rows[0].version;
    assert.equal(r.policy_version, `default@${v}`);
    const log = await pool.query(`select after from admin_log where kind = 'rules_change' and target = 'default' order by id desc limit 1`);
    assert.equal(log.rows[0].after.version, v, 'the policy history records the version tasks point at');
  });

  it('restamps on a due change: both milestones move with the due time', async () => {
    const id = (await (await as(U.leadA)).post('/api/tasks', body())).body.task.id as number;
    const before = await row(id);
    assert.equal((await (await as(U.mgrA)).post(`/api/tasks/${id}/due`, { ...due(localIn(5, 'America/Los_Angeles')), reason: 'Client delay' })).status, 200);
    const r = await row(id);
    assert.ok(r.due_at.getTime() > before.due_at.getTime());
    assert.deepEqual(gaps(r), [1440, 4320]);
    assert.equal(r.deadline_l2_at!.getTime() - before.deadline_l2_at!.getTime(), r.due_at.getTime() - before.due_at.getTime());
  });

  it('restamps on priority edit: Normal → Critical takes the Critical delays', async () => {
    await setDefault({ ...DEFAULT_RULES, deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, critical: [30, 120] } }, 'Critical 30 min / 2 h');
    const lead = await as(U.leadA);
    const id = (await lead.post('/api/tasks', body({ priority: 'normal' }))).body.task.id as number;
    assert.deepEqual(gaps(await row(id)), [1440, 4320], 'Normal keeps +24 h / +72 h');
    assert.equal((await lead.put(`/api/tasks/${id}`, body({ priority: 'critical' }))).status, 200);
    assert.deepEqual(gaps(await row(id)), [30, 120]);
    await setDefault(DEFAULT_RULES, 'back to ship values');
  });

  it('a policy change does not move an open task’s milestones (D-146)', async () => {
    const id = (await (await as(U.leadA)).post('/api/tasks', body())).body.task.id as number;
    await setDefault({ ...DEFAULT_RULES, deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, critical: [30, 120] } }, 'Critical 30 min / 2 h');
    assert.deepEqual(gaps(await row(id)), [1440, 4320], 'the open task keeps its schedule');
    const fresh = (await (await as(U.leadA)).post('/api/tasks', body())).body.task.id as number;
    assert.deepEqual(gaps(await row(fresh)), [30, 120], 'a new task uses the new policy');
    await setDefault(DEFAULT_RULES, 'back to ship values');
  });

  it('a draft is stamped when it is assigned, not when it is saved', async () => {
    const lead = await as(U.leadA);
    const id = (await lead.post('/api/tasks', { ...body(), draft: true })).body.task.id as number;
    assert.equal((await row(id)).deadline_l2_at, null);
    assert.equal((await lead.post(`/api/tasks/${id}/publish`)).status, 200);
    assert.deepEqual(gaps(await row(id)), [1440, 4320]);
  });

  it('the engine escalates from the stored milestones: Critical reaches L2 at due + 30 min', async () => {
    await setDefault({ ...DEFAULT_RULES, deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, critical: [30, 120] } }, 'Critical 30 min / 2 h');
    const id = (await (await as(U.leadA)).post('/api/tasks', body({ ...due(localIn(1, 'Asia/Kolkata')) }))).body.task.id as number;
    await (await as(U.staffA1)).post(`/api/tasks/${id}/start`);
    const dueAt = (await row(id)).due_at.getTime();
    setNow(new Date(dueAt + 29 * MIN));
    await runEngine();
    assert.equal(await taskLevel(id), 1, 'past due: L1');
    setNow(new Date(dueAt + 30 * MIN));
    await runEngine();
    assert.equal(await taskLevel(id), 2, 'due + 30 min: L2');
    await setDefault(DEFAULT_RULES, 'back to ship values');
  });
});

describe('ADR-0014 scheduling fields: start time, requirements, reviewer, several assignees (D-144, D-153)', () => {
  const tz = 'Asia/Kolkata'; // Lead A's zone
  const body = (over: Record<string, unknown> = {}) => ({ ...M, title: 'Scheduled work', category: 'Operations', assigneeId: U.staffA1, priority: 'normal', ...due(localIn(30, tz)), ...over });
  const fields = async (over: Record<string, unknown>) => (await (await as(U.leadA)).post('/api/tasks', body(over))).body.fields;
  const count = async () => (await pool.query('select count(*)::int n from tasks')).rows[0].n as number;

  it('the scheduled start keeps its time of day, in the giver’s zone', async () => {
    const start = localIn(28, tz);
    const res = await (await as(U.leadA)).post('/api/tasks', body({ startDate: start.slice(0, 10), startTime: start.slice(11, 16) }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(new Date(res.body.task.startAt).getTime(), DateTime.fromISO(start, { zone: tz }).toMillis());
  });

  it('a start after the due time is refused', async () => {
    const start = localIn(31, tz);
    assert.deepEqual(await fields({ startDate: start.slice(0, 10), startTime: start.slice(11, 16) }), { startDate: 'The scheduled start must be before the due time.' });
  });

  it('submission requirements are stored, shown on the task and editable', async () => {
    const lead = await as(U.leadA);
    const id = (await lead.post('/api/tasks', body({ submissionRequirements: 'Attach the signed PDF.' }))).body.task.id as number;
    assert.equal((await lead.get(`/api/tasks/${id}`)).body.task.submissionRequirements, 'Attach the signed PDF.');
    assert.equal((await lead.put(`/api/tasks/${id}`, body({ submissionRequirements: 'Attach the signed PDF and the receipt.' }))).status, 200);
    assert.equal((await lead.get(`/api/tasks/${id}`)).body.task.submissionRequirements, 'Attach the signed PDF and the receipt.');
    assert.equal((await lead.post('/api/tasks', body({ submissionRequirements: 'See A123-456-789' }))).status, 422, 'sensitive-ID guard');
  });

  it('the reviewer defaults to the giver; a chosen reviewer must be able to review and cannot be the assignee', async () => {
    const lead = await as(U.leadA);
    const own = (await lead.post('/api/tasks', body({ reviewRequired: true }))).body.task;
    assert.equal(own.reviewerId, U.leadA);
    const chosen = (await lead.post('/api/tasks', body({ reviewRequired: true, reviewerId: U.mgrA }))).body.task;
    assert.equal(chosen.reviewerId, U.mgrA);
    assert.deepEqual(await fields({ reviewRequired: true, reviewerId: U.staffA2 }), { reviewerId: 'Choose someone who can review tasks.' });
    assert.deepEqual(await fields({ reviewRequired: true, reviewerId: U.staffA1 }), { reviewerId: 'The assignee cannot review their own work.' });
    assert.deepEqual(await fields({ reviewRequired: true, reviewerId: 99999 }), { reviewerId: 'Choose someone who can review tasks.' });
  });

  it('several assignees: one task per person, each with its own milestones', async () => {
    const res = await (await as(U.leadA)).post('/api/tasks', { ...body({ title: 'For both of you' }), assigneeId: undefined, assigneeIds: [U.staffA1, U.staffA2] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.tasks.map((t: any) => t.assigneeId).sort(), [U.staffA1, U.staffA2]);
    assert.equal(new Set(res.body.tasks.map((t: any) => t.id)).size, 2);
    for (const t of res.body.tasks) {
      assert.equal(t.title, 'For both of you');
      assert.equal(t.milestones.length, 3);
    }
  });

  it('several assignees is all or none, and the list is checked', async () => {
    const lead = await as(U.leadA);
    const n = await count();
    const bad = await lead.post('/api/tasks', { ...body(), assigneeId: undefined, assigneeIds: [U.staffA1, 99999] });
    assert.equal(bad.status, 422);
    assert.equal(await count(), n, 'nothing was created');
    assert.equal((await lead.post('/api/tasks', { ...body(), assigneeIds: [U.staffA2] })).status, 422, 'not both assigneeId and assigneeIds');
    assert.equal((await lead.post('/api/tasks', { ...body(), assigneeId: undefined, assigneeIds: [U.staffA1, U.staffA1] })).status, 422, 'no duplicates');
    assert.equal((await lead.post('/api/tasks', { ...body(), assigneeId: undefined, assigneeIds: [] })).status, 422, 'at least one');
  });
});

describe('ADR-0014 pre-deadline warning and start notice (US-05, D-143, D-144)', () => {
  const tz = 'Asia/Kolkata';
  const row = async (id: number) => (await pool.query('select due_at, start_at from tasks where id = $1', [id])).rows[0] as { due_at: Date; start_at: Date | null };
  const at = (d: Date, minutes: number) => setNow(new Date(d.getTime() + minutes * MIN));
  const body = (over: Record<string, unknown> = {}) => ({ ...M, title: 'Short task', category: 'Operations', assigneeId: U.staffA1, priority: 'critical', ...over });
  const create = async (over: Record<string, unknown>) => {
    const res = await (await as(U.leadA)).post('/api/tasks', body(over));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.task.id as number;
  };

  it('the 10-minute warning goes to the assignee once, at due − 10 min', async () => {
    const id = await create(due(localIn(1, tz)));
    const { due_at } = await row(id);
    at(due_at, -11);
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'deadline_warning'), 0, 'not before');
    at(due_at, -10);
    await runEngine();
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'deadline_warning'), 1, 'once, at T − 10');
    assert.equal(await inapp(id, U.leadA, 'deadline_warning'), 0, 'assignee only');
  });

  it('no warning when assigned inside the window: the assignment notice says how long is left', async () => {
    const id = await create(due(localIn(6 / 60, tz)));
    const { rows } = await pool.query(`select body from notifications where task_id = $1 and user_id = $2 and event = 'assigned' and channel = 'inapp'`, [id, U.staffA1]);
    assert.match(rows[0].body, /Due in \d+ min\./);
    const { due_at } = await row(id);
    at(due_at, -1);
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'deadline_warning'), 0);
  });

  it('no warning once the work is submitted', async () => {
    const id = await create({ ...due(localIn(2, tz)), reviewRequired: true });
    const staff = await as(U.staffA1);
    await staff.post(`/api/tasks/${id}/start`);
    assert.equal((await staff.post(`/api/tasks/${id}/submit`, { note: 'Handed in early' })).status, 200);
    at((await row(id)).due_at, -10);
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'deadline_warning'), 0);
  });

  it('the start notice goes out once, 10 minutes before the scheduled start', async () => {
    const start = localIn(2, tz);
    const id = await create({ ...due(localIn(5, tz)), startDate: start.slice(0, 10), startTime: start.slice(11, 16) });
    const { start_at } = await row(id);
    at(start_at!, -11);
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'start_notice'), 0, 'not before');
    at(start_at!, -10);
    await runEngine();
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'start_notice'), 1, 'once');
  });

  it('due-soon is skipped when the whole task is shorter than the due-soon window (D-143)', async () => {
    const id = await create({ ...due(localIn(2, tz)), priority: 'normal' });
    at((await row(id)).due_at, -60);
    await runEngine();
    assert.equal(await inapp(id, U.staffA1, 'due_soon'), 0);
  });
});

describe('ADR-0014 vertical policies: sparse overrides, GM editing, scoped reads (D-141, D-142, D-150)', () => {
  const setHead = (entity: string, id: number | null) => pool.query('update entities set head_id = $2 where id = $1', [entity, id]);
  const version = async (scope: string) => (await pool.query('select version from sla_rules where organization_id = 1 and scope = $1', [scope])).rows[0]?.version as number | undefined;
  const reset = async () => {
    const cos = await as(U.cos);
    await cos.put('/api/rules/default', { config: DEFAULT_RULES, note: 'vertical tests: reset' });
    for (const s of ['BAIS', 'EMB']) await cos.req('DELETE', `/api/rules/${s}`);
  };
  before(async () => {
    await reset();
    await setHead('BAIS', U.mgrA);
  });
  after(async () => {
    await setHead('BAIS', null);
    await reset();
  });

  it('a vertical row holds only what it changed; the rest is inherited, and a later global change shows through', async () => {
    const cos = await as(U.cos);
    assert.equal((await cos.put('/api/rules/BAIS', { config: { deadlineDelaysMinutes: { critical: [30, 120] } }, note: 'Critical faster' })).status, 200);
    let r = (await cos.get('/api/rules')).body;
    assert.deepEqual(r.overrides.BAIS.deadlineDelaysMinutes.critical, [30, 120]);
    assert.deepEqual(r.overrides.BAIS.deadlineDelaysMinutes.high, [1440, 4320], 'inherited');
    assert.deepEqual(r.overrides.BAIS.windowsHours, DEFAULT_RULES.windowsHours, 'inherited');
    assert.deepEqual(r.stored.BAIS, { deadlineDelaysMinutes: { critical: [30, 120] } }, 'stored sparse');
    assert.equal((await cos.put('/api/rules/default', { config: { ...DEFAULT_RULES, windowsHours: { ...DEFAULT_RULES.windowsHours, high: 20 } } })).status, 200);
    r = (await cos.get('/api/rules')).body;
    assert.equal(r.overrides.BAIS.windowsHours.high, 20, 'a global change shows through an un-overridden field');
    assert.deepEqual(r.overrides.BAIS.deadlineDelaysMinutes.critical, [30, 120], 'and never overwrites the customisation');
    await reset();
  });

  it('bounds: L2 ≥ 5 min, L3 after L2, review deadline 5 min–7 days, recipients from the vertical or the Founder’s Office', async () => {
    const cos = await as(U.cos);
    const fields = async (config: unknown) => (await cos.put('/api/rules/BAIS', { config })).body.fields;
    assert.ok((await fields({ deadlineDelaysMinutes: { critical: [30, 20] } })).d_critical);
    assert.ok((await fields({ deadlineDelaysMinutes: { high: [3, 20] } })).d_high);
    assert.ok((await fields({ reviewSlaMinutes: { low: 0 } })).sla_low);
    assert.ok((await fields({ extraRecipients: { l2: [U.staffB1] } })).rcpt_l2, 'someone from another vertical');
    assert.equal((await cos.put('/api/rules/BAIS', { config: { extraRecipients: { l2: [U.staffA2, U.cos] } } })).status, 200, 'own vertical or FO');
    assert.ok((await (await cos.put('/api/rules/default', { config: { ...DEFAULT_RULES, deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, low: [60, 60] } } })).body).fields.d_low);
    await reset();
  });

  it('the GM edits their own vertical: versioned and audited under their name', async () => {
    const gm = await as(U.mgrA);
    const before = (await version('BAIS')) ?? 0;
    assert.equal((await gm.put('/api/rules/BAIS', { config: { deadlineDelaysMinutes: { critical: [30, 120] } }, note: 'GM: faster critical' })).status, 200);
    const after = (await version('BAIS'))!;
    // A row recreated after a reset keeps counting (final-review fix below), so with no row the new version is only "higher".
    if (before) assert.equal(after, before + 1);
    else assert.ok(after >= 1);
    const { rows } = await pool.query(`select actor_id from admin_log where kind = 'rules_change' and target = 'BAIS' order by id desc limit 1`);
    assert.equal(rows[0].actor_id, U.mgrA);
  });

  it('a GM cannot edit another vertical (404) or the global policy (403), nor set organization-wide fields (422)', async () => {
    const gm = await as(U.mgrA);
    assert.equal((await gm.put('/api/rules/EMB', { config: { windowsHours: { critical: 2 } } })).status, 404);
    assert.equal((await gm.put('/api/rules/default', { config: DEFAULT_RULES })).status, 403);
    const v = await version('BAIS');
    assert.equal((await gm.put('/api/rules/BAIS', { config: { quietHours: DEFAULT_RULES.quietHours } })).status, 422);
    assert.equal(await version('BAIS'), v, 'nothing saved');
    assert.equal((await (await as(U.mgrB)).put('/api/rules/BAIS', { config: { windowsHours: { critical: 2 } } })).status, 404, 'not the GM of BAIS');
  });

  it('D-155: a GM cannot change level multiples or extra recipients (the CoS sets them), but may send the CoS’s values back unchanged', async () => {
    const gm = await as(U.mgrA);
    const cos = await as(U.cos);
    const v = await version('BAIS');
    const multiples = await gm.put('/api/rules/BAIS', { config: { multiples: [1, 2, 3, 4] } });
    assert.equal(multiples.status, 422);
    assert.deepEqual(multiples.body.fields, { multiples: 'Level multiples are set by the Chief of Staff.' });
    assert.equal((await gm.put('/api/rules/BAIS', { config: { extraRecipients: { l1: [U.staffA1], l2: [], l3: [] } } })).status, 422);
    assert.equal(await version('BAIS'), v, 'nothing saved');
    const { rows } = await pool.query(`select config from sla_rules where organization_id = 1 and scope = 'BAIS'`);
    const kept = rows[0]?.config ?? {};
    try {
      assert.equal((await cos.put('/api/rules/BAIS', { config: { ...kept, extraRecipients: { l1: [U.staffA1], l2: [], l3: [] } } })).status, 200, 'the CoS may');
      const res = await gm.put('/api/rules/BAIS', { config: { extraRecipients: { l1: [U.staffA1], l2: [], l3: [] }, deadlineDelaysMinutes: { critical: [45, 180] } } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      await pool.query(`update sla_rules set config = $1 where organization_id = 1 and scope = 'BAIS'`, [JSON.stringify(kept)]);
      invalidateRules();
    }
  });

  it('the CoS overrides the GM’s value; the history shows both, and the GM sees only their own vertical’s history', async () => {
    const cos = await as(U.cos);
    assert.equal((await cos.put('/api/rules/BAIS', { config: { deadlineDelaysMinutes: { critical: [60, 240] } }, note: 'CoS override' })).status, 200);
    const h = (await (await as(U.mgrA)).get('/api/rules/history?scope=BAIS')).body.items as Array<{ actor: string; target: string; version: number }>;
    assert.ok(h.some((x) => x.actor === 'Chief of Staff') && h.some((x) => x.actor === 'Manager A'));
    assert.ok(h.every((x) => x.target === 'BAIS'));
    assert.ok(h[0]!.version > h[h.length - 1]!.version, 'newest first, numbered');
    assert.equal((await (await as(U.mgrA)).get('/api/rules/history?scope=EMB')).status, 404);
  });

  it('a GM resets their vertical to the global policy', async () => {
    assert.equal((await (await as(U.mgrA)).req('DELETE', '/api/rules/BAIS')).status, 204);
    assert.equal((await (await as(U.mgrA)).req('DELETE', '/api/rules/EMB')).status, 404);
  });

  it('people outside policy administration read the global policy and their own vertical only', async () => {
    const cos = await as(U.cos);
    await cos.put('/api/rules/EMB', { config: { windowsHours: { critical: 2 } } });
    await cos.put('/api/rules/BAIS', { config: { windowsHours: { critical: 3 } } });
    const r = (await (await as(U.staffA1)).get('/api/rules')).body;
    assert.deepEqual(Object.keys(r.overrides), ['BAIS']);
    assert.ok(r.history.every((x: { target: string }) => ['default', 'BAIS'].includes(x.target)));
    assert.deepEqual(Object.keys((await cos.get('/api/rules')).body.overrides).sort(), ['BAIS', 'EMB'], 'the CoS sees all');
    assert.deepEqual((await (await as(U.mgrA)).get('/api/me')).body.headOf, ['BAIS'], 'bootstrap tells the client which vertical the GM heads');
    await reset();
  });
});

describe('ADR-0014 apply to open tasks and extra recipients (D-146, D-142)', () => {
  const gaps = async (id: number) => {
    const r = (await pool.query('select due_at, deadline_l2_at from tasks where id = $1', [id])).rows[0];
    return (r.deadline_l2_at.getTime() - r.due_at.getTime()) / MIN;
  };
  before(() => pool.query(`update entities set head_id = $1 where id = 'BAIS'`, [U.mgrA]));
  after(async () => {
    await pool.query(`update entities set head_id = null where id = 'BAIS'`);
    await (await as(U.cos)).req('DELETE', '/api/rules/BAIS');
  });

  it('apply restamps the vertical’s open tasks from the policy as it stands, and is audited', async () => {
    const id = await newTask(U.leadA, U.staffA1, 'critical', 5);
    const other = await newTask(U.leadB, U.staffB1, 'critical', 5);
    const gm = await as(U.mgrA);
    assert.equal((await gm.put('/api/rules/BAIS', { config: { deadlineDelaysMinutes: { critical: [30, 120] } } })).status, 200);
    assert.equal(await gaps(id), 1440, 'unchanged until applied');
    const res = await gm.post('/api/rules/BAIS/apply');
    assert.equal(res.status, 200);
    assert.ok(res.body.updated >= 1);
    assert.equal(await gaps(id), 30);
    assert.equal(await gaps(other), 1440, 'another vertical is untouched');
    const { rows } = await pool.query(`select actor_id, after from admin_log where kind = 'rules_applied' and target = 'BAIS' order by id desc limit 1`);
    assert.equal(rows[0].actor_id, U.mgrA);
    assert.equal(rows[0].after.updated, res.body.updated);
    assert.equal((await gm.post('/api/rules/EMB/apply')).status, 404, 'only their own vertical');
  });

  it('an extra L2 recipient is copied on L2', async () => {
    const cos = await as(U.cos);
    assert.equal((await cos.put('/api/rules/BAIS', { config: { deadlineDelaysMinutes: { critical: [30, 120] }, extraRecipients: { l2: [U.staffA2] } } })).status, 200);
    const id = await newTask(U.leadA, U.staffA1, 'critical', 1);
    const due = (await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime();
    setNow(new Date(due + 31 * MIN));
    await runEngine();
    const { rows } = await pool.query(
      `select r.user_id, r.kind from escalations e join escalation_recipients r on r.escalation_id = e.id where e.task_id = $1 and e.level = 2`,
      [id],
    );
    assert.ok(rows.some((r) => r.user_id === U.staffA2 && r.kind === 'cc'), JSON.stringify(rows));
  });
});

describe('ADR-0014 review accountability, reviewer deadline, Critical at night, late reassignment (D-145, D-147, D-148)', () => {
  const tz = 'Asia/Kolkata';
  const dueOf = async (id: number) => (await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime() as number;
  const make = async (priority: string, dueInHours: number, over: Record<string, unknown> = {}) => {
    const res = await (await as(U.leadA)).post('/api/tasks', { ...M, title: 'Reviewed work', category: 'Operations', assigneeId: U.staffA1, priority, ...due(localIn(dueInHours, tz)), reviewRequired: true, reviewerId: U.mgrA, ...over });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.task.id as number;
  };
  const submit = async (id: number, extra: Record<string, unknown> = {}) => {
    const staff = await as(U.staffA1);
    await staff.post(`/api/tasks/${id}/start`);
    const res = await staff.post(`/api/tasks/${id}/submit`, { note: 'Handed in for review', ...extra });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };
  const escalation = async (id: number, level: number) =>
    (await pool.query(
      `select e.accountable, array_agg(r.user_id order by r.user_id) filter (where r.kind = 'to') as "to"
         from escalations e join escalation_recipients r on r.escalation_id = e.id where e.task_id = $1 and e.level = $2 group by e.id order by e.id desc limit 1`,
      [id, level],
    )).rows[0] as { accountable: string; to: number[] } | undefined;

  it('submitted on time: escalations after the due time are the reviewer’s, and reach the reviewer', async () => {
    const id = await make('normal', 2);
    await submit(id);
    setNow(new Date((await dueOf(id)) + MIN));
    await runEngine();
    const l1 = await escalation(id, 1);
    assert.equal(l1?.accountable, 'reviewer');
    assert.ok(l1?.to.includes(U.mgrA), 'the reviewer is a To recipient');
  });

  it('submitted late: escalations stay the assignee’s', async () => {
    const id = await make('normal', 1);
    setNow(new Date((await dueOf(id)) + MIN));
    await runEngine();
    await submit(id, { shortfallReason: 'Waited on the client documents.' });
    setNow(new Date((await dueOf(id)) + 24 * H + MIN));
    await runEngine();
    assert.equal((await escalation(id, 1))?.accountable, 'assignee');
    assert.equal((await escalation(id, 2))?.accountable, 'assignee');
  });

  it('the accountability report does not count the reviewer’s escalations against the assignee', async () => {
    const id = await make('normal', 2);
    await submit(id);
    setNow(new Date((await dueOf(id)) + MIN));
    await runEngine();
    const { rows } = await pool.query(`select count(*)::int n from escalations where assignee_id = $1 and level >= 1 and accountable = 'assignee' and fired_at >= $2`, [U.staffA1, new Date(now.getTime() - 30 * 24 * H)]);
    const res = await (await as(U.cos)).get('/api/reports/accountability?days=30');
    assert.equal(res.body.byPerson.find((p: any) => p.userId === U.staffA1).escalations, rows[0].n);
  });

  it('reviewer deadline: R1 to the reviewer at the SLA, once; R2 to the reviewer’s manager at twice the SLA', async () => {
    const id = await make('critical', 5); // Critical: 30 minutes (D-152)
    await submit(id);
    const sub = now.getTime();
    setNow(new Date(sub + 29 * MIN));
    await runEngine();
    assert.equal(await inapp(id, U.mgrA, 'review_r1'), 0);
    setNow(new Date(sub + 30 * MIN));
    await runEngine();
    await runEngine();
    assert.equal(await inapp(id, U.mgrA, 'review_r1'), 1);
    setNow(new Date(sub + 60 * MIN));
    await runEngine();
    assert.equal(await inapp(id, U.cos, 'review_r2'), 1, 'Manager A reports to the Chief of Staff');
    assert.equal(await inapp(id, U.mgrA, 'review_r2'), 1, 'the reviewer is copied');
  });

  it('no reviewer reminder once the review is decided', async () => {
    const id = await make('critical', 5);
    await submit(id);
    const sub = now.getTime();
    assert.equal((await (await as(U.mgrA)).post(`/api/tasks/${id}/review`, { decision: 'approved', comment: '', qualityScore: 90, outcomeScore: 90 })).status, 200);
    setNow(new Date(sub + 31 * MIN));
    await runEngine();
    assert.equal(await inapp(id, U.mgrA, 'review_r1'), 0);
  });

  it('reassigning a task that is past due, or due within 10 minutes, needs a new due time', async () => {
    const lead = await as(U.leadA);
    const res = await lead.post('/api/tasks', { ...M, title: 'Late handover', category: 'Operations', assigneeId: U.staffA1, priority: 'high', ...due(localIn(1, tz)) });
    const id = res.body.task.id as number;
    setNow(new Date((await dueOf(id)) + MIN));
    await runEngine();
    const bad = await lead.post(`/api/tasks/${id}/reassign`, { toId: U.staffA2, reason: 'Ana is out today' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.fields, { dueDate: 'This task is past due or due within 10 minutes: set a new due time for the new assignee.' });
    const later = localIn(6, tz);
    const ok = await lead.post(`/api/tasks/${id}/reassign`, { toId: U.staffA2, reason: 'Ana is out today', dueDate: later.slice(0, 10), dueTime: later.slice(11, 16) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const r = (await pool.query('select assignee_id, due_at, deadline_l2_at from tasks where id = $1', [id])).rows[0];
    assert.equal(r.assignee_id, U.staffA2);
    assert.ok(r.due_at.getTime() > now.getTime(), 'a new due time');
    assert.equal(r.deadline_l2_at.getTime() - r.due_at.getTime(), 24 * H, 'milestones from the new due time');
  });
});

describe('ADR-0014 schedule (US-01, US-04)', () => {
  const day = () => DateTime.fromJSDate(now, { zone: 'Asia/Kolkata' }).toISODate();

  it('a person sees their own day; a lead sees a person in their line; nobody sees outside their scope', async () => {
    const start = localIn(1, 'Asia/Kolkata');
    await (await as(U.leadA)).post('/api/tasks', { ...M, title: 'Morning slot', category: 'Operations', assigneeId: U.staffA1, priority: 'normal', ...due(localIn(2, 'Asia/Kolkata')), startDate: start.slice(0, 10), startTime: start.slice(11, 16) });
    const own = await (await as(U.staffA1)).get(`/api/schedule?date=${day()}`);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.people.length, 1);
    assert.equal(own.body.people[0].userId, U.staffA1);
    assert.ok(own.body.people[0].tasks.some((t: any) => t.title === 'Morning slot'));
    assert.equal(own.body.people[0].timeZone, 'Asia/Kolkata');
    assert.equal((await (await as(U.leadA)).get(`/api/schedule?date=${day()}&userId=${U.staffA1}`)).status, 200);
    assert.equal((await (await as(U.leadA)).get(`/api/schedule?date=${day()}&userId=${U.staffB1}`)).status, 404);
    assert.equal((await (await as(U.staffA1)).get(`/api/schedule?date=${day()}&userId=${U.staffA2}`)).status, 404);
    assert.equal((await (await as(U.staffA1)).get('/api/schedule?date=nope')).status, 422);
  });

  it('a lead’s team view lists everyone in their line, with overlaps flagged', async () => {
    const lead = await as(U.leadA);
    for (const title of ['Overlap one', 'Overlap two']) {
      const start = localIn(3, 'Asia/Kolkata');
      await lead.post('/api/tasks', { ...M, title, category: 'Operations', assigneeId: U.staffA2, priority: 'normal', ...due(localIn(5, 'Asia/Kolkata')), startDate: start.slice(0, 10), startTime: start.slice(11, 16) });
    }
    const res = await lead.get(`/api/schedule?date=${DateTime.fromJSDate(now, { zone: 'America/Los_Angeles' }).toISODate()}&team=1`);
    assert.equal(res.status, 200);
    const ids = res.body.people.map((p: any) => p.userId);
    assert.ok(ids.includes(U.staffA1) && ids.includes(U.staffA2), 'everyone below the lead');
    assert.ok(!ids.includes(U.staffB1) && !ids.includes(U.leadA), 'nobody else');
    const a2 = res.body.people.find((p: any) => p.userId === U.staffA2);
    assert.ok(a2.tasks.filter((t: any) => t.title.startsWith('Overlap')).every((t: any) => t.overlap));
  });
});

describe('ADR-0014 final-review fixes', () => {
  const tz = 'Asia/Kolkata';
  const body = (over: Record<string, unknown> = {}) => ({ ...M, title: 'Review fix', category: 'Operations', assigneeId: U.staffA1, priority: 'high', ...due(localIn(1, tz)), ...over });
  const dueOf = async (id: number) => (await pool.query('select due_at from tasks where id = $1', [id])).rows[0].due_at.getTime() as number;

  it('D-148 also holds when the assignee is changed through Edit', async () => {
    const lead = await as(U.leadA);
    const id = (await lead.post('/api/tasks', body())).body.task.id as number;
    setNow(new Date((await dueOf(id)) + MIN));
    const res = await lead.put(`/api/tasks/${id}`, { ...body({ assigneeId: U.staffA2 }), ...due(DateTime.fromMillis(await dueOf(id), { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm")) });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual(res.body.fields, { dueDate: 'This task is past due or due within 10 minutes: set a new due time for the new assignee.' });
    assert.equal((await pool.query('select assignee_id from tasks where id = $1', [id])).rows[0].assignee_id, U.staffA1, 'nothing changed');
  });

  it('a reassignment due within 10 minutes tells the new assignee how long is left', async () => {
    const lead = await as(U.leadA);
    const id = (await lead.post('/api/tasks', body({ ...due(localIn(3, tz)) }))).body.task.id as number;
    const soon = localIn(5 / 60, tz);
    assert.equal((await lead.post(`/api/tasks/${id}/reassign`, { toId: U.staffA2, reason: 'Ana is out today', dueDate: soon.slice(0, 10), dueTime: soon.slice(11, 16) })).status, 200);
    const { rows } = await pool.query(`select body from notifications where task_id = $1 and user_id = $2 and event = 'reassigned' and channel = 'inapp'`, [id, U.staffA2]);
    assert.match(rows[0].body, /Due in \d+ min\./);
  });

  it('history versions are the stored versions: an apply is not numbered, and a reset does not restart the count', async () => {
    const cos = await as(U.cos);
    await cos.req('DELETE', '/api/rules/EMB');
    assert.equal((await cos.put('/api/rules/EMB', { config: { windowsHours: { critical: 3 } } })).status, 200);
    assert.equal((await cos.post('/api/rules/EMB/apply')).status, 200);
    assert.equal((await cos.put('/api/rules/EMB', { config: { windowsHours: { critical: 2 } } })).status, 200);
    const stored = async () => (await pool.query(`select version from sla_rules where organization_id = 1 and scope = 'EMB'`)).rows[0]?.version as number;
    let items = (await cos.get('/api/rules/history?scope=EMB')).body.items as Array<{ version: number | null; after: unknown }>;
    assert.equal(items[0]!.version, await stored(), 'the newest save shows the stored version');
    assert.equal(items[1]!.version, null, 'an apply has no version of its own');
    const before = await stored();
    assert.equal((await cos.req('DELETE', '/api/rules/EMB')).status, 204);
    assert.equal((await cos.put('/api/rules/EMB', { config: { windowsHours: { critical: 3 } } })).status, 200);
    assert.ok((await stored()) > before, 'versions keep counting after a reset');
    items = (await cos.get('/api/rules/history?scope=EMB')).body.items;
    assert.equal(items[0]!.version, await stored());
    await cos.req('DELETE', '/api/rules/EMB');
  });

  it('a policy saved by another instance is used for new tasks (no stale cache in the milestones)', async () => {
    const { rows } = await pool.query(`select config from sla_rules where organization_id = 1 and scope = 'default'`);
    const config = { ...rows[0].config, deadlineDelaysMinutes: { ...DEFAULT_RULES.deadlineDelaysMinutes, high: [240, 1440] } };
    await pool.query(`update sla_rules set config = $1, version = version + 1 where organization_id = 1 and scope = 'default'`, [JSON.stringify(config)]); // as if saved elsewhere
    try {
      const id = (await (await as(U.leadA)).post('/api/tasks', body({ ...due(localIn(5, tz)) }))).body.task.id as number;
      const r = (await pool.query('select due_at, deadline_l2_at from tasks where id = $1', [id])).rows[0];
      assert.equal((r.deadline_l2_at.getTime() - r.due_at.getTime()) / MIN, 240);
    } finally {
      await pool.query(`update sla_rules set config = $1 where organization_id = 1 and scope = 'default'`, [JSON.stringify(rows[0].config)]);
      invalidateRules();
    }
  });
});

describe('ADR-0015 working time and away (D-158, D-160, D-164)', () => {
  const IST = 'Asia/Kolkata';
  const t = (iso: string) => DateTime.fromISO(iso, { zone: IST }).toJSDate();
  const dayShift = makeWorkClock({ zone: IST, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
  const always = async () => {
    await pool.query(`update entities set work_days = '{0,1,2,3,4,5,6}', work_start = '00:00', work_end = '24:00', time_zone = null, quiet_start = null, quiet_end = null, quiet_enabled = null where id = 'BAIS'`);
    invalidateDirectory();
  };
  const weekdays = async () => {
    await pool.query(`update entities set work_days = '{1,2,3,4,5}', work_start = '09:00', work_end = '18:00', time_zone = $1 where id = 'BAIS'`, [IST]);
    invalidateDirectory();
  };
  const fastNormal = async () => assert.equal((await (await as(U.cos)).put('/api/rules/BAIS', { config: { windowsHours: { ...DEFAULT_RULES.windowsHours, normal: 4 } } })).status, 200);
  const leave = async (userId: number, day: string, markedAt: Date) => {
    await pool.query(`insert into attendance (organization_id, user_id, day, status, marked_by, marked_at) values (1, $1, $2, 'leave', $3, $4)`, [userId, day, U.mgrA, markedAt]);
  };
  afterEach(async () => {
    await always();
    await pool.query(`delete from attendance where organization_id = 1`); // test DB only
    await (await as(U.cos)).req('DELETE', '/api/rules/BAIS');
  });

  it('a Normal task does not climb over the weekend; Critical does, as today', async () => {
    await weekdays();
    setNow(t('2026-11-20T17:00'));
    const normal = await newTask(U.leadA, U.staffA1, 'normal', 24 * 30);
    const critical = await newTask(U.leadA, U.staffA1, 'critical', 24 * 30);
    setNow(t('2026-11-23T08:59'));
    await runEngine();
    assert.equal(await taskLevel(normal), -1);
    assert.ok((await taskLevel(critical)) >= 1);
  });

  it('leave today pauses Normal silence, not Critical', async () => {
    await weekdays();
    await fastNormal();
    setNow(t('2026-11-23T09:00'));
    const normal = await newTask(U.leadA, U.staffA1, 'normal', 24 * 30);
    const critical = await newTask(U.leadA, U.staffA1, 'critical', 24 * 30);
    await leave(U.staffA1, '2026-11-23', t('2026-11-23T09:00'));
    setNow(t('2026-11-23T18:00'));
    await runEngine();
    assert.equal(await taskLevel(normal), -1, 'away all day: no working silence');
    assert.ok((await taskLevel(critical)) >= 1);
  });

  it('a mark only counts from marked_at: levels never drop and nothing is cleared', async () => {
    await weekdays();
    await fastNormal();
    setNow(t('2026-11-23T09:00'));
    const id = await newTask(U.leadA, U.staffA1, 'normal', 24 * 30);
    setNow(t('2026-11-23T15:00'));
    await runEngine();
    assert.equal(await taskLevel(id), 1, '6 working hours silent ≥ 4 × 1.5');
    await leave(U.staffA1, '2026-11-23', t('2026-11-23T15:00'));
    await runEngine();
    assert.equal(await taskLevel(id), 1);
    const { rows } = await pool.query('select count(*)::int n from escalations where task_id = $1 and cleared_at is not null', [id]);
    assert.equal(rows[0].n, 0);
  });

  it('the vertical’s time zone and quiet hours become each member’s', async () => {
    await pool.query(`update entities set time_zone = 'America/Los_Angeles', quiet_enabled = true, quiet_start = '21:00', quiet_end = '08:00' where id = 'BAIS'`);
    invalidateDirectory();
    const u = (await getDirectory(1)).must(U.staffA1);
    assert.deepEqual([u.timeZone, u.quietStart, u.quietEnd, u.work.zone], ['America/Los_Angeles', '21:00', '08:00', 'America/Los_Angeles']);
  });

  it('L2 and L3 are stamped in working minutes for a Normal task', async () => {
    await weekdays();
    setNow(t('2026-11-20T10:00'));
    const id = await newTask(U.leadA, U.staffA1, 'normal', 7); // Fri 17:00 IST
    const r = (await pool.query('select due_at, deadline_l2_at, deadline_l3_at from tasks where id = $1', [id])).rows[0];
    assert.equal(r.deadline_l2_at.getTime(), dayShift.add(r.due_at.getTime(), 1440 * MIN));
    assert.equal(r.deadline_l3_at.getTime(), dayShift.add(r.due_at.getTime(), 4320 * MIN));
  });
});

describe('ADR-0015 vertical working time (D-159, D-165)', () => {
  const wt = { timeZone: 'America/Los_Angeles', quietHours: { enabled: true, start: '21:00', end: '08:00' }, workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '18:00' };
  before(async () => {
    await pool.query(`update entities set head_id = $1 where id = 'BAIS'`, [U.mgrA]);
    invalidateDirectory();
  });
  after(async () => {
    await pool.query(`update entities set head_id = null, work_days = '{0,1,2,3,4,5,6}', work_start = '00:00', work_end = '24:00', time_zone = null, quiet_enabled = null, quiet_start = null, quiet_end = null where id = 'BAIS'`);
    invalidateDirectory();
  });

  it('the GM sets their vertical’s working time; members follow; audited', async () => {
    assert.equal((await (await as(U.mgrA)).put('/api/entities/BAIS/worktime', wt)).status, 204);
    const org = (await (await as(U.mgrA)).get('/api/org')).body;
    assert.deepEqual(org.entities.find((e: any) => e.id === 'BAIS').worktime, wt);
    assert.equal((await getDirectory(1)).must(U.staffA1).timeZone, 'America/Los_Angeles');
    const { rows } = await pool.query(`select actor_id from admin_log where kind = 'vertical.worktime_changed' and target = 'vertical:BAIS' order by id desc limit 1`);
    assert.equal(rows[0]?.actor_id, U.mgrA);
  });

  it('validates the values; another vertical is not found; staff cannot', async () => {
    const gm = await as(U.mgrA);
    const bad = await gm.put('/api/entities/BAIS/worktime', { ...wt, timeZone: 'Mars/Olympus' });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.fields.timeZone);
    assert.equal((await gm.put('/api/entities/BAIS/worktime', { ...wt, workDays: [] })).status, 422);
    assert.equal((await gm.put('/api/entities/BAIS/worktime', { ...wt, workStart: '25:00' })).status, 422);
    assert.equal((await gm.put('/api/entities/EMB/worktime', wt)).status, 404);
    assert.equal((await (await as(U.staffA1)).put('/api/entities/BAIS/worktime', wt)).status, 404);
    assert.equal((await (await as(U.cos)).put('/api/entities/EMB/worktime', { ...wt, timeZone: null })).status, 204, 'the CoS may, any vertical; null = default');
  });

  it('D-165: open tasks keep their deadline times until "Apply to open tasks"', async () => {
    const gm = await as(U.mgrA);
    assert.equal((await gm.put('/api/entities/BAIS/worktime', { ...wt, timeZone: 'Asia/Kolkata' })).status, 204);
    const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
    const before = (await pool.query('select deadline_l2_at from tasks where id = $1', [id])).rows[0].deadline_l2_at.getTime();
    assert.equal((await gm.put('/api/entities/BAIS/worktime', { ...wt, timeZone: 'Asia/Kolkata', workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '24:00' })).status, 204);
    assert.equal((await pool.query('select deadline_l2_at from tasks where id = $1', [id])).rows[0].deadline_l2_at.getTime(), before, 'unchanged');
    assert.equal((await gm.post('/api/rules/BAIS/apply')).status, 200);
    const after = (await pool.query('select due_at, deadline_l2_at from tasks where id = $1', [id])).rows[0];
    assert.equal(after.deadline_l2_at.getTime(), after.due_at.getTime() + 1440 * MIN, 'restamped on the all-day clock');
  });
});

describe('ADR-0015 a GM runs their own vertical (D-162)', () => {
  const body = (over: Record<string, unknown> = {}) => ({ name: 'Gm Hire', email: `gm.hire.${Date.now()}@example.com`, title: 'Analyst', roles: ['staff'], entityId: 'BAIS', teamId: null, location: '', phone: null, whatsapp: null, whatsappOptIn: false, timezone: '', ...over });
  before(async () => {
    await pool.query(`update entities set head_id = $1 where id = 'BAIS'`, [U.mgrA]);
    invalidateDirectory();
  });
  after(async () => {
    await pool.query(`update entities set head_id = null where id = 'BAIS'`);
    invalidateDirectory();
  });

  it('adds, edits, deactivates and resets a person in their vertical, and sees their contact details', async () => {
    const gm = await as(U.mgrA);
    const made = await gm.post('/api/people', body());
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.id as number;
    assert.equal((await gm.put(`/api/people/${id}`, body({ email: made.body.email, title: 'Senior analyst', roles: ['lead'] }))).status, 200);
    assert.equal((await gm.post(`/api/people/${id}/reset-access`)).status, 200);
    assert.equal((await gm.post(`/api/people/${id}/status`, { status: 'inactive' })).status, 200);
    const list = (await gm.get('/api/people')).body.items;
    assert.equal(list.find((u: any) => u.id === U.staffA1).email, `user${U.staffA1}@example.com`);
  });

  it('another vertical is not found; CoS-only powers are refused', async () => {
    const gm = await as(U.mgrA);
    assert.equal((await gm.post('/api/people', body({ entityId: 'EMB' }))).status, 404);
    assert.equal((await gm.put(`/api/people/${U.staffB1}`, body({ email: `user${U.staffB1}@example.com`, entityId: 'EMB' }))).status, 404);
    assert.equal((await gm.post(`/api/people/${U.staffB1}/status`, { status: 'inactive' })).status, 404);
    const cos = await gm.post('/api/people', body({ roles: ['cos'] }));
    assert.equal(cos.status, 403);
    assert.equal(cos.body.error, 'Only the Chief of Staff can do that.');
    assert.equal((await gm.put('/api/entities/BAIS', { name: 'BAIS', headId: U.mgrB })).status, 403, 'who is GM stays with the CoS');
    assert.equal((await (await as(U.leadA)).post('/api/people', body())).status, 403, 'not a GM: unchanged');
  });

  it('cannot make another vertical’s person a department lead (reviewer C-1)', async () => {
    const gm = await as(U.mgrA);
    const bLead = (await pool.query(`insert into users (name, email, entity_id, roles, time_zone, created_at, organization_id, title) values ('Free Lead EMB', $1, 'EMB', '{lead}', 'Asia/Kolkata', now(), 1, 'Lead') returning id`, [`free.lead.${Date.now()}@example.com`])).rows[0].id as number;
    invalidateDirectory();
    const made = await gm.post('/api/teams', { entityId: 'BAIS', name: `Poach ${Date.now()}`, leadId: bLead });
    assert.equal(made.status, 404, JSON.stringify(made.body));
    assert.equal((await pool.query('select entity_id from users where id = $1', [bLead])).rows[0].entity_id, 'EMB', 'not moved');
    const own = await gm.post('/api/teams', { entityId: 'BAIS', name: `Own ${Date.now()}`, leadId: null });
    assert.equal((await gm.put(`/api/teams/${own.body.id}`, { name: `Own2 ${Date.now()}`, leadId: bLead })).status, 404);
    assert.equal((await pool.query('select entity_id from users where id = $1', [bLead])).rows[0].entity_id, 'EMB', 'still not moved');
  });

  it('a GM cannot deactivate or reset their own account (owner: only the CoS)', async () => {
    const gm = await as(U.mgrA);
    const off = await gm.post(`/api/people/${U.mgrA}/status`, { status: 'inactive' });
    assert.equal(off.status, 403);
    assert.equal(off.body.error, 'Ask the Chief of Staff to change your own account.');
    assert.equal((await gm.post(`/api/people/${U.mgrA}/reset-access`)).status, 403);
  });

  it('manages departments of their vertical only', async () => {
    const gm = await as(U.mgrA);
    const made = await gm.post('/api/teams', { entityId: 'BAIS', name: `GM dept ${Date.now()}`, leadId: null });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await gm.put(`/api/teams/${made.body.id}`, { name: `GM dept renamed ${Date.now()}`, leadId: null })).status, 204);
    assert.equal((await gm.post('/api/teams', { entityId: 'EMB', name: 'Not mine', leadId: null })).status, 404);
  });
});

describe('ADR-0015 attendance (D-156…D-158, D-161, D-163)', () => {
  const IST = 'Asia/Kolkata';
  const MON = '2026-11-23';
  const mark = async (by: number, body: Record<string, unknown>) => (await as(by)).put('/api/attendance', { from: MON, to: MON, ...body });
  before(async () => {
    await pool.query(`update entities set head_id = $1 where id = 'BAIS'`, [U.mgrA]);
    await pool.query(
      `insert into users (id, name, email, entity_id, roles, manager_id, time_zone, created_at, organization_id, title) values (990, 'FO Analyst', 'fo990@example.com', 'FO', '{staff}', $1, $2, now(), 1, 'Analyst') on conflict do nothing`,
      [U.cos, IST],
    );
    invalidateDirectory();
  });
  after(async () => {
    await pool.query(`update entities set head_id = null where id = 'BAIS'`);
    invalidateDirectory();
  });
  afterEach(async () => {
    await pool.query(`delete from attendance where organization_id = 1`); // test DB only
  });

  it('the GM marks present, absent, half day and leave for their members; audited', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    for (const status of ['present', 'absent', 'leave']) assert.equal((await mark(U.mgrA, { userIds: [U.staffA1], status })).status, 200, status);
    await pool.query(`update entities set work_start = '09:00', work_end = '18:00' where id = 'BAIS'`);
    invalidateDirectory();
    const half = await mark(U.mgrA, { userIds: [U.staffA1], status: 'half_day', half: 'second' });
    await pool.query(`update entities set work_start = '00:00', work_end = '24:00' where id = 'BAIS'`);
    invalidateDirectory();
    assert.deepEqual(half.body, { updated: 1 });
    const list = (await (await as(U.mgrA)).get(`/api/attendance?from=${MON}&to=${MON}`)).body;
    assert.deepEqual(list.days.find((d: any) => d.userId === U.staffA1 && d.day === MON), { userId: U.staffA1, day: MON, status: 'half_day', awayFrom: '13:30', awayTo: '18:00' }, 'afternoon = lunch (mid-day) to the end of work');
    const { rows } = await pool.query(`select actor_id from admin_log where kind = 'attendance.marked' order by id desc limit 1`);
    assert.equal(rows[0].actor_id, U.mgrA);
  });

  it('today and past only; a half day needs a valid range', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    const future = await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave', from: '2026-11-24', to: '2026-11-24' });
    assert.equal(future.status, 422);
    assert.equal(future.body.fields.day, 'Attendance can be marked for today and past days only.');
    assert.deepEqual((await mark(U.mgrA, { userIds: [U.staffA1], status: 'half_day' })).body.fields, { half: 'Choose whether they were away in the morning or the afternoon.' });
    const morning = await mark(U.mgrA, { userIds: [U.staffA1], status: 'half_day', half: 'first' });
    assert.equal(morning.status, 200);
    const d = (await (await as(U.mgrA)).get(`/api/attendance?from=${MON}&to=${MON}&userId=${U.staffA1}`)).body.days[0];
    assert.deepEqual([d.awayFrom, d.awayTo], ['00:00', '12:00'], 'morning = start of work to lunch (all-day fixture)');
    const impossible = await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave', from: '2026-02-31', to: '2026-02-31' });
    assert.equal(impossible.status, 422);
    assert.equal(impossible.body.fields.from, 'Choose a real date.');
    assert.equal((await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave', from: '2026-11-16', to: '2026-11-20' })).body.updated, 5, 'a past range, one row per working day');
  });

  it('only the GM of the person’s vertical; nobody marks a GM, the CoS or the CEO; the CoS marks the Founder’s Office', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    assert.equal((await mark(U.mgrA, { userIds: [U.staffB1], status: 'present' })).status, 404);
    for (const id of [U.mgrA, U.cos, U.ceo]) assert.equal((await mark(U.mgrA, { userIds: [id], status: 'present' })).status, 422, `no attendance for ${id}`);
    assert.equal((await mark(U.cos, { userIds: [990], status: 'leave' })).status, 200, 'CoS = GM of the Founder’s Office');
    assert.equal((await mark(U.cos, { userIds: [U.staffA1], status: 'present' })).status, 404, 'not the GM of BAIS');
    assert.equal((await mark(U.leadA, { userIds: [U.staffA1], status: 'present' })).status, 404, 'a lead does not mark');
  });

  it('unmarked days change nothing and show as unmarked', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    const list = (await (await as(U.mgrA)).get(`/api/attendance?from=${MON}&to=${MON}`)).body;
    assert.equal(list.days.find((d: any) => d.userId === U.staffA2 && d.day === MON).status, 'unmarked');
    const { rows } = await pool.query(`select count(*)::int n from notifications where event = 'away_tasks' and user_id = $1`, [U.staffA2]);
    assert.equal(rows[0].n, 0, 'never marked: never told');
  });

  it('away today tells the assignee, their GM and the task giver once', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    const id = await newTask(U.leadA, U.staffA1, 'normal', 5);
    for (let i = 0; i < 2; i++) assert.equal((await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave' })).status, 200);
    for (const who of [U.staffA1, U.mgrA, U.leadA]) assert.equal(await inapp(id, who, 'away_tasks'), 1, `user ${who}`);
  });

  it('the task page honours leave exactly like the engine (fixed-offset zone, all-day hours)', async () => {
    setNow(new Date('2026-11-12T21:37:50Z'));
    const gm = await as(U.mgrA);
    try {
      assert.equal((await gm.put('/api/entities/BAIS/worktime', { timeZone: 'Etc/GMT+11', quietHours: null, workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '24:00' })).status, 204);
      assert.equal((await gm.put('/api/rules/BAIS', { config: { windowsHours: { critical: 1, high: 24, normal: 1, low: 72 } } })).status, 200);
      const id = await newTask(U.leadA, U.staffA1, 'normal', 22);
      assert.equal((await gm.put('/api/attendance', { userIds: [U.staffA1], from: '2026-11-12', to: '2026-11-12', status: 'leave' })).status, 200);
      setNow(new Date('2026-11-12T23:38:00Z'));
      await runEngine();
      assert.equal(await taskLevel(id), -1, 'engine');
      const view = (await (await as(U.leadA)).get(`/api/tasks/${id}`)).body.task;
      assert.equal(view.levelInfo.level, -1, 'task page');
      assert.ok(view.assigneeAwayUntil, 'the page can say the assignee is on leave');
    } finally {
      await gm.put('/api/entities/BAIS/worktime', { timeZone: null, quietHours: null, workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '24:00' });
      await (await as(U.cos)).req('DELETE', '/api/rules/BAIS');
    }
  });

  it('re-saving a leave keeps the away time already counted (reviewer I-1)', async () => {
    await pool.query(`update entities set work_days = '{0,1,2,3,4,5,6}', work_start = '00:00', work_end = '24:00', time_zone = $1 where id = 'BAIS'`, [IST]);
    invalidateDirectory();
    const gm = await as(U.mgrA);
    try {
      assert.equal((await gm.put('/api/rules/BAIS', { config: { windowsHours: { critical: 1, high: 24, normal: 1, low: 72 } } })).status, 200);
      setNow(DateTime.fromISO(`${MON}T08:00`, { zone: IST }).toJSDate());
      const id = await newTask(U.leadA, U.staffA1, 'normal', 30);
      await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave' });
      setNow(DateTime.fromISO(`${MON}T15:00`, { zone: IST }).toJSDate());
      await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave' }); // the GM saves it again
      await runEngine();
      assert.equal(await taskLevel(id), -1, 'still away since 08:00');
    } finally {
      await pool.query(`update entities set time_zone = null where id = 'BAIS'`);
      invalidateDirectory();
      await (await as(U.cos)).req('DELETE', '/api/rules/BAIS');
    }
  });

  it('"mark the unmarked present" never overwrites an existing mark, even from a stale page (review I-2, server side)', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave' });
    const res = await mark(U.mgrA, { userIds: [U.staffA1, U.leadA], status: 'present', onlyUnmarked: true }); // both in IST: today
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const days = (await (await as(U.mgrA)).get(`/api/attendance?from=${MON}&to=${MON}`)).body.days;
    assert.equal(days.find((d: any) => d.userId === U.staffA1).status, 'leave', 'kept');
    assert.equal(days.find((d: any) => d.userId === U.leadA).status, 'present');
    assert.deepEqual(res.body, { updated: 1 }, 'only the unmarked day was written');
  });

  it('a GM with no staff yet gets an empty list, not an error', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    await pool.query(`insert into entities (id, name, organization_id, head_id) values ('ZZ', 'Empty vertical', 1, $1) on conflict (id) do update set head_id = $1`, [U.mgrB]);
    await pool.query(`update entities set head_id = null where id = 'EMB'`);
    invalidateDirectory();
    try {
      const res = await (await as(U.mgrB)).get(`/api/attendance?from=${MON}&to=${MON}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.people, res.body.days], [[], []]);
    } finally {
      await pool.query(`update entities set head_id = null, archived_at = now() where id = 'ZZ'`);
      invalidateDirectory();
    }
  });

  it('everyone with attendance sees only their own month', async () => {
    setNow(DateTime.fromISO(`${MON}T10:00`, { zone: IST }).toJSDate());
    await mark(U.mgrA, { userIds: [U.staffA1], status: 'leave' });
    const mine = (await (await as(U.staffA1)).get('/api/attendance/me?month=2026-11')).body;
    assert.equal(mine.days.find((d: any) => d.day === MON).status, 'leave');
    assert.equal((await (await as(U.staffA1)).get(`/api/attendance?from=${MON}&to=${MON}`)).status, 404, 'staff do not see others');
    assert.equal((await (await as(U.mgrA)).get('/api/attendance/me?month=2026-11')).status, 404, 'a GM has no attendance');
  });
});
