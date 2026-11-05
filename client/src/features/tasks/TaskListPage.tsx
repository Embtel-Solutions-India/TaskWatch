import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PRIORITY_LABEL, STATUS_LABEL } from '../../constants';
import { DataTable } from '../../components/DataTable';
import { Button, Empty, ErrorState, Field, Dialog, PageHeader, Segmented, Textarea } from '../../components/ui';
import { useAction, useApi, useCan, useLocalState, useMe } from '../../hooks';
import { bulkAcknowledge, bulkCancel, listTasks, type TaskScope } from '../../services/api/tasks';
import { ACTIVE_STATUSES } from '../../types';
import { downloadCsv } from '../../utils/format';
import { applyFilter, EMPTY_FILTER, SavedViews, taskColumns, TaskFilters, type TaskFilter } from './shared';

const META: Record<TaskScope, { title: string; description: string }> = {
  mine: { title: 'My Tasks', description: 'Work assigned to you. Post progress updates to keep each task inside its update window.' },
  assigned_by_me: { title: 'Assigned by Me', description: 'Tasks you created or assigned, including drafts.' },
  team: { title: 'Team Tasks', description: 'Everything assigned to people in your reporting line.' },
  all: { title: 'All Tasks', description: 'Every task in the organization.' },
};

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
  const [quick, setQuick] = useState<'all' | 'attention' | 'review'>('all');
  const [cancelIds, setCancelIds] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const cancel = useAction(bulkCancel, {
    success: (r) => `Cancelled ${r.done.length} task(s)${r.skipped.length ? `; ${r.skipped.length} skipped (not permitted or already closed)` : ''}.`,
    onSuccess: () => (setCancelIds(null), setReason('')),
  });
  const ack = useAction(bulkAcknowledge, { success: (r) => `Acknowledged ${r.done.length} task(s)${r.skipped.length ? `; ${r.skipped.length} skipped` : ''}.` });

  const rows = q.data ?? [];
  const filtered = useMemo(() => {
    let r = applyFilter(rows, filter);
    if (quick === 'attention') r = r.filter((t) => t.overdue || t.level >= 0 || (ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt));
    if (quick === 'review') r = r.filter((t) => t.status === 'submitted' || t.status === 'changes_requested');
    return r;
  }, [rows, filter, quick]);
  const attention = applyFilter(rows, filter).filter((t) => t.overdue || t.level >= 0 || (ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt)).length;

  const meta = META[scope];
  const exportRows = (ids?: string[]) => {
    const list = ids ? filtered.filter((t) => ids.includes(t.id)) : filtered;
    downloadCsv(`taskwatch-${scope}-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Task ID', 'Title', 'Priority', 'Status', 'Assignee', 'Task giver', 'Team', 'Due', 'Last update', 'Escalation level', 'Progress %'],
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
              options={[
                { value: 'all', label: 'All', count: applyFilter(rows, filter).length },
                { value: 'attention', label: 'Needs attention', count: attention },
                { value: 'review', label: 'In review', count: applyFilter(rows, filter).filter((t) => t.status === 'submitted' || t.status === 'changes_requested').length },
              ]}
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
