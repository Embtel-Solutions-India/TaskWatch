import { FREQUENCIES } from '@taskwatch/shared/recurrence';
import { Router } from 'express';
import { z } from 'zod';
import { PRIORITIES } from '../domain.js';
import { idParam, me, requireUser } from '../http/middleware.js';
import { deleteRecurring, listRecurring, saveRecurring, setRecurringActive } from '../services/recurring.js';

export const recurringRouter = Router();
recurringRouter.use(requireUser);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (error: string) => z.number({ error }).int({ error });

// Types only; the REC-02 rules and their messages are in shared/recurrence.ts (scheduleErrors) and the service.
const scheduleBody = z
  .object({
    title: z.string({ error: 'Give the schedule a title of at least 4 characters.' }),
    description: z.string().max(5000, { error: 'Keep the description under 5000 characters.' }).default(''),
    category: z.string({ error: 'Choose a category.' }),
    priority: z.enum(PRIORITIES, { error: 'Choose a priority.' }),
    // null passes here so every field rule is reported together (scheduleErrors).
    assigneeId: int('Choose an assignee.').nullable(),
    teamId: int('Choose a team.').nullable().default(null),
    reviewRequired: z.boolean().default(false),
    frequency: z.enum(FREQUENCIES, { error: 'Choose how often it repeats.' }),
    interval: int('Between 1 and 365.'),
    weekdays: z.array(int('Pick at least one weekday.').min(0).max(6)).max(7).default([]),
    startDate: z.string().regex(DAY, { error: 'Choose a start date.' }),
    endDate: z.string().regex(DAY, { error: 'Choose a valid end date.' }).nullable().default(null),
    dueHour: int('Between 0 and 23.'),
  })
  .strict();

// REC-01
recurringRouter.get('/recurring', async (req, res) => {
  res.json(await listRecurring(me(req).user));
});

// REC-02
recurringRouter.post('/recurring', async (req, res) => {
  res.status(201).json(await saveRecurring(me(req).user, null, scheduleBody.parse(req.body)));
});

recurringRouter.put('/recurring/:id', async (req, res) => {
  const { id } = await saveRecurring(me(req).user, idParam(req), scheduleBody.parse(req.body));
  res.json({ id });
});

// REC-03
recurringRouter.post('/recurring/:id/active', async (req, res) => {
  const { active } = z.object({ active: z.boolean({ error: 'Choose active or paused.' }) }).strict().parse(req.body);
  res.json({ ok: true, generated: await setRecurringActive(me(req).user, idParam(req), active) });
});

recurringRouter.delete('/recurring/:id', async (req, res) => {
  await deleteRecurring(me(req).user, idParam(req));
  res.status(204).end();
});
