// PERF pages (PERFORMANCE-FRD §6): team leaderboard, person breakdown, team workload. Server mode only.
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Card, Empty, ErrorState, Input, PageHeader, Segmented, Select, Skeleton, Stat, Tag } from '../../components/ui';
import { useApi, useCan, useMe } from '../../hooks';
import { BACKEND } from '../../services/http';
import { fmt, leaderboard, perfTeams, personBreakdown, SERVER_ONLY, teamWorkload, type BreakdownTask, type PeriodKind, type PeriodParams } from '../../services/api/performance';
import { formatDate } from '../../utils/format';

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
    <Select aria-label="Team" value={teamId ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
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
  if (BACKEND !== 'server') return <ServerOnly title="Team performance" />;
  if (teamsError || q.error) return <ErrorState error={(teamsError ?? q.error) as never} />;
  const board = q.data;
  return (
    <div className="page">
      <PageHeader
        title="Team performance"
        description="Outcome, timeliness and quality of the tasks due in the period. People are compared only with their own team."
        actions={teams.length > 1 ? <TeamSelect teams={teams} teamId={teamId} onChange={setTeamId} /> : undefined}
      />
      <PeriodPicker value={period} onChange={setPeriod} />
      {!teams.length ? (
        <Card>
          <Empty icon="users" title="You are not in a team yet" />
        </Card>
      ) : !board ? (
        <Skeleton rows={5} />
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Leaderboard for {board.team.name}</caption>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Employee</th>
                  <th className="right">Outcome</th>
                  <th className="right">Timeliness</th>
                  <th className="right">Quality</th>
                  <th className="right">Score</th>
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
                    <td data-label="Outcome" className="right">{fmt(r.outcome)}</td>
                    <td data-label="Timeliness" className="right">{fmt(r.timeliness)}</td>
                    <td data-label="Quality" className="right">{fmt(r.quality)}</td>
                    <td data-label="Score" className="right"><strong>{fmt(r.score)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small pad">Score = Outcome × 50% + Timeliness × 20% + Quality × 30%. Figures rounded to one decimal.</p>
        </div>
      )}
    </div>
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
            <Stat label="Score" value={fmt(d.score.score)} hint={d.score.ranked ? undefined : 'Not ranked'} />
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
                    <th>On time</th>
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
                      <td data-label="On time">{t.onTime ? <Tag tone="ok">On time</Tag> : <Tag tone="warn">Late</Tag>}</td>
                      <td data-label="Quality" className="right">{fmt(t.quality)}</td>
                      <td data-label="Rework" className="right">{t.reworkCount}</td>
                      <td data-label="Counted">{t.excluded ? <Tag tone="muted">{EXCLUDED[t.excluded]}</Tag> : 'Yes'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!d.tasks.length && <Empty icon="inbox" title="No scored tasks due in this period" />}
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
          <Empty icon="users" title="You are not in a team yet" />
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

