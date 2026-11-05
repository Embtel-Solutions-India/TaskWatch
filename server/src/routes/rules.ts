import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { me, requirePermission, requireUser } from '../http/middleware.js';
import { runEngine } from '../engine/engine.js';
import { checkRules, entityRulesSchema, getRuleSet, resetRules, rulesSchema, saveRules } from '../services/rules.js';
import { guardText } from '../services/tasks.js';

export const rulesRouter = Router();
rulesRouter.use(requireUser);

// Everyone can read the rules that govern their work; only a holder of manage_escalation_policies can change them.
rulesRouter.get('/rules', async (req, res) => {
  const { user } = me(req);
  const rules = await getRuleSet(user.organizationId);
  const { rows } = await pool.query(
    `select l.id, l.at, l.target, l.before, l.after, l.note, u.name as actor
       from admin_log l left join users u on u.id = l.actor_id
      where l.kind = 'rules_change' and l.organization_id = $1 order by l.at desc limit 50`,
    [user.organizationId],
  );
  res.json({ defaults: rules.defaults, overrides: Object.fromEntries(rules.overrides), history: rows });
});

async function validScope(organizationId: number, scope: string): Promise<void> {
  if (scope === 'default') return;
  const { rows } = await pool.query('select 1 from entities where id = $1 and organization_id = $2', [scope, organizationId]);
  if (!rows[0]) throw new HttpError(422, 'Unknown entity');
}

const canChange = requirePermission('manage_escalation_policies', 'change escalation policies');
const note = z.string().trim().max(500).optional();

/** POL-01 / POL-03: save the default or one entity's override, then re-evaluate the tasks it governs on this request (C-7). */
rulesRouter.put('/rules/:scope', canChange, async (req, res) => {
  const { user } = me(req);
  const scope = String(req.params.scope);
  await validScope(user.organizationId, scope);
  const body = z.object({ config: scope === 'default' ? rulesSchema : entityRulesSchema, note }).strict().parse(req.body);
  checkRules(body.config);
  guardText(body.note);
  await saveRules(user.organizationId, scope, body.config, user.id, body.note);
  await runEngine({ organizationId: user.organizationId, ...(scope === 'default' ? {} : { entityId: scope }) });
  res.json({ ok: true });
});

rulesRouter.delete('/rules/:scope', canChange, async (req, res) => {
  const { user } = me(req);
  const scope = String(req.params.scope);
  await validScope(user.organizationId, scope);
  await resetRules(user.organizationId, scope, user.id);
  await runEngine({ organizationId: user.organizationId, entityId: scope });
  res.status(204).end();
});
