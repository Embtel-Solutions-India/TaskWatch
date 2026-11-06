import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import { DateTime } from 'luxon';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { PRIORITIES } from '../domain.js';
import { HttpError, invalid, notFound } from '../http/errors.js';
import { idParam, me, requireUser } from '../http/middleware.js';
import { rateLimit } from '../http/rateLimit.js';
import { isCoS } from '@taskwatch/shared/permissions';
import { assignableUsers, canView } from '../services/access.js';
import { addAttachments, addComment, deleteComment, editComment, removeAttachment } from '../services/collab.js';
import { checkUploads, INLINE_SAFE } from '../services/uploads.js';
import {
  assigneeOptions,
  ESCALATION_STATUSES,
  escalationList,
  escalationView,
  extensionQueue,
  EXTENSION_FILTERS,
  listTasks,
  parentOptions,
  reviewQueue,
  taskDetail,
  taskSummary,
  taskViewById,
  TASK_SCOPES,
  TASK_VIEWS,
} from '../services/queries.js';
import {
  acknowledge,
  acknowledgeTask,
  blockTask,
  cancelTask,
  changeDue,
  completeTask,
  createTask,
  decideExtension,
  dueFrom,
  postProgress,
  postUpdate,
  publishTask,
  reassignTask,
  reopenTask,
  requestExtension,
  rateTask,
  reviewTask,
  startTask,
  submitTask,
  updateTask,
  type TaskInput,
} from '../services/tasks.js';

export const tasksRouter = Router();
tasksRouter.use(requireUser);

fs.mkdirSync(config.uploadDir, { recursive: true });
// S-4: uploads stay in memory (15 MiB each, D-13; 5 per request) and reach the disk only inside an authorized action.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 5 } });
const uploadFiles = upload.array('files', 5);

const text = (max: number) => z.string().trim().max(max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

tasksRouter.get('/tasks/summary', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await taskSummary(user, dir));
});

/** TASK-04 lists by scope, TASK-09 quick views on top. `{items, truncated}` (ADR-0009). */
tasksRouter.get('/tasks', async (req, res) => {
  const { user, dir } = me(req);
  const q = z
    .object({
      scope: z.enum(TASK_SCOPES, { error: 'Unknown list.' }).optional(),
      view: z.enum(TASK_VIEWS, { error: 'Unknown view.' }).optional(),
      entity: z.string().max(20).optional(),
      q: z.string().max(100).optional(),
      dueFrom: z.string().regex(DATE, { error: 'Use YYYY-MM-DD.' }).optional(),
      dueTo: z.string().regex(DATE, { error: 'Use YYYY-MM-DD.' }).optional(),
    })
    .refine((x) => !x.dueFrom || !x.dueTo || x.dueFrom <= x.dueTo, { error: 'The start date must be on or before the end date.', path: ['dueTo'] })
    .parse(req.query);
  // A scoped list returns every status (the screen filters them); the plain list keeps its open-work default.
  const view = q.view ?? (q.scope ? 'all' : 'open');
  // TASK-06: calendar days are whole days in the viewer's own zone (BR-85); `dueTo` includes its whole day.
  const day = (d: string) => DateTime.fromISO(d, { zone: user.timeZone });
  res.json(
    await listTasks(user, dir, {
      scope: q.scope,
      view,
      entity: q.entity || undefined,
      q: q.q || undefined,
      dueFrom: q.dueFrom ? day(q.dueFrom).toJSDate() : undefined,
      dueTo: q.dueTo ? day(q.dueTo).plus({ days: 1 }).toJSDate() : undefined,
    }),
  );
});

/** TASK-08: assignee picker (needs assign_tasks, else empty) and parent picker (visible active or draft tasks). */
tasksRouter.get('/tasks/options/assignees', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await assigneeOptions(user, dir, assignableUsers(user, dir)));
});

tasksRouter.get('/tasks/options/parents', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await parentOptions(user, dir));
});

/* ---------- Create and edit (TASK-01…03) ---------- */

/** PERF: a 0–100 integer score from a reviewer or giver. */
const score = (error: string) => z.number({ error }).int({ error }).min(0, { error }).max(100, { error }).optional();

