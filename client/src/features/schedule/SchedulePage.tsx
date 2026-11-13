// ADR-0014 / US-01, US-04: one day's scheduled work. "My day" groups the viewer's tasks; "My team" shows each person
// below the viewer as a timeline of scheduled windows, with overlaps outlined and late work in red.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PRIORITY_LABEL } from '../../constants';
import { Card, Empty, ErrorState, Field, Input, PageHeader, Skeleton, Tag } from '../../components/ui';
import { useApi, useAuth, useMe } from '../../hooks';
import { getSchedule, type ScheduleDay } from '../../services/api/tasks';
import { getDb, now } from '../../services/mock/store';
import { reportsOf } from '../../services/authz/permissions';
import { BACKEND } from '../../services/http';
import { ACTIVE_STATUSES } from '../../types';
import { cx, toDateInput } from '../../utils/format';

type Item = ScheduleDay['people'][number]['tasks'][number];
const H = 3_600_000;

const time = (iso: string, zone: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(iso));

/** Upcoming / Active / Overdue / Completed (US-04); handed-in work counts as completed for the assignee. */
function group(t: Item, at: number): 'Upcoming' | 'Active' | 'Overdue' | 'Completed' {
  if (t.status === 'completed' || t.status === 'submitted') return 'Completed';
  if (ACTIVE_STATUSES.includes(t.status) && Date.parse(t.dueAt) <= at) return 'Overdue';
  if (t.status === 'assigned' && t.startAt && Date.parse(t.startAt) > at) return 'Upcoming';
  return 'Active';
}

export function SchedulePage() {
  const me = useMe();
  const auth = useAuth();
  const supervises = BACKEND === 'server' ? (auth.bootstrap?.user.reportCount ?? 0) > 0 : reportsOf(getDb(), me.id).size > 0;
  const [date, setDate] = useState(toDateInput(now()));
  const [teamPicked, setTeam] = useState(false);
  const team = teamPicked && supervises; // a person with no reports always sees their own day
  const q = useApi(['schedule', date, team], () => getSchedule(date, { team }));
  const at = now();
  return (
    <div className="page">
      <PageHeader title="Schedule" description="Scheduled start and due times. Starting earlier or later never moves a due time." />
      <div className="filters">
        <Field label="Day" htmlFor="sch-date">
          <Input id="sch-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {supervises && (
          <div className="seg" role="group" aria-label="Whose schedule">
            <button type="button" className={cx('seg-btn', !team && 'is-on')} aria-pressed={!team} onClick={() => setTeam(false)}>
              My day
            </button>
            <button type="button" className={cx('seg-btn', team && 'is-on')} aria-pressed={team} onClick={() => setTeam(true)}>
              My team
            </button>
          </div>
        )}
      </div>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data ? (
        <Skeleton rows={6} />
      ) : team ? (
        <Card title="Team day" sub="Each bar is a scheduled window (start → due) in that person's time zone. Outlined bars overlap another task.">
          {q.data.people.length === 0 && <Empty title="No one below you in the reporting line" />}
          <div className="sch-team">
            {q.data.people.map((p) => (
              <div key={p.userId} className="sch-row">
                <div className="sch-name">{p.name}</div>
                <div className="sch-track" aria-label={`${p.name}: ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}`}>
                  {p.tasks.map((t) => {
                    const from = Date.parse(`${date}T00:00`);
                    const s = t.startAt ? Date.parse(t.startAt) : Date.parse(t.dueAt) - H;
                    const left = Math.max(0, ((s - from) / (24 * H)) * 100);
                    const width = Math.max(1.5, Math.min(100 - left, ((Date.parse(t.dueAt) - Math.max(s, from)) / (24 * H)) * 100));
                    const late = group(t, at) === 'Overdue';
                    return (
                      <Link
                        key={t.id}
                        to={`/tasks/${t.id}`}
                        className={cx('sch-block', `prio-${t.priority}`, t.overlap && 'is-overlap', late && 'is-late')}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${t.title} · ${t.startAt ? time(t.startAt, p.timeZone) : '—'}–${time(t.dueAt, p.timeZone)}${t.overlap ? ' · overlaps another task' : ''}`}
                      >
                        <span>{t.title}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <MyDay day={q.data} at={at} />
      )}
    </div>
  );
}

function MyDay({ day, at }: { day: ScheduleDay; at: number }) {
  const p = day.people[0];
  if (!p || !p.tasks.length) return <Empty title="Nothing scheduled for this day" />;
  const groups = (['Overdue', 'Active', 'Upcoming', 'Completed'] as const).map((g) => [g, p.tasks.filter((t) => group(t, at) === g)] as const);
  return (
    <div className="grid-2">
      {groups.map(([g, items]) => (
        <Card key={g} title={`${g} (${items.length})`}>
          {items.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="sch-list">
              {items.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  <span className="muted small">
                    {' '}
                    {t.startAt ? `${time(t.startAt, p.timeZone)}–` : 'due '}
                    {time(t.dueAt, p.timeZone)} · {PRIORITY_LABEL[t.priority]}
                  </span>
                  {t.overlap && <Tag tone="warn">Overlaps</Tag>}
                  {t.submittedAt && <Tag tone={Date.parse(t.submittedAt) <= Date.parse(t.dueAt) ? 'ok' : 'danger'}>{Date.parse(t.submittedAt) <= Date.parse(t.dueAt) ? 'Handed in on time' : 'Handed in late'}</Tag>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
