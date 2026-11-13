// PERF pages (PERFORMANCE-FRD §6): team leaderboard, person breakdown, team workload. Server mode only.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BarList, LineChart } from '../../components/charts';
import { Avatar, Card, Empty, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, Stat, Tag } from '../../components/ui';
import { useApi, useCan, useMe } from '../../hooks';
import { BACKEND } from '../../services/http';
import { fmt, leaderboard, perfAnalytics, perfTeams, type Analytics, type LeaderRow, personBreakdown, SERVER_ONLY, teamWorkload, type BreakdownTask, type PeriodKind, type PeriodParams, type Weights } from '../../services/api/performance';
import { formatDate } from '../../utils/format';
import { PRIORITY_LABEL } from '../../constants';
import { PRIORITIES } from '../../types';

function ServerOnly({ title }: { title: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <Card>
        <Empty icon="chart" title={SERVER_ONLY} />
      </Card>
    </div>
  );
}

/** Period picker kept in the URL so a breakdown link keeps the same period. */
function usePeriod(): [PeriodParams, (p: PeriodParams) => void] {
  const [params, setParams] = useSearchParams();
  const p: PeriodParams = { period: (params.get('period') as PeriodKind) || 'month', from: params.get('from') ?? undefined, to: params.get('to') ?? undefined };
  return [p, (n) => setParams(Object.fromEntries(Object.entries({ ...Object.fromEntries(params), ...n }).filter(([, v]) => v)) as Record<string, string>)];
}

