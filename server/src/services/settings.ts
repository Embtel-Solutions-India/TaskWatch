// Organization settings (SET-01, ADR-0010). Only changed values are stored (organizations.settings); the rest come
// from the shared defaults, so the server never keeps its own copy of them. The name is the organization's own name
// (one source, KI-23); retention is fixed at 7 years (WO); the simulation flags follow the credentials (D-41).
import { DEFAULT_SETTINGS, type Settings } from '@taskwatch/shared/settings';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { config } from '../config.js';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { invalid } from '../http/errors.js';
import { appendAdmin } from './audit.js';
import type { DirUser } from './directory.js';

/** Settings the organization chooses; the rest are fixed or derived. */
const STORED = ['timezone', 'workdayStart', 'workdayEnd', 'sessionTimeoutMinutes', 'categories', 'overloadThreshold', 'digestDay', 'digestHour'] as const;

export async function getSettings(organizationId: number, db: Db = pool): Promise<Settings> {
  const { rows } = await db.query<{ name: string; value: Partial<Settings> }>('select name, settings as value from organizations where id = $1', [organizationId]);
  return {
    ...DEFAULT_SETTINGS,
    ...rows[0]?.value,
    orgName: rows[0]?.name ?? DEFAULT_SETTINGS.orgName,
    retentionYears: DEFAULT_SETTINGS.retentionYears,
    emailSimulation: !config.smtp.enabled,
    whatsappSimulation: !config.whatsapp.enabled,
  };
}

/** What every signed-in person may read (SET-01-AC-4). */
export const publicSettings = (s: Settings) => ({
  orgName: s.orgName,
  timezone: s.timezone,
  categories: s.categories,
  overloadThreshold: s.overloadThreshold,
  workdayStart: s.workdayStart,
  workdayEnd: s.workdayEnd,
});

const HHMM = { pattern: /^([01]\d|2[0-3]):[0-5]\d$/, error: 'Use HH:MM (24-hour)' };
const between = (min: number, max: number, error: string) => z.number({ error }).int({ error }).min(min, { error }).max(max, { error });

/** The Settings page body. `retentionYears` and the simulation flags may be sent but are ignored (fixed / derived). */
export const settingsSchema = z
  .object({
    orgName: z
      .string({ error: 'Organization name is required.' })
      .trim()
      .min(1, { error: 'Organization name is required.' })
      .min(2, { error: 'Use at least 2 characters.' })
      .max(120, { error: 'Use at most 120 characters.' }),
    timezone: z.string({ error: 'Unknown time zone' }).refine((tz) => DateTime.now().setZone(tz).isValid, { error: 'Unknown time zone' }),
    workdayStart: z.string({ error: HHMM.error }).regex(HHMM.pattern, { error: HHMM.error }),
    workdayEnd: z.string({ error: HHMM.error }).regex(HHMM.pattern, { error: HHMM.error }),
    sessionTimeoutMinutes: between(5, 480, 'Between 5 and 480 minutes.'),
    overloadThreshold: between(1, 50, 'Between 1 and 50.'),
    digestDay: between(0, 6, 'Between 0 and 6.'),
    digestHour: between(0, 23, 'Between 0 and 23.'),
    categories: z
      .array(z.string({ error: 'Keep at least one category.' }).trim().max(40, { error: 'Use at most 40 characters per category.' }), {
        error: 'Keep at least one category.',
      })
      .transform((cs) => [...new Set(cs.filter(Boolean))])
      .refine((cs) => cs.length > 0, { error: 'Keep at least one category.' }),
    retentionYears: z.unknown().optional(),
    emailSimulation: z.unknown().optional(),
    whatsappSimulation: z.unknown().optional(),
  })
  .strict()
  // Only compare two well-formed times; a malformed one already has its own message.
  .refine((s) => !HHMM.pattern.test(s.workdayStart) || !HHMM.pattern.test(s.workdayEnd) || s.workdayStart < s.workdayEnd, {
    error: 'The workday must end after it starts.',
    path: ['workdayEnd'],
  });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** SET-01 save: one transaction, audited with the changed keys only. */
export async function saveSettings(actor: DirUser, input: z.infer<typeof settingsSchema>): Promise<Settings> {
  const org = actor.organizationId;
  await tx(async (c) => {
    await c.query('select 1 from organizations where id = $1 for update', [org]);
    const before = await getSettings(org, c);
    const stored = Object.fromEntries(STORED.filter((k) => !same(input[k], DEFAULT_SETTINGS[k])).map((k) => [k, input[k]]));
    await c
      .query('update organizations set name = $2, settings = $3 where id = $1', [org, input.orgName, JSON.stringify(stored)])
      .catch((err: { code?: string; constraint?: string }) => {
        if (err.code === '23505' && err.constraint === 'organizations_name_uq') throw invalid({ orgName: 'Another organization already uses this name.' });
        throw err;
      });
    const changed = (['orgName', ...STORED] as const).filter((k) => !same(before[k], input[k]));
    if (changed.length) {
      await appendAdmin(c, {
        actorId: actor.id,
        kind: 'settings.updated',
        target: 'settings',
        targetType: 'settings',
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, input[k]])),
      });
    }
  });
  return getSettings(org);
}
