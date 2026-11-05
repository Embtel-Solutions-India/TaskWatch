import { z } from 'zod';
import * as clock from '../clock.js';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { DEFAULT_RULES, PRIORITIES, type RulesConfig } from '../domain.js';
import { HttpError, invalid } from '../http/errors.js';
import { appendAdmin } from './audit.js';

const num = z.number();
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const windows = z.object({ critical: num, high: num, normal: num, low: num }).strict();
const multiples = z.tuple([num, num, num, num]);

/** The shape of a policy; the value rules are in `checkRules`, so each answers under the FRD's field key (POL-01). */
export const rulesSchema = z
  .object({
    windowsHours: windows,
    multiples,
    overdueOffsetsHours: z.tuple([num, num, num]),
    quietHours: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }).strict(),
    l3NotifyCeo: z.boolean(),
    ackSnoozeHours: num,
    repeatAfterWindows: num,
    blockedAlertsLead: z.boolean(),
    dueSoonHours: num,
  })
  .strict();

/** D-48: an entity may differ from the default in its update windows and multiples only (WO). */
export const entityRulesSchema = z.object({ windowsHours: windows, multiples }).strict();
export type EntityRules = z.infer<typeof entityRulesSchema>;

const between = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

/** POL-01 validation: every broken rule, keyed as the Policies page shows it. */
export function checkRules(c: Partial<RulesConfig> & EntityRules): void {
  const f: Record<string, string> = {};
  for (const p of PRIORITIES) if (!between(c.windowsHours[p], 1, 720)) f[`w_${p}`] = 'Between 1 and 720 hours.';
  const m = c.multiples;
  if (!(m[0] > 0 && m[0] < m[1] && m[1] < m[2] && m[2] < m[3])) f.multiples = 'Multiples must increase from L0 to L3.';
  const o = c.overdueOffsetsHours;
  if (o && !(o[0] >= 0 && o[0] < o[1] && o[1] < o[2])) f.offsets = 'Past-due offsets must increase from L1 to L3.';
  if (c.ackSnoozeHours !== undefined && !between(c.ackSnoozeHours, 1, 72)) f.ackSnoozeHours = 'Between 1 and 72 hours.';
  if (c.dueSoonHours !== undefined && !between(c.dueSoonHours, 1, 168)) f.dueSoonHours = 'Between 1 and 168 hours.';
  if (c.repeatAfterWindows !== undefined && !between(c.repeatAfterWindows, 0, 10)) f.repeatAfterWindows = 'Between 0 and 10 windows.';
  if (Object.keys(f).length) throw invalid(f);
}

export class RuleSet {
  constructor(
    readonly defaults: RulesConfig,
    readonly overrides: Map<string, RulesConfig>,
  ) {}

  for(entityId: string): RulesConfig {
    return this.overrides.get(entityId) ?? this.defaults;
  }
}

function withDefaults(cfg: Partial<RulesConfig>, base: RulesConfig): RulesConfig {
  return {
    ...base,
    ...cfg,
    windowsHours: { ...base.windowsHours, ...cfg.windowsHours },
    quietHours: { ...base.quietHours, ...cfg.quietHours },
  };
}

const cached = new Map<number, RuleSet>();

/** One organization's escalation rules (ADR-0010). */
export async function getRuleSet(organizationId: number, db: Db = pool): Promise<RuleSet> {
  const hit = cached.get(organizationId);
  if (hit) return hit;
  const { rows } = await db.query<{ scope: string; config: RulesConfig }>('select scope, config from sla_rules where organization_id = $1', [organizationId]);
  const defRow = rows.find((r) => r.scope === 'default');
  const defaults = withDefaults(defRow?.config ?? {}, DEFAULT_RULES);
  const overrides = new Map<string, RulesConfig>();
  // D-48: only the windows and multiples of an override apply; everything else follows the default.
  for (const r of rows) if (r.scope !== 'default') overrides.set(r.scope, withDefaults({ windowsHours: r.config.windowsHours, multiples: r.config.multiples }, defaults));
  const set = new RuleSet(defaults, overrides);
  cached.set(organizationId, set);
  return set;
}

export function invalidateRules(): void {
  cached.clear();
}

/** Save the default rules or one entity's override. Every change is logged with before/after values. */
export async function saveRules(organizationId: number, scope: string, config: RulesConfig | EntityRules, actorId: number, note?: string): Promise<void> {
  const now = clock.now();
  await tx(async (c) => {
    const { rows } = await c.query('select config from sla_rules where organization_id = $1 and scope = $2 for update', [organizationId, scope]);
    await c.query(
      `insert into sla_rules (organization_id, scope, config, updated_at, updated_by) values ($1, $2, $3, $4, $5)
       on conflict (organization_id, scope) do update set config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [organizationId, scope, JSON.stringify(config), now, actorId],
    );
    await appendAdmin(c, { actorId, kind: 'rules_change', target: scope, before: rows[0]?.config ?? null, after: config, note: note ?? null, targetType: 'policy' }, now);
  });
  invalidateRules();
}

/** Remove an entity override so it follows the default rules again. */
export async function resetRules(organizationId: number, scope: string, actorId: number): Promise<void> {
  if (scope === 'default') throw new HttpError(409, 'The default rules cannot be removed.');
  const now = clock.now();
  await tx(async (c) => {
    const { rows } = await c.query('delete from sla_rules where organization_id = $1 and scope = $2 returning config', [organizationId, scope]);
    if (!rows[0]) return;
    await appendAdmin(
      c,
      { actorId, kind: 'rules_change', target: scope, before: rows[0].config, after: null, note: 'Override removed; entity follows default rules', targetType: 'policy' },
      now,
    );
  });
  invalidateRules();
}