/** PERF (FRD §4): the giver's measures, shared by the task and recurring-schedule bodies. */
export const measuredFields = {
    target: z.number({ error: 'Enter a target above 0.' }).positive({ error: 'Enter a target above 0.' }).nullable().default(null),
    unit: z.string().trim().max(40, { error: 'Keep the unit under 40 characters.' }).default(''),
    estimatedHours: z.number({ error: 'Between 0.25 and 200 hours.' }).min(0.25, { error: 'Between 0.25 and 200 hours.' }).max(200, { error: 'Between 0.25 and 200 hours.' }).nullable().default(null),
    purpose: z.enum(['revenue', 'support'], { error: 'Choose revenue or support.' }).nullable().default(null),
};

const taskBody = z
  .object({
    title: z.string({ error: 'Give the task a title of at least 4 characters.' }).max(1000),
    description: text(5000).default(''),
    instructions: text(5000).default(''),
    category: z.string({ error: 'Choose a category.' }).default(''),
    priority: z.enum(PRIORITIES, { error: 'Choose a priority.' }),
    assigneeId: z.number({ error: 'Choose who will do this.' }).int(),
    teamId: z.number().int().nullable().default(null),
    dueDate: z.string({ error: 'Set a due date.' }),
    dueTime: z.string().regex(TIME, { error: 'Enter a valid time.' }).optional(),
    startDate: z.string().regex(DATE, { error: 'Enter a valid date.' }).nullable().optional(),
    reviewRequired: z.boolean().default(false),
    parentId: z.number().int().nullable().default(null),
    ...measuredFields,
  })
  .strict();

/** Body → service input. Dates are read in the caller's own zone (D-5); a missing or bad date is its own 422. */
function toTaskInput(req: Request, b: z.infer<typeof taskBody>): TaskInput {
  const tz = me(req).user.timeZone;
  if (!b.dueDate) throw invalid({ dueDate: 'Set a due date.' });
  const dueAt = DATE.test(b.dueDate) ? dueFrom(b.dueDate, b.dueTime, tz) : null;
  if (!dueAt) throw invalid({ dueDate: 'Enter a valid date.' });
  return {
    title: b.title,
    description: b.description,
    instructions: b.instructions,
    category: b.category,
    priority: b.priority,
    assigneeId: b.assigneeId,
    teamId: b.teamId,
    dueAt,
    startAt: b.startDate ? dueFrom(b.startDate, '00:00', tz) : null,
    reviewRequired: b.reviewRequired,
    parentId: b.parentId,
    target: b.target,
    unit: b.unit || null,
    estimatedHours: b.estimatedHours,
    purpose: b.purpose,
  };
}

/** TASK-01 / TASK-02: `draft: true` saves without assigning. 201 `{task, actions}`. */
tasksRouter.post('/tasks', async (req, res) => {
  const { user, dir } = me(req);
  const { draft, ...rest } = taskBody.extend({ draft: z.boolean().default(false) }).parse(req.body);
  const id = await createTask(user, toTaskInput(req, rest), { draft });
  res.status(201).json(await taskViewById(user, dir, id));
});

tasksRouter.put('/tasks/:id', async (req, res) => {
  const { user, dir } = me(req);
  const id = idParam(req);
  await updateTask(user, id, toTaskInput(req, taskBody.parse(req.body)));
  res.json(await taskViewById(user, dir, id));
});

tasksRouter.get('/tasks/:id', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await taskDetail(user, dir, idParam(req)));
});

/* ---------- Workflow actions (WF-01…09, WF-11, EXT-04): each answers {task, actions} ---------- */


// 30 uploads per 10 min per person; checked before multer writes anything to disk. Text-only requests are not counted.
const uploadLimit = rateLimit({ max: 30, windowMs: 10 * 60_000, key: (req) => (req.is('multipart/form-data') ? `u:${req.user?.id}` : undefined) });

/** The request's uploads, type-checked (D-69); `files[]`, or the legacy single `file`. */
const uploadsOf = (req: Request) => checkUploads((req.files as Express.Multer.File[] | undefined) ?? (req.file ? [req.file] : undefined));