function PeriodPicker({ value, onChange }: { value: PeriodParams; onChange: (p: PeriodParams) => void }) {
  return (
    <div className="filters">
      <Segmented
        label="Period"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
        options={[
          { value: 'week', label: 'This week' },
          { value: 'month', label: 'This month' },
          { value: 'custom', label: 'Custom' },
        ]}
      />
      {value.period === 'custom' && (
        <>
          <Input type="date" aria-label="From" value={value.from ?? ''} onChange={(e) => onChange({ ...value, from: e.target.value })} />
          <Input type="date" aria-label="To" value={value.to ?? ''} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </div>
  );
}

/** Team picker over the boards the viewer may open; defaults to the first (the server lists only visible teams). */
function useTeam(): { teams: { id: number; name: string }[]; teamId: number | null; setTeamId: (id: number) => void; error: unknown } {
  const q = useApi(['perf-teams'], perfTeams);
  const [params, setParams] = useSearchParams();
  const teams = q.data ?? [];
  const teamId = Number(params.get('team')) || teams[0]?.id || null;
  return { teams, teamId, setTeamId: (id) => setParams({ ...Object.fromEntries(params), team: String(id) }), error: q.error };
}

function TeamSelect({ teams, teamId, onChange }: { teams: { id: number; name: string }[]; teamId: number | null; onChange: (id: number) => void }) {
  return (
    <Select aria-label="Department" value={teamId ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </Select>
  );
}

const periodQs = (p: PeriodParams) => new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

export function LeaderboardPage() {
  const me = useMe();
  const canDrill = useCan('view_team_reports');
  const [period, setPeriod] = usePeriod();
  const { teams, teamId, setTeamId, error: teamsError } = useTeam();
  const ready = BACKEND === 'server' && teamId !== null && (period.period !== 'custom' || (!!period.from && !!period.to));
  const q = useApi(['perf-board', teamId, period], () => (ready ? leaderboard(teamId!, period) : Promise.resolve(null)));
  const charts = useApi(['perf-analytics', teamId, period], () => (ready ? perfAnalytics(teamId!, period) : Promise.resolve(null)));
  if (BACKEND !== 'server') return <ServerOnly title="Team performance" />;
  if (teamsError || q.error) return <ErrorState error={(teamsError ?? q.error) as never} />;
  const board = q.data;
  return (
    <div className="page">
      <PageHeader
        title="Team performance"
        description="Ranked on the Performance score (Outcome 50 %, Quality 30 %, Timeliness 20 %) of the tasks due in the period. People are compared only with their own department."
        actions={teams.length > 1 ? <TeamSelect teams={teams} teamId={teamId} onChange={setTeamId} /> : undefined}
      />
      <PeriodPicker value={period} onChange={setPeriod} />
      {!teams.length ? (
        <Card>
          <Empty icon="users" title="You are not in a department yet" />
        </Card>
      ) : !board ? (
        <Skeleton rows={5} />
      ) : (
        <>
        <BoardVisuals rows={board.rows} analytics={charts.data ?? null} teamId={teamId} onTeam={setTeamId} canOpen={(id) => id === Number(me.id) || canDrill} periodQs={periodQs(period)} />
        <div className="table-card">
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Leaderboard for {board.team.name}</caption>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Employee</th>
                  <th className="right">Performance score</th>
                  <th className="right muted">Outcome</th>
                  <th className="right muted">Quality</th>
                  <th className="right muted">Timeliness</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.userId}>
                    <td data-label="Rank">{r.rank ?? <Tag tone="muted">{r.eligible > 0 && r.eligible < 5 ? 'Not ranked (fewer than 5 tasks)' : 'Not ranked'}</Tag>}</td>
                    <td data-label="Employee">
                      {r.userId === Number(me.id) || canDrill ? <Link to={`/performance/people/${r.userId}?${periodQs(period)}`}>{r.name}</Link> : r.name}{' '}
                      {r.flags.includes('no_quality_reviews') && <Tag tone="muted">No quality reviews</Tag>}
                    </td>
                    <td data-label="Performance score" className="right"><strong>{fmt(r.score)}</strong></td>
                    <td data-label="Outcome" className="right muted">{fmt(r.outcome)}</td>
                    <td data-label="Quality" className="right muted">{fmt(r.quality)}</td>
                    <td data-label="Timeliness" className="right muted">{fmt(r.timeliness)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ScoreRule weights={board.weights} />
        </div>
        </>
      )}
    </div>
  );
}

const MEDAL = ['1st', '2nd', '3rd'];
const weekLabel = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Leaderboard visuals: top-3 podium, everyone's Performance score, the team's weekly trend and, for management, teams side by side. */
function BoardVisuals({ rows, analytics, teamId, onTeam, canOpen, periodQs }: { rows: LeaderRow[]; analytics: Analytics | null; teamId: number | null; onTeam: (id: number) => void; canOpen: (userId: number) => boolean; periodQs: string }) {
  const nav = useNavigate();
  const top = rows.filter((r) => r.rank !== null).slice(0, 3);
  const scored = rows.filter((r) => r.score !== null).sort((a, b) => b.score! - a.score!);
  const weeks = analytics?.trend.filter((w) => w.average !== null) ?? [];
  const open = (userId: number) => canOpen(userId) && nav(`/performance/people/${userId}?${periodQs}`);
  return (
    <div className="dash-grid">
      <Card title="Top performers" sub="The three highest Performance scores among ranked people.">
        {top.length ? (
          <ol className="podium">
            {top.map((r, i) => (
              <li key={r.userId} className={`podium-${i + 1}`}>
                <span className="podium-medal">{MEDAL[i]}</span>
                <Avatar name={r.name} size={40} />
                {canOpen(r.userId) ? <Link to={`/performance/people/${r.userId}?${periodQs}`}>{r.name}</Link> : <strong>{r.name}</strong>}
                <span className="podium-score">{fmt(r.score)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty icon="chart" title="Nobody is ranked yet">People are ranked once they have 5 scored tasks due in the period.</Empty>
        )}
      </Card>
      <Card title="Performance scores" sub="Everyone with a score in the period, best first.">
        {scored.length ? (
          <BarList
            label="Performance score by person"
            data={scored.map((r) => ({ label: r.name, value: Math.round(r.score! * 10) / 10, tone: 'series-1', hint: r.rank ? `Rank ${r.rank}` : 'Not ranked' }))}
            format={(v) => v.toFixed(1)}
            max={100}
            onSelect={(d) => {
              const r = scored.find((x) => x.name === d.label);
              if (r) open(r.userId);
            }}
          />
        ) : (
          <Empty icon="chart" title="No scores yet">Scores appear once scored tasks fall due in the period.</Empty>
        )}
      </Card>
      <Card title="Score trend" sub="The team's average Performance score, week by week (last 8 weeks; weeks without scored tasks are skipped).">
        {weeks.length > 1 ? (
          <LineChart label="Team average Performance score by week" categories={weeks.map((w) => weekLabel(w.from))} series={[{ name: 'Team average', values: weeks.map((w) => w.average!), tone: 'series-1' }]} />
        ) : (
          <Empty icon="chart" title="Not enough history">The trend needs scores in at least two weeks.</Empty>
        )}
      </Card>
      {!!analytics?.teams.length && (
        <Card title="Department comparison" sub="Average Performance score per department in the period. Choose a department to open its board.">
          {analytics.teams.some((t) => t.average !== null) && (
            <BarList
              label="Average Performance score by department"
              data={analytics.teams.filter((t) => t.average !== null).map((t) => ({ label: t.name, value: t.average!, tone: t.id === teamId ? 'series-2' : 'series-1', hint: `${t.scored} of ${t.people} people scored` }))}
              format={(v) => v.toFixed(1)}
              max={100}
              onSelect={(d) => {
                const t = analytics.teams.find((x) => x.name === d.label);
                if (t) onTeam(t.id);
              }}
            />
          )}
          {/* A team without scores has no average; showing 0.0 would read as a failing score. */}
          {analytics.teams.some((t) => t.average === null) && (
            <p className="muted small">
              No scores yet:{' '}
              {analytics.teams
                .filter((t) => t.average === null)
                .map((t) => t.name)
                .join(', ')}
              .
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/** D-124 / D-173: the ranking rule and the weights in force, so both are visible wherever a score is shown. */
function ScoreRule({ weights }: { weights: Weights }) {
  return (
    <p className="muted small pad">
      Performance score = Outcome × 50 % + Quality × 30 % + Timeliness × 20 %; a part with no data yet is left out and the rest re-weighted.{' '}
      <strong>Outcome</strong> = Σ(task outcome × weight) ÷ Σ(weight); task outcome = achieved ÷ target, capped at 100 %, or the reviewer's rating when the task has no target; weights by priority: {PRIORITIES.map((p) => `${PRIORITY_LABEL[p]} ${weights[p]}`).join(' · ')} (set in Settings).{' '}
      <strong>Quality</strong> = accepted first time 100, minus 40 for each return for corrections (reviewed tasks only).{' '}
      <strong>Timeliness</strong> = 100 when on time; when late, 100 − hours late ÷ estimated hours × 100 (2 h late on a 4 h task = 50). A deadline moved by the task giver counts; the person's own extensions do not. Accepted shortfalls are left out. Figures rounded to one decimal.
    </p>
  );
}

const EXCLUDED: Record<NonNullable<BreakdownTask['excluded']>, string> = {
  not_due: 'Not due yet',
  accepted: 'Shortfall accepted: not counted',
  not_rated: 'Outcome not rated',
  reassigned_after_due: 'Reassigned after due: not in timeliness',
  pending_review: 'No quality review',
};

export function PersonPerformancePage() {
  const { id = '' } = useParams();
  const [period, setPeriod] = usePeriod();
  const ready = BACKEND === 'server' && (period.period !== 'custom' || (!!period.from && !!period.to));
  const q = useApi(['perf-person', id, period], () => (ready ? personBreakdown(id, period) : Promise.resolve(null)));
  if (BACKEND !== 'server') return <ServerOnly title="Performance" />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <div className="page">
      <PageHeader title={d ? `${d.person.name}: performance` : 'Performance'} description="The tasks behind each part of the score, and why any task is left out." />
      <PeriodPicker value={period} onChange={setPeriod} />
      {!d ? (
        <Skeleton rows={5} />
      ) : (
        <>
          <div className="stats">
            <Stat label="Performance score" value={fmt(d.score.score)} hint={d.score.ranked ? 'Ranks the leaderboard' : 'Not ranked'} />
            <Stat label="Outcome" value={fmt(d.score.outcome)} />
            <Stat label="Timeliness" value={fmt(d.score.timeliness)} />
            <Stat label="Quality" value={fmt(d.score.quality)} hint={d.score.flags.includes('no_quality_reviews') ? 'No quality reviews' : undefined} />
            <Stat label="Efficiency" value={fmt(d.score.efficiency)} hint={`Critical/High ${fmt(d.score.efficiencyByPressure.high)} · Normal/Low ${fmt(d.score.efficiencyByPressure.normal)}`} />
          </div>
          <div className="table-card">
            <div className="table-scroll">
              <table className="table">
                <caption className="sr-only">Tasks in the period</caption>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Due</th>
                    <th className="right">Outcome</th>
                    <th className="right">Weight</th>
                    <th className="right">Timeliness</th>
                    <th className="right">Quality</th>
                    <th className="right">Rework</th>
                    <th>Counted</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tasks.map((t) => (
                    <tr key={t.id}>
                      <td data-label="Task"><Link to={`/tasks/${t.id}`}>{t.title}</Link></td>
                      <td data-label="Due">{formatDate(t.dueAt)}</td>
                      <td data-label="Outcome" className="right">{fmt(t.outcome)}</td>
                      <td data-label="Weight" className="right">{t.weight}</td>
                      <td data-label="Timeliness" className="right">{t.timeliness >= 100 ? <Tag tone="ok">On time</Tag> : <><Tag tone="warn">Late</Tag> {fmt(t.timeliness)}</>}</td>
                      <td data-label="Quality" className="right">{fmt(t.quality)}</td>
                      <td data-label="Rework" className="right">{t.reworkCount}</td>
                      <td data-label="Counted">{t.excluded ? <Tag tone="muted">{EXCLUDED[t.excluded]}</Tag> : 'Yes'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!d.tasks.length && <Empty icon="inbox" title="No scored tasks due in this period" />}
            <ScoreRule weights={d.weights} />
          </div>
        </>
      )}
    </div>
  );
}

const BAND_TONE = { light: 'muted', normal: 'ok', overloaded: 'danger' } as const;

export function WorkloadPage() {
  const { teams, teamId, setTeamId, error: teamsError } = useTeam();
  const q = useApi(['perf-workload', teamId], () => (BACKEND === 'server' && teamId !== null ? teamWorkload(teamId) : Promise.resolve(null)));
  if (BACKEND !== 'server') return <ServerOnly title="Workload" />;
  if (teamsError || q.error) return <ErrorState error={(teamsError ?? q.error) as never} />;
  const d = q.data;
  return (
    <div className="page">
      <PageHeader
        title="Workload"
        description="Estimated hours of open work due in the next 5 working days, against working hours. Under 50% light, 50–100% normal, over 100% overloaded."
        actions={teams.length > 1 ? <TeamSelect teams={teams} teamId={teamId} onChange={setTeamId} /> : undefined}
      />
      {!teams.length ? (
        <Card>
          <Empty icon="users" title="You are not in a department yet" />
        </Card>
      ) : !d ? (
        <Skeleton rows={5} />
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Workload for {d.team.name}</caption>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th className="right">Load (5 working days)</th>
                  <th className="right">Open hours</th>
                  <th className="right">Critical/High share</th>
                  <th className="right">Overdue</th>
                  <th className="right">Blocked</th>
                  <th className="right">No estimate</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.userId}>
                    <td data-label="Employee">{r.name}</td>
                    <td data-label="Load" className="right">
                      {Math.round(r.loadPercent)}% <Tag tone={BAND_TONE[r.band]}>{r.band}</Tag>
                    </td>
                    <td data-label="Open hours" className="right">{r.openHours}</td>
                    <td data-label="Critical/High share" className="right">{Math.round(r.highShare)}%</td>
                    <td data-label="Overdue" className="right">{r.overdue}</td>
                    <td data-label="Blocked" className="right">{r.blocked}</td>
                    <td data-label="No estimate" className="right">{r.noEstimate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

