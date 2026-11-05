import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '../../constants';
import { BarList, ColumnChart, Donut, LineChart } from '../../components/charts';
import { Icon } from '../../components/icons';
import { Banner, Button, Card, Empty, ErrorState, Field, Input, PageHeader, Select, Skeleton, Stat } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { getReport, reportScope, type Report, type ReportFilters } from '../../services/api/misc';
import { getDb, now } from '../../services/mock/store';
import { PRIORITIES, STATUSES } from '../../types';
import { downloadCsv, formatShort, pct, toDateInput } from '../../utils/format';

interface Def {
  id: string;
  title: string;
  question: string;
  icon: string;
}
const REPORTS: Def[] = [
  { id: 'completion', title: 'Task Completion', question: 'How much work gets finished, and on time?', icon: 'circle-check' },
  { id: 'overdue', title: 'Overdue Tasks', question: 'What is late right now, and where?', icon: 'alert' },
  { id: 'escalations', title: 'Escalations', question: 'How often do tasks climb the ladder, and how far?', icon: 'zap' },
  { id: 'accountability', title: 'Staff Accountability', question: 'Is each person keeping their work updated and on time?', icon: 'user' },
  { id: 'teams', title: 'Team Performance', question: 'How do teams compare on delivery and risk?', icon: 'users' },
  { id: 'assignments', title: 'Task Assignment', question: 'Who assigns work, and how is it distributed?', icon: 'send' },
  { id: 'compliance', title: 'Task Update Compliance', question: 'Are assignees posting updates within the required window?', icon: 'clock' },
  { id: 'reviews', title: 'Review Turnaround', question: 'How quickly are submissions reviewed?', icon: 'review' },
  { id: 'extensions', title: 'Due-Date Extensions', question: 'How often are deadlines moved, and why?', icon: 'calendar' },
];

const DEFINITIONS: Record<string, string> = {
  'Completion rate': 'Completed ÷ tasks created in the date range (historical).',
  'On-time rate': 'Completed on or before the (latest approved) due date ÷ completed.',
  'Open now': 'Current workload: tasks open right now, regardless of the date range.',
  'Overdue now': 'Current: open tasks past their due date.',
  'Update compliance': "Current: active tasks whose assignee updated within the priority's window ÷ active tasks.",
  Escalations: 'L1+ escalation events that fired within the date range.',
  'Avg review time': 'Hours from submission to decision, for decisions on submissions made within the range.',
};

