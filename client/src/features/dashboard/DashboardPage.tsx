import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DAY, HOUR, LEVEL_LABEL, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { BarList, ColumnChart, Donut, LineChart, ProgressRing } from '../../components/charts';
import { Icon } from '../../components/icons';
import { Avatar, Card, ErrorState, InfoTip, Segmented, Select, Skeleton, Tag } from '../../components/ui';
import { useApi, useLocalState, useMe } from '../../hooks';
import type { TaskView } from '../../services/api/base';
import { getDashboard, type Dashboard } from '../../services/api/misc';
import { reportsOf } from '../../services/authz/permissions';
import { foundersOffice } from '../../services/core';
import { allowedActions } from '../../services/engine/workflow';
import { getDb, now } from '../../services/mock/store';
import type { User } from '../../types';
import { ACTIVE_STATUSES, PRIORITIES } from '../../types';
import { cx, formatShort, pct, relative } from '../../utils/format';
import { activityHeatmap, attention, departmentOf, escalationResponse, funnel, health, kpis, trend, workload, type Range } from './insights';
import { ActivityCard, AttentionPanel, FunnelCard, HealthCard, HeatmapCard, KpiStrip, TaskMiniList, TrendCard, WorkloadCard } from './widgets';

const isOpen = (t: TaskView) => ACTIVE_STATUSES.includes(t.status) || t.status === 'submitted';

function greeting(h: number) {
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  const user = useMe();
  const q = useApi(['dashboard', user.id], getDashboard);
  const [range, setRange] = useLocalState<Range>('dash.range', 30);
  const [dept, setDept] = useState('');
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="page"><Skeleton rows={12} /></div>;
  const db = getDb();
  const n = now();
  const d = q.data;
  const scopeLabel = user.role === 'cos' || user.role === 'ceo' ? `${db.settings.orgName} · organization-wide` : user.role === 'staff' ? 'Your assigned work' : `Your reporting line · ${reportsOf(db, user.id).size} people`;
  const today = new Date(n).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <div className="page dash">
      <FoundersOfficeBanner />
      <header className="dash-head">
        <div>
          <p className="eyebrow">{today}</p>
          <h1>
            {greeting(new Date(n).getHours())}, {user.name.split(' ')[0]}.
          </h1>
          <p className="muted">
            {user.role === 'staff' ? "Here's your day: what's late, what's due, and what to update next." : 'Monitor execution, spot bottlenecks, and keep your team accountable.'} <Tag tone="info">{ROLE_LABEL[user.role]}</Tag> <span className="small">{scopeLabel}</span>
          </p>
        </div>
        <div className="dash-controls">
          {(user.role === 'cos' || user.role === 'ceo') && (
            <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className="w-auto">
              <option value="">All departments</option>
              {db.departments.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          )}
          <Segmented label="Date range" value={String(range) as '7' | '30' | '90'} onChange={(v) => setRange(Number(v) as Range)} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          {user.role !== 'staff' && (
            <Link to="/tasks/new" className="btn btn-primary">
              <Icon name="plus" size={15} /> New task
            </Link>
          )}
        </div>
      </header>
      {user.role === 'staff' && <StaffDash d={d} range={range} />}
      {user.role === 'lead' && <LeadDash d={d} range={range} />}
      {user.role === 'manager' && <ManagerDash d={d} range={range} />}
      {(user.role === 'cos' || user.role === 'ceo') && <CosDash d={d} range={range} dept={dept} />}
    </div>
  );
}

function useReviewerSet(tasks: TaskView[]) {
  const user = useMe();
  const db = getDb();
  return useMemo(() => {
    const s = new Set<string>();
    for (const t of tasks) {
      const raw = db.tasks.find((x) => x.id === t.id);
      if (!raw) continue;
      const a = allowedActions(db, user, raw);
      if (a.has('review')) s.add(t.id);
      if (a.has('decide_extension')) for (const e of db.extensions.filter((x) => x.taskId === t.id && x.status === 'pending')) s.add(`ext:${e.id}`);
    }
    return s;
  }, [tasks, db, user]);
}

/* ---------------- Staff: personal execution workspace ---------------- */

