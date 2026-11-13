import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError, invalid } from '../http/errors.js';
import { me, requireUser } from '../http/middleware.js';
import { headOf } from '../services/structure.js';
import { runEngine } from '../engine/engine.js';
import { can } from '../services/access.js';
import { checkRules, getRuleSet, pickVertical, resetRules, rulesSchema, saveRules, verticalOverrideSchema, type VerticalOverride } from '../services/rules.js';
import { guardText, stampMilestones } from '../services/tasks.js';
import { resolvePolicy } from '@taskwatch/shared/policy';
import { tx } from '../db/pool.js';
import { appendAdmin } from '../services/audit.js';
import * as clock from '../clock.js';
import { LADDER_STATUSES } from '../domain.js';

export const rulesRouter = Router();
rulesRouter.use(requireUser);

const UNKNOWN = () => new HttpError(422, 'Unknown entity');

/** The verticals this person heads as general manager (ADR-0011 `head_id`; archived ones excluded). */

/**
 * D-141 / D-150: who may change a policy scope. A holder of manage_escalation_policies (the CoS) may change every
 * scope; a vertical's general manager may change that vertical only. Anything else is refused as if it did not
 * exist (404) for a vertical, and 403 for the organization's default.
 */
async function canEditScope(req: Request, scope: string): Promise<'all' | 'vertical'> {
  const { user, dir } = me(req);
  if (can(user, dir, 'manage_escalation_policies')) {
    if (scope !== 'default') {
      const { rows } = await pool.query('select 1 from entities where id = $1 and organization_id = $2', [scope, user.organizationId]);
      if (!rows[0]) throw UNKNOWN();
    }
    return 'all';
  }
  if (scope === 'default') throw new HttpError(403, "You don't have permission to change escalation policies.");
  if ((await headOf(user.id, user.organizationId)).includes(scope)) return 'vertical';
  throw new HttpError(404, 'Vertical not found.'); // the same answer whether it exists or not
}

/** The scopes a person may read beyond the default: all for policy administrators, else their own and headed verticals. */
async function readableScopes(req: Request): Promise<Set<string> | 'all'> {
  const { user, dir } = me(req);
  if (can(user, dir, 'manage_escalation_policies')) return 'all';
  return new Set([user.entityId, ...(await headOf(user.id, user.organizationId))]);
}

/** The newest 50 policy changes the reader may see: the default's, and those of the readable scopes. */
async function history(organizationId: number, scopes: Set<string> | 'all', scope?: string) {
  const { rows } = await pool.query(
    `select l.id, l.at, l.target, l.before, l.after, l.note, u.name as actor,
            case when l.kind = 'rules_change' then (l.after->>'version')::int end as version -- the stored version; an apply has none
       from admin_log l left join users u on u.id = l.actor_id
      where l.kind in ('rules_change', 'rules_applied') and l.organization_id = $1 and ($2::text is null or l.target = $2)
        and ($3::text[] is null or l.target = 'default' or l.target = any($3))
      order by l.at desc, l.id desc
      limit 50`,
    [organizationId, scope ?? null, scopes === 'all' ? null : [...scopes]],
  );
  return rows;
}

// Everyone reads the default and the rules that govern their own work; policy administrators read every vertical.
rulesRouter.get('/rules', async (req, res) => {
  const { user } = me(req);
  const rules = await getRuleSet(user.organizationId);
  const scopes = await readableScopes(req);
  const visible = (scope: string) => scopes === 'all' || scopes.has(scope);
  const { rows: stored } = await pool.query<{ scope: string; config: object; version: number }>('select scope, config, version from sla_rules where organization_id = $1', [user.organizationId]);
  res.json({
    defaults: rules.defaults,
    // Effective policy per vertical with its own row (inherited fields filled in), as before ADR-0014.
    overrides: Object.fromEntries([...rules.overrides].filter(([s]) => visible(s))),
    // ADR-0014: what each vertical actually stores, so the page can show Inherited / Custom per field.
    stored: Object.fromEntries(stored.filter((r) => r.scope !== 'default' && visible(r.scope)).map((r) => [r.scope, pickVertical(r.config)])),
    versions: Object.fromEntries(stored.filter((r) => r.scope === 'default' || visible(r.scope)).map((r) => [r.scope, r.version])),
    headOf: await headOf(user.id, user.organizationId),
    history: await history(user.organizationId, scopes),
  });
});

rulesRouter.get('/rules/history', async (req, res) => {
  const { user } = me(req);
  const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : undefined;
  const scopes = await readableScopes(req);
  if (scope && scope !== 'default' && scopes !== 'all' && !scopes.has(scope)) throw new HttpError(404, 'Unknown entity');
  res.json({ items: await history(user.organizationId, scopes, scope) });
});

const note = z.string().trim().max(500).optional();

