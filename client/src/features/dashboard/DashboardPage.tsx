// DASH-01: the role dashboard. Every figure comes from getDashboard() (server, or the mock running the same shared
// rules); this page renders only and never reads the store (DASH-03-AC-4).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, PRIORITY_LABEL, ROLE_LABEL, STATUS_LABEL } from '../../constants';
import { BarList, ColumnChart, Donut, LineChart, ProgressRing } from '../../components/charts';
import { Icon } from '../../components/icons';
import { Avatar, Card, ErrorState, InfoTip, Segmented, Select, Skeleton, Stat, Tag } from '../../components/ui';
import { useApi, useLocalState, useMe } from '../../hooks';
import { getDashboard } from '../../services/api/misc';
import { PRIORITIES } from '../../types';
import { cx, formatShort, pct, relative } from '../../utils/format';
import type { DashboardPayload, Range } from './insights';
import { ActivityCard, AttentionPanel, FunnelCard, HealthCard, HeatmapCard, KpiStrip, TaskMiniList, TrendCard, WorkloadCard } from './widgets';

type Of<L extends DashboardPayload['layout']> = Extract<DashboardPayload, { layout: L }>;

function greeting(h: number) {
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const user = useMe();
  const [range, setRange] = useLocalState<Range>('dash.range', 30);
  const [entity, setEntity] = useState('');
  const q = useApi(['dashboard', user.id, range, entity], () => getDashboard(range, entity));
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="page"><Skeleton rows={12} /></div>;
  const d = q.data;
  const n = new Date();
  const today = n.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="page dash">
      <FoundersOfficeBanner d={d} />
      <header className="dash-head">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>
            {greeting(n.getHours())}, {user.name.split(' ')[0]}.
          </h1>
          <p className="muted">
            {d.layout === 'staff' ? "Here's your day: what's late, what's due, and what to update next." : 'Monitor execution, spot bottlenecks, and keep your team accountable.'} <Tag tone="info">{ROLE_LABEL[user.role]}</Tag> <span className="small">{d.scopeLabel}</span>
          </p>
        </div>
        <div className="dash-controls">
          {d.entityOptions.length > 0 && (
            <Select aria-label="Entity" value={entity} onChange={(e) => setEntity(e.target.value)} className="w-auto">
              <option value="">All entities</option>
              {d.entityOptions.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          )}
          <Segmented label="Date range" value={String(range) as '7' | '30' | '90'} onChange={(v) => setRange(Number(v) as Range)} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          {d.canCreate && (
            <Link to="/tasks/new" className="btn btn-primary">
              <Icon name="plus" size={15} /> New task
            </Link>
          )}
        </div>
      </header>
      {d.layout === 'staff' && <StaffDash d={d} range={range} />}
      {d.layout === 'lead' && <LeadDash d={d} range={range} />}
      {d.layout === 'manager' && <ManagerDash d={d} range={range} />}
      {d.layout === 'executive' && <CosDash d={d} range={range} />}
    </div>
  );
}

/* ---------------- PERF-07: own score, progress and load ---------------- */

function MyPerformance({ me }: { me: DashboardPayload['me'] }) {
  const user = useMe();
  if (!me) return null;
  return (
    <div className="stats">
      <Stat label="My score this month" value={me.score.score === null ? '—' : Math.round(me.score.score)} hint={me.score.ranked ? undefined : 'not enough rated tasks yet'} to={`/performance/people/${user.id}`} help="Outcome, timeliness and quality of your tasks due this month, as on the Performance page." />
      <Stat label="Progress of open measured tasks" value={me.openProgress === null ? '—' : `${me.openProgress}%`} hint={`${me.measuredOpen} task(s) with a target`} />
      <Stat label="My load" value={`${me.loadPercent}%`} tone={me.band === 'overloaded' ? 'danger' : undefined} hint={me.band} help="Estimated hours of your open work over the next 5 working days, against your working hours." />
    </div>
  );
}

/* ---------------- Staff: personal execution workspace ---------------- */

