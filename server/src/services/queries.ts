import { isCoS, isFoundersOffice } from '@taskwatch/shared/permissions';
import * as clock from '../clock.js';
import { pool } from '../db/pool.js';
import { isOpenStatus, LEVEL_LABELS, openSql, type Priority } from '../domain.js';
import { taskLevel } from '../engine/levels.js';
import { forbidden, notFound } from '../http/errors.js';
import { can, canView, relation, taskActions, taskPermissions, visibilityFilter } from './access.js';
import { presentKind, presentValues, verifyChains } from './activity.js';
import type { Directory, DirUser } from './directory.js';
import { getRuleSet } from './rules.js';

/** FR-10 quick views (TASK-09), applied on top of the scope. 'all' (every status) is for server callers and scopes. */
export const TASK_VIEWS = ['open', 'mine', 'escalated', 'red', 'blocked', 'closed', 'all'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];
/** TASK-04 list scopes. */
export const TASK_SCOPES = ['mine', 'assigned_by_me', 'team', 'all'] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

/** ADR-0009: lists stay client-side over a capped, scoped result; `truncated` says the cap was hit. */
export const LIST_CAP = 500;

export interface ListFilters {
  view: TaskView;
  scope?: TaskScope;
  entity?: string;
  q?: string;
  assigneeId?: number;
  /** Tasks this person created or assigned. */
  givenBy?: number;
  /** TASK-06 calendar window (instants already resolved in the viewer's zone); drafts are left out. */
  dueFrom?: Date;
  dueTo?: Date;
}

const TASK_COLUMNS = `
  t.id, t.organization_id, t.title, t.description, t.instructions, t.category, t.entity_id, en.name as entity_name, t.priority, t.status,
  t.due_at, t.original_due_at, t.created_at, t.updated_at, t.assigned_at, t.start_at, t.clock_started_at, t.last_update_at,
  t.acknowledged_at, t.snooze_until, t.progress, t.review_required, t.parent_id, t.recurring_id, t.occurrence_date,
  t.cancel_reason, t.completed_at, t.closed_at, t.blocked_reason, t.level, t.lead_extension_used,
  t.assignee_id, a.name as assignee_name, t.assigner_id, g.name as assigner_name, t.created_by, t.reviewer_id,
  t.team_id, tm.name as team_name`;

const TASK_JOINS = `
  from tasks t
  join users a on a.id = t.assignee_id
  join users g on g.id = t.assigner_id
  join entities en on en.id = t.entity_id
  left join teams tm on tm.id = t.team_id`;

/** The per-task facts the shared action rules need (WF-10) and the row's own escalation state; `me` is a $n placeholder. */
const FACTS = (me: string) => `,
  exists (select 1 from extensions x where x.task_id = t.id and x.status = 'pending') as pending_extension,
  exists (select 1 from escalations e join escalation_recipients er on er.escalation_id = e.id
           where e.task_id = t.id and e.cleared_at is null and e.acknowledged_at is null and er.user_id = ${me} and er.kind = 'to') as my_to_escalation,
  exists (select 1 from escalations e where e.task_id = t.id and e.cleared_at is null and e.acknowledged_at is null) as any_escalation,
  (select e.acknowledged_at is not null from escalations e where e.task_id = t.id and e.cleared_at is null order by e.level desc limit 1) as top_acked,
  (select json_build_object('id', e.id, 'level', e.level, 'acknowledgedAt', e.acknowledged_at)
     from escalations e join escalation_recipients er on er.escalation_id = e.id
    where e.task_id = t.id and e.cleared_at is null and e.level >= 1 and er.user_id = ${me} and er.kind = 'to'
    order by e.level desc limit 1) as my_escalation`;

type Rules = Awaited<ReturnType<typeof getRuleSet>>;

/**
 * The API's TaskView (API_CONTRACTS §1): the task, its level computed now (TASK-04-AC-3), the viewer's allowed actions,
 * and only the names of the people on it — never contact details or anyone else's records.
 */