/** One action route: parse the body, run the action, answer with the task as the caller now sees it. */
function action<S extends z.ZodTypeAny>(pathSuffix: string, schema: S, run: (req: Request, id: number, body: z.infer<S>) => Promise<unknown>, withUpload = false) {
  const handlers = withUpload ? [uploadLimit, uploadFiles] : [];
  tasksRouter.post(`/tasks/:id/${pathSuffix}`, ...handlers, async (req, res) => {
    const { user, dir } = me(req);
    const id = idParam(req);
    await run(req, id, schema.parse(req.body ?? {}));
    res.json(await taskViewById(user, dir, id));
  });
}

/* ---------- Bulk cancel and acknowledge (TASK-07): each id on its own; failures are skipped, never explained ---------- */

const bulkIds = z.array(z.coerce.number().int().positive(), { error: 'Choose at least one task.' }).min(1, { error: 'Choose at least one task.' }).max(200, { error: 'At most 200 tasks at a time.' });

async function bulk(ids: number[], run: (id: number) => Promise<void>) {
  const done: number[] = [];
  const skipped: number[] = [];
  for (const id of ids) {
    try {
      await run(id);
      done.push(id);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status >= 500) throw err;
      skipped.push(id); // unknown, not visible, or not allowed: all look the same (TASK-07-AC-3)
    }
  }
  return { done, skipped };
}

tasksRouter.post('/tasks/bulk/cancel', async (req, res) => {
  const { user } = me(req);
  const b = z.object({ ids: bulkIds, reason: z.string().max(1000).default('') }).strict().parse(req.body);
  if (b.reason.trim().length < 5) throw invalid({ reason: 'A cancellation reason is required.' });
  res.json(await bulk(b.ids, (id) => cancelTask(user, id, b.reason)));
});

tasksRouter.post('/tasks/bulk/acknowledge', async (req, res) => {
  const { user } = me(req);
  const b = z.object({ ids: bulkIds }).strict().parse(req.body);
  res.json(await bulk(b.ids, (id) => acknowledgeTask(user, id)));
});

const empty = z.object({}).strict();
const reasonOnly = z.object({ reason: z.string().max(1000).default('') }).strict();

action('publish', empty, (req, id) => publishTask(me(req).user, id));
action('acknowledge', empty, (req, id) => acknowledgeTask(me(req).user, id));
action('start', empty, (req, id) => startTask(me(req).user, id));
action(
  'progress',
  z.object({ message: z.string().max(5000).default(''), percent: z.coerce.number().optional(), achieved: z.coerce.number({ error: 'Enter a number of 0 or more.' }).min(0, { error: 'Enter a number of 0 or more.' }).optional() }).strict(),
  (req, id, b) => postProgress(me(req).user, id, { message: b.message, percent: b.percent, achieved: b.achieved, files: uploadsOf(req) }),
  true,
);
action('block', reasonOnly, (req, id, b) => blockTask(me(req).user, id, b.reason));
action('submit', z.object({ note: z.string().max(5000).default(''), achieved: z.coerce.number({ error: 'Enter a number of 0 or more.' }).min(0, { error: 'Enter a number of 0 or more.' }).optional(), result: z.string().max(1000, { error: 'Keep the result under 1000 characters.' }).optional(), shortfallReason: z.string().max(500, { error: 'Keep the reason under 500 characters.' }).optional() }).strict(), (req, id, b) => submitTask(me(req).user, id, { ...b, files: uploadsOf(req) }), true);
action('complete', z.object({ note: z.string().max(1000).default(''), achieved: z.coerce.number({ error: 'Enter a number of 0 or more.' }).min(0, { error: 'Enter a number of 0 or more.' }).optional(), result: z.string().max(1000, { error: 'Keep the result under 1000 characters.' }).optional(), shortfallReason: z.string().max(500, { error: 'Keep the reason under 500 characters.' }).optional() }).strict(), (req, id, b) => completeTask(me(req).user, id, b.note, b));
action(
  'review',
  z
    .object({
      decision: z.enum(['approved', 'changes_requested', 'rejected'], { error: 'Choose a decision.' }),
      comment: z.string().max(2000).default(''),
      qualityScore: score('Give a quality score from 0 to 100.'),
      outcomeScore: score('Give an outcome score from 0 to 100.'),
      shortfallAccepted: z.boolean().optional(),
    })
    .strict(),
  (req, id, b) => reviewTask(me(req).user, id, b),
);
action(
  'rate',
  z
    .object({ outcomeScore: score('Give an outcome score from 0 to 100.'), shortfallAccepted: z.boolean({ error: 'Choose yes or no.' }).optional() })
    .strict()
    .refine((b) => b.outcomeScore !== undefined || b.shortfallAccepted !== undefined, { error: 'Give an outcome score or decide on the shortfall.' }),
  (req, id, b) => rateTask(me(req).user, id, b),
);
action('reassign', z.object({ toId: z.number().int().optional(), reason: z.string().max(1000).default('') }).strict(), (req, id, b) => reassignTask(me(req).user, id, b));
action('cancel', reasonOnly, (req, id, b) => cancelTask(me(req).user, id, b.reason));
action(
  'reopen',
  z.object({ reason: z.string().max(1000).default(''), dueDate: z.string().default(''), dueTime: z.string().regex(TIME).optional() }).strict(),
  (req, id, b) => reopenTask(me(req).user, id, { reason: b.reason, dueAt: DATE.test(b.dueDate) ? dueFrom(b.dueDate, b.dueTime, me(req).user.timeZone) : null }),
);
action(
  'due',
  z.object({ dueDate: z.string().default(''), dueTime: z.string().regex(TIME, { error: 'Enter a valid time.' }).optional(), reason: z.string().max(1000).default('') }).strict(),
  async (req, id, b) => {
    const dueAt = DATE.test(b.dueDate) ? dueFrom(b.dueDate, b.dueTime, me(req).user.timeZone) : null;
    if (!dueAt) throw invalid({ dueDate: 'Enter a valid date.' });
    await changeDue(me(req).user, id, dueAt, b.reason);
  },
);

