// Production bootstrap (owner 2026-11-11): an empty database gets the organization, its settings and its verticals, as
// on the owner's local database, plus the first Chief of Staff. No demo people or tasks. The CoS then sets up the
// rest (departments, general managers, staff) in the app.
//
//   BOOTSTRAP_COS_EMAIL=… BOOTSTRAP_COS_PASSWORD=… npm run db:bootstrap
//
// The email and password come from the environment only, never from the repository (AGENTS: no secrets in code).
import { DEFAULT_SETTINGS, type Settings } from '@taskwatch/shared/settings';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import * as clock from '../clock.js';
import { appendAdmin } from '../services/audit.js';
import { hashPassword, passwordRule } from '../services/auth.js';
import { migrate } from './migrate.js';
import { pool, tx } from './pool.js';

/** The organization as configured on the owner's local database (2026-11-11). Not secret: names and preferences. */
export const ORGANIZATION = {
  name: 'Embtel Web Solutions',
  settings: {
    timezone: 'America/New_York',
    workdayStart: '09:00',
    workdayEnd: '18:00',
    sessionTimeoutMinutes: 60,
    categories: ['Operations', 'Finance', 'Compliance', 'Client delivery', 'Reporting', 'Hiring', 'IT & Systems', 'Facilities'],
    overloadThreshold: 6,
    digestDay: 1,
    digestHour: 10,
    priorityWeights: { critical: 1, high: 3, normal: 2, low: 1 },
  } satisfies Partial<Settings>,
  /** Verticals in display order; FO is where the Chief of Staff sits. */
  verticals: [
    ['FO', "Founder's Office"],
    ['BAIS', 'Bay Area Immigration Services'],
    ['USAIS', 'USAIS'],
    ['IE', 'International Evaluations'],
    ['EMBTEL', 'Embtel Solutions Inc'],
    ['BAAS', 'Bay Area Accounting Solutions'],
  ] as const,
};

const input = z.object({
  email: z.string({ error: 'Set BOOTSTRAP_COS_EMAIL.' }).trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { error: 'BOOTSTRAP_COS_EMAIL is not an email address.' }),
  password: passwordRule,
  name: z.string().trim().min(1).default('Chief of Staff'),
});

/** Only what differs from the shared defaults is stored, as Settings saves do (SET-01). */
const storedSettings = () =>
  Object.fromEntries(Object.entries(ORGANIZATION.settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(DEFAULT_SETTINGS[k as keyof Settings])));

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<{ cosId: number; email: string }> {
  const cos = input.parse({ email: env.BOOTSTRAP_COS_EMAIL, password: env.BOOTSTRAP_COS_PASSWORD, name: env.BOOTSTRAP_COS_NAME || undefined });
  await migrate();
  const hash = await hashPassword(cos.password);
  return tx(async (c) => {
    const { rows: people } = await c.query<{ n: number }>('select count(*)::int as n from users');
    if (people[0]!.n > 0) throw new Error('This database already has people. The bootstrap only runs on an empty one.');
    const now = clock.now();
    // Organization 1 is created by migration 007; it takes the real name and settings.
    await c.query('update organizations set name = $2, settings = $3 where id = $1', [1, ORGANIZATION.name, JSON.stringify(storedSettings())]);
    for (const [i, [id, name]] of ORGANIZATION.verticals.entries()) {
      await c.query('insert into entities (id, name, sort, organization_id) values ($1, $2, $3, 1)', [id, name, i]);
    }
    const { rows } = await c.query<{ id: number }>(
      `insert into users (name, email, title, roles, entity_id, time_zone, created_at, organization_id)
       values ($1, $2, 'Chief of Staff', $3, 'FO', $4, $5, 1) returning id`,
      [cos.name, cos.email, ['cos'], ORGANIZATION.settings.timezone, now],
    );
    const cosId = rows[0]!.id;
    // Kept out of users so directory reads never load secrets (migration 004).
    await c.query('insert into user_credentials (user_id, password_hash, password_changed_at) values ($1, $2, $3)', [cosId, hash, now]);
    await appendAdmin(c, {
      actorId: cosId,
      kind: 'organization.bootstrapped',
      target: 'organization:1',
      targetType: 'settings',
      after: { name: ORGANIZATION.name, verticals: ORGANIZATION.verticals.map(([id]) => id), chiefOfStaff: cosId },
    });
    return { cosId, email: cos.email };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap()
    .then(({ email }) => {
      console.log(`Bootstrapped "${ORGANIZATION.name}": ${ORGANIZATION.verticals.length} verticals. The Chief of Staff signs in as ${email}.`);
      return pool.end();
    })
    .catch((err: unknown) => {
      const e = err as { issues?: { message: string }[]; message?: string };
      console.error(e.issues ? e.issues.map((i) => i.message).join(' ') : (e.message ?? err));
      process.exit(1);
    });
}
