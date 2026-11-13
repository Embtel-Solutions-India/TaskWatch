// ADR-0015 attendance API (D-156…D-163). Object-level checks live in services/attendance.ts.
import { Router } from 'express';
import { z } from 'zod';
import * as clock from '../clock.js';
import { me, requireUser } from '../http/middleware.js';
import { dayIn, listAttendance, markAttendance, markSchema, myAttendance, STATUSES } from '../services/attendance.js';

export const attendanceRouter = Router();
attendanceRouter.use('/attendance', requireUser);

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

attendanceRouter.put('/attendance', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await markAttendance(user, dir, markSchema.parse(req.body)));
});

attendanceRouter.get('/attendance', async (req, res) => {
  const { user, dir } = me(req);
  const today = dayIn(user.work.zone, clock.now().getTime());
  const q = z
    .object({ from: DAY.default(today), to: DAY.default(today), teamId: z.coerce.number().int().optional(), userId: z.coerce.number().int().optional(), status: z.enum(STATUSES).optional() })
    .strict()
    .parse(req.query);
  res.json(await listAttendance(user, dir, q));
});

attendanceRouter.get('/attendance/me', async (req, res) => {
  const { user } = me(req);
  const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).default(dayIn(user.work.zone, clock.now().getTime()).slice(0, 7)) }).strict().parse(req.query);
  res.json(await myAttendance(user, month));
});