/* ---------- Extensions (EXT-01…03) and the review queue (WF-06) ---------- */

tasksRouter.post('/tasks/:id/extensions', async (req, res) => {
  const { user } = me(req);
  const b = z.object({ requestedDate: z.string().default(''), requestedTime: z.string().regex(TIME).optional(), reason: z.string().max(1000).default(''), info: z.string().max(2000).default('') }).strict().parse(req.body);
  const requestedDue = DATE.test(b.requestedDate) ? dueFrom(b.requestedDate, b.requestedTime, user.timeZone) : null;
  const extId = await requestExtension(user, idParam(req), { requestedDue, reason: b.reason, info: b.info });
  const { rows } = await pool.query('select * from extensions where id = $1', [extId]);
  res.status(201).json(rows[0]);
});

tasksRouter.post('/extensions/:id/decision', async (req, res) => {
  const { user, dir } = me(req);
  const b = z.object({ approve: z.boolean({ error: 'Approve or reject.' }), note: z.string().max(1000).default('') }).strict().parse(req.body);
  const taskId = await decideExtension(user, idParam(req), b);
  const { rows } = await pool.query('select * from extensions where id = $1', [idParam(req)]);
  res.json({ extension: rows[0], ...(await taskViewById(user, dir, taskId)) });
});

tasksRouter.get('/extensions', async (req, res) => {
  const { user, dir } = me(req);
  const { status } = z.object({ status: z.enum(EXTENSION_FILTERS, { error: 'Unknown filter.' }).default('pending') }).parse(req.query);
  res.json(await extensionQueue(user, dir, status));
});

tasksRouter.get('/reviews', async (req, res) => {
  const { user, dir } = me(req);
  res.json(await reviewQueue(user, dir));
});

/* ---------- Legacy request shapes, kept until the client moves to the action endpoints (T-4.14) ---------- */

tasksRouter.post('/tasks/:id/updates', uploadLimit, upload.single('file'), async (req, res) => {
  const { user } = me(req);
  const body = z
    .object({
      body: text(5000),
      // 'done' is the pre-cutover name of 'completed' (T-4.0).
      status: z
        .enum(['in_progress', 'blocked', 'completed', 'done'])
        .transform((s) => (s === 'done' ? 'completed' : s))
        .optional()
        .or(z.literal('').transform(() => undefined)),
    })
    .parse(req.body);
  await postUpdate(user, idParam(req), { body: body.body, status: body.status, files: uploadsOf(req) });
  res.status(201).json({ ok: true });
});


