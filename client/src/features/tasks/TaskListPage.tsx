import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PRIORITY_LABEL, STATUS_LABEL } from '../../constants';
import { DataTable } from '../../components/DataTable';
import { Button, Empty, ErrorState, Field, Dialog, PageHeader, Segmented, Stat, Textarea } from '../../components/ui';
import { useAction, useApi, useCan, useLocalState, useMe } from '../../hooks';
import { bulkAcknowledge, bulkCancel, listTasks, type TaskScope } from '../../services/api/tasks';
import { taskStage } from '@taskwatch/shared/insights';
import type { TaskView } from '../../services/api/base';
import { ACTIVE_STATUSES } from '../../types';
import { downloadCsv } from '../../utils/format';
import { applyFilter, EMPTY_FILTER, SavedViews, taskColumns, TaskFilters, type TaskFilter } from './shared';

const META: Record<TaskScope, { title: string; description: string }> = {
  mine: { title: 'My Tasks', description: 'Work assigned to you. Post progress updates to keep each task inside its update window.' },
  assigned_by_me: { title: 'Assigned by Me', description: 'Tasks you created or assigned, including drafts.' },
  team: { title: 'Team Tasks', description: 'Everything assigned to people in your reporting line.' },
  all: { title: 'All Tasks', description: 'Every task in the organization.' },
};

const isOpen = (t: TaskView) => t.status !== 'draft' && t.status !== 'completed' && t.status !== 'cancelled';
/** Quick views: the WO FR-10 views (TASK-09) plus the prototype's own (kept, D-20). */
const QUICK = {
  all: { label: 'All', test: () => true },
  open: { label: 'All open', test: isOpen },
  escalated: { label: 'Escalated to me', test: (t: TaskView) => isOpen(t) && !!t.escalatedToMe },
  red: { label: 'Red', test: (t: TaskView) => isOpen(t) && t.level >= 2 },
  blocked: { label: 'Blocked', test: (t: TaskView) => t.status === 'blocked' },
  closed: { label: 'Closed', test: (t: TaskView) => t.status === 'completed' || t.status === 'cancelled' },
  attention: { label: 'Needs attention', test: (t: TaskView) => t.overdue || t.level >= 0 || (ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt) },
  review: { label: 'In review', test: (t: TaskView) => t.status === 'submitted' || t.status === 'changes_requested' },
} as const;
type Quick = keyof typeof QUICK;

