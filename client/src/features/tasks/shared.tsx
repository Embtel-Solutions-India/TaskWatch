import { labelDepartments } from '@taskwatch/shared/permissions';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DAY, HOUR, PRIORITY_ORDER, STATUS_LABEL } from '../../constants';
import type { Column } from '../../components/DataTable';
import { Icon } from '../../components/icons';
import { Avatar, Button, ConfirmDialog, Dialog, Field, Input, LevelBadge, Menu, PriorityBadge, ProgressBar, Select, StatusBadge } from '../../components/ui';
import { useAction, useLocalState, useMe } from '../../hooks';
import { taskStage } from '@taskwatch/shared/insights';
import type { TaskView } from '../../services/api/base';
import { acknowledgeTask } from '../../services/api/tasks';
import { CancelDialog, DiscardDialog, ReassignDialog } from './TaskDialogs';
import { allowedActions } from '../../services/engine/workflow';
import { getDb, now } from '../../services/mock/store';
import type { Priority, Status } from '../../types';
import { ACTIVE_STATUSES, PRIORITIES, STATUSES } from '../../types';
import { cx, dueLabel, formatDateTime, formatShort, relative } from '../../utils/format';

export function TaskTitle({ t, sub = true }: { t: TaskView; sub?: boolean }) {
  const unack = ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt;
  return (
    <span className="task-title">
      <Link to={`/tasks/${t.id}`} className="task-link">
        {t.title}
      </Link>
      {sub && (t.recurrenceId || unack) && (
        <span className="task-sub">
          {t.recurrenceId && (
            <>
              <Icon name="repeat" size={11} /> recurring
            </>
          )}
          {t.recurrenceId && unack && ' · '}
          {unack && <span className="unack">not acknowledged</span>}
        </span>
      )}
    </span>
  );
}

export function DueCell({ t }: { t: TaskView }) {
  const open = ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted';
  const d = dueLabel(t.dueAt);
  return (
    <span className="due">
      <span>{formatShort(t.dueAt)}</span>
      {open && <small className={cx(d.overdue && 'tone-danger', d.soon && 'tone-warn')}>{d.overdue ? <><Icon name="alert" size={11} /> {d.text}</> : d.text}</small>}
    </span>
  );
}

export function Person({ name }: { name?: string }) {
  if (!name) return <span className="muted">—</span>;
  return (
    <span className="person">
      <Avatar name={name} size={20} />
      <span>{name}</span>
    </span>
  );
}

function RowActions({ t }: { t: TaskView }) {
  const user = useMe();
  const nav = useNavigate();
  const ack = useAction(acknowledgeTask, { success: `${t.id} acknowledged` });
  const [dialog, setDialog] = useState<'reassign' | 'cancel' | 'discard' | null>(null);
  const actions = t.actions ? new Set(t.actions) : allowedActions(getDb(), user, t); // server mode: computed by the server
  const close = () => setDialog(null);
  return (
    <>
      <Menu
        label={`Actions for ${t.id}`}
        items={[
          { label: 'Open', icon: 'external', onClick: () => nav(`/tasks/${t.id}`) },
          actions.has('acknowledge') ? { label: 'Acknowledge', icon: 'check', onClick: () => ack.run(t.id) } : null,
          actions.has('edit') ? { label: 'Edit', icon: 'edit', onClick: () => nav(`/tasks/${t.id}/edit`) } : null,
          // D-133: the giver's own actions, in every task list.
          actions.has('reassign') ? { label: 'Reassign', icon: 'users', onClick: () => setDialog('reassign') } : null,
          actions.has('discard')
            ? { label: 'Delete draft', icon: 'trash', danger: true, onClick: () => setDialog('discard') }
            : actions.has('cancel')
              ? { label: 'Cancel task', icon: 'x', danger: true, onClick: () => setDialog('cancel') }
              : null,
        ]}
      />
      {dialog === 'reassign' && <ReassignDialog task={t} onClose={close} />}
      {dialog === 'cancel' && <CancelDialog task={t} onClose={close} />}
      {dialog === 'discard' && <DiscardDialog task={t} onClose={close} />}
    </>
  );
}