function StaffDash({ d, range }: { d: Of<'staff'>; range: Range }) {
  const { myDay, week } = d;
  return (
    <>
      <KpiStrip items={d.kpis} />
      <MyPerformance me={d.me} />
      <section className="myday card">
        <header className="card-head">
          <div>
            <h2 className="card-title">My day</h2>
            <p className="card-sub">What's late, what's due today, what's waiting on someone else, and what to update next.</p>
          </div>
        </header>
        <div className="myday-grid">
          <div className="myday-col late">
            <h3><Icon name="alert" size={14} /> Already late <span className="count">{myDay.overdue.count}</span></h3>
            <TaskMiniList tasks={myDay.overdue.items} empty="Nothing late. Nice." showAssignee={false} />
          </div>
          <div className="myday-col today">
            <h3><Icon name="calendar" size={14} /> Due today <span className="count">{myDay.dueToday.count}</span></h3>
            <TaskMiniList tasks={myDay.dueToday.items} empty="Nothing else due today." showAssignee={false} />
          </div>
          <div className="myday-col waiting">
            <h3><Icon name="review" size={14} /> Waiting on others <span className="count">{myDay.awaitingReview.count}</span></h3>
            <TaskMiniList tasks={myDay.awaitingReview.items} empty="Nothing in review." showAssignee={false} />
          </div>
          <div className="myday-col next">
            <h3><Icon name="arrow-up" size={14} /> Update next</h3>
            {myDay.updateNext.items.length ? (
              <ul className="mini-tasks">
                {myDay.updateNext.items.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="mini-title">{t.title}</Link>
                    <span className="small muted">{t.next ? `${LEVEL_LABEL[t.next.level]!.split(' ')[0]} ${relative(t.next.at)}` : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted pad-sm">No active tasks.</p>
            )}
          </div>
        </div>
      </section>
      <div className="dash-grid">
        <AttentionPanel items={d.attention} title="Today's priorities" />
        <Card title="This week" sub="Tasks due this week that you've completed">
          <div className="week-progress">
            <ProgressRing value={week.due ? week.done / week.due : 0} label="Weekly completion">
              <strong>{week.done}/{week.due}</strong>
              <small>done</small>
            </ProgressRing>
            <ul className="week-strip" aria-label="Next 7 days">
              {week.days.map((x) => (
                <li key={x.date} className={cx(x.count > 0 && 'has')}>
                  <span className="muted small">{new Date(x.date).toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <strong>{new Date(x.date).getDate()}</strong>
                  <span className="dots" aria-label={`${x.count} due`}>
                    {x.priorities.map((p, i) => <i key={i} className={`pr-dot pr-${p}`} />)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <Link to="/calendar" className="link-more">Open calendar <Icon name="arrow" size={12} /></Link>
        </Card>
      </div>
      <div className="dash-grid three">
        <Card title="Recent feedback">
          {(d.feedback?.length ?? 0) + (d.comments?.length ?? 0) === 0 ? (
            <p className="muted">No review feedback or comments yet.</p>
          ) : (
            <ul className="feed">
              {d.feedback?.map((r) => (
                <li key={`r${r.id}`}>
                  <span className={cx('feed-sys', r.decision === 'approved' ? 'tone-ok' : 'tone-warn')}><Icon name={r.decision === 'approved' ? 'circle-check' : 'rotate'} size={13} /></span>
                  <div>
                    <span><Link to={`/tasks/${r.taskId}`} className="mono">{r.taskId}</Link> {r.decision === 'approved' ? 'approved' : 'needs changes'}{r.comment ? `: “${r.comment}”` : ''}</span>
                    <time className="muted small">{relative(r.at)}</time>
                  </div>
                </li>
              ))}
              {d.comments?.map((c) => (
                <li key={`c${c.id}`}>
                  <Avatar name={c.author.name} size={26} />
                  <div>
                    <span>“{c.body.slice(0, 90)}” on <Link to={`/tasks/${c.taskId}`} className="mono">{c.taskId}</Link></span>
                    <time className="muted small">{relative(c.at)}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <ActivityCard items={d.activity} title="My task timeline" limit={6} />
        <TrendCard data={d.trend} range={range} title="My execution" />
      </div>
    </>
  );
}

/* ---------------- Team Lead: team execution ---------------- */

const statusLabel = (s: keyof typeof STATUS_LABEL) => STATUS_LABEL[s];

function LeadDash({ d, range }: { d: Of<'lead'>; range: Range }) {
  return (
    <>
      <KpiStrip items={d.kpis} />
      <div className="dash-grid">
        <AttentionPanel items={d.attention} />
        <HealthCard h={d.health} title="Team task health" base="/tasks/team" />
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={d.workload} threshold={d.overloadThreshold} title="Team workload distribution" selectable />
        <div className="stack">
          <Card title="Review queue" sub={`${d.reviewQueue.count} waiting`} actions={<Link to="/reviews" className="link-btn">Open queue</Link>}>
            <TaskMiniList tasks={d.reviewQueue.items} empty="Nothing to review." />
          </Card>
          <Card title="Escalation watchlist" sub="L1+ in your team" actions={<Link to="/escalations" className="link-btn">All escalations</Link>}>
            <TaskMiniList tasks={d.escalated.items} empty="No escalations." />
          </Card>
        </div>
      </div>
      <div className="dash-grid three">
        <Card title="Awaiting updates" sub="Assignee silent past the update window">
          <TaskMiniList tasks={d.stale.items} empty="Everyone is up to date." />
        </Card>
        <Card title="Due-date risk" sub="Open, due within 48 h">
          <TaskMiniList tasks={d.dueSoon.items} empty="No deadlines in the next 48 h." />
        </Card>
        <Card title="Assignments" sub="Open tasks you assigned">
          <BarList label="Open tasks you assigned by status" data={d.assignments.map((a) => ({ label: statusLabel(a.status), value: a.count, tone: 'series-1' }))} />
        </Card>
      </div>
      <div className="dash-grid">
        <TrendCard data={d.trend} range={range} />
        <HeatmapCard grid={d.heatmap} title="Team member activity" />
      </div>
      <ActivityCard items={d.activity} />
    </>
  );
}

/* ---------------- Manager: department performance ---------------- */

function ManagerDash({ d, range }: { d: Of<'manager'>; range: Range }) {
  const loads = d.workload.map((w) => w.active);
  const avg = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
  return (
    <>
      <KpiStrip items={d.kpis} />
      <div className="dash-grid">
        <HealthCard h={d.health} title="Department health" base="/tasks/team" />
        <AttentionPanel items={d.attention} limit={5} />
      </div>
      <div className="dash-grid">
        <TrendCard data={d.trend} range={range} title="Completion trend" />
        <Card title="Overdue by team" sub="Open tasks past due, per team">
          <BarList label="Overdue by team" data={d.overdueByTeam.map((t) => ({ label: t.name, value: t.value, tone: 'tone-danger-bg' }))} />
        </Card>
      </div>
      <div className="dash-grid three">
        <Card title="Escalations by priority" sub="Open tasks at each level">
          <ColumnChart categories={PRIORITIES.map((p) => PRIORITY_LABEL[p])} series={d.escalationsByPriority.map((r) => ({ name: `L${r.level}`, values: r.values, tone: `lvl-fill-${r.level}` }))} label="Escalations by priority" stacked height={170} />
        </Card>
        <Card title={<>Update compliance <InfoTip text="Share of each team's active tasks whose assignee updated within the required window." /></>}>
          <BarList label="Update compliance by team" data={d.complianceByTeam.map((c) => ({ label: c.name, value: c.value, tone: c.value >= 0.8 ? 'series-2' : c.value >= 0.6 ? 'tone-warn-bg' : 'tone-danger-bg' }))} format={(v) => `${Math.round(v * 100)}%`} max={1} />
        </Card>
        <Card title="Delayed reviews" sub="In review for over 24 h">
          <TaskMiniList tasks={d.delayedReviews.items} empty="No reviews waiting over 24 h." />
        </Card>
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={d.workload} threshold={d.overloadThreshold} title={`Workload imbalance · avg ${avg.toFixed(1)} active per person`} />
        <TeamComparison teams={d.teams} />
      </div>
    </>
  );
}

function TeamComparison({ teams }: { teams: Of<'manager'>['teams'] }) {
  return (
    <Card title={<>Team comparison <InfoTip text="Completion = completed ÷ non-cancelled tasks in scope (all time). Open/overdue/escalated are current counts. These are operational indicators, not a ranking of people." /></>}>
      <table className="table compact">
        <caption className="sr-only">Team comparison</caption>
        <thead>
          <tr>
            <th>Team</th>
            <th className="right">Open</th>
            <th className="right">Overdue</th>
            <th className="right">Escalated</th>
            <th>Completion</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.id}>
              <td data-label="Team"><Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link></td>
              <td data-label="Open" className="right">{t.open}</td>
              <td data-label="Overdue" className="right">{t.overdue ? <span className="tone-danger">{t.overdue}</span> : 0}</td>
              <td data-label="Escalated" className="right">{t.escalated}</td>
              <td data-label="Completion">
                <span className="row-gap"><span className="minibar"><span style={{ width: `${(t.completionRate ?? 0) * 100}%` }} /></span>{pct(t.completionRate)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* ---------------- Chief of Staff / CEO: executive command center ---------------- */

function CosDash({ d, range }: { d: Of<'executive'>; range: Range }) {
  const staff = d.staff ?? { active: 0, inactive: 0, noManager: 0 };
  const kpis = [
    { key: 'staff', label: 'Active staff', value: String(staff.active), raw: 0, prev: null, polarity: 'up-good' as const, spark: [], context: `${staff.inactive} inactive · ${staff.noManager} without manager`, help: 'People with an active account in the selected scope.', to: '/admin/staff', tone: 'slate' as const, format: 'int' as const },
    ...d.kpis,
  ];
  const resp = d.escalationResponse;
  const byRole = d.staffByRole ?? {};
  return (
    <>
      <KpiStrip items={kpis} />
      <div className="dash-grid">
        <AttentionPanel items={d.attention} title="Critical attention queue" />
        <HealthCard h={d.health} title="Organization health" base="/tasks/team" />
      </div>
      <div className="dash-grid">
        <FunnelCard data={d.funnel} range={range} title="Escalation pyramid" />
        <Card title="Entity workload" sub="Active tasks per entity; click to drill into teams">
          <ColumnChart
            categories={d.entities.map((r) => r.name)}
            series={[
              { name: 'On track / at risk', values: d.entities.map((r) => r.active - r.overdue - Math.max(0, r.escalated - r.overdue)), tone: 'series-1' },
              { name: 'Escalated', values: d.entities.map((r) => Math.max(0, r.escalated - r.overdue)), tone: 'series-warn' },
              { name: 'Overdue', values: d.entities.map((r) => r.overdue), tone: 'series-danger' },
            ]}
            label="Entity workload"
            stacked
            height={170}
          />
          <ul className="drill">
            {d.entities.map((x) => (
              <li key={x.id}>
                <strong>{x.name}</strong>
                {x.teams.map((t) => (
                  <Link key={t.id} to={`/tasks/team?team=${t.id}`} className="chip">
                    {t.name} <span className="muted">{t.open}</span>
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="dash-grid">
        <TrendCard data={d.trend} range={range} title="Task completion trend" />
        <Card title={<>Escalation response <InfoTip text="Average hours from an L1+ escalation firing to its acknowledgement, by period. Only acknowledged escalations are counted." /></>} sub={`${resp.reduce((s, r) => s + r.count, 0)} acknowledged escalations`}>
          <LineChart categories={resp.map((r) => r.label)} series={[{ name: 'Avg hours to acknowledge', values: resp.map((r) => Math.round(r.hours * 10) / 10), tone: 'series-violet' }]} label="Escalation response trend" />
        </Card>
      </div>
      <div className="dash-grid three">
        <Card title={<>At-risk teams <InfoTip text="Teams ranked by (overdue + escalated) ÷ open tasks. A team appears only if it has at least one." /></>}>
          {d.atRiskTeams.length === 0 ? (
            <p className="muted">No team has overdue or escalated work.</p>
          ) : (
            <ul className="risk-list">
              {d.atRiskTeams.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link>
                  <span className="minibar danger"><span style={{ width: `${Math.min(100, t.risk * 100)}%` }} /></span>
                  <span className="small muted">{t.overdue} overdue · {t.escalated} escalated / {t.open}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Staff by role">
          <Donut label="Active staff by role" data={(['ceo', 'cos', 'manager', 'lead', 'staff'] as const).map((r, i) => ({ label: ROLE_LABEL[r], value: byRole[r] ?? 0, tone: `series-${i + 1}` }))} center={<><strong>{staff.active}</strong><small>active</small></>} />
        </Card>
        <Card title="Organization" actions={<Link to="/admin/org" className="link-btn">Open chart</Link>}>
          <OrgMini org={d.orgMini ?? []} />
        </Card>
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={d.workload} threshold={d.overloadThreshold} title="Staff workload" selectable />
        <Card title="Recent administrative activity" actions={<Link to="/admin/audit" className="link-btn">Audit log</Link>}>
          <ul className="feed">
            {d.recentAdmin?.map((a) => (
              <li key={a.id}>
                <Avatar name={a.actor?.name ?? 'TaskWatch'} size={26} />
                <div>
                  <span>
                    <strong>{a.actor?.name ?? 'Demo'}</strong> {a.action.replace(/[._]/g, ' ')} {typeof a.next === 'string' && a.next && <span className="muted">→ {a.next}</span>}
                  </span>
                  <time className="muted small">{formatShort(a.at)}</time>
                </div>
              </li>
            ))}
            {!d.recentAdmin?.length && <li className="muted">No administrative changes yet.</li>}
          </ul>
        </Card>
      </div>
      <ActivityCard items={d.activity} title="Recent operational activity" />
    </>
  );
}

function OrgMini({ org }: { org: NonNullable<DashboardPayload['orgMini']> }) {
  return (
    <ul className="org-mini">
      {org.map((dpt) => (
        <li key={dpt.id}>
          <div className="org-mini-dept">
            <Icon name="building" size={14} /> <strong>{dpt.name}</strong> <span className="muted small">{dpt.head}</span>
          </div>
          <ul>
            {dpt.teams.map((t) => (
              <li key={t.id}>
                <Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link> <span className="muted small">{t.members} people · lead {t.lead ?? '—'}{t.leadWithoutManager ? ' (no manager)' : ''}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Work order: L3 Founder's Office escalations sit at the top of the dashboard for their recipients. */
function FoundersOfficeBanner({ d }: { d: DashboardPayload }) {
  const b = d.l3Banner;
  if (!b) return null;
  return (
    <section className="l3-banner" role="alert" aria-label="L3 Founder's Office escalations">
      <div className="l3-head">
        <span className="l3-badge"><Icon name="alert" size={15} /> L3 Founder's Office</span>
        <strong>{b.taskCount} task{b.taskCount > 1 ? 's' : ''} escalated to you</strong>
        <span className="small">{b.unacked} not yet acknowledged</span>
        <Link to="/escalations?level=3" className="btn btn-sm l3-btn">Review all</Link>
      </div>
      <ul>
        {b.tasks.map((t) => (
          <li key={t.id}>
            <Link to={`/tasks/${t.id}`}><span className="mono">{t.id}</span> {t.title}</Link>
            <span className="small">{t.assignee} · {t.reason === 'overdue' ? 'past due' : t.reason === 'blocked' ? 'blocked' : 'no update'} · since {relative(t.since)}{t.acknowledged ? ' · acknowledged' : ''}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