export function TaskListPage({ scope }: { scope: TaskScope }) {
  const user = useMe();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const canCreate = useCan('create_tasks');
  const q = useApi(['tasks', scope, user.id], () => listTasks(scope));
  const [stored, setStored] = useLocalState<TaskFilter>(`filter.${user.id}.${scope}`, EMPTY_FILTER);
  // URL params (from search, dashboards, notifications) take priority on first load.
  const [filter, setFilterState] = useState<TaskFilter>(() => ({
    ...stored,
    ...(params.get('team') ? { teamId: params.get('team')!, status: 'open' as const } : {}),
    ...(params.get('due') ? { due: params.get('due') as TaskFilter['due'] } : {}),
    ...(params.get('assignee') ? { assigneeId: params.get('assignee')!, status: 'open' as const } : {}),
    ...(params.get('level') ? { level: params.get('level') as TaskFilter['level'] } : {}),
    ...(params.get('status') ? { status: params.get('status') as TaskFilter['status'] } : {}),
  }));
  const setFilter = (f: TaskFilter) => {
    setFilterState(f);
    setStored(f);
  };
  const [quick, setQuick] = useState<Quick>(() => {
    const v = params.get('view');
    return v && Object.hasOwn(QUICK, v) ? (v as Quick) : 'all';
  });
  const [cancelIds, setCancelIds] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const cancel = useAction(bulkCancel, {
    success: (r) => `Cancelled ${r.done.length} task(s)${r.skipped.length ? `; ${r.skipped.length} skipped (not permitted or already closed)` : ''}.`,
    onSuccess: () => (setCancelIds(null), setReason('')),
  });
  const ack = useAction(bulkAcknowledge, { success: (r) => `Acknowledged ${r.done.length} task(s)${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}.` });

  const rows = q.data ?? [];
  const filtered = useMemo(() => {
    return applyFilter(rows, filter).filter(QUICK[quick].test);
  }, [rows, filter, quick]);
  const base = applyFilter(rows, filter);
  // TASK-10 summary tiles over this list's tasks, so every figure matches the rows below.
  const open = rows.filter(isOpen);
  const stageCount = (s: string) => open.filter((t) => taskStage(t.status, t.level) === s).length;

  const meta = META[scope];
  const exportRows = (ids?: string[]) => {
    const list = ids ? filtered.filter((t) => ids.includes(t.id)) : filtered;
    downloadCsv(`taskwatch-${scope}-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Task ID', 'Title', 'Priority', 'Status', 'Assignee', 'Task giver', 'Department', 'Due', 'Last update', 'Escalation level', 'Progress %'],
      ...list.map((t) => [t.id, t.title, PRIORITY_LABEL[t.priority], STATUS_LABEL[t.status], t.assignee?.name, t.giver?.name, t.team?.name, t.dueAt, t.lastUpdateAt, t.level >= 0 ? `L${t.level}` : 'On track', t.progress]),
    ]);
  };

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="page">
      <PageHeader
        title={meta.title}
        description={meta.description}
        actions={
          <>
            <SavedViews scope={scope} value={filter} onApply={setFilter} />
            <Button icon="download" onClick={() => exportRows()} disabled={!filtered.length}>
              Export CSV
            </Button>
            {canCreate && scope !== 'mine' && (
              <Link to="/tasks/new" className="btn btn-primary">
                New task
              </Link>
            )}
          </>
        }
      />
      <div className="stats" aria-label="Summary">
        <Stat label="Open" value={open.length} />
        <Stat label="On track" value={stageCount('on_track')} tone="ok" />
        <Stat label="Amber (L0–L1)" value={stageCount('amber')} tone={stageCount('amber') ? 'warn' : undefined} />
        <Stat label="Red (L2–L3)" value={stageCount('red')} tone={stageCount('red') ? 'danger' : undefined} />
        <Stat label="Blocked" value={rows.filter(QUICK.blocked.test).length} />
        <Stat label="Escalated to me" value={rows.filter(QUICK.escalated.test).length} />
      </div>
      <DataTable
        caption={meta.title}
        storageKey={`tasks.${scope}`}
        rows={filtered}
        loading={q.isLoading}
        rowKey={(t) => t.id}
        columns={taskColumns({ hideAssignee: scope === 'mine', hideGiver: scope === 'assigned_by_me' })}
        initialSort={{ id: 'due', dir: 'asc' }}
        onRowClick={(t) => nav(`/tasks/${t.id}`)}
        selectable
        toolbar={
          <div className="stack-sm">
            <Segmented
              label="Quick filter"
              value={quick}
              onChange={setQuick}
              options={(Object.keys(QUICK) as Quick[]).map((k) => ({ value: k, label: QUICK[k].label, count: base.filter(QUICK[k].test).length }))}
            />
            <TaskFilters value={filter} onChange={setFilter} rows={rows} showAssignee={scope !== 'mine'} showGiver={scope !== 'assigned_by_me'} />
          </div>
        }
        bulkBar={(ids, clear) => (
          <>
            {scope === 'mine' && (
              <Button size="sm" icon="check" loading={ack.pending} onClick={() => (ack.run(ids), clear())}>
                Acknowledge
              </Button>
            )}
            <Button size="sm" icon="download" onClick={() => exportRows(ids)}>
              Export
            </Button>
            {scope !== 'mine' && canCreate && (
              <Button size="sm" variant="danger" icon="x" onClick={() => setCancelIds(ids)}>
                Cancel tasks
              </Button>
            )}
          </>
        )}
        empty={
          rows.length === 0 ? (
            <Empty icon="check-square" title={scope === 'mine' ? 'No tasks assigned to you' : 'No tasks yet'} action={canCreate && scope !== 'mine' ? <Link to="/tasks/new" className="btn btn-primary">Create a task</Link> : undefined}>
              {scope === 'mine' ? 'When someone assigns you work, it will appear here.' : 'Tasks will appear here once they are created.'}
            </Empty>
          ) : (
            <Empty icon="filter" title="No tasks match these filters" action={<Button onClick={() => (setFilter({ ...EMPTY_FILTER, status: '' }), setQuick('all'))}>Clear filters</Button>} />
          )
        }
      />
      <Dialog
        open={!!cancelIds}
        onClose={() => setCancelIds(null)}
        title={`Cancel ${cancelIds?.length ?? 0} task(s)?`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelIds(null)}>
              Keep tasks
            </Button>
            <Button variant="danger" loading={cancel.pending} onClick={() => cancel.run(cancelIds!, reason)}>
              Cancel tasks
            </Button>
          </>
        }
      >
        <p>Tasks you are not permitted to cancel, or that are already closed, will be skipped. History is preserved.</p>
        <Field label="Reason" required error={cancel.fields.reason} htmlFor="bulk-reason">
          <Textarea id="bulk-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!cancel.fields.reason} />
        </Field>
      </Dialog>
    </div>
  );
}