const STAGE_LABEL = { on_track: 'On track', amber: 'Amber (L0–L1)', red: 'Red (L2–L3)' } as const;

/** TASK-10 stage stripe (D-49); none for closed and draft tasks. */
function StageStripe({ t }: { t: TaskView }) {
  const stage = taskStage(t.status, t.level);
  return stage ? <span className={`stage-stripe stage-${stage}`} role="img" aria-label={STAGE_LABEL[stage]} title={STAGE_LABEL[stage]} /> : null;
}

export function taskColumns(opts: { hideAssignee?: boolean; hideGiver?: boolean } = {}): Column<TaskView>[] {
  return [
    { id: 'stage', header: 'Stage', width: '64px', cell: (t) => <StageStripe t={t} />, sort: (t) => ['on_track', 'amber', 'red'].indexOf(taskStage(t.status, t.level) ?? '') },
    { id: 'id', header: 'ID', fixed: true, width: '88px', cell: (t) => <span className="mono">{t.id}</span>, sort: (t) => Number(t.id.split('-')[1]) },
    { id: 'title', header: 'Title', fixed: true, cell: (t) => <TaskTitle t={t} />, sort: (t) => t.title },
    { id: 'priority', header: 'Priority', width: '110px', cell: (t) => <PriorityBadge priority={t.priority} />, sort: (t) => PRIORITY_ORDER[t.priority] },
    { id: 'assignee', header: 'Assignee', defaultHidden: opts.hideAssignee, cell: (t) => <Person name={t.assignee?.name} />, sort: (t) => t.assignee?.name ?? '' },
    { id: 'giver', header: 'Task giver', defaultHidden: opts.hideGiver, cell: (t) => <Person name={t.giver?.name} />, sort: (t) => t.giver?.name ?? '' },
    { id: 'status', header: 'Status', width: '150px', cell: (t) => <StatusBadge status={t.status} />, sort: (t) => STATUSES.indexOf(t.status) },
    { id: 'progress', header: 'Progress', defaultHidden: true, width: '110px', cell: (t) => <ProgressBar value={t.progress} label={`${t.id} progress`} />, sort: (t) => t.progress },
    { id: 'due', header: 'Due', width: '150px', cell: (t) => <DueCell t={t} />, sort: (t) => t.dueAt },
    { id: 'updated', header: 'Last update', width: '120px', cell: (t) => <span title={formatDateTime(t.lastUpdateAt)}>{relative(t.lastUpdateAt)}</span>, sort: (t) => t.lastUpdateAt },
    { id: 'level', header: 'Escalation', width: '110px', cell: (t) => <LevelBadge level={t.level} acked={t.escalationAcked} />, sort: (t) => t.level },
    { id: 'team', header: 'Department', defaultHidden: true, cell: (t) => t.team?.name ?? '—', sort: (t) => t.team?.name ?? '' },
    { id: 'created', header: 'Created', defaultHidden: true, cell: (t) => formatShort(t.createdAt), sort: (t) => t.createdAt },
    { id: 'actions', header: 'Actions', fixed: true, width: '60px', cell: (t) => <RowActions t={t} /> },
  ];
}

/* ---------------- Filters ---------------- */

export interface TaskFilter {
  q: string;
  status: '' | 'open' | 'closed' | Status;
  priority: '' | Priority;
  assigneeId: string;
  giverId: string;
  teamId: string;
  due: '' | 'overdue' | 'today' | 'week' | 'later';
  level: '' | 'any' | 'none' | '0' | '1' | '2' | '3';
  created: '' | '7d' | '30d' | '90d';
  updated: '' | '24h' | '7d' | 'stale';
}

export const EMPTY_FILTER: TaskFilter = { q: '', status: 'open', priority: '', assigneeId: '', giverId: '', teamId: '', due: '', level: '', created: '', updated: '' };