/* ---------- Comments, files, escalation acknowledgement (T-4.10, T-4.11, Phase 5 rework them) ---------- */

const commentRow = async (id: number) => (await pool.query('select id, task_id as "taskId", author_id as "authorId", parent_id as "parentId", body, created_at as "at", edited_at as "editedAt" from comments where id = $1', [id])).rows[0];

/** CMT-01: comment or reply, optionally with files (multipart). Never touches the clock. */
tasksRouter.post('/tasks/:id/comments', uploadLimit, uploadFiles, async (req, res) => {
  const { user } = me(req);
  const b = z.object({ body: z.string().max(20000).default(''), parentId: z.coerce.number().int().positive().optional() }).strict().parse(req.body);
  const id = await addComment(user, idParam(req), { body: b.body, parentId: b.parentId ?? null, files: uploadsOf(req) });
  res.status(201).json({ comment: await commentRow(id) });
});

tasksRouter.put('/comments/:id', async (req, res) => {
  const { user } = me(req);
  const b = z.object({ body: z.string().max(20000).default('') }).strict().parse(req.body);
  await editComment(user, idParam(req), b);
  res.json({ comment: await commentRow(idParam(req)) });
});

tasksRouter.delete('/comments/:id', async (req, res) => {
  await deleteComment(me(req).user, idParam(req));
  res.json({ ok: true });
});

/** ATT-01: files on the task itself. */
tasksRouter.post('/tasks/:id/attachments', uploadLimit, uploadFiles, async (req, res) => {
  const ids = await addAttachments(me(req).user, idParam(req), uploadsOf(req));
  const { rows } = await pool.query('select id, file_name as "fileName", mime, size, sha256, uploaded_at as "uploadedAt", context from attachments where id = any($1) order by id', [ids]);
  res.status(201).json({ attachments: rows });
});

/** ATT-03: hidden, never deleted. */
tasksRouter.delete('/attachments/:id', async (req, res) => {
  await removeAttachment(me(req).user, idParam(req));
  res.json({ ok: true });
});

tasksRouter.get('/tasks/:id/attachments/:aid', async (req, res) => {
  const { user, dir } = me(req);
  const { rows } = await pool.query(
    `select a.*, t.organization_id, t.assignee_id, t.assigner_id, t.created_by, t.reviewer_id, t.status from attachments a join tasks t on t.id = a.task_id
      where a.id = $1 and a.task_id = $2`,
    [idParam(req, 'aid'), idParam(req)],
  );
  const a = rows[0];
  if (!a || !canView(user, a, dir) || (a.removed_at && !isCoS(user))) throw notFound('File not found'); // removed: kept as evidence for the CoS
  const file = path.join(config.uploadDir, path.basename(a.storage_key));
  const inline = req.query.inline === '1' && INLINE_SAFE.has(a.mime);
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (inline) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.file_name)}`);
  fs.createReadStream(file)
    .on('error', () => res.status(404).end())
    .pipe(res);
});

/** ESC-09: the Escalations workspace; filters on the server (D-10), unknown values answer 422. */
tasksRouter.get('/escalations', async (req, res) => {
  const { user, dir } = me(req);
  const f = z
    .object({
      status: z.enum(ESCALATION_STATUSES).default('open'),
      level: z.coerce.number().int().min(0).max(3).optional(),
      priority: z.enum(PRIORITIES).optional(),
      teamId: z.coerce.number().int().positive().optional(),
      assigneeId: z.coerce.number().int().positive().optional(),
    })
    .strict()
    .parse(req.query);
  res.json(await escalationList(user, dir, f));
});

tasksRouter.post('/escalations/:id/ack', async (req, res) => {
  const { user, dir } = me(req);
  const body = z.object({ note: z.string().max(1000, 'Keep the note under 1000 characters.').default('') }).strict().parse(req.body);
  const id = idParam(req);
  const taskId = await acknowledge(user, id, body.note);
  res.json({ event: await escalationView(user, id), task: (await taskViewById(user, dir, taskId)).task });
});