function StaffDash({ d, range }: { d: Dashboard; range: Range }) {
  const user = useMe();
  const db = getDb();
  const n = now();
  const myAll = d.mine.all;
  const all = myAll;
  const k = kpis(myAll, n, range, '/tasks/mine').filter((x) => x.key !== 'critical');
  const reviewers = useReviewerSet(all);
  const items = attention(d.mine.open, db.extensions, n, user, reviewers);
  const weekStart = n - ((new Date(n).getDay() + 6) % 7) * DAY - (n % DAY);
  const dueThisWeek = db.tasks.filter((t) => t.assigneeId === user.id && t.status !== 'cancelled' && t.status !== 'draft' && Date.parse(t.dueAt) >= weekStart && Date.parse(t.dueAt) < weekStart + 7 * DAY);
  const doneThisWeek = dueThisWeek.filter((t) => t.status === 'completed');
  const updateNext = [...d.mine.open].filter((t) => ACTIVE_STATUSES.includes(t.status)).sort((a, b) => (a.levelInfo?.next?.at ?? Infinity) - (b.levelInfo?.next?.at ?? Infinity)).slice(0, 4);
  const feedback = db.reviews.filter((r) => r.submittedBy === user.id && r.decidedAt).sort((a, b) => b.decidedAt!.localeCompare(a.decidedAt!)).slice(0, 3);
  const comments = db.comments.filter((c) => !c.deleted && c.authorId !== user.id && db.tasks.some((t) => t.id === c.taskId && t.assigneeId === user.id)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
  const days = Array.from({ length: 7 }, (_, i) => {
    const s = new Date(n);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() + i);
    const e = s.getTime() + DAY;
    return { date: s, tasks: d.mine.open.filter((t) => Date.parse(t.dueAt) >= s.getTime() && Date.parse(t.dueAt) < e) };
  });
  const myActs = db.activities.filter((a) => db.tasks.some((t) => t.id === a.taskId && t.assigneeId === user.id)).sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <KpiStrip items={k} />
      <section className="myday card">
        <header className="card-head">
          <div>
            <h2 className="card-title">My day</h2>
            <p className="card-sub">What's late, what's due today, what's waiting on someone else, and what to update next.</p>
          </div>
        </header>
        <div className="myday-grid">
          <div className="myday-col late">
            <h3><Icon name="alert" size={14} /> Already late <span className="count">{d.mine.overdue.length}</span></h3>
            <TaskMiniList tasks={d.mine.overdue.slice(0, 4)} empty="Nothing late. Nice." showAssignee={false} />
          </div>
          <div className="myday-col today">
            <h3><Icon name="calendar" size={14} /> Due today <span className="count">{d.mine.dueToday.length}</span></h3>
            <TaskMiniList tasks={d.mine.dueToday.slice(0, 4)} empty="Nothing else due today." showAssignee={false} />
          </div>
          <div className="myday-col waiting">
            <h3><Icon name="review" size={14} /> Waiting on others <span className="count">{d.mine.awaitingReview.length}</span></h3>
            <TaskMiniList tasks={d.mine.awaitingReview.slice(0, 4)} empty="Nothing in review." showAssignee={false} />
          </div>
          <div className="myday-col next">
            <h3><Icon name="arrow-up" size={14} /> Update next</h3>
            {updateNext.length ? (
              <ul className="mini-tasks">
                {updateNext.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="mini-title">{t.title}</Link>
                    <span className="small muted">{t.levelInfo?.next ? `${LEVEL_LABEL[t.levelInfo.next.level]!.split(' ')[0]} ${relative(new Date(t.levelInfo.next.at).toISOString())}` : ''}</span>
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
        <AttentionPanel items={items} title="Today's priorities" />
        <Card title="This week" sub="Tasks due this week that you've completed">
          <div className="week-progress">
            <ProgressRing value={dueThisWeek.length ? doneThisWeek.length / dueThisWeek.length : 0} label="Weekly completion">
              <strong>{doneThisWeek.length}/{dueThisWeek.length}</strong>
              <small>done</small>
            </ProgressRing>
            <ul className="week-strip" aria-label="Next 7 days">
              {days.map((x) => (
                <li key={x.date.toISOString()} className={cx(x.tasks.length > 0 && 'has')}>
                  <span className="muted small">{x.date.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                  <strong>{x.date.getDate()}</strong>
                  <span className="dots" aria-label={`${x.tasks.length} due`}>
                    {x.tasks.slice(0, 3).map((t) => <i key={t.id} className={`pr-dot pr-${t.priority}`} />)}
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
          {feedback.length + comments.length === 0 ? (
            <p className="muted">No review feedback or comments yet.</p>
          ) : (
            <ul className="feed">
              {feedback.map((r) => (
                <li key={r.id}>
                  <span className={cx('feed-sys', r.decision === 'approved' ? 'tone-ok' : 'tone-warn')}><Icon name={r.decision === 'approved' ? 'circle-check' : 'rotate'} size={13} /></span>
                  <div>
                    <span><Link to={`/tasks/${r.taskId}`} className="mono">{r.taskId}</Link> {r.decision === 'approved' ? 'approved' : 'needs changes'}{r.comment ? `: “${r.comment}”` : ''}</span>
                    <time className="muted small">{relative(r.decidedAt)}</time>
                  </div>
                </li>
              ))}
              {comments.map((c) => (
                <li key={c.id}>
                  <Avatar name={db.users.find((u) => u.id === c.authorId)?.name ?? '?'} size={26} />
                  <div>
                    <span>“{c.body.slice(0, 90)}” on <Link to={`/tasks/${c.taskId}`} className="mono">{c.taskId}</Link></span>
                    <time className="muted small">{relative(c.at)}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <ActivityCard items={myActs} users={db.users} title="My task timeline" limit={6} />
        <TrendCard data={trend(myAll, now(), range)} range={range} title="My execution" />
      </div>
    </>
  );
}

/* ---------------- Team Lead: team execution ---------------- */

function LeadDash({ d, range }: { d: Dashboard; range: Range }) {
  const user = useMe();
  const db = getDb();
  const n = now();
  const scope = d.scope.all;
  const reviewers = useReviewerSet(scope);
  const people = d.workload.map((w) => db.users.find((u) => u.id === w.id)!).filter(Boolean);
  const ids = new Set(scope.map((t) => t.id));
  const riskSoon = scope.filter((t) => isOpen(t) && !t.overdue && Date.parse(t.dueAt) - n < 48 * HOUR).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <>
      <KpiStrip items={kpis(scope, n, range, '/tasks/team')} />
      <div className="dash-grid">
        <AttentionPanel items={attention(scope, db.extensions, n, user, reviewers)} />
        <HealthCard h={health(scope, n)} title="Team task health" base="/tasks/team" />
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={workload(scope, people, n, range, db.settings.overloadThreshold)} threshold={db.settings.overloadThreshold} title="Team workload distribution" selectable />
        <div className="stack">
          <Card title="Review queue" sub={`${d.scope.awaitingReview.length} waiting`} actions={<Link to="/reviews" className="link-btn">Open queue</Link>}>
            <TaskMiniList tasks={d.scope.awaitingReview.slice(0, 5)} empty="Nothing to review." />
          </Card>
          <Card title="Escalation watchlist" sub="L1+ in your team" actions={<Link to="/escalations" className="link-btn">All escalations</Link>}>
            <TaskMiniList tasks={d.scope.escalated.sort((a, b) => b.level - a.level).slice(0, 5)} empty="No escalations." />
          </Card>
        </div>
      </div>
      <div className="dash-grid three">
        <Card title="Awaiting updates" sub="Assignee silent past the update window">
          <TaskMiniList tasks={d.scope.stale.slice(0, 6)} empty="Everyone is up to date." />
        </Card>
        <Card title="Due-date risk" sub="Open, due within 48 h">
          <TaskMiniList tasks={riskSoon.slice(0, 6)} empty="No deadlines in the next 48 h." />
        </Card>
        <Card title="Assignments" sub="Open tasks you assigned">
          <BarList label="Open tasks you assigned by status" data={['assigned', 'in_progress', 'submitted', 'changes_requested', 'reopened'].map((s) => ({ label: s.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase()), value: d.scope.assignedByMe.filter((t) => t.status === s).length, tone: 'series-1' }))} />
        </Card>
      </div>
      <div className="dash-grid">
        <TrendCard data={trend(scope, n, range)} range={range} />
        <HeatmapCard grid={activityHeatmap(db.activities, ids, n)} title="Team member activity" />
      </div>
      <ActivityCard items={db.activities.filter((a) => ids.has(a.taskId)).sort((a, b) => b.at.localeCompare(a.at))} users={db.users} />
    </>
  );
}

/* ---------------- Manager: department performance ---------------- */

function ManagerDash({ d, range }: { d: Dashboard; range: Range }) {
  const user = useMe();
  const db = getDb();
  const n = now();
  const scope = d.scope.all;
  const reviewers = useReviewerSet(scope);
  const people = d.workload.map((w) => db.users.find((u) => u.id === w.id)!).filter(Boolean);
  const wl = workload(scope, people, n, range, db.settings.overloadThreshold);
  const teams = db.teams.filter((t) => scope.some((x) => x.teamId === t.id));
  const delayed = d.scope.awaitingReview.filter((t) => n - Date.parse(t.clockStartedAt) > 24 * HOUR);
  const compliance = teams.map((t) => {
    const run = scope.filter((x) => x.teamId === t.id && ACTIVE_STATUSES.includes(x.status));
    return { label: t.name, value: run.length ? run.filter((x) => (x.levelInfo?.silenceLevel ?? -1) < 0).length / run.length : 0 };
  });
  const loads = wl.map((w) => w.active);
  const avg = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
  return (
    <>
      <KpiStrip items={kpis(scope, n, range, '/tasks/team')} />
      <div className="dash-grid">
        <HealthCard h={health(scope, n)} title="Department health" base="/tasks/team" />
        <AttentionPanel items={attention(scope, db.extensions, n, user, reviewers)} limit={5} />
      </div>
      <div className="dash-grid">
        <TrendCard data={trend(scope, n, range)} range={range} title="Completion trend" />
        <Card title="Overdue by team" sub="Open tasks past due, per team">
          <BarList label="Overdue by team" data={teams.map((t) => ({ label: t.name, value: scope.filter((x) => x.teamId === t.id && isOpen(x) && x.overdue).length, tone: 'tone-danger-bg' }))} />
        </Card>
      </div>
      <div className="dash-grid three">
        <Card title="Escalations by priority" sub="Open tasks at each level">
          <ColumnChart categories={PRIORITIES.map((p) => PRIORITY_LABEL[p])} series={[0, 1, 2, 3].map((l) => ({ name: `L${l}`, values: PRIORITIES.map((p) => scope.filter((t) => isOpen(t) && t.priority === p && t.level === l).length), tone: `lvl-fill-${l}` }))} label="Escalations by priority" stacked height={170} />
        </Card>
        <Card title={<>Update compliance <InfoTip text="Share of each team's active tasks whose assignee updated within the required window." /></>}>
          <BarList label="Update compliance by team" data={compliance.map((c) => ({ ...c, tone: c.value >= 0.8 ? 'series-2' : c.value >= 0.6 ? 'tone-warn-bg' : 'tone-danger-bg' }))} format={(v) => `${Math.round(v * 100)}%`} max={1} />
        </Card>
        <Card title="Delayed reviews" sub="In review for over 24 h">
          <TaskMiniList tasks={delayed.slice(0, 6)} empty="No reviews waiting over 24 h." />
        </Card>
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={wl} threshold={db.settings.overloadThreshold} title={`Workload imbalance · avg ${avg.toFixed(1)} active per person`} />
        <TeamComparison d={d} />
      </div>
    </>
  );
}

function TeamComparison({ d }: { d: Dashboard }) {
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
          {d.teams.map((t) => (
            <tr key={t.id}>
              <td data-label="Team"><Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link></td>
              <td data-label="Open" className="right">{t.open}</td>
              <td data-label="Overdue" className="right">{t.overdue ? <span className="tone-danger">{t.overdue}</span> : 0}</td>
              <td data-label="Escalated" className="right">{t.escalated}</td>
              <td data-label="Completion">
                <span className="row-gap"><span className="minibar"><span style={{ width: pct(t.completionRate) === '—' ? 0 : `${(t.completionRate ?? 0) * 100}%` }} /></span>{pct(t.completionRate)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* ---------------- Chief of Staff: executive command center ---------------- */

function CosDash({ d, range, dept }: { d: Dashboard; range: Range; dept: string }) {
  const user = useMe();
  const db = getDb();
  const n = now();
  const scope = dept ? d.scope.all.filter((t) => departmentOf(db, t.teamId) === dept) : d.scope.all;
  const reviewers = useReviewerSet(scope);
  const ids = new Set(scope.map((t) => t.id));
  const staff = db.users.filter((u) => !dept || departmentOf(db, u.teamId) === dept || (u.role === 'manager' && db.departments.find((x) => x.id === dept)?.headId === u.id));
  const k = kpis(scope, n, range, '/tasks/team');
  k.splice(0, 0, { key: 'staff', label: 'Active staff', value: String(staff.filter((u) => u.status === 'active').length), raw: 0, prev: null, polarity: 'up-good', spark: [], context: `${staff.filter((u) => u.status !== 'active').length} inactive · ${d.staffStats.noManager} without manager`, help: 'People with an active account in the selected scope.', to: '/admin/staff', tone: 'slate', format: 'int' });
  const k2 = k.filter((x) => x.key !== 'compliance' || true);
  const deptRows = db.departments.filter((x) => !dept || x.id === dept).map((x) => {
    const tv = scope.filter((t) => departmentOf(db, t.teamId) === x.id);
    return { id: x.id, name: x.name, active: tv.filter(isOpen).length, overdue: tv.filter((t) => isOpen(t) && t.overdue).length, escalated: tv.filter((t) => isOpen(t) && t.level >= 1).length };
  });
  const atRisk = d.teams
    .filter((t) => !dept || db.teams.find((x) => x.id === t.id)?.departmentId === dept)
    .map((t) => ({ ...t, risk: t.open ? (t.overdue + t.escalated) / t.open : 0 }))
    .filter((t) => t.risk > 0)
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 5);
  const resp = escalationResponse(db.escalations, ids, n, range);
  const people = staff.filter((u) => u.id !== user.id);
  return (
    <>
      <KpiStrip items={k2} />
      <div className="dash-grid">
        <AttentionPanel items={attention(scope, db.extensions, n, user, reviewers).filter((i) => i.severity !== 'medium' || i.task.level >= 1)} title="Critical attention queue" />
        <HealthCard h={health(scope, n)} title="Organization health" base="/tasks/team" />
      </div>
      <div className="dash-grid">
        <FunnelCard data={funnel(scope, db.escalations, n, range)} range={range} title="Escalation pyramid" />
        <Card title="Department workload" sub="Active tasks per department; click to drill into teams">
          <ColumnChart categories={deptRows.map((r) => r.name)} series={[{ name: 'On track / at risk', values: deptRows.map((r) => r.active - r.overdue - Math.max(0, r.escalated - r.overdue)), tone: 'series-1' }, { name: 'Escalated', values: deptRows.map((r) => Math.max(0, r.escalated - r.overdue)), tone: 'series-warn' }, { name: 'Overdue', values: deptRows.map((r) => r.overdue), tone: 'series-danger' }]} label="Department workload" stacked height={170} />
          <ul className="drill">
            {db.departments.filter((x) => !dept || x.id === dept).map((x) => (
              <li key={x.id}>
                <strong>{x.name}</strong>
                {db.teams.filter((t) => t.departmentId === x.id).map((t) => (
                  <Link key={t.id} to={`/tasks/team?team=${t.id}`} className="chip">
                    {t.name} <span className="muted">{scope.filter((s) => s.teamId === t.id && isOpen(s)).length}</span>
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="dash-grid">
        <TrendCard data={trend(scope, n, range)} range={range} title="Task completion trend" />
        <Card title={<>Escalation response <InfoTip text="Average hours from an L1+ escalation firing to its acknowledgement, by period. Only acknowledged escalations are counted." /></>} sub={`${resp.reduce((s, r) => s + r.count, 0)} acknowledged escalations`}>
          <LineChart categories={resp.map((r) => r.label)} series={[{ name: 'Avg hours to acknowledge', values: resp.map((r) => Math.round(r.hours * 10) / 10), tone: 'series-violet' }]} label="Escalation response trend" />
        </Card>
      </div>
      <div className="dash-grid three">
        <Card title={<>At-risk teams <InfoTip text="Teams ranked by (overdue + escalated) ÷ open tasks. A team appears only if it has at least one." /></>}>
          {atRisk.length === 0 ? (
            <p className="muted">No team has overdue or escalated work.</p>
          ) : (
            <ul className="risk-list">
              {atRisk.map((t) => (
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
          <Donut label="Active staff by role" data={(['ceo', 'cos', 'manager', 'lead', 'staff'] as const).map((r, i) => ({ label: ROLE_LABEL[r], value: staff.filter((u) => u.role === r && u.status === 'active').length, tone: `series-${i + 1}` }))} center={<><strong>{staff.filter((u) => u.status === 'active').length}</strong><small>active</small></>} />
        </Card>
        <Card title="Organization" actions={<Link to="/admin/org" className="link-btn">Open chart</Link>}>
          <OrgMini people={people} />
        </Card>
      </div>
      <div className="dash-grid">
        <WorkloadCard rows={workload(scope, people, n, range, db.settings.overloadThreshold)} threshold={db.settings.overloadThreshold} title="Staff workload" selectable />
        <Card title="Recent administrative activity" actions={<Link to="/admin/audit" className="link-btn">Audit log</Link>}>
          <ul className="feed">
            {d.recentAdmin.map((a) => (
              <li key={a.id}>
                <Avatar name={db.users.find((u) => u.id === a.actorId)?.name ?? 'TaskWatch'} size={26} />
                <div>
                  <span>
                    <strong>{db.users.find((u) => u.id === a.actorId)?.name ?? 'Demo'}</strong> {a.action.replace(/[._]/g, ' ')} {a.next && <span className="muted">→ {a.next}</span>}
                  </span>
                  <time className="muted small">{formatShort(a.at)}</time>
                </div>
              </li>
            ))}
            {d.recentAdmin.length === 0 && <li className="muted">No administrative changes yet.</li>}
          </ul>
        </Card>
      </div>
      <ActivityCard items={db.activities.filter((a) => ids.has(a.taskId)).sort((a, b) => b.at.localeCompare(a.at))} users={db.users} title="Recent operational activity" />
    </>
  );
}

function OrgMini({ people }: { people: User[] }) {
  const db = getDb();
  return (
    <ul className="org-mini">
      {db.departments.map((dpt) => {
        const head = db.users.find((u) => u.id === dpt.headId);
        return (
          <li key={dpt.id}>
            <div className="org-mini-dept">
              <Icon name="building" size={14} /> <strong>{dpt.name}</strong> <span className="muted small">{head?.name}</span>
            </div>
            <ul>
              {db.teams.filter((t) => t.departmentId === dpt.id).map((t) => {
                const members = people.filter((u) => u.teamId === t.id && u.status === 'active');
                const lead = db.users.find((u) => u.id === t.leadId);
                return (
                  <li key={t.id}>
                    <Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link> <span className="muted small">{members.length} people · lead {lead?.name ?? '—'}{lead && !lead.managerId ? ' (no manager)' : ''}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/** Work order: L3 Founder's Office escalations sit at the top of the dashboard for their recipients. */
function FoundersOfficeBanner() {
  const user = useMe();
  const db = getDb();
  if (!foundersOffice(db).includes(user.id)) return null;
  const open = db.escalations.filter((e) => e.level === 3 && e.status !== 'resolved' && e.recipientIds.includes(user.id));
  const taskIds = [...new Set(open.map((e) => e.taskId))];
  if (!taskIds.length) return null;
  const unacked = new Set(open.filter((e) => e.status === 'active').map((e) => e.taskId)).size;
  return (
    <section className="l3-banner" role="alert" aria-label="L3 Founder's Office escalations">
      <div className="l3-head">
        <span className="l3-badge"><Icon name="alert" size={15} /> L3 Founder's Office</span>
        <strong>{taskIds.length} task{taskIds.length > 1 ? 's' : ''} escalated to you</strong>
        <span className="small">{unacked} not yet acknowledged</span>
        <Link to="/escalations?level=3" className="btn btn-sm l3-btn">Review all</Link>
      </div>
      <ul>
        {taskIds.slice(0, 3).map((id) => {
          const t = db.tasks.find((x) => x.id === id)!;
          const ev = open.find((e) => e.taskId === id)!;
          return (
            <li key={id}>
              <Link to={`/tasks/${id}`}><span className="mono">{id}</span> {t.title}</Link>
              <span className="small">{db.users.find((u) => u.id === t.assigneeId)?.name} · {ev.reason === 'overdue' ? 'past due' : 'no update'} · since {relative(ev.at)}{ev.status === 'acknowledged' ? ' · acknowledged' : ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
