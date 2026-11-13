// US-05 / D-149: a floating countdown at the top centre for the assignee's next deadline, turning into an overdue
// timer once it passes. Shows one task (the most urgent) and lists the rest behind "+N more". It reads the person's
// own task list (refreshed with every other card) and server-adjusted time; it never moves a deadline.
import { nextCountdown, type CountdownItem } from '@taskwatch/shared/schedule';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/icons';
import { Popover } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { listTasks } from '../../services/api/tasks';
import { now } from '../../services/mock/store';

/** "09:42" left, or "+03:15" overdue; hours appear once past 60 minutes. */
export function clockText(ms: number): string {
  const s = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${ms < 0 ? '+' : ''}${h ? `${h}:` : ''}${mm}:${ss}`;
}

export function DeadlineTimer() {
  const me = useMe();
  const q = useApi(['tasks', 'mine'], () => listTasks('mine'));
  const [t, setT] = useState(now());
  const [collapsed, setCollapsed] = useState(false);
  const mine = (q.data ?? []).filter((x) => x.assigneeId === me.id).map((x) => ({ id: x.id, title: x.title, status: x.status, dueAt: Date.parse(x.dueAt) }));
  const { primary, others } = nextCountdown(mine, t);

  // Tick once a second only while something is shown.
  useEffect(() => {
    if (!primary) return;
    const id = setInterval(() => setT(now()), 1000);
    return () => clearInterval(id);
  }, [primary?.id]);
  // Re-check every 30 s so a task entering its last 10 minutes appears without a refresh.
  useEffect(() => {
    const id = setInterval(() => setT(now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // A new overdue task cannot stay hidden.
  useEffect(() => {
    if (primary?.overdue) setCollapsed(false);
  }, [primary?.id, primary?.overdue]);

  if (!primary) return null;
  const announce = primary.overdue ? `${primary.title} is overdue` : `${primary.title} is due in under 10 minutes`;

  if (collapsed) {
    return (
      <button type="button" className="deadline-dot" onClick={() => setCollapsed(false)} aria-label={`Show the deadline timer: ${announce}`}>
        <Icon name="clock" size={14} />
      </button>
    );
  }
  return (
    <div className={`deadline-timer${primary.overdue ? ' is-overdue' : ''}`} role="status">
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <Icon name="clock" size={15} />
      <Link to={`/tasks/${primary.id}`} className="deadline-title" title={primary.title}>
        {primary.title}
      </Link>
      <span className="deadline-clock" aria-hidden>
        {clockText(primary.msLeft)}
        {primary.overdue && <small> overdue</small>}
      </span>
      {others.length > 0 && (
        <Popover
          align="end"
          trigger={({ toggle, open, id }) => (
            <button type="button" className="deadline-more" onClick={toggle} aria-expanded={open} aria-controls={id}>
              +{others.length} more
            </button>
          )}
        >
          {(close) => (
            <ul className="menu deadline-list">
              {others.map((o: CountdownItem) => (
                <li key={o.id}>
                  <Link to={`/tasks/${o.id}`} className={`menu-item${o.overdue ? ' is-overdue' : ''}`} onClick={close}>
                    <span className="deadline-title">{o.title}</span>
                    <span className="deadline-clock">{clockText(o.msLeft)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      )}
      {!primary.overdue && (
        <button type="button" className="deadline-hide" onClick={() => setCollapsed(true)} aria-label="Hide the deadline timer">
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
