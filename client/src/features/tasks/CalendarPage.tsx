import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, ErrorState, IconButton, PageHeader, Segmented, StatusBadge, LevelBadge } from '../../components/ui';
import { useApi, useCan, useMe } from '../../hooks';
import { listTasks } from '../../services/api/tasks';
import { now } from '../../services/mock/store';
import { CLOSED_STATUSES } from '../../types';
import { cx, formatDate } from '../../utils/format';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function CalendarPage() {
  const user = useMe();
  const supervises = useCan('view_tasks');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [showClosed, setShowClosed] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const d = new Date(now());
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const q = useApi(['tasks', scope === 'mine' ? 'mine' : 'all', user.id], () => listTasks(scope === 'mine' ? 'mine' : 'all'));
  const rows = (q.data ?? []).filter((t) => t.status !== 'draft' && (showClosed || !CLOSED_STATUSES.includes(t.status)));

  const byDay = useMemo(() => {
    const m = new Map<string, typeof rows>();
    for (const t of rows) {
      const k = key(new Date(t.dueAt));
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [rows]);

  const first = new Date(cursor);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = key(new Date(now()));
  const monthTasks = rows.filter((t) => {
    const d = new Date(t.dueAt);
    return d.getMonth() === cursor.getMonth() && d.getFullYear() === cursor.getFullYear();
  }).sort((a, b) => a.dueAt.localeCompare(b.dueAt));

  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="page">
      <PageHeader
        title="Task Calendar"
        description="Tasks by due date."
        actions={
          <>
            {supervises && <Segmented label="Scope" value={scope} onChange={setScope} options={[{ value: 'mine', label: 'My tasks' }, { value: 'all', label: 'Everything I can see' }]} />}
            <label className="check inline">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> <span>Show closed</span>
            </label>
          </>
        }
      />
      <div className="cal-nav">
        <IconButton icon="chevron-left" label="Previous month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} />
        <h2>{cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
        <IconButton icon="chevron-right" label="Next month" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} />
        <Button size="sm" onClick={() => setCursor(new Date(new Date(now()).getFullYear(), new Date(now()).getMonth(), 1))}>
          Today
        </Button>
        <span className="muted">{monthTasks.length} task(s) due this month</span>
      </div>
      <div className="calendar" role="grid" aria-label="Month calendar">
        <div className="cal-row cal-head" role="row">
          {DAYS.map((d) => (
            <div key={d} role="columnheader">
              {d}
            </div>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, w) => (
          <div className="cal-row" role="row" key={w}>
            {cells.slice(w * 7, w * 7 + 7).map((d) => {
              const list = byDay.get(key(d)) ?? [];
              return (
                <div key={key(d)} role="gridcell" className={cx('cal-cell', d.getMonth() !== cursor.getMonth() && 'other', key(d) === today && 'today')} aria-label={`${formatDate(d.toISOString())}, ${list.length} task(s)`}>
                  <span className="cal-date">{d.getDate()}</span>
                  {list.slice(0, 3).map((t) => (
                    <Link key={t.id} to={`/tasks/${t.id}`} className={cx('cal-task', `pr-${t.priority}`, t.overdue && 'overdue', CLOSED_STATUSES.includes(t.status) && 'closed')} title={`${t.id} · ${t.title}`}>
                      {t.title}
                    </Link>
                  ))}
                  {list.length > 3 && <span className="cal-more">+{list.length - 3} more</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <section className="cal-list" aria-label="Tasks due this month">
        <h2 className="h3">Due this month</h2>
        <ul>
          {monthTasks.map((t) => (
            <li key={t.id}>
              <span className="mono">{formatDate(t.dueAt)}</span>
              <Link to={`/tasks/${t.id}`}>{t.title}</Link>
              <StatusBadge status={t.status} />
              {t.level >= 0 && <LevelBadge level={t.level} />}
            </li>
          ))}
          {monthTasks.length === 0 && <li className="muted">Nothing due this month.</li>}
        </ul>
      </section>
    </div>
  );
}
