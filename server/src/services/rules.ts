import { z } from 'zod';
import * as clock from '../clock.js';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { VERTICAL_FIELDS, legacyDelays, resolvePolicy, type DeepPartial } from '@taskwatch/shared/policy';
import { DEFAULT_RULES, PRIORITIES, type RulesConfig } from '../domain.js';
import { HttpError, invalid } from '../http/errors.js';
import { appendAdmin } from './audit.js';

const num = z.number();
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const windows = z.object({ critical: num, high: num, normal: num, low: num }).strict();
const multiples = z.tuple([num, num, num, num]);
const delays = z.tuple([num, num]);
const ids = z.array(z.number().int().positive());

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
    // ADR-0014. Optional so a client from before it can still save; absent fields keep their stored or default value.
    deadlineDelaysMinutes: z.object({ critical: delays, high: delays, normal: delays, low: delays }).strict().optional(),
    reviewSlaMinutes: windows.optional(),
    extraRecipients: z.object({ l1: ids, l2: ids, l3: ids }).strict().optional(),
  })
  .strict();

const perPriority = <T extends z.ZodType>(v: T) => z.object({ critical: v.optional(), high: v.optional(), normal: v.optional(), low: v.optional() }).strict();

/**
 * D-142 (ADR-0014, replaces D-48): a vertical stores only the fields it changed, from VERTICAL_FIELDS; every other
 * value is inherited from the organization's policy, field by field, so a later global change still shows through.
 */
export const verticalOverrideSchema = z
  .object({
    windowsHours: perPriority(num).optional(),
    multiples: multiples.optional(),
    deadlineDelaysMinutes: perPriority(delays).optional(),
    reviewSlaMinutes: perPriority(num).optional(),
    extraRecipients: z.object({ l1: ids.optional(), l2: ids.optional(), l3: ids.optional() }).strict().optional(),
  })
  .strict();
export type VerticalOverride = z.infer<typeof verticalOverrideSchema>;

const between = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;

/** POL-01 validation: every broken rule, keyed as the Policies page shows it. */
export function checkRules(c: RulesConfig): void {
  const f: Record<string, string> = {};
  const whole = (v: number) => Number.isInteger(v);
  for (const p of PRIORITIES) {
    const d = c.deadlineDelaysMinutes[p];
    if (!(whole(d[0]) && whole(d[1]) && d[0] >= 5 && d[1] > d[0] && d[1] <= 43_200)) {
      f[`d_${p}`] = 'L2 at least 5 minutes after the due time, L3 later than L2, at most 30 days; whole minutes.';
    }
    const sla = c.reviewSlaMinutes[p];
    if (!(whole(sla) && sla >= 5 && sla <= 10_080)) f[`sla_${p}`] = 'Between 5 minutes and 7 days, in whole minutes.';
  }
  for (const k of ['l1', 'l2', 'l3'] as const) if (c.extraRecipients[k].length > 10) f[`rcpt_${k}`] = 'At most 10 people per level.';
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
    /** Version of each stored policy row, by scope ('default' or an entity id). */
    readonly versions: Map<string, number> = new Map(),
  ) {}

  /** Which policy rows govern this entity, e.g. 'default@3,BAIS@2' (stored on a task with its milestones, ADR-0014). */
  versionTag(entityId: string): string {
    const own = this.versions.get(entityId);
    return `default@${this.versions.get('default') ?? 1}` + (own ? `,${entityId}@${own}` : '');
  }

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

/**
 * One organization's escalation rules (ADR-0010). Each call costs one tiny version query, so a loop over many tasks
 * should call it once per organization and reuse the result (the engine does).
 */
export async function getRuleSet(organizationId: number, db: Db = pool): Promise<RuleSet> {
  // Another instance may have saved a policy: reuse the cache only while every stored version still matches (one tiny query).
  const hit = cached.get(organizationId);
  if (hit) {
    const { rows: v } = await db.query<{ scope: string; version: number }>('select scope, version from sla_rules where organization_id = $1', [organizationId]);
    if (v.length === hit.versions.size && v.every((r) => hit.versions.get(r.scope) === r.version)) return hit;
  }
  const { rows } = await db.query<{ scope: string; config: RulesConfig; version: number }>('select scope, config, version from sla_rules where organization_id = $1', [organizationId]);
  const defRow = rows.find((r) => r.scope === 'default');
  // A default row from before ADR-0014 has past-due offsets but no delays: its offsets keep applying.
  const stored: Partial<RulesConfig> = defRow?.config ?? {};
  const legacy = !stored.deadlineDelaysMinutes && stored.overdueOffsetsHours ? { deadlineDelaysMinutes: legacyDelays(stored.overdueOffsetsHours) } : {};
  const defaults = withDefaults({ ...legacy, ...stored }, DEFAULT_RULES);
  const overrides = new Map<string, RulesConfig>();
  // D-142: a vertical's stored fields (VERTICAL_FIELDS only) over the default, leaf by leaf.
  for (const r of rows) if (r.scope !== 'default') overrides.set(r.scope, resolvePolicy(defaults, pickVertical(r.config)));
  const set = new RuleSet(defaults, overrides, new Map(rows.map((r) => [r.scope, r.version])));
  cached.set(organizationId, set);
  return set;
}

/** Only the fields a vertical may set (rows from before ADR-0014 also hold windows and multiples, which qualify). */
export function pickVertical(config: object): DeepPartial<RulesConfig> {
  return Object.fromEntries(Object.entries(config).filter(([k]) => (VERTICAL_FIELDS as readonly string[]).includes(k))) as DeepPartial<RulesConfig>;
}

export function invalidateRules(): void {
  cached.clear();
}

/** Save the default rules or one entity's override. Every change is logged with before/after values. */
export async function saveRules(organizationId: number, scope: string, config: RulesConfig | VerticalOverride, actorId: number, note?: string): Promise<void> {
  const now = clock.now();
  await tx(async (c) => {
    const { rows } = await c.query('select config from sla_rules where organization_id = $1 and scope = $2 for update', [organizationId, scope]);
    const { rows: saved } = await c.query<{ version: number }>(
      // A row recreated after a reset keeps counting from the last logged version, so a policy_version never repeats.
      `insert into sla_rules (organization_id, scope, config, updated_at, updated_by, version) values ($1, $2, $3, $4, $5,
         coalesce((select max((after->>'version')::int) from admin_log where organization_id = $1 and kind = 'rules_change' and target = $2), 0) + 1)
       on conflict (organization_id, scope) do update set config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         version = sla_rules.version + 1
       returning version`,
      [organizationId, scope, JSON.stringify(config), now, actorId],
    );
    // ADR-0014: the version a task's policy_version points at, so its history can be found in the log.
    const after = { ...config, version: saved[0]!.version };
    await appendAdmin(c, { actorId, kind: 'rules_change', target: scope, before: rows[0]?.config ?? null, after, note: note ?? null, targetType: 'policy' }, now);
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
