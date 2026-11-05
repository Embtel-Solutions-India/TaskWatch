import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LEVEL_LABEL, LEVEL_SHORT, NOTIFICATION_LABEL } from '../../constants';
import { ColumnChart, Heatmap, LineChart, Sparkline } from '../../components/charts';
import { Icon } from '../../components/icons';
import { Avatar, Card, Empty, InfoTip, LevelBadge, PriorityBadge, Segmented, StatusBadge } from '../../components/ui';
import type { TaskView } from '../../services/api/base';
import type { Activity, User } from '../../types';
import { cx, formatShort, relative } from '../../utils/format';
import { HEALTH_HELP, type AttentionItem, type Health, type Kpi, type Range, type TrendPoint, type WorkloadRow } from './insights';

export function KpiStrip({ items }: { items: Kpi[] }) {
  return (
    <div className="kpis">
      {items.map((k) => {
        const diff = k.prev === null ? null : k.raw - k.prev;
        const good = diff === null || diff === 0 ? null : (diff > 0) === (k.polarity === 'up-good');
        const fmt = (v: number) => (k.format === 'pct' ? `${Math.abs(Math.round(v * 100))} pts` : String(Math.abs(Math.round(v))));
        return (
          <Link key={k.key} to={k.to} className={cx('kpi', `kpi-${k.tone}`)}>
            <span className="kpi-label">
              {k.label}
              <InfoTip text={k.help} />
            </span>
            <span className="kpi-row">
              <span className="kpi-value">{k.value}</span>
              {k.spark.length > 1 && <Sparkline values={k.spark} label={`${k.label} trend`} />}
            </span>
            <span className="kpi-foot">
              {diff !== null ? (
                <span className={cx('delta', good === true && 'good', good === false && 'bad')}>
                  <Icon name={diff > 0 ? 'arrow-up' : diff < 0 ? 'arrow-down' : 'arrow'} size={11} />
                  {diff === 0 ? 'no change' : fmt(diff)}
                </span>
              ) : null}
              <span className="muted">{k.context}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function HealthCard({ h, title = 'Operational health', base }: { h: Health; title?: string; base: string }) {
  const nav = useNavigate();
  const total = h.onTrack.length + h.atRisk.length + h.overdue.length + h.escalated.length;
  const segs = [
    { k: 'On track', v: h.onTrack.length, c: 'seg-ok', to: `${base}?level=none` },
    { k: 'At risk', v: h.atRisk.length, c: 'seg-warn', to: `${base}?level=0` },
    { k: 'Escalated', v: h.escalated.length, c: 'seg-esc', to: '/escalations' },
    { k: 'Overdue', v: h.overdue.length, c: 'seg-danger', to: `${base}?due=overdue` },
  ];
  const healthy = total ? Math.round((h.onTrack.length / total) * 100) : 100;
  return (
    <Card title={<>{title} <InfoTip text={HEALTH_HELP} /></>} sub={`${total} open tasks`}>
      <div className="health">
        <div className="health-score">
          <span className="health-num">{healthy}%</span>
          <span className="muted">on track</span>
        </div>
        <div className="health-bar" role="img" aria-label={segs.map((s) => `${s.k} ${s.v}`).join(', ')}>
          {segs.map((s) => (s.v ? <button key={s.k} type="button" className={cx('health-seg', s.c)} style={{ flexGrow: s.v }} onClick={() => nav(s.to)} title={`${s.k}: ${s.v}`} aria-label={`${s.k}: ${s.v} tasks`} /> : null))}
          {!total && <span className="health-seg seg-empty" style={{ flexGrow: 1 }} />}
        </div>
        <ul className="health-legend">
          {segs.map((s) => (
            <li key={s.k}>
              <Link to={s.to}>
                <span className={cx('swatch', s.c)} aria-hidden /> {s.k}
                <strong>{s.v}</strong>
                <small className="muted">{total ? Math.round((s.v / total) * 100) : 0}%</small>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function AttentionPanel({ items, title = 'Attention required', limit = 6 }: { items: AttentionItem[]; title?: string; limit?: number }) {
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, limit);
  return (
    <Card
      title={title}
      sub={items.length ? `${items.length} item(s), most severe first` : undefined}
      className="attention"
      actions={items.length > limit ? <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show all ${items.length}`}</button> : undefined}
    >
      {list.length === 0 ? (
        <Empty icon="circle-check" title="Nothing needs intervention">No overdue, unacknowledged or about-to-escalate tasks in your scope.</Empty>
      ) : (
        <ul className="attn-list">
          {list.map((i) => (
            <li key={i.key} className={cx('attn', `sev-${i.severity}`)}>
              <span className="attn-sev" aria-label={`Severity: ${i.severity}`}>
                <Icon name={i.severity === 'critical' ? 'alert' : i.severity === 'high' ? 'flag' : 'clock'} size={14} />
              </span>
              <div className="attn-body">
                <div className="attn-top">
                  <strong>{i.reason}</strong>
                  <span className="muted">· {i.detail}</span>
                  <LevelBadge level={i.task.level} acked={i.task.escalationAcked} />
                </div>
                <Link to={`/tasks/${i.task.id}`} className="attn-title">
                  <span className="mono">{i.task.id}</span> {i.task.title}
                </Link>
                <div className="attn-meta">
                  <Avatar name={i.task.assignee?.name ?? '?'} size={18} /> {i.task.assignee?.name} · due {formatShort(i.task.dueAt)}
                </div>
              </div>
              <Link to={`/tasks/${i.task.id}`} className="attn-action">
                {i.action} <Icon name="arrow" size={12} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function TrendCard({ data, range, title = 'Execution trend' }: { data: TrendPoint[]; range: Range; title?: string }) {
  const [mode, setMode] = useState<'line' | 'bars'>('line');
  const series = [
    { name: 'Created', values: data.map((d) => d.created), tone: 'series-1' },
    { name: 'Completed', values: data.map((d) => d.completed), tone: 'series-2' },
    { name: 'Became overdue', values: data.map((d) => d.overdue), tone: 'series-danger' },
  ];
  const totals = series.map((s) => s.values.reduce((a, b) => a + b, 0));
  return (
    <Card title={title} sub={`Last ${range} days · created ${totals[0]}, completed ${totals[1]}, became overdue ${totals[2]}`} actions={<Segmented label="Chart type" value={mode} onChange={setMode} options={[{ value: 'line', label: 'Line' }, { value: 'bars', label: 'Bars' }]} />}>
      {mode === 'line' ? <LineChart categories={data.map((d) => d.label)} series={series} label={title} /> : <ColumnChart categories={data.map((d) => d.label)} series={series} label={title} />}
    </Card>
  );
}

export function WorkloadCard({ rows, threshold, title = 'Workload', base = '/tasks/team', selectable }: { rows: WorkloadRow[]; threshold: number; title?: string; base?: string; selectable?: boolean }) {
  const [focus, setFocus] = useState('');
  const shown = (focus ? rows.filter((r) => r.id === focus) : rows).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.active + r.completed));
  return (
    <Card
      title={<>{title} <InfoTip text={`Bars show active (open) and completed tasks per person in the selected period. "Overloaded" means more than ${threshold} active tasks — the threshold is set in System Settings.`} /></>}
      sub={`${rows.filter((r) => r.overloaded).length} over the ${threshold}-task threshold`}
      actions={
        selectable ? (
          <select className="input select input-sm" aria-label="Team member" value={focus} onChange={(e) => setFocus(e.target.value)}>
            <option value="">All members</option>
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <Empty icon="users" title="No workload in scope" />
      ) : (
        <ul className="workload">
          {shown.map((r) => (
            <li key={r.id}>
              <Link to={`${base}?assignee=${r.id}`} className="wl-name">
                <Avatar name={r.name} size={26} />
                <span>
                  <strong>{r.name}</strong>
                  <small className="muted">{r.title}</small>
                </span>
              </Link>
              <div className="wl-bar" role="img" aria-label={`${r.active} active, ${r.overdue} overdue, ${r.completed} completed`}>
                <span className="wl-active" style={{ width: `${((r.active - r.overdue) / max) * 100}%` }} />
                <span className="wl-overdue" style={{ width: `${(r.overdue / max) * 100}%` }} />
                <span className="wl-done" style={{ width: `${(r.completed / max) * 100}%` }} />
                <span className="wl-threshold" style={{ left: `${(threshold / max) * 100}%` }} title={`Threshold: ${threshold}`} />
              </div>
              <span className="wl-nums">
                <strong>{r.active}</strong> active{r.overdue ? <span className="tone-danger"> · {r.overdue} overdue</span> : ''}
              </span>
              <span className={cx('pill', r.overloaded ? 'pill-danger' : r.overdue ? 'pill-warn' : 'pill-ok')}>
                <span className="pill-dot" />
                {r.overloaded ? 'Overloaded' : r.overdue ? 'Behind' : 'Balanced'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="legend-row">
        <span><i className="swatch wl-active" /> Active</span>
        <span><i className="swatch wl-overdue" /> Overdue</span>
        <span><i className="swatch wl-done" /> Completed (period)</span>
        <span><i className="swatch wl-th" /> Threshold</span>
      </div>
    </Card>
  );
}

export function FunnelCard({ data, range, title = 'Escalation funnel' }: { data: { level: number; count: number; share: number; triggered: number; prevTriggered: number }[]; range: Range; title?: string }) {
  const nav = useNavigate();
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <Card title={<>{title} <InfoTip text={`Open tasks currently at each level (a task counts once, at its highest level). "Triggered" counts escalation events that fired in the last ${range} days vs the ${range} days before.`} /></>} sub="Click a level to see those tasks">
      <div className="funnel">
        {data.map((d) => (
          <button key={d.level} type="button" className={cx('funnel-step', `lvl-bg-${d.level}`)} onClick={() => nav(`/escalations?level=${d.level}`)} aria-label={`${LEVEL_LABEL[d.level]}: ${d.count} tasks`}>
            <span className="funnel-lvl">{LEVEL_SHORT[d.level]}</span>
            <span className="funnel-track">
              <span className="funnel-fill" style={{ width: `${Math.max(d.count ? 6 : 0, (d.count / max) * 100)}%` }} />
            </span>
            <span className="funnel-count">{d.count}</span>
            <span className="funnel-share muted">{Math.round(d.share * 100)}%</span>
            <span className={cx('funnel-delta', d.triggered > d.prevTriggered ? 'bad' : d.triggered < d.prevTriggered ? 'good' : '')}>
              {d.triggered} triggered {d.triggered !== d.prevTriggered && <Icon name={d.triggered > d.prevTriggered ? 'arrow-up' : 'arrow-down'} size={10} />}
            </span>
          </button>
        ))}
      </div>
      <p className="muted small">{LEVEL_LABEL.join(' → ')}</p>
    </Card>
  );
}

export function ActivityCard({ items, users, title = 'Recent activity', limit = 8 }: { items: Activity[]; users: User[]; title?: string; limit?: number }) {
  const icon: Record<string, string> = { assigned: 'send', progress: 'arrow-up', acknowledged: 'check', extension_decided: 'clock', escalated: 'alert', review_decided: 'review', completed: 'circle-check', reassigned: 'users', created: 'plus', review_submitted: 'review', comment: 'message' };
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <Empty icon="clock" title="No recent activity" />
      ) : (
        <ol className="feed">
          {items.slice(0, limit).map((a) => {
            const actor = users.find((u) => u.id === a.actorId);
            return (
              <li key={a.id}>
                {actor ? <Avatar name={actor.name} size={26} /> : <span className="feed-sys"><Icon name={icon[a.type] ?? 'circle'} size={13} /></span>}
                <div>
                  <span>
                    <strong>{actor?.name ?? 'TaskWatch'}</strong> {a.text.charAt(0).toLowerCase() + a.text.slice(1)}{' '}
                    <Link to={`/tasks/${a.taskId}`} className="mono">
                      {a.taskId}
                    </Link>
                  </span>
                  <time className="muted small">{relative(a.at)}</time>
                </div>
                <span className={cx('feed-icon', a.type === 'escalated' && 'tone-danger', a.type === 'completed' && 'tone-ok')}>
                  <Icon name={icon[a.type] ?? 'circle'} size={13} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export function HeatmapCard({ grid, title = 'Update activity' }: { grid: number[][]; title?: string }) {
  const total = grid.flat().reduce((a, b) => a + b, 0);
  return (
    <Card title={<>{title} <InfoTip text="Progress updates posted in the last 4 weeks, by weekday and 3-hour block (local time). Shows when the team reports, not how much it works." /></>} sub={`${total} progress updates in 4 weeks`}>
      <Heatmap grid={grid} rows={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']} cols={['0', '3', '6', '9', '12', '15', '18', '21']} label={title} />
    </Card>
  );
}

export function TaskMiniList({ tasks, empty, showAssignee = true }: { tasks: TaskView[]; empty: string; showAssignee?: boolean }) {
  if (!tasks.length) return <p className="muted pad-sm">{empty}</p>;
  return (
    <ul className="mini-tasks">
      {tasks.map((t) => (
        <li key={t.id}>
          <PriorityBadge priority={t.priority} compact />
          <Link to={`/tasks/${t.id}`} className="mini-title">
            {t.title}
          </Link>
          {showAssignee && <span className="muted small">{t.assignee?.name}</span>}
          <StatusBadge status={t.status} />
          <span className={cx('small', t.overdue ? 'tone-danger' : 'muted')}>{t.overdue ? `${relative(t.dueAt).replace(' ago', '')} late` : relative(t.dueAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export { NOTIFICATION_LABEL };
