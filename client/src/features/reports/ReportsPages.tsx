import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '../../constants';
import { BarList, ColumnChart, Donut, LineChart } from '../../components/charts';
import { Icon } from '../../components/icons';
import { Banner, Button, Card, Empty, ErrorState, Field, Input, PageHeader, Select, Skeleton, Stat } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { exportAccountability, exportReport, getAccountability, getReport, getReportOptions, reportScope, type Report, type ReportFilters } from '../../services/api/misc';
import { BACKEND } from '../../services/http';
import { now } from '../../services/mock/store';
import { isReportId, REPORT_STATUSES } from '@taskwatch/shared/reports';
import { RANGES, type Range } from '@taskwatch/shared/insights';
import { PRIORITIES } from '../../types';
import { formatDateTime, formatShort, hoursLabel, pct, toDateInput } from '../../utils/format';

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
  { id: 'teams', title: 'Department Performance', question: 'How do departments compare on delivery and risk?', icon: 'users' },
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

/** RPT-05/06 (WO FR-11). Server only: the prototype has no first-response data. */
const FR11: Def = { id: 'entities', title: 'Vertical & Person Accountability', question: 'Per vertical: open, on track, amber, red, longest silence. Per person: first response, escalations, on-time %.', icon: 'layers' };

export function ReportsIndexPage() {
  const scope = useApi(['report-scope'], reportScope);
  if (scope.error) return <ErrorState error={scope.error} />;
  return (
    <div className="page">
      <PageHeader title="Accountability Reports" description={!scope.data ? '' : scope.data === 'org' ? 'Organization-wide reports.' : 'Reports scoped to your reporting line.'} />
      <div className="report-grid">
        {(BACKEND === 'server' ? [FR11, ...REPORTS] : REPORTS).map((r) => (
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
  const [f, setF] = useState<ReportFilters>(() => ({ from: toDateInput(now() - 30 * 86_400_000), to: toDateInput(now()), teamId: '', userId: '', giverId: '', priority: '', status: '', level: '' }));
  const q = useApi(['report', user.id, JSON.stringify(f)], () => getReport(f));
  const opts = useApi(['report-options', user.id], getReportOptions);
  const set = <K extends keyof ReportFilters>(k: K, v: ReportFilters[K]) => setF((x) => ({ ...x, [k]: v }));
  if (!def || !isReportId(def.id)) return <ErrorState error={{ status: 404, message: 'Unknown report.' }} />;
  const bad = q.error?.status === 422; // a filter the user can fix keeps the page
  if (q.error && !bad) return <ErrorState error={q.error} />;
  if (opts.error) return <ErrorState error={opts.error} />;
  const r = bad ? undefined : q.data;
  const id = def.id;
  return (
    <div className="page">
      <PageHeader title={`${def.title} report`} description={def.question} actions={r && <Button icon="download" onClick={() => exportReport(id, f, r)}>Export CSV</Button>} />
      <div className="report-filters card">
        <Field label="From" htmlFor="rf-from">
          <Input id="rf-from" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} className="input-sm" />
        </Field>
        <Field label="To" htmlFor="rf-to">
          <Input id="rf-to" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} className="input-sm" />
        </Field>
        <Field label="Department" htmlFor="rf-team">
          <Select id="rf-team" value={f.teamId} onChange={(e) => set('teamId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {opts.data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Staff member" htmlFor="rf-user">
          <Select id="rf-user" value={f.userId} onChange={(e) => set('userId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {opts.data?.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Field label="Task giver" htmlFor="rf-giver">
          <Select id="rf-giver" value={f.giverId} onChange={(e) => set('giverId', e.target.value)} className="input-sm">
            <option value="">All</option>
            {opts.data?.givers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
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
            {REPORT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
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
      {bad ? (
        <Banner tone="danger">{q.error!.message}</Banner>
      ) : !r ? (
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
          <Card title="By department"><T head={['Department', 'Created', 'Completed', 'Completion', 'On-time']} rows={r.teamRows.map((t) => [t.name, t.assigned, t.completed, pct(t.completionRate), pct(t.onTimeRate)])} /></Card>
        </>
      );
    case 'overdue':
      return (
        <>
          <div className="grid-2">
            <Card title="Overdue by department" sub="Current"><BarList label="Overdue by department" data={r.overdueByTeam.map((t) => ({ label: t.key, value: t.value, tone: 'tone-danger-bg' }))} /></Card>
            {priority}
          </div>
          <Card title={`Overdue tasks (${r.overdue.length})`}><T head={['Task', 'Assignee', 'Priority', 'Due', 'Level']} rows={r.overdue.map((t) => [<Link key={t.id} to={`/tasks/${t.id}`}>{t.id} · {t.title}</Link>, t.assignee?.name, PRIORITY_LABEL[t.priority], formatShort(t.dueAt), t.level >= 0 ? `L${t.level}` : '—'])} empty="Nothing overdue." /></Card>
        </>
      );
    case 'escalations':
      return (
        <div className="grid-2">
          <Card title="Escalation events by level" sub="Triggered in range vs open now"><ColumnChart categories={r.escalationsByLevel.map((l) => LEVEL_LABEL[l.key]!)} series={[{ name: 'Triggered in range', values: r.escalationsByLevel.map((l) => l.value), tone: 'series-violet' }, { name: 'Open now', values: r.escalationsByLevel.map((l) => l.active), tone: 'series-danger' }]} label="Escalations by level" /></Card>
          <Card title="Escalations by person"><T head={['Staff', 'Department', 'L1+ escalations', 'Open now', 'Overdue now']} rows={r.staffRows.filter((s) => s.escalations).sort((a, b) => b.escalations - a.escalations).map((s) => [s.name, s.team, s.escalations, s.openNow, s.overdueNow])} empty="No L1+ escalations in range." /></Card>
        </div>
      );
    case 'accountability':
      return (
        <Card title="Staff accountability" sub="Historical columns use the date range; 'now' columns are current. Not a performance score.">
          <T head={['Staff', 'Department', 'Assigned', 'Completed', 'On-time', 'Update compliance', 'Open now', 'Overdue now', 'L1+ escalations']} rows={r.staffRows.map((s) => [s.name, s.team, s.assigned, s.completed, pct(s.onTimeRate), pct(s.compliance), s.openNow, s.overdueNow, s.escalations])} />
        </Card>
      );
    case 'teams':
      return (
        <>
          <Card title="Department comparison"><ColumnChart categories={r.teamRows.map((t) => t.name)} series={[{ name: 'Completed', values: r.teamRows.map((t) => t.completed), tone: 'series-2' }, { name: 'Open now', values: r.teamRows.map((t) => t.openNow), tone: 'series-1' }, { name: 'Overdue now', values: r.teamRows.map((t) => t.overdueNow), tone: 'series-danger' }]} label="Department comparison" /></Card>
          <Card title="Department performance"><T head={['Department', 'Created', 'Completed', 'Completion', 'On-time', 'Open now', 'Overdue now', 'L1+ escalations']} rows={r.teamRows.map((t) => [t.name, t.assigned, t.completed, pct(t.completionRate), pct(t.onTimeRate), t.openNow, t.overdueNow, t.escalations])} /></Card>
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
          <Card title="Submissions"><LineChart categories={r.turnaround.slice(-20).map((x) => String(x.taskId))} series={[{ name: 'Hours to decision', values: r.turnaround.slice(-20).map((x) => Math.round(x.hours * 10) / 10), tone: 'series-1' }]} label="Hours to decision per submission" /></Card>
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

/** RPT-05…07: WO FR-11 by entity and by person, with CSV and PDF (server only). */
export function AccountabilityPage() {
  const [days, setDays] = useState<Range>(30);
  const q = useApi(['accountability', days], () => getAccountability(days));
  if (q.error) return <ErrorState error={q.error} />;
  const a = q.data;
  return (
    <div className="page">
      <PageHeader
        title={FR11.title}
        description={a ? `${a.scope} · generated ${formatDateTime(a.generatedAt)}` : FR11.question}
        actions={
          <>
            <Button icon="download" onClick={() => exportAccountability(days, 'csv')}>Export CSV</Button>
            <Button icon="download" onClick={() => exportAccountability(days, 'pdf')}>Export PDF</Button>
          </>
        }
      />
      <div className="report-filters card">
        <Field label="Period" htmlFor="acc-days">
          <Select id="acc-days" value={days} onChange={(e) => setDays(Number(e.target.value) as Range)} className="input-sm">
            {RANGES.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </Select>
        </Field>
      </div>
      {!a ? (
        <Skeleton rows={10} />
      ) : (
        <>
          <Card title="By vertical" sub="Open tasks now. Amber = L0–L1, red = L2–L3. The period applies to the person table only.">
            <T
              head={['Vertical', 'Open', 'On track', 'Amber', 'Red', 'Blocked', 'Longest silence', 'Longest-silent task']}
              rows={a.byEntity.map((e) => [
                e.entityName,
                e.open,
                e.onTrack,
                e.amber,
                e.red,
                e.blocked,
                e.longestSilenceHours === null ? '—' : hoursLabel(e.longestSilenceHours),
                e.longestSilenceTask ? <Link key={e.entityId} to={`/tasks/${e.longestSilenceTask.id}`}>#{e.longestSilenceTask.id} {e.longestSilenceTask.title} ({e.longestSilenceTask.assignee})</Link> : '—',
              ])}
            />
          </Card>
          <Card title="By person" sub={`First response, escalations and closures in the last ${a.days} days; open tasks now.`}>
            <T
              head={['Person', 'Vertical', 'Open tasks', 'Avg first response', 'Escalations (L1+)', 'Closed', 'On time', 'On-time %']}
              rows={a.byPerson.map((p) => [p.name, p.entityId, p.open, p.avgFirstResponseHours === null ? '—' : `${p.avgFirstResponseHours.toFixed(1)} h`, p.escalations, p.closed, p.onTime, p.onTimePct === null ? '—' : `${p.onTimePct}%`])}
            />
          </Card>
        </>
      )}
    </div>
  );
}