export function applyFilter(rows: TaskView[], f: TaskFilter): TaskView[] {
  const n = now();
  const eod = new Date(n);
  eod.setHours(23, 59, 59, 999);
  const q = f.q.trim().toLowerCase();
  return rows.filter((t) => {
    if (q && !(t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.assignee?.name.toLowerCase().includes(q) || t.giver?.name.toLowerCase().includes(q))) return false;
    const open = ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted' || t.status === 'draft';
    if (f.status === 'open' && !open) return false;
    if (f.status === 'closed' && open) return false;
    if (f.status && f.status !== 'open' && f.status !== 'closed' && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.assigneeId && t.assigneeId !== f.assigneeId) return false;
    if (f.giverId && t.assignedBy !== f.giverId) return false;
    if (f.teamId && t.teamId !== f.teamId) return false;
    const due = Date.parse(t.dueAt);
    if (f.due === 'overdue' && !t.overdue) return false;
    if (f.due === 'today' && (due > eod.getTime() || t.overdue)) return false;
    if (f.due === 'week' && (due > n + 7 * DAY || t.overdue)) return false;
    if (f.due === 'later' && due <= n + 7 * DAY) return false;
    if (f.level === 'any' && t.level < 0) return false;
    if (f.level === 'none' && t.level >= 0) return false;
    if (['0', '1', '2', '3'].includes(f.level) && t.level !== Number(f.level)) return false;
    const created = Date.parse(t.createdAt);
    if (f.created && created < n - { '7d': 7, '30d': 30, '90d': 90 }[f.created] * DAY) return false;
    const upd = Date.parse(t.lastUpdateAt);
    if (f.updated === '24h' && upd < n - 24 * HOUR) return false;
    if (f.updated === '7d' && upd < n - 7 * DAY) return false;
    if (f.updated === 'stale' && (t.levelInfo?.silenceLevel ?? -1) < 0) return false;
    return true;
  });
}

export function activeFilterCount(f: TaskFilter): number {
  return (Object.keys(f) as (keyof TaskFilter)[]).filter((k) => k !== 'q' && f[k] !== EMPTY_FILTER[k]).length;
}