function toTaskView(r: any, now: Date, rules: Rules, viewer: DirUser, dir: Directory) {
  const info = taskLevel(r, rules.for(r.entity_id), now);
  const active = info !== null; // on the ladder: active statuses and In review
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    instructions: r.instructions,
    category: r.category,
    priority: r.priority,
    status: r.status,
    assigneeId: r.assignee_id,
    createdBy: r.created_by,
    assignedBy: r.assigner_id,
    reviewerId: r.reviewer_id,
    teamId: r.team_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startAt: r.start_at,
    dueAt: r.due_at,
    originalDueAt: r.original_due_at,
    clockStartedAt: r.clock_started_at,
    acknowledgedAt: r.acknowledged_at,
    snoozeUntil: r.snooze_until,
    progress: r.progress,
    reviewRequired: r.review_required,
    parentId: r.parent_id,
    recurrenceId: r.recurring_id,
    occurrenceDate: r.occurrence_date,
    cancelReason: r.cancel_reason,
    completedAt: r.completed_at,
    blockedReason: r.blocked_reason,
    entityId: r.entity_id,
    entityName: r.entity_name,
    level: info?.level ?? -1,
    levelInfo: info,
    overdue: active && r.due_at.getTime() < now.getTime(),
    lastUpdateAt: r.clock_started_at,
    escalationAcked: r.top_acked === true,
    myEscalation: r.my_escalation ?? null,
    assignee: { id: r.assignee_id, name: r.assignee_name },
    giver: { id: r.assigner_id, name: r.assigner_name },
    team: r.team_id ? { id: r.team_id, name: r.team_name } : null,
    actions: taskActions(viewer, dir, r, {
      pendingExtension: r.pending_extension === true,
      mayAckEscalation: r.my_to_escalation === true || (isCoS(viewer) && r.any_escalation === true), // R-1
    }),
  };
}

/** TASK-04: the scoped list (with a quick view on top), capped at LIST_CAP rows. */
export async function listTasks(viewer: DirUser, dir: Directory, f: ListFilters) {
  if (f.scope === 'assigned_by_me' && !can(viewer, dir, 'create_tasks')) throw forbidden("You don't have permission to see tasks you assigned.");
  if (f.scope === 'team' && !can(viewer, dir, 'view_tasks')) throw forbidden("You don't have permission to view team tasks.");
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const params: unknown[] = [...vis.params];
  const where = [vis.sql];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const me = p(viewer.id);

  switch (f.scope) {
    case 'mine':
      where.push(`t.assignee_id = ${me} and t.status <> 'draft'`);
      break;
    case 'assigned_by_me':
      where.push(`(t.created_by = ${me} or t.assigner_id = ${me})`);
      break;
    case 'team':
      // The Founder's Office's team is everyone but themselves; everyone else's is their transitive reports.
      where.push(isFoundersOffice(viewer) ? `t.assignee_id <> ${me}` : `t.assignee_id = any(${p([...dir.descendants(viewer.id)])})`);
      where.push(`t.status <> 'draft'`);
      break;
  }
  switch (f.view) {
    case 'open':
      where.push(openSql('t'));
      break;
    case 'mine':
      where.push(`${openSql('t')} and t.assignee_id = ${me}`);
      break;
    case 'escalated':
      where.push(`${openSql('t')} and exists (
        select 1 from escalations e join escalation_recipients er on er.escalation_id = e.id
        where e.task_id = t.id and e.cleared_at is null and e.level >= 1 and er.user_id = ${me} and er.kind = 'to')`);
      break;
    case 'red':
      where.push(`${openSql('t')} and t.level >= 2`);
      break;
    case 'blocked':
      where.push(`t.status = 'blocked'`);
      break;
    case 'closed':
      where.push(`t.status in ('completed', 'cancelled')`);
      break;
  }
  if (f.entity) where.push(`t.entity_id = ${p(f.entity)}`);
  if (f.assigneeId) where.push(`t.assignee_id = ${p(f.assigneeId)}`);
  if (f.givenBy) {
    const g = p(f.givenBy);
    where.push(`(t.assigner_id = ${g} or t.created_by = ${g})`);
  }
  if (f.q) where.push(`(t.title ilike ${p(`%${f.q}%`)} or a.name ilike $${params.length})`);

  if (f.dueFrom) where.push(`t.due_at >= ${p(f.dueFrom)}`);
  if (f.dueTo) where.push(`t.due_at < ${p(f.dueTo)}`);
  if (f.dueFrom || f.dueTo) where.push(`t.status <> 'draft'`); // TASK-06-AC-2

  const order = f.view === 'closed' ? 't.closed_at desc' : f.view === 'all' ? 't.created_at desc' : 't.level desc, t.due_at asc';
  const { rows } = await pool.query(
    `select ${TASK_COLUMNS} ${FACTS(me)} ${TASK_JOINS}
     where ${where.join(' and ')}
     order by ${order}
     limit ${LIST_CAP + 1}`,
    params,
  );
  const rules = await getRuleSet(viewer.organizationId);
  const now = clock.now();
  return { items: rows.slice(0, LIST_CAP).map((r) => toTaskView(r, now, rules, viewer, dir)), truncated: rows.length > LIST_CAP };
}

