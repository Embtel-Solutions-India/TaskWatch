import { labelDepartments } from '@taskwatch/shared/permissions';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LEVEL_LABEL, PRIORITY_LABEL, PRIORITY_ORDER } from '../../constants';
import { DataTable } from '../../components/DataTable';
import { Button, Empty, ErrorState, LevelBadge, PageHeader, PriorityBadge, Segmented, Select, Stat, Tag } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { listEscalations, type EscalationRow } from '../../services/api/admin';
import { AckEscalationDialog } from '../tasks/TaskDialogs';
import { PRIORITIES } from '../../types';
import { downloadCsv, formatShort, hoursLabel, relative } from '../../utils/format';
import { Person } from '../tasks/shared';

type Row = EscalationRow;

export function EscalationsPage() {
  const user = useMe();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = useApi(['escalations', user.id], listEscalations);
  const [acking, setAcking] = useState<Row | null>(null);
  const [status, setStatus] = useState<'open' | 'active' | 'acknowledged' | 'resolved' | 'all'>('open');
  const [priority, setPriority] = useState('');
  const [team, setTeam] = useState('');
  const [assignee, setAssignee] = useState('');
  const level = params.get('level') ?? '';

  const rows = q.data ?? [];
  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (status === 'all' || (status === 'open' ? r.status !== 'resolved' : r.status === status)) &&
          (!priority || r.task.priority === priority) &&
          (!team || r.task.teamId === team) &&
          (!assignee || r.task.assigneeId === assignee) &&
          (!level || r.level === Number(level)),
      ),
    [rows, status, priority, team, assignee, level],
  );
  const open = rows.filter((r) => r.status !== 'resolved');
  const teams = labelDepartments([...new Map(rows.flatMap((r) => (r.task.team ? [[r.task.team.id, r.task.team] as const] : []))).values()], (t) => t.departmentId)
    .map((t) => [t.id, t.name] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));

  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="page">
      <PageHeader
        title="Escalations"
        description="Tasks that crossed a silence or past-due threshold in your scope. Acknowledging (with a note) pauses repeat alerts at that level; it never lowers the level or resets the clock."
        actions={
          <Button
            icon="download"
            disabled={!filtered.length}
            onClick={() =>
              downloadCsv('taskwatch-escalations.csv', [
                ['Task', 'Title', 'Priority', 'Assignee', 'Task giver', 'Level', 'Status', 'Since', 'Overdue hours', 'Last update', 'Next escalation', 'Recipients'],
                ...filtered.map((r) => [r.task.id, r.task.title, PRIORITY_LABEL[r.task.priority], r.task.assignee?.name, r.task.giver?.name, `L${r.level}`, r.status, r.since, Math.round(r.task.levelInfo?.overdueHours ?? 0), r.task.lastUpdateAt, r.nextLevel ? `${r.nextLevel.label} ${r.nextLevel.at}` : '', r.recipients.join('; ')]),
              ])
            }
          >
            Export CSV
          </Button>
        }
      />
      <div className="stats">
        {[0, 1, 2, 3].map((l) => (
          <Stat key={l} label={LEVEL_LABEL[l]!} value={open.filter((r) => r.level === l).length} tone={l >= 2 && open.some((r) => r.level === l) ? 'danger' : l === 1 && open.some((r) => r.level === 1) ? 'warn' : undefined} hint={`${open.filter((r) => r.level === l && r.status === 'active').length} unacknowledged`} />
        ))}
      </div>
      <DataTable<Row>
        caption="Escalations"
        storageKey="escalations"
        rows={filtered}
        loading={q.isLoading}
        rowKey={(r) => r.task.id}
        onRowClick={(r) => nav(`/tasks/${r.task.id}`)}
        initialSort={{ id: 'level', dir: 'desc' }}
        toolbar={
          <div className="filters">
            <Segmented
              label="Escalation status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'open', label: 'Open', count: open.length },
                { value: 'active', label: 'Active', count: rows.filter((r) => r.status === 'active').length },
                { value: 'acknowledged', label: 'Acknowledged', count: rows.filter((r) => r.status === 'acknowledged').length },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Select aria-label="Level" value={level} onChange={(e) => setParams(e.target.value ? { level: e.target.value } : {})}>
              <option value="">Any level</option>
              {[0, 1, 2, 3].map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABEL[l]}
                </option>
              ))}
            </Select>
            <Select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
            <Select aria-label="Department" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Any department</option>
              {teams.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </Select>
            <Select aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Any assignee</option>
              {[...new Map(rows.map((r) => [r.task.assigneeId, r.task.assignee?.name ?? ''])).entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </Select>
          </div>
        }
        columns={[
          { id: 'task', header: 'Task', fixed: true, cell: (r) => <span className="task-title"><Link to={`/tasks/${r.task.id}`} className="task-link">{r.task.title}</Link><span className="task-sub mono">{r.task.id}</span></span>, sort: (r) => r.task.id },
          { id: 'priority', header: 'Priority', cell: (r) => <PriorityBadge priority={r.task.priority} />, sort: (r) => PRIORITY_ORDER[r.task.priority] },
          { id: 'assignee', header: 'Assignee', cell: (r) => <Person name={r.task.assignee?.name} />, sort: (r) => r.task.assignee?.name ?? '' },
          { id: 'giver', header: 'Task giver', defaultHidden: true, cell: (r) => <Person name={r.task.giver?.name} />, sort: (r) => r.task.giver?.name ?? '' },
          { id: 'level', header: 'Level', cell: (r) => <LevelBadge level={r.level} acked={r.status === 'acknowledged'} long />, sort: (r) => r.level },
          { id: 'overdue', header: 'Time overdue', cell: (r) => (r.task.overdue ? <span className="tone-danger">{hoursLabel(r.task.levelInfo?.overdueHours ?? 0)}</span> : <span className="muted">Not overdue</span>), sort: (r) => r.task.levelInfo?.overdueHours ?? 0 },
          { id: 'update', header: 'Last update', cell: (r) => relative(r.task.lastUpdateAt), sort: (r) => r.task.lastUpdateAt },
          { id: 'next', header: 'Next escalation', cell: (r) => (r.status === 'resolved' ? '—' : r.nextLevel ? <span title={formatShort(r.nextLevel.at)}>L{r.nextLevel.level} {relative(r.nextLevel.at)}</span> : <span className="muted">Top level</span>), sort: (r) => r.nextLevel?.at ?? 'z' },
          { id: 'recipient', header: 'Recipient', cell: (r) => (
            // One line: first recipient + count; the full list is in the tooltip (and the CSV).
            <span className="nowrap" title={r.recipients.join(', ')}>
              {r.recipients[0] ?? '—'}
              {r.recipients.length > 1 && <span className="muted"> +{r.recipients.length - 1}</span>}
            </span>
          ), sort: (r) => r.recipients.join() },
          { id: 'status', header: 'Status', cell: (r) => <Tag tone={r.status === 'active' ? 'danger' : r.status === 'acknowledged' ? 'warn' : 'ok'}>{r.status === 'active' ? 'Active' : r.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}</Tag>, sort: (r) => r.status },
          {
            id: 'actions',
            header: 'Actions',
            fixed: true,
            cell: (r) => (r.canAck && r.status === 'active' ? <Button size="sm" onClick={(e) => (e.stopPropagation(), setAcking(r))}>Acknowledge</Button> : null),
          },
        ]}
        empty={<Empty icon="shield" title="No escalations match">Everything in your scope is within its update window and due date.</Empty>}
      />
      {acking && <AckEscalationDialog task={acking.task} eventId={acking.ackEventId ?? undefined} onClose={() => setAcking(null)} />}
    </div>
  );
}
