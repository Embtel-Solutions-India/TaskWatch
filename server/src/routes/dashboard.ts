import { Router } from 'express';
import { z } from 'zod';
import { RANGES, type Range } from '@taskwatch/shared/insights';
import { me, requireUser } from '../http/middleware.js';
import { rateLimit } from '../http/rateLimit.js';
import { roleDashboard, teamOverview } from '../services/dashboard.js';
import { search } from '../services/search.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireUser);

/** DASH-01: the role dashboard over the viewer's scope; `entity` only for organization-wide viewers. */
const dashboardSchema = z.object({
  range: z.coerce
    .number()
    .refine((d): d is Range => (RANGES as readonly number[]).includes(d), { error: 'Choose 7, 30 or 90 days.' })
    .default(30),
  entity: z.string().min(1).max(40).optional(),
});

dashboardRouter.get('/dashboard', async (req, res) => {
  const { user, dir } = me(req);
  const q = dashboardSchema.parse(req.query);
  res.json(await roleDashboard(user, dir, { range: q.range as Range, entity: q.entity }));
});

/** DASH-02 */
dashboardRouter.get('/team/overview', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await teamOverview(user, dir));
});

/** SRCH-01: rate-limited per person (SEC-3). */
const searchLimit = rateLimit({ max: 120, windowMs: 60_000, key: (req) => `search:${req.user?.id}` });
const searchSchema = z.object({ q: z.string().max(100, { error: 'Search text is too long.' }).default('') });

dashboardRouter.get('/search', searchLimit, async (req, res) => {
  const { user, dir } = me(req);
  res.json(await search(user, dir, searchSchema.parse(req.query).q));
});