/** POL-01 / POL-03 / D-141: save the default or one vertical's override, then re-evaluate the tasks it governs (C-7). */
rulesRouter.put('/rules/:scope', async (req, res) => {
  const { user } = me(req);
  const scope = String(req.params.scope);
  const mode = await canEditScope(req, scope);
  const rules = await getRuleSet(user.organizationId);
  let effective;
  if (scope === 'default') {
    const body = z.object({ config: rulesSchema, note }).strict().parse(req.body);
    effective = resolvePolicy(rules.defaults, body.config);
    checkRules(effective);
    guardText(body.note);
    // The merged policy, not the request: a client that omits the optional ADR-0014 fields must not erase them.
    await saveRules(user.organizationId, scope, effective, user.id, body.note);
  } else {
    const body = z.object({ config: verticalOverrideSchema, note }).strict().parse(req.body);
    if (mode === 'vertical') await gmKeepsCosFields(user.organizationId, scope, body.config);
    effective = resolvePolicy(rules.defaults, body.config);
    checkRules(effective);
    await checkRecipients(user.organizationId, scope, body.config.extraRecipients);
    guardText(body.note);
    await saveRules(user.organizationId, scope, body.config, user.id, body.note);
  }
  await runEngine({ organizationId: user.organizationId, ...(scope === 'default' ? {} : { entityId: scope }) });
  res.json({ ok: true });
});

/**
 * D-155 (2026-11-13): a GM sets deadline delays, review deadlines and update windows for their vertical; level
 * multiples and extra recipients stay with the CoS. A GM's save may carry them back unchanged (the page sends every
 * custom field), but not change them.
 */
async function gmKeepsCosFields(organizationId: number, scope: string, config: { multiples?: unknown; extraRecipients?: unknown }) {
  const stored = await storedVertical(organizationId, scope);
  const f: Record<string, string> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (config.multiples !== undefined && !same(config.multiples, stored.multiples)) f.multiples = 'Level multiples are set by the Chief of Staff.';
  if (config.extraRecipients !== undefined && !same(config.extraRecipients, stored.extraRecipients)) f.rcpt_l1 = 'Extra recipients are set by the Chief of Staff.';
  if (Object.keys(f).length) throw invalid(f);
}

/** What a vertical stores now (only VERTICAL_FIELDS); empty when it has no row. */
async function storedVertical(organizationId: number, scope: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ config: Record<string, unknown> }>('select config from sla_rules where organization_id = $1 and scope = $2', [organizationId, scope]);
  return pickVertical(rows[0]?.config ?? {}) as Record<string, unknown>;
}

/** D-142: extra recipients must be active people of that vertical or of the Founder's Office. */
async function checkRecipients(organizationId: number, scope: string, extra: { l1?: number[]; l2?: number[]; l3?: number[] } | undefined) {
  if (!extra) return;
  const f: Record<string, string> = {};
  for (const k of ['l1', 'l2', 'l3'] as const) {
    const ids = extra[k] ?? [];
    if (!ids.length) continue;
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int n from users where id = any($1) and organization_id = $2 and active and entity_id in ($3, 'FO')`,
      [ids, organizationId, scope],
    );
    if (rows[0]!.n !== new Set(ids).size) f[`rcpt_${k}`] = "Choose active people from this vertical or the Founder's Office.";
  }
  if (Object.keys(f).length) throw invalid(f);
}

rulesRouter.delete('/rules/:scope', async (req, res) => {
  const { user } = me(req);
  const scope = String(req.params.scope);
  const mode = await canEditScope(req, scope);
  // D-155: a GM's reset clears what a GM may set; the CoS's level multiples and extra recipients stay.
  const stored = mode === 'vertical' ? await storedVertical(user.organizationId, scope) : {};
  const kept = Object.fromEntries((['multiples', 'extraRecipients'] as const).filter((k) => stored[k] !== undefined).map((k) => [k, stored[k]]));
  if (Object.keys(kept).length) await saveRules(user.organizationId, scope, kept as VerticalOverride, user.id, 'Reset by the general manager; the Chief of Staff’s settings kept');
  else await resetRules(user.organizationId, scope, user.id);
  await runEngine({ organizationId: user.organizationId, entityId: scope });
  res.status(204).end();
});

/**
 * D-146: a policy change does not move the milestones of open tasks. This applies it to them on purpose: every open
 * task in the scope is restamped from the policy as it stands now, and the engine re-evaluates them. Audited.
 */
rulesRouter.post('/rules/:scope/apply', async (req, res) => {
  const { user } = me(req);
  const scope = String(req.params.scope);
  await canEditScope(req, scope);
  const updated = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `select id from tasks where organization_id = $1 and status = any($2) and ($3::text = 'default' or entity_id = $3) for update`,
      [user.organizationId, [...LADDER_STATUSES], scope],
    );
    for (const r of rows) await stampMilestones(c, r.id);
    const versions = (await getRuleSet(user.organizationId, c)).versions;
    await appendAdmin(c, { actorId: user.id, kind: 'rules_applied', target: scope, before: null, after: { scope, version: versions.get(scope) ?? null, updated: rows.length }, note: null, targetType: 'policy' }, clock.now());
    return rows.length;
  });
  await runEngine({ organizationId: user.organizationId, ...(scope === 'default' ? {} : { entityId: scope }) });
  res.json({ updated });
});