export function TaskFilters({ value, onChange, rows, showAssignee = true, showGiver = true }: { value: TaskFilter; onChange: (f: TaskFilter) => void; rows: TaskView[]; showAssignee?: boolean; showGiver?: boolean }) {
  const set = <K extends keyof TaskFilter>(k: K, v: TaskFilter[K]) => onChange({ ...value, [k]: v });
  const people = (pick: (t: TaskView) => { id: string; name: string } | undefined) => [...new Map(rows.map((t) => pick(t)).filter(Boolean).map((p) => [p!.id, p!.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const teams = labelDepartments([...new Map(rows.filter((t) => t.team).map((t) => [t.team!.id, t.team!])).values()], (t) => t.departmentId)
    .map((t) => [t.id, t.name] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));
  return (
    <div className="filters" role="search" aria-label="Filter tasks">
      <div className="filter-search">
        <Icon name="search" size={14} />
        <Input aria-label="Search tasks" placeholder="Search ID, title, person…" value={value.q} onChange={(e) => set('q', e.target.value)} />
      </div>
      <Select aria-label="Status" value={value.status} onChange={(e) => set('status', e.target.value as TaskFilter['status'])}>
        <option value="">All statuses</option>
        <option value="open">Open (any)</option>
        <option value="closed">Closed (any)</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </Select>
      <Select aria-label="Priority" value={value.priority} onChange={(e) => set('priority', e.target.value as Priority | '')}>
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p[0]!.toUpperCase() + p.slice(1)}
          </option>
        ))}
      </Select>
      {showAssignee && (
        <Select aria-label="Assignee" value={value.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
          <option value="">Any assignee</option>
          {people((t) => t.assignee).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      )}
      {showGiver && (
        <Select aria-label="Task giver" value={value.giverId} onChange={(e) => set('giverId', e.target.value)}>
          <option value="">Any task giver</option>
          {people((t) => t.giver).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      )}
      {teams.length > 1 && (
        <Select aria-label="Department" value={value.teamId} onChange={(e) => set('teamId', e.target.value)}>
          <option value="">Any department</option>
          {teams.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      )}
      <Select aria-label="Due date" value={value.due} onChange={(e) => set('due', e.target.value as TaskFilter['due'])}>
        <option value="">Any due date</option>
        <option value="overdue">Overdue</option>
        <option value="today">Due today</option>
        <option value="week">Due in 7 days</option>
        <option value="later">Due later</option>
      </Select>
      <Select aria-label="Escalation level" value={value.level} onChange={(e) => set('level', e.target.value as TaskFilter['level'])}>
        <option value="">Any escalation</option>
        <option value="any">Escalated (L0+)</option>
        <option value="none">On track</option>
        <option value="0">L0</option>
        <option value="1">L1</option>
        <option value="2">L2</option>
        <option value="3">L3</option>
      </Select>
      <Select aria-label="Created" value={value.created} onChange={(e) => set('created', e.target.value as TaskFilter['created'])}>
        <option value="">Created any time</option>
        <option value="7d">Created last 7 days</option>
        <option value="30d">Created last 30 days</option>
        <option value="90d">Created last 90 days</option>
      </Select>
      <Select aria-label="Last updated" value={value.updated} onChange={(e) => set('updated', e.target.value as TaskFilter['updated'])}>
        <option value="">Updated any time</option>
        <option value="24h">Updated in 24 h</option>
        <option value="7d">Updated in 7 days</option>
        <option value="stale">Update overdue</option>
      </Select>
      {activeFilterCount(value) > 0 || value.q ? (
        <Button size="sm" variant="ghost" icon="x" onClick={() => onChange({ ...EMPTY_FILTER, status: '' })}>
          Clear
        </Button>
      ) : null}
    </div>
  );
}

export interface SavedView {
  name: string;
  filter: TaskFilter;
}

export function SavedViews({ scope, value, onApply }: { scope: string; value: TaskFilter; onApply: (f: TaskFilter) => void }) {
  const user = useMe();
  const [views, setViews] = useLocalState<SavedView[]>(`views.${user.id}.${scope}`, []);
  // App dialogs instead of the browser's prompt()/confirm() boxes, so every question looks the same.
  const [ask, setAsk] = useState<'name' | 'clear' | null>(null);
  const [name, setName] = useState('');
  const saveView = () => {
    const n = name.trim();
    if (!n) return;
    setViews([...views.filter((v) => v.name !== n), { name: n, filter: value }]);
    setAsk(null);
  };
  return (
    <>
      <Menu
        label="Saved views"
        icon="layers"
        buttonLabel="Views"
        items={[
          ...views.map((v) => ({ label: v.name, icon: 'filter', onClick: () => onApply(v.filter) })),
          { label: 'Save current filters…', icon: 'plus', onClick: () => (setName(''), setAsk('name')) },
          views.length ? { label: 'Delete all saved views', icon: 'trash', danger: true, onClick: () => setAsk('clear') } : null,
        ]}
      />
      <Dialog
        open={ask === 'name'}
        onClose={() => setAsk(null)}
        size="sm"
        title="Save this view"
        footer={<><Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button><Button variant="primary" type="submit" form="f-view" disabled={!name.trim()}>Save view</Button></>}
      >
        <form id="f-view" noValidate onSubmit={(e) => (e.preventDefault(), saveView())}>
          <Field label="Name" htmlFor="view-name" hint="A view with the same name is replaced.">
            <Input id="view-name" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
        </form>
      </Dialog>
      <ConfirmDialog open={ask === 'clear'} onClose={() => setAsk(null)} onConfirm={() => (setViews([]), setAsk(null))} title="Delete all saved views?" confirmLabel="Delete all" danger>
        <p>Every saved view for this list is removed from this browser.</p>
      </ConfirmDialog>
    </>
  );
}