export function ReportsIndexPage() {
  const scope = reportScope();
  return (
    <div className="page">
      <PageHeader title="Accountability Reports" description={scope === 'org' ? 'Organization-wide reports.' : 'Reports scoped to your reporting line.'} />
      <div className="report-grid">
        {REPORTS.map((r) => (
          <Link key={r.id} to={`/reports/${r.id}`} className="report-tile">
            <span className="report-icon">
              <Icon name={r.icon} size={18} />
            </span>
            <strong>{r.title}</strong>
            <span className="muted small">{r.question}</span>
            <span className="link-more">
              Open <Icon name="arrow" size={12} />
            </span>
          </Link>
        ))}
      </div>
      <Card title="Metric definitions" sub="Historical metrics use the date range; current-workload metrics do not.">
        <dl className="defs">
          {Object.entries(DEFINITIONS).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

export function ReportPage() {
  const { reportId = '' } = useParams();
  const user = useMe();
  const def = REPORTS.find((r) => r.id === reportId);
  const db = getDb();
  const [f, setF] = useState<ReportFilters>(() => ({ from: toDateInput(now() - 30 * 86_400_000), to: toDateInput(now()), teamId: '', userId: '', giverId: '', priority: '', status: '', level: '' }));
  const q = useApi(['report', user.id, JSON.stringify(f)], () => getReport(f));
  const set = <K extends keyof ReportFilters>(k: K, v: ReportFilters[K]) => setF((x) => ({ ...x, [k]: v }));
  if (!def) return <ErrorState error={{ status: 404, message: 'Unknown report.' }} />;
  if (q.error) return <ErrorState error={q.error} />;
  const r = q.data;
  const people = db.users.filter((u) => u.status === 'active');
  return (
    <div className="page">
      <PageHeader title={`${def.title} report`} description={def.question} actions={r && <Button icon="download" onClick={() => exportReport(def.id, r)}>Export CSV</Button>} />
      <div className="report-filters card">
        <Field label="From" htmlFor="rf-from">
          <Input id="rf-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} className="input-sm" />
        </Field>
        <Field label="To" htmlFor="rf-to">
          <Input id="rf-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} className="input-sm" />
        </Field>
        <Field label="Team" htmlFor="rf-team">
          <Select id="rf-team" value={f.teamId} onChange={(e) => set('teamId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {db.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Staff member" htmlFor="rf-user">
          <Select id="rf-user" value={f.userId} onChange={(e) => set('userId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Task giver" htmlFor="rf-giver">
          <Select id="rf-giver" value={f.giverId} onChange={(e) => set('giverId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {people.filter((u) => u.role !== 'staff').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="rf-pr">
          <Select id="rf-pr" value={f.priority} onChange={(e) => set('priority', e.target.value as ReportFilters['priority'])} className="input-sm">
            <option value="">All</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </Select>
        </Field>
        <Field label="Status" htmlFor="rf-st">
          <Select id="rf-st" value={f.status} onChange={(e) => set('status', e.target.value as ReportFilters['status'])} className="input-sm">
            <option value="">All</option>
            {STATUSES.filter((s) => s !== 'draft').map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </Select>
        </Field>
        <Field label="Escalation" htmlFor="rf-lv">
          <Select id="rf-lv" value={f.level} onChange={(e) => set('level', e.target.value)} className="input-sm">
            <option value="">All</option>
            <option value="none">On track</option>
            {[0, 1, 2, 3].map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
          </Select>
        </Field>
      </div>
      {!r ? (
        <Skeleton rows={10} />
      ) : (
        <>
          {r.scope === 'team' && <Banner tone="info">Scoped to your reporting line. People outside it are not included even if selected.</Banner>}
          <div className="stats">
            <Stat label="Completion rate" value={pct(r.summary.completionRate)} hint={`${r.summary.completed} of ${r.summary.created} created`} help={DEFINITIONS['Completion rate']} />
            <Stat label="On-time rate" value={pct(r.summary.onTimeRate)} help={DEFINITIONS['On-time rate']} />
            <Stat label="Open now" value={r.summary.openNow} hint="current workload" help={DEFINITIONS['Open now']} />
            <Stat label="Overdue now" value={r.summary.overdueNow} tone={r.summary.overdueNow ? 'danger' : undefined} help={DEFINITIONS['Overdue now']} />
            <Stat label="Update compliance" value={pct(r.summary.compliance)} help={DEFINITIONS['Update compliance']} />
            <Stat label="Escalations (L1+)" value={r.summary.escalations} help={DEFINITIONS.Escalations} />
          </div>
          <ReportBody id={def.id} r={r} />
        </>
      )}
    </div>
  );
}

function T({ head, rows, empty = 'No data for these filters.' }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <Empty icon="chart" title={empty} />;
  return (
    <div className="table-scroll">
      <table className="table compact">
        <thead>
          <tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((c, j) => <td key={j} data-label={String(head[j] ?? '')}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportBody({ id, r }: { id: string; r: Report }) {
  const weeks = r.weeks.map((w) => w.label);
  const trend = <Card title="Created vs completed" sub="Per week in range"><ColumnChart categories={weeks} series={[{ name: 'Created', values: r.weeks.map((w) => w.created), tone: 'series-1' }, { name: 'Completed', values: r.weeks.map((w) => w.completed), tone: 'series-2' }]} label="Created vs completed" /></Card>;
  const status = <Card title="Tasks by status" sub="Created in range"><Donut label="Tasks by status" data={r.byStatus.filter((s) => s.value).map((s, i) => ({ label: STATUS_LABEL[s.key], value: s.value, tone: `series-${(i % 6) + 1}` }))} /></Card>;
  const priority = <Card title="Tasks by priority"><ColumnChart categories={r.byPriority.map((p) => PRIORITY_LABEL[p.key])} series={[{ name: 'Created in range', values: r.byPriority.map((p) => p.value), tone: 'series-1' }, { name: 'Open now', values: r.byPriority.map((p) => p.open), tone: 'series-3' }, { name: 'Overdue now', values: r.byPriority.map((p) => p.overdue), tone: 'series-danger' }]} label="Tasks by priority" /></Card>;
  switch (id) {
    case 'completion':
      return (
        <>
          <div className="grid-2">{trend}{status}</div>
          <Card title="By team"><T head={['Team', 'Created', 'Completed', 'Completion', 'On-time']} rows={r.teamRows.map((t) => [t.name, t.assigned, t.completed, pct(t.completionRate), pct(t.onTimeRate)])} /></Card>
        </>
      );
    case 'overdue':
      return (
        <>
          <div className="grid-2">
            <Card title="Overdue by team" sub="Current"><BarList label="Overdue by team" data={r.overdueByTeam.map((t) => ({ label: t.key, value: t.value, tone: 'tone-danger-bg' }))} /></Card>
            {priority}
          </div>
          <Card title={`Overdue tasks (${r.overdue.length})`}><T head={['Task', 'Assignee', 'Priority', 'Due', 'Level']} rows={r.overdue.map((t) => [<Link key={t.id} to={`/tasks/${t.id}`}>{t.id} · {t.title}</Link>, t.assignee?.name, PRIORITY_LABEL[t.priority], formatShort(t.dueAt), t.level >= 0 ? `L${t.level}` : '—'])} empty="Nothing overdue." /></Card>
        </>
      );
    case 'escalations':
      return (
        <div className="grid-2">
          <Card title="Escalation events by level" sub="Triggered in range vs open now"><ColumnChart categories={r.escalationsByLevel.map((l) => LEVEL_LABEL[l.key]!)} series={[{ name: 'Triggered in range', values: r.escalationsByLevel.map((l) => l.value), tone: 'series-violet' }, { name: 'Open now', values: r.escalationsByLevel.map((l) => l.active), tone: 'series-danger' }]} label="Escalations by level" /></Card>
          <Card title="Escalations by person"><T head={['Staff', 'Team', 'L1+ escalations', 'Open now', 'Overdue now']} rows={r.staffRows.filter((s) => s.escalations).sort((a, b) => b.escalations - a.escalations).map((s) => [s.name, s.team, s.escalations, s.openNow, s.overdueNow])} empty="No L1+ escalations in range." /></Card>
        </div>
      );
    case 'accountability':
      return (
        <Card title="Staff accountability" sub="Historical columns use the date range; 'now' columns are current. Not a performance score.">
          <T head={['Staff', 'Team', 'Assigned', 'Completed', 'On-time', 'Update compliance', 'Open now', 'Overdue now', 'L1+ escalations']} rows={r.staffRows.map((s) => [s.name, s.team, s.assigned, s.completed, pct(s.onTimeRate), pct(s.compliance), s.openNow, s.overdueNow, s.escalations])} />
        </Card>
      );
    case 'teams':
      return (
        <>
          <Card title="Team comparison"><ColumnChart categories={r.teamRows.map((t) => t.name)} series={[{ name: 'Completed', values: r.teamRows.map((t) => t.completed), tone: 'series-2' }, { name: 'Open now', values: r.teamRows.map((t) => t.openNow), tone: 'series-1' }, { name: 'Overdue now', values: r.teamRows.map((t) => t.overdueNow), tone: 'series-danger' }]} label="Team comparison" /></Card>
          <Card title="Team performance"><T head={['Team', 'Created', 'Completed', 'Completion', 'On-time', 'Open now', 'Overdue now', 'L1+ escalations']} rows={r.teamRows.map((t) => [t.name, t.assigned, t.completed, pct(t.completionRate), pct(t.onTimeRate), t.openNow, t.overdueNow, t.escalations])} /></Card>
        </>
      );
    case 'assignments':
      return (
        <>
          <div className="grid-2">
            <Card title="Workload by staff member" sub="Open now"><BarList label="Workload" data={r.staffRows.slice(0, 15).map((s) => ({ label: s.name, value: s.openNow, tone: s.overdueNow ? 'tone-danger-bg' : 'series-1', hint: `${s.overdueNow} overdue` }))} /></Card>
            {priority}
          </div>
          <Card title="By task giver"><T head={['Task giver', 'Role', 'Assigned', 'Open', 'Completed', 'Overdue now', 'Reassignments']} rows={r.giverRows.map((g) => [g.name, g.role, g.assigned, g.open, g.completed, g.overdue, g.reassigned])} /></Card>
        </>
      );
    case 'compliance':
      return (
        <div className="grid-2">
          <Card title="Update compliance by person" sub="Current snapshot"><BarList label="Compliance" max={1} format={(v) => `${Math.round(v * 100)}%`} data={r.staffRows.filter((s) => s.compliance !== null).sort((a, b) => (a.compliance ?? 0) - (b.compliance ?? 0)).map((s) => ({ label: s.name, value: s.compliance ?? 0, tone: (s.compliance ?? 0) >= 0.8 ? 'series-2' : (s.compliance ?? 0) >= 0.6 ? 'tone-warn-bg' : 'tone-danger-bg' }))} /></Card>
          <Card title="Detail"><T head={['Staff', 'Active tasks', 'Compliance']} rows={r.staffRows.filter((s) => s.compliance !== null).map((s) => [s.name, s.openNow, pct(s.compliance)])} /></Card>
        </div>
      );
    case 'reviews':
      return (
        <>
          <div className="stats"><Stat label="Avg review time" value={r.summary.avgReviewHours === null ? '—' : `${r.summary.avgReviewHours.toFixed(1)} h`} help={DEFINITIONS['Avg review time']} /><Stat label="Decisions" value={r.turnaround.length} /></div>
          <div className="grid-2">
            <Card title="Turnaround by reviewer"><BarList label="Average hours" format={(v) => `${v.toFixed(1)} h`} data={r.reviewers.map((x) => ({ label: x.reviewer, value: x.avgHours, tone: 'series-violet', hint: `${x.reviews} reviews` }))} /></Card>
            <Card title="Reviewers"><T head={['Reviewer', 'Reviews', 'Avg hours', 'Sent back']} rows={r.reviewers.map((x) => [x.reviewer, x.reviews, x.avgHours.toFixed(1), pct(x.changesRate)])} /></Card>
          </div>
          <Card title="Submissions"><LineChart categories={r.turnaround.slice(-20).map((x) => x.taskId)} series={[{ name: 'Hours to decision', values: r.turnaround.slice(-20).map((x) => Math.round(x.hours * 10) / 10), tone: 'series-1' }]} label="Hours to decision per submission" /></Card>
        </>
      );
    case 'extensions':
      return (
        <>
          <div className="stats">
            <Stat label="Requests" value={r.extensions.length} />
            <Stat label="Approved" value={r.extensions.filter((e) => e.status === 'approved').length} />
            <Stat label="Rejected" value={r.extensions.filter((e) => e.status === 'rejected').length} />
            <Stat label="Pending" value={r.extensions.filter((e) => e.status === 'pending').length} />
          </div>
          <Card title="Extension requests"><T head={['Task', 'Requested by', 'Days added', 'Reason', 'Status', 'Decided by']} rows={r.extensions.map((e) => [<Link key={e.id} to={`/tasks/${e.taskId}`}>{e.taskId}</Link>, e.requester, e.days.toFixed(1), e.reason, e.status, e.decider])} empty="No extension requests in range." /></Card>
        </>
      );
    default:
      return null;
  }
}

function exportReport(id: string, r: Report) {
  const file = `taskwatch-report-${id}-${new Date().toISOString().slice(0, 10)}.csv`;
  const map: Record<string, (string | number | null | undefined)[][]> = {
    completion: [['Team', 'Created', 'Completed', 'Completion rate', 'On-time rate'], ...r.teamRows.map((t) => [t.name, t.assigned, t.completed, t.completionRate, t.onTimeRate])],
    overdue: [['Task', 'Title', 'Assignee', 'Priority', 'Due', 'Level'], ...r.overdue.map((t) => [t.id, t.title, t.assignee?.name, t.priority, t.dueAt, t.level])],
    escalations: [['Level', 'Triggered in range', 'Open now'], ...r.escalationsByLevel.map((l) => [`L${l.key}`, l.value, l.active])],
    accountability: [['Staff', 'Team', 'Assigned', 'Completed', 'On-time rate', 'Update compliance', 'Open now', 'Overdue now', 'L1+ escalations'], ...r.staffRows.map((s) => [s.name, s.team, s.assigned, s.completed, s.onTimeRate, s.compliance, s.openNow, s.overdueNow, s.escalations])],
    teams: [['Team', 'Created', 'Completed', 'Completion', 'On-time', 'Open now', 'Overdue now', 'Escalations'], ...r.teamRows.map((t) => [t.name, t.assigned, t.completed, t.completionRate, t.onTimeRate, t.openNow, t.overdueNow, t.escalations])],
    assignments: [['Task giver', 'Role', 'Assigned', 'Open', 'Completed', 'Overdue', 'Reassignments'], ...r.giverRows.map((g) => [g.name, g.role, g.assigned, g.open, g.completed, g.overdue, g.reassigned])],
    compliance: [['Staff', 'Active tasks', 'Compliance'], ...r.staffRows.map((s) => [s.name, s.openNow, s.compliance])],
    reviews: [['Task', 'Round', 'Reviewer', 'Decision', 'Hours', 'Submitted'], ...r.turnaround.map((t) => [t.taskId, t.round, t.reviewer, t.decision, t.hours.toFixed(2), t.submittedAt])],
    extensions: [['Task', 'Requested by', 'Current due', 'Requested due', 'Days', 'Reason', 'Status', 'Decided by'], ...r.extensions.map((e) => [e.taskId, e.requester, e.currentDue, e.requestedDue, e.days.toFixed(1), e.reason, e.status, e.decider])],
  };
  downloadCsv(file, map[id] ?? []);
}

