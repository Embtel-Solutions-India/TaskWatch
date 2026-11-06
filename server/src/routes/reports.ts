import { Router, type Request } from 'express';
import { z } from 'zod';
import { PRIORITIES } from '@taskwatch/shared/insights';
import { isReportId, REPORT_STATUSES, reportCsv } from '@taskwatch/shared/reports';
import { me, requireUser } from '../http/middleware.js';
import { notFound } from '../http/errors.js';
import { accountabilityCsv, accountabilityPdf, csvRows } from '../services/exports.js';
import { accountability, report, reportOptions, reportScope } from '../services/reports.js';
import * as clock from '../clock.js';

/** RPT-01…07. Every endpoint is gated by the RPT-01 scope (403 without a report permission). */
export const reportsRouter = Router();
reportsRouter.use('/reports', requireUser, (req, _res, next) => {
  const { user, dir } = me(req);
  reportScope(user, dir);
  next();
});

const date = z.union([z.literal(''), z.iso.date({ error: 'Enter a valid date.' })]).default('');
const id = z.union([z.literal(''), z.string().regex(/^\d{1,9}$/, { error: 'Choose an option from the list.' })]).default('');
const filtersSchema = z
  .strictObject({
    from: date,
    to: date,
    teamId: id,
    userId: id,
    giverId: id,
    priority: z.union([z.literal(''), z.enum(PRIORITIES)]).default(''),
    status: z.union([z.literal(''), z.enum(REPORT_STATUSES as [string, ...string[]])]).default(''),
    level: z.enum(['', 'none', '0', '1', '2', '3']).default(''),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { path: ['from'], error: 'The start date must be on or before the end date.' });

const filters = (req: Request) => filtersSchema.parse(req.query) as Parameters<typeof report>[2];
const fileStamp = () => clock.now().toISOString().slice(0, 10);
const csvHeaders = (res: import('express').Response, name: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${fileStamp()}.csv"`);
};

reportsRouter.get('/reports/scope', (req, res) => {
  const { user, dir } = me(req);
  res.json({ scope: reportScope(user, dir) });
});

reportsRouter.get('/reports/options', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await reportOptions(user, dir));
});

/** FR-11 accountability (RPT-05/06) and its exports (RPT-07); registered before /reports/:reportId. */
const daysSchema = z.strictObject({ days: z.coerce.number().int().refine((d) => [7, 30, 90].includes(d), { error: 'Choose 7, 30 or 90 days.' }).default(30) });

reportsRouter.get('/reports/accountability', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await accountability(user, dir, daysSchema.parse(req.query).days));
});

reportsRouter.get('/reports/accountability/export.csv', async (req, res) => {
  const { user, dir } = me(req);
  const a = await accountability(user, dir, daysSchema.parse(req.query).days);
  csvHeaders(res, 'taskwatch-accountability');
  res.send('﻿' + accountabilityCsv(a, user.timeZone));
});

reportsRouter.get('/reports/accountability/export.pdf', async (req, res) => {
  const { user, dir } = me(req);
  const a = await accountability(user, dir, daysSchema.parse(req.query).days);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="taskwatch-accountability-${fileStamp()}.pdf"`);
  accountabilityPdf(a, user.timeZone).pipe(res);
});

/** RPT-02: the payload behind all nine reports. */
reportsRouter.get('/reports', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await report(user, dir, filters(req)));
});

/** RPT-03: one report's CSV, from the same filters as the screen. */
reportsRouter.get('/reports/:reportId/export.csv', async (req, res) => {
  const { user, dir } = me(req);
  const rid = req.params.reportId;
  if (!isReportId(rid)) throw notFound('Unknown report.');
  const r = await report(user, dir, filters(req));
  csvHeaders(res, `taskwatch-report-${rid}`);
  res.send('﻿' + csvRows(reportCsv(rid, r, user.timeZone)) + '\n');
});
