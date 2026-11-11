import { Router } from 'express';
import { z } from 'zod';
import { idParam, me, requireUser } from '../http/middleware.js';
import { analytics, leaderboard, personBreakdown, teamWorkload, visibleTeams } from '../services/performance.js';

// PERF (PERFORMANCE-FRD §3, §5). Access is decided per team / person in the service (404 outside scope).
export const performanceRouter = Router();
performanceRouter.use(requireUser);

const period = {
  period: z.enum(['week', 'month', 'custom'], { error: 'Choose week, month or custom.' }).default('month'),
  from: z.string().optional(),
  to: z.string().optional(),
};
const teamQuery = z.object({ teamId: z.coerce.number({ error: 'Choose a team.' }).int({ error: 'Choose a team.' }), ...period }).strict();

performanceRouter.get('/performance/teams', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await visibleTeams(user, dir));
});

performanceRouter.get('/performance/leaderboard', async (req, res) => {
  const { user, dir } = me(req);
  const { teamId, ...q } = teamQuery.parse(req.query);
  res.json(await leaderboard(user, dir, teamId, q));
});

performanceRouter.get('/performance/analytics', async (req, res) => {
  const { user, dir } = me(req);
  const { teamId, ...q } = teamQuery.parse(req.query);
  res.json(await analytics(user, dir, teamId, q));
});

performanceRouter.get('/performance/people/:id', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await personBreakdown(user, dir, idParam(req), z.object(period).strict().parse(req.query)));
});

performanceRouter.get('/workload', async (req, res) => {
  const { user, dir } = me(req);
  const { teamId } = z.object({ teamId: z.coerce.number({ error: 'Choose a team.' }).int({ error: 'Choose a team.' }) }).strict().parse(req.query);
  res.json(await teamWorkload(user, dir, teamId));
});