/** TASK-08: the people the viewer may assign to, with their open load. */
export async function assigneeOptions(viewer: DirUser, dir: Directory, assignable: DirUser[]) {
  const { rows } = await pool.query<{ id: number; n: number }>(
    `select t.assignee_id as id, count(*)::int n from tasks t where t.assignee_id = any($1) and ${openSql('t')} group by 1`,
    [assignable.map((u) => u.id)],
  );
  const load = new Map(rows.map((r) => [r.id, r.n]));
  const { rows: teams } = await pool.query<{ id: number; name: string }>('select id, name from teams where organization_id = $1', [viewer.organizationId]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return assignable.map((u) => ({
    id: u.id,
    name: u.name,
    title: u.title,
    roles: u.roles,
    teamId: u.teamId,
    teamName: u.teamId ? (teamName.get(u.teamId) ?? null) : null,
    entityId: u.entityId,
    timeZone: u.timeZone,
    openCount: load.get(u.id) ?? 0,
  }));
}

/** TASK-08: tasks the viewer can see that may be a parent (active or draft). */
export async function parentOptions(viewer: DirUser, dir: Directory) {
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const { rows } = await pool.query(
    `select t.id, t.title from tasks t where ${vis.sql} and (t.status = 'draft' or ${openSql('t')}) order by t.created_at desc limit ${LIST_CAP}`,
    vis.params,
  );
  return rows;
}

export async function taskSummary(viewer: DirUser, dir: Directory) {
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const me = vis.params.length + 1;
  const { rows } = await pool.query(
    `select
       count(*) filter (where ${openSql('t')}) as open,
       count(*) filter (where ${openSql('t')} and t.level < 0) as on_track,
       count(*) filter (where ${openSql('t')} and t.level between 0 and 1) as amber,
       count(*) filter (where ${openSql('t')} and t.level >= 2) as red,
       count(*) filter (where t.status = 'blocked') as blocked,
       count(*) filter (where ${openSql('t')} and t.assignee_id = $${me}) as mine,
       count(*) filter (where ${openSql('t')} and exists (
         select 1 from escalations e join escalation_recipients er on er.escalation_id = e.id
         where e.task_id = t.id and e.cleared_at is null and e.level >= 1 and er.user_id = $${me} and er.kind = 'to')) as escalated,
       count(*) filter (where ${openSql('t')} and exists (
         select 1 from escalations e join escalation_recipients er on er.escalation_id = e.id
         where e.task_id = t.id and e.cleared_at is null and e.level >= 1 and er.user_id = $${me} and er.kind = 'to'
           and e.acknowledged_at is null)) as needs_ack
     from tasks t where ${vis.sql}`,
    [...vis.params, viewer.id],
  );
  const s = rows[0];
  const l3 = await pool.query(
    `select ${TASK_COLUMNS} ${FACTS(`$${me}`)} ${TASK_JOINS} where ${vis.sql} and ${openSql('t')} and t.level = 3 order by t.clock_started_at limit 20`,
    [...vis.params, viewer.id],
  );
  const rules = await getRuleSet(viewer.organizationId);
  const now = clock.now();
  return {
    open: s.open,
    onTrack: s.on_track,
    amber: s.amber,
    red: s.red,
    blocked: s.blocked,
    mine: s.mine,
    escalated: s.escalated,
    needsAck: s.needs_ack,
    l3: l3.rows.map((r) => toTaskView(r, now, rules, viewer, dir)),
  };
}

/** One task as the caller sees it; the action endpoints answer with `{task, actions}` (TASK-WORKFLOW-FRD conventions). */
export async function taskViewById(viewer: DirUser, dir: Directory, taskId: number) {
  const { rows } = await pool.query(`select ${TASK_COLUMNS} ${FACTS('$2')} ${TASK_JOINS} where t.id = $1`, [taskId, viewer.id]);
  if (!rows[0] || !canView(viewer, rows[0], dir)) throw notFound('Task not found');
  const task = toTaskView(rows[0], clock.now(), await getRuleSet(viewer.organizationId), viewer, dir);
  return { task, actions: task.actions };
}

/** WF-06 queue: submitted tasks the caller may review, with their pending submission. */
export async function reviewQueue(viewer: DirUser, dir: Directory) {
  if (!can(viewer, dir, 'review_tasks')) throw forbidden("You don't have permission to review tasks.");
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const me = `$${vis.params.length + 1}`;
  const { rows } = await pool.query(
    `select ${TASK_COLUMNS} ${FACTS(me)}, row_to_json(r) as submission ${TASK_JOINS}
       join reviews r on r.task_id = t.id and r.decision is null
      where ${vis.sql} and t.status = 'submitted' order by r.submitted_at`,
    [...vis.params, viewer.id],
  );
  const rules = await getRuleSet(viewer.organizationId);
  const now = clock.now();
  return rows
    .map((r) => ({ task: toTaskView(r, now, rules, viewer, dir), submission: r.submission }))
    .filter((x) => x.task.actions.includes('review'));
}

export const EXTENSION_FILTERS = ['pending', 'decided', 'all'] as const;

/** EXT-03: requests on visible tasks, pending first then newest; `canDecide` mirrors what EXT-02 would accept. */
export async function extensionQueue(viewer: DirUser, dir: Directory, status: (typeof EXTENSION_FILTERS)[number]) {
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const me = `$${vis.params.length + 1}`;
  const where = status === 'pending' ? `x.status = 'pending'` : status === 'decided' ? `x.status <> 'pending'` : 'true';
  const { rows } = await pool.query(
    `select ${TASK_COLUMNS} ${FACTS(me)}, row_to_json(x) as ext ${TASK_JOINS}
       join extensions x on x.task_id = t.id
      where ${vis.sql} and ${where}
      order by (x.status = 'pending') desc, x.requested_at desc limit ${LIST_CAP}`,
    [...vis.params, viewer.id],
  );
  const rules = await getRuleSet(viewer.organizationId);
  const now = clock.now();
  return rows.map((r) => {
    const task = toTaskView(r, now, rules, viewer, dir);
    const leadOnceUsed = r.lead_extension_used && relationIsLead(viewer, r, dir);
    const canDecide = r.ext.status === 'pending' && r.ext.requested_by !== viewer.id && task.actions.includes('decide_extension') && !leadOnceUsed;
    return { ext: r.ext, task, canDecide };
  });
}

const relationIsLead = (viewer: DirUser, r: any, dir: Directory) => relation(viewer, r, dir) === 'lead';

const brief = (id: number | null, name: string | null) => (id ? { id, name } : null);

/**
 * TASK-05 detail (API_CONTRACTS §2.2). `people` names only the people on this task (never the directory). Comments
 * and updates are read from the log until comments get their own rows (T-4.10). `permissions` is the legacy set the
 * services still enforce until T-4.5…T-4.8 move them onto `actions`.
 */
/** One escalation event with its recipients' names (never contact details). */
const ESCALATION_SELECT = `select e.*, ab.name as acknowledged_by_name,
     coalesce((select json_agg(json_build_object('id', u.id, 'name', u.name, 'kind', er.kind) order by er.kind desc, u.name)
       from escalation_recipients er join users u on u.id = er.user_id where er.escalation_id = e.id), '[]') as recipients
     from escalations e left join users ab on ab.id = e.acknowledged_by`;

function escalationRow(e: any, viewer: DirUser) {
  const recipients = e.recipients as { id: number; name: string; kind: 'to' | 'cc' }[];
  return {
    id: e.id,
    level: e.level,
    reason: e.reason,
    firedAt: e.fired_at,
    reachedAt: e.reached_at,
    cycleStartedAt: e.cycle_started_at,
    clearedAt: e.cleared_at,
    lastAlertAt: e.last_alert_at,
    acknowledgedAt: e.acknowledged_at,
    acknowledgedBy: e.acknowledged_by_name,
    acknowledgedById: e.acknowledged_by,
    ackNote: e.ack_note,
    snoozeUntil: e.snooze_until,
    recipients,
    // ESC-06 (R-1): an open, unacknowledged event, for its "to" recipients or any Chief of Staff.
    canAcknowledge: !e.cleared_at && !e.acknowledged_at && (isCoS(viewer) || recipients.some((x) => x.id === viewer.id && x.kind === 'to')),
  };
}

/** ESC-06: the event as the acknowledgement answers it. The caller has already been authorized on its task. */
export async function escalationView(viewer: DirUser, escalationId: number) {
  const { rows } = await pool.query(`${ESCALATION_SELECT} where e.id = $1`, [escalationId]);
  return escalationRow(rows[0], viewer);
}

export const ESCALATION_STATUSES = ['open', 'active', 'acknowledged', 'resolved', 'all'] as const;
export interface EscalationFilters {
  status: (typeof ESCALATION_STATUSES)[number];
  level?: number;
  priority?: Priority;
  teamId?: number;
  assigneeId?: number;
}

/**
 * ESC-09: one row per visible task that has escalated, newest task first, capped. The Chief of Staff sees every task;
 * everyone else sees visible tasks not assigned to themselves. Names only, never contact details (ESC-09-AC-3).
 */
export async function escalationList(viewer: DirUser, dir: Directory, f: EscalationFilters) {
  if (!can(viewer, dir, 'view_tasks')) throw forbidden("You don't have permission to view escalations.");
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const params: unknown[] = [...vis.params];
  const p = (v: unknown) => (params.push(v), `$${params.length}`);
  const me = p(viewer.id);
  const where = [vis.sql, 'exists (select 1 from escalations x where x.task_id = t.id)'];
  if (!isCoS(viewer)) where.push(`t.assignee_id <> ${me}`);
  if (f.priority) where.push(`t.priority = ${p(f.priority)}`);
  if (f.teamId) where.push(`t.team_id = ${p(f.teamId)}`);
  if (f.assigneeId) where.push(`t.assignee_id = ${p(f.assigneeId)}`);
  const { rows: tasks } = await pool.query(
    `select ${TASK_COLUMNS} ${FACTS(me)} ${TASK_JOINS} where ${where.join(' and ')} order by t.id desc limit ${LIST_CAP + 1}`,
    params,
  );
  const shown = tasks.slice(0, LIST_CAP);
  const { rows: events } = await pool.query(`${ESCALATION_SELECT} where e.task_id = any($1) order by e.fired_at, e.level`, [shown.map((t) => t.id)]);
  const now = clock.now();
  const rules = await getRuleSet(viewer.organizationId);
  const rows = shown.map((r) => {
    const task = toTaskView(r, now, rules, viewer, dir);
    const evs = events.filter((e) => e.task_id === r.id).map((e) => escalationRow(e, viewer));
    const open = evs.filter((e) => !e.clearedAt).sort((a, b) => b.level - a.level);
    const top = open[0] ?? [...evs].sort((a, b) => b.level - a.level)[0]!;
    const status = !open.length ? 'resolved' : open.some((e) => !e.acknowledgedAt) ? 'active' : 'acknowledged';
    const ackEventId = open.find((e) => e.canAcknowledge)?.id ?? null;
    const next = task.levelInfo?.next;
    return {
      task,
      level: top.level,
      status,
      since: top.reachedAt ?? top.firedAt,
      recipients: top.recipients.map((x) => (x.kind === 'cc' ? `cc ${x.name}` : x.name)),
      nextLevel: open.length && next ? { level: next.level, at: next.at, label: LEVEL_LABELS[next.level] } : null,
      canAck: ackEventId !== null,
      ackEventId,
      events: evs,
    };
  });
  return {
    rows: rows.filter((x) => (f.status === 'all' || (f.status === 'open' ? x.status !== 'resolved' : x.status === f.status)) && (f.level === undefined || x.level === f.level)),
    truncated: tasks.length > LIST_CAP,
  };
}

export async function taskDetail(viewer: DirUser, dir: Directory, taskId: number) {
  const { rows } = await pool.query(`select ${TASK_COLUMNS} ${FACTS('$2')} ${TASK_JOINS} where t.id = $1`, [taskId, viewer.id]);
  const r = rows[0];
  if (!r || !canView(viewer, r, dir)) throw notFound('Task not found'); // same as missing, so ids never leak

  const [log, escalations, attachments, comments, assignments, reviews, extensions, family, recurrence, chain] = await Promise.all([
    pool.query(
      `select l.id, l.seq, l.at, l.kind, l.body, l.before, l.after, l.hash, l.prev_hash, l.actor_id, u.name as actor_name
         from activity_log l left join users u on u.id = l.actor_id where l.task_id = $1 order by l.seq`,
      [taskId],
    ),
    pool.query(`${ESCALATION_SELECT} where e.task_id = $1 order by e.fired_at desc, e.level desc`, [taskId]),
    pool.query(
      `select a.id, a.log_id, a.file_name, a.mime, a.size, a.sha256, a.uploaded_at, a.uploaded_by, a.context, a.comment_id, u.name as uploaded_by_name
         from attachments a join users u on u.id = a.uploaded_by where a.task_id = $1 and a.removed_at is null order by a.id`,
      [taskId],
    ),
    pool.query(
      `select c.id, c.author_id, c.parent_id, c.body, c.created_at, c.edited_at, c.deleted_at, u.name as author_name
         from comments c join users u on u.id = c.author_id where c.task_id = $1 order by c.created_at, c.id`,
      [taskId],
    ),
    pool.query(
      `select s.assigned_at, s.first_update_at, s.ended_at, s.assignee_id, u.name as assignee, s.assigned_by as assigned_by_id, b.name as assigned_by
         from assignments s join users u on u.id = s.assignee_id join users b on b.id = s.assigned_by
        where s.task_id = $1 order by s.assigned_at`,
      [taskId],
    ),
    pool.query('select * from reviews where task_id = $1 order by round', [taskId]),
    pool.query('select * from extensions where task_id = $1 order by requested_at', [taskId]),
    pool.query(
      `select t.id, t.title, t.status, t.parent_id from tasks t where (t.id = $2 or t.parent_id = $1) and ${visibilityFilter(viewer, dir, 't', 3).sql}`,
      [taskId, r.parent_id ?? 0, ...visibilityFilter(viewer, dir, 't', 3).params],
    ),
    r.recurring_id ? pool.query(
          `select id, title, frequency, "interval", weekdays, start_date::text as "startDate", end_date::text as "endDate", due_hour as "dueHour", active
             from recurring_tasks where id = $1`,
          [r.recurring_id],
        ) : null,
    verifyChains(pool, [taskId]),
  ]);

  const rules = await getRuleSet(viewer.organizationId);
  const now = clock.now();
  const task = toTaskView(r, now, rules, viewer, dir);
  const activities = log.rows.map((l) => ({
    id: l.id,
    seq: l.seq,
    at: l.at,
    kind: presentKind(l.kind),
    body: l.body,
    before: presentValues(l.before),
    after: presentValues(l.after),
    hash: l.hash,
    prevHash: l.prev_hash,
    actorId: l.actor_id,
    actor: brief(l.actor_id, l.actor_name),
  }));
  const escalationRows = escalations.rows.map((e) => escalationRow(e, viewer));

  // Only the people this task involves, by id.
  const people: Record<number, { id: number; name: string; title: string | null }> = {};
  const add = (id: number | null | undefined, name?: string | null) => {
    if (!id || people[id]) return;
    const u = dir.get(id);
    people[id] = { id, name: u?.name ?? name ?? '', title: u?.title ?? null };
  };
  [r.assignee_id, r.assigner_id, r.created_by, r.reviewer_id].forEach((id) => add(id));
  activities.forEach((a) => add(a.actorId, a.actor?.name));
  escalationRows.forEach((e) => (e.recipients.forEach((x) => add(x.id, x.name)), add(e.acknowledgedById, e.acknowledgedBy)));
  attachments.rows.forEach((a) => add(a.uploaded_by, a.uploaded_by_name));
  comments.rows.forEach((c) => add(c.author_id, c.author_name));
  assignments.rows.forEach((s) => (add(s.assignee_id, s.assignee), add(s.assigned_by_id, s.assigned_by)));

  return {
    task,
    actions: task.actions,
    permissions: taskPermissions(viewer, r, dir),
    activities,
    // CMT-03: a deleted comment keeps its place without its text; the original is in the log.
    comments: comments.rows.map((c) => ({ id: c.id, authorId: c.author_id, parentId: c.parent_id, body: c.deleted_at ? null : c.body, at: c.created_at, editedAt: c.edited_at, deleted: c.deleted_at !== null })),
    updates: activities.filter((a) => a.kind === 'progress').map((a) => ({ id: a.id, authorId: a.actorId, body: a.body, at: a.at, status: (a.after as any)?.status ?? null })),
    attachments: attachments.rows.map((a) => ({
      id: a.id,
      logId: a.log_id,
      fileName: a.file_name,
      mime: a.mime,
      size: a.size,
      sha256: a.sha256,
      uploadedAt: a.uploaded_at,
      uploadedBy: a.uploaded_by,
      context: a.context,
      commentId: a.comment_id,
    })),
    reviews: reviews.rows,
    extensions: extensions.rows,
    assignments: assignments.rows.map((s) => ({
      assigneeId: s.assignee_id,
      assignedById: s.assigned_by_id,
      assignedAt: s.assigned_at,
      firstUpdateAt: s.first_update_at,
      endedAt: s.ended_at,
    })),
    escalations: escalationRows,
    parent: family.rows.find((x) => x.id === r.parent_id) ?? null,
    children: family.rows.filter((x) => x.parent_id === r.id).map(({ id, title, status }) => ({ id, title, status })),
    recurrence: recurrence?.rows[0] ?? null,
    people,
    rules: rules.for(r.entity_id),
    chain: { ok: chain.ok, rows: chain.rowsChecked, breaks: chain.breaks },
  };
}

/** Used by services that need to know whether a task row is still open (lists, counts). */
export { isOpenStatus };
