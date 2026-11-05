import { Router } from 'express';
import { z } from 'zod';
import { me, requireUser } from '../http/middleware.js';
import { accountabilityCsv, accountabilityPdf } from '../services/exports.js';
import { accountability } from '../services/reports.js';
import * as clock from '../clock.js';

export const dashboardRouter = Router();
dashboardRouter.use(requireUser);

const daysSchema = z.object({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d)).default(30) });

dashboardRouter.get('/dashboard', async (req, res) => {
  const { user, dir } = me(req);
  const { days } = daysSchema.parse(req.query);
  res.json(await accountability(user, dir, days));
});

const fileStamp = () => clock.now().toISOString().slice(0, 10);

dashboardRouter.get('/dashboard/export.csv', async (req, res) => {
  const { user, dir } = me(req);
  const { days } = daysSchema.parse(req.query);
  const report = await accountability(user, dir, days);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="taskwatch-accountability-${fileStamp()}.csv"`);
  res.send('﻿' + accountabilityCsv(report, user.timeZone));
});

dashboardRouter.get('/dashboard/export.pdf', async (req, res) => {
  const { user, dir } = me(req);
  const { days } = daysSchema.parse(req.query);
  const report = await accountability(user, dir, days);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="taskwatch-accountability-${fileStamp()}.pdf"`);
  accountabilityPdf(report, user.timeZone).pipe(res);
});
