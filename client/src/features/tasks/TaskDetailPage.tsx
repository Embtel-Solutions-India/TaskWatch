import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LEVEL_LABEL, PRIORITY_LABEL } from '../../constants';
import { Icon, type IconName } from '../../components/icons';
import { Avatar, Banner, Button, Card, Empty, ErrorState, FilePicker, KV, LevelBadge, Menu, PriorityBadge, ProgressBar, Skeleton, StatusBadge, TabPanel, Tabs, Textarea, ConfirmDialog, Tag } from '../../components/ui';
import { useAction, useApi, useMe } from '../../hooks';
import { acknowledgeTask, addAttachments, addComment, attachmentUrl, deleteComment, editComment, getTask, publishTask, removeAttachment, startTask, type TaskDetail } from '../../services/api/tasks';
import { silenceThresholds } from '../../services/engine/escalation';
import { describeRecurrence } from '../../services/engine/recurrence';
import { getDb, now } from '../../services/mock/store';
import type { Activity, ActivityType, Comment, User } from '../../types';
import type { TaskView } from '../../services/api/base';
import { ACTIVE_STATUSES } from '../../types';
import { bytes, cx, dueLabel, formatDateTime, formatShort, hoursLabel, relative } from '../../utils/format';
import { AckEscalationDialog, CancelDialog, DiscardDialog, CompleteDialog, DecideExtensionDialog, ExtensionDialog, ProgressDialog, ReassignDialog, ReopenDialog, ReviewDialog, SubmitDialog, type DialogKind, RateDialog } from './TaskDialogs';

type Tab = 'activity' | 'details' | 'updates' | 'comments' | 'reviews' | 'files' | 'assignments' | 'escalations';

export function TaskDetailPage() {
  const { id = '' } = useParams();
  const q = useApi(['task', id], () => getTask(id));
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || q.data.task.id !== id) return <div className="page"><Skeleton rows={10} /></div>;
  return <TaskWorkspace d={q.data} />;
}

function TaskWorkspace({ d }: { d: TaskDetail }) {
  const t = d.task;
  const user = useMe();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState<Tab>('activity');
  const can = (a: string) => d.actions.includes(a as never);
  const name = (uid: string | null | undefined) => d.users.find((u) => u.id === uid)?.name ?? '—';
  const ack = useAction(acknowledgeTask, { success: 'Acknowledged. Repeat notifications are paused for 12 h; the escalation clock keeps running.' });
  const start = useAction(startTask, { success: 'Marked as in progress' });
  const publish = useAction(publishTask, { success: `${t.id} assigned` });
  const pendingExt = d.extensions.find((e) => e.status === 'pending');
  const lastReview = d.reviews.at(-1);
  const activeEsc = d.escalations.filter((e) => e.status !== 'resolved').sort((a, b) => b.level - a.level);
  /** Server mode acknowledges one event: the highest one this viewer may acknowledge (D-26). */
  const ackEventId = activeEsc.find((e) => e.canAck)?.id;
  const isAssignee = t.assigneeId === user.id;
  const running = ACTIVE_STATUSES.includes(t.status);
  const due = dueLabel(t.dueAt);
  const windows = silenceThresholds(t.priority, d.rules ?? getDb().rules);

  const primary: ReactNode[] = [];
  if (can('publish')) primary.push(<Button key="pub" variant="primary" icon="send" loading={publish.pending} onClick={() => publish.run(t.id)}>Assign now</Button>);
  if (can('acknowledge')) primary.push(<Button key="ack" variant={can('start') ? 'secondary' : 'primary'} icon="check" loading={ack.pending} onClick={() => ack.run(t.id)}>Acknowledge</Button>);
  if (can('start')) primary.push(<Button key="start" variant="primary" icon="play" loading={start.pending} onClick={() => start.run(t.id)}>Start work</Button>);
  if (can('progress')) primary.push(<Button key="prog" variant={can('start') ? 'secondary' : 'primary'} icon="arrow-up" onClick={() => setDialog('progress')}>Post update</Button>);
  if (can('submit')) primary.push(<Button key="sub" icon="review" onClick={() => setDialog('submit')}>Submit for review</Button>);
  if (can('complete')) primary.push(<Button key="done" icon="circle-check" onClick={() => setDialog('complete')}>Mark complete</Button>);
  if (can('review')) primary.push(<Button key="rev" variant="primary" icon="review" onClick={() => setDialog('review')}>Review submission</Button>);
  if (can('decide_extension')) primary.push(<Button key="dec" icon="clock" onClick={() => setDialog('decide')}>Decide extension</Button>);
  if (can('ack_escalation')) primary.push(<Button key="esc" icon="check" onClick={() => setDialog('ack_escalation')}>Acknowledge escalation</Button>);
  // D-133: the giver's own actions are buttons, not hidden in the menu.
  if (can('edit')) primary.push(<Button key="edit" variant="ghost" icon="edit" onClick={() => nav(`/tasks/${t.id}/edit`)}>Edit</Button>);
  if (can('reassign')) primary.push(<Button key="reas" variant="ghost" icon="users" onClick={() => setDialog('reassign')}>Reassign</Button>);
  if (can('discard')) primary.push(<Button key="disc" variant="ghost" icon="trash" onClick={() => setDialog('discard')}>Delete draft</Button>);
  else if (can('cancel')) primary.push(<Button key="canc" variant="ghost" icon="x" onClick={() => setDialog('cancel')}>Cancel task</Button>);
  if (can('rate')) primary.push(<Button key="rate" variant={t.awaitingRating ? 'primary' : 'secondary'} icon="check" onClick={() => setDialog('rate')}>Rate task</Button>);

  return (
    <div className="page task-page">
      <header className="task-head">
        <div className="task-head-main">
          <div className="task-head-meta">
            <span className="mono">{t.id}</span>
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            <LevelBadge level={t.level} acked={t.escalationAcked} long />
            {running && activeEsc[0] && <Tag tone={activeEsc[0].level >= 2 ? 'danger' : 'warn'}>{activeEsc[0].reason === 'overdue' ? 'Past due' : activeEsc[0].reason === 'blocked' ? 'Marked Blocked' : 'No assignee update'}</Tag>}
            {t.recurrenceId && <Tag tone="info"><Icon name="repeat" size={11} /> Recurring</Tag>}
            {t.reviewRequired && <Tag>Review required</Tag>}
            {t.awaitingRating && <Tag tone="warn">Awaiting rating{t.completedAt && withinRateWindow(t.completedAt) ? ' · rate within 3 working days' : ''}</Tag>}
          </div>
          <h1>{t.title}</h1>
          <p className="muted">
            Assigned to <strong>{name(t.assigneeId)}</strong> by <strong>{name(t.assignedBy)}</strong> · {t.status === 'completed' ? `completed ${relative(t.completedAt)}` : running || t.status === 'submitted' ? <span className={cx(due.overdue && 'tone-danger')}>{due.text}</span> : formatShort(t.dueAt)}
          </p>
        </div>
        <div className="task-head-side">
          <div className="task-head-actions">
            {primary}
            <Menu
              label="More actions"
              items={[
                can('request_extension') ? { label: 'Request extension', icon: 'clock', onClick: () => setDialog('extension') } : null,
                can('reopen') ? { label: 'Reopen', icon: 'rotate', onClick: () => setDialog('reopen') } : null,
                can('discard') && can('cancel') ? { label: 'Cancel instead', icon: 'x', danger: true, onClick: () => setDialog('cancel') } : null,
              ]}
            />
          </div>
          {/* Owner 2026-11-11: the level bar sits under the actions; the rest of the clock strip was removed. */}
          {running && t.levelInfo && (
            <div
              className="ladder-bar head-ladder"
              aria-label="Silence relative to escalation thresholds"
              title={`${hoursLabel(t.levelInfo.silentHours)} since the last update${t.levelInfo.next ? ` · next: ${LEVEL_LABEL[t.levelInfo.next.level]} ${relative(new Date(t.levelInfo.next.at).toISOString())}` : ''}`}
            >
              {windows.map((w, k) => (
                <span key={k} className={cx('ladder-step', `lvl-bg-${k}`, t.levelInfo!.silentHours >= w && 'hit')} title={`${LEVEL_LABEL[k]} at ${w} h`}>
                  L{k}
                  <small>{w}h</small>
                </span>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="banners">
        {isAssignee && running && !t.acknowledgedAt && <Banner tone="info" action={<Button size="sm" variant="primary" onClick={() => ack.run(t.id)}>Acknowledge</Button>}>Let {name(t.assignedBy)} know you've seen this task.</Banner>}
        {t.status === 'changes_requested' && lastReview?.comment && (
          <Banner tone="warn" icon="rotate">
            <strong>{lastReview.decision === 'rejected' ? 'Rejected' : 'Changes requested'}</strong> by {name(lastReview.reviewerId)}: “{lastReview.comment}”
          </Banner>
        )}
        {t.status === 'submitted' && lastReview && <Banner tone="info" icon="review">Round {lastReview.round} submitted {relative(lastReview.submittedAt)} — waiting for {name(t.reviewerId)}.</Banner>}
        {pendingExt && (
          <Banner tone="info" icon="clock" action={can('decide_extension') ? <Button size="sm" onClick={() => setDialog('decide')}>Decide</Button> : undefined}>
            Extension requested by {name(pendingExt.requestedBy)} to <strong>{formatDateTime(pendingExt.requestedDue)}</strong>: {pendingExt.reason}
          </Banner>
        )}
        {t.status === 'cancelled' && <Banner tone="danger" icon="circle-x">Cancelled: {t.cancelReason}</Banner>}
        {t.status === 'draft' && <Banner tone="info" icon="circle-dash">Draft — not yet visible to {name(t.assigneeId)}.</Banner>}
      </div>

      <div className="task-grid">
        <div className="task-main">
          <Card pad={false}>
            <Tabs
              label="Task workspace"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'activity', label: 'Activity' },
                // Owner 2026-11-11: the Details card is now a tab here, next to Activity.
                { id: 'details', label: 'Details', count: d.children.length || undefined },
                { id: 'updates', label: 'Progress', count: d.updates.length },
                { id: 'comments', label: 'Comments', count: d.comments.filter((c) => !c.deleted).length },
                { id: 'reviews', label: 'Reviews', count: d.reviews.length },
                { id: 'files', label: 'Files', count: d.attachments.length },
                { id: 'assignments', label: 'Assignment & extensions' },
                { id: 'escalations', label: 'Escalations', count: d.escalations.length },
              ]}
            />
            <div className="card-body">
              {tab === 'activity' && <TabPanel id="activity"><Timeline items={d.activities} users={d.users} /></TabPanel>}
              {tab === 'details' && (
                <TabPanel id="details">
                  <div className="prose">
                    {t.description ? <p>{t.description}</p> : <p className="muted">No description.</p>}
                    {t.instructions && (
                      <div className="instructions">
                        <strong>Instructions from {name(t.assignedBy)}</strong>
                        <p>{t.instructions}</p>
                      </div>
                    )}
                  </div>
                  {d.children.length > 0 && (
                    <div className="subtasks">
                      <h3>Sub-tasks</h3>
                      <ul>
                        {d.children.map((c) => (
                          <li key={c.id}>
                            <Link to={`/tasks/${c.id}`}>{c.id} · {c.title}</Link> <StatusBadge status={c.status} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </TabPanel>
              )}
              {tab === 'updates' && (
                <TabPanel id="updates">
                  {can('progress') && <Button icon="plus" onClick={() => setDialog('progress')} className="mb">Post update</Button>}
                  {d.updates.length === 0 ? (
                    <Empty icon="arrow-up" title="No progress updates yet">Only the assignee's progress updates reset the silence clock.</Empty>
                  ) : (
                    <ul className="updates">
                      {d.updates.map((u) => (
                        <li key={u.id}>
                          <div className="update-head">
                            <Avatar name={name(u.authorId)} size={24} />
                            <strong>{name(u.authorId)}</strong>
                            <span className="muted" title={formatDateTime(u.at)}>{relative(u.at)}</span>
                            <span className="update-pct">{u.percent}%</span>
                          </div>
                          <p>{u.message}</p>
                          <ProgressBar value={u.percent} />
                          {u.attachmentIds.length > 0 && (
                            <div className="update-files">
                              {u.attachmentIds.map((aid) => {
                                const a = d.attachments.find((x) => x.id === aid);
                                return a ? <FileChip key={aid} id={aid} name={a.name} size={a.size} /> : null;
                              })}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </TabPanel>
              )}
              {tab === 'comments' && <TabPanel id="comments"><Comments d={d} /></TabPanel>}
              {tab === 'reviews' && (
                <TabPanel id="reviews">
                  {d.reviews.length === 0 ? (
                    <Empty icon="review" title={t.reviewRequired ? 'Not yet submitted' : 'Review not required'}>{t.reviewRequired ? 'Submissions and decisions will be listed here.' : 'This task completes without review.'}</Empty>
                  ) : (
                    <ol className="reviews">
                      {d.reviews.map((r) => (
                        <li key={r.id}>
                          <div className="review-round">Round {r.round}</div>
                          <div>
                            <p><strong>{name(r.submittedBy)}</strong> submitted {formatDateTime(r.submittedAt)}</p>
                            <blockquote className="quote">{r.note}</blockquote>
                            {r.decision ? (
                              <p className={cx('review-decision', r.decision === 'approved' ? 'tone-ok' : 'tone-warn')}>
                                <Icon name={r.decision === 'approved' ? 'circle-check' : 'rotate'} size={14} /> {r.decision === 'approved' ? 'Approved' : r.decision === 'rejected' ? 'Rejected' : 'Changes requested'} by {name(r.reviewerId)} · {formatDateTime(r.decidedAt)}
                                {r.comment && <span className="review-comment">“{r.comment}”</span>}
                              </p>
                            ) : (
                              <p className="muted">Awaiting decision from {name(t.reviewerId)}.</p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabPanel>
              )}
              {tab === 'files' && <TabPanel id="files"><Files d={d} /></TabPanel>}
              {tab === 'assignments' && (
                <TabPanel id="assignments">
                  <h3 className="h3">Assignment history</h3>
                  <ol className="history">
                    {d.assignments.map((a) => (
                      <li key={a.id}>
                        <span className="muted">{formatDateTime(a.at)}</span>
                        <span>
                          {a.fromId ? <>{name(a.fromId)} → <strong>{name(a.toId)}</strong></> : <>Assigned to <strong>{name(a.toId)}</strong></>} by {name(a.byId)}
                          {a.reason && <small className="muted"> · {a.reason}</small>}
                        </span>
                      </li>
                    ))}
                    {d.assignments.length === 0 && <li className="muted">Not assigned yet (draft).</li>}
                  </ol>
                  <h3 className="h3">Extension requests</h3>
                  {d.extensions.length === 0 ? (
                    <p className="muted">None.</p>
                  ) : (
                    <ol className="history">
                      {d.extensions.map((e) => (
                        <li key={e.id}>
                          <span className="muted">{formatDateTime(e.at)}</span>
                          <span>
                            {name(e.requestedBy)} asked to move {formatShort(e.currentDue)} → <strong>{formatShort(e.requestedDue)}</strong> · <Tag tone={e.status === 'approved' ? 'ok' : e.status === 'rejected' ? 'danger' : 'warn'}>{e.status}</Tag>
                            <small className="muted"> {e.reason}</small>
                            {e.decidedBy && <small className="muted"> · {e.status} by {name(e.decidedBy)}{e.decisionNote ? `: ${e.decisionNote}` : ''}</small>}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabPanel>
              )}
              {tab === 'escalations' && (
                <TabPanel id="escalations">
                  <EscalationTimeline d={d} />
                </TabPanel>
              )}
            </div>
          </Card>
        </div>

        <aside className="task-side">
          <Card title="Overview">
            <KV
              items={[
                ['Assignee', <PersonRow key="a" user={d.users.find((u) => u.id === t.assigneeId)} />],
                ['Task giver', <PersonRow key="g" user={d.users.find((u) => u.id === t.assignedBy)} />],
                ['Reviewer', t.reviewRequired ? <PersonRow key="r" user={d.users.find((u) => u.id === t.reviewerId)} /> : <span className="muted">Not required</span>],
                ['Team', t.team?.name ?? '—'],
                ['Priority', PRIORITY_LABEL[t.priority]],
                ['Due', <span key="d" className={cx(due.overdue && running && 'tone-danger')}>{formatDateTime(t.dueAt)}</span>],
                ['Start', t.startAt ? formatDateTime(t.startAt) : '—'],
                ['Created', formatDateTime(t.createdAt)],
                ['Last updated', formatDateTime(t.updatedAt)],
                ['Acknowledged', t.acknowledgedAt ? <span key="ack"><Icon name="check" size={12} /> {formatDateTime(t.acknowledgedAt)}</span> : <span className="tone-warn">Not acknowledged</span>],
                ['Progress', <span key="p" className="row-gap"><ProgressBar value={t.progress} /> {t.progress}%</span>],
                ['Category', t.category],
                ...(measuredFacts(t, d.time) as [string, ReactNode][]),
                ...(d.recurrence ? ([['Recurrence', describeRecurrence(d.recurrence)]] as [string, ReactNode][]) : []),
                ...(d.parent ? ([['Parent', <Link key="pa" to={`/tasks/${d.parent.id}`}>{d.parent.id}</Link>]] as [string, ReactNode][]) : []),
              ]}
            />
          </Card>
        </aside>
      </div>

      {dialog === 'progress' && <ProgressDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'submit' && <SubmitDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'complete' && <CompleteDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'review' && <ReviewDialog task={t} submission={lastReview} onClose={() => setDialog(null)} />}
      {dialog === 'extension' && <ExtensionDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'decide' && pendingExt && <DecideExtensionDialog task={t} ext={pendingExt} onClose={() => setDialog(null)} />}
      {dialog === 'reassign' && <ReassignDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'cancel' && <CancelDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'discard' && <DiscardDialog task={t} onClose={() => setDialog(null)} onDone={() => nav('/tasks/assigned-by-me')} />}
      {dialog === 'reopen' && <ReopenDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'rate' && <RateDialog task={t} onClose={() => setDialog(null)} />}
      {dialog === 'ack_escalation' && <AckEscalationDialog task={t} eventId={ackEventId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function PersonRow({ user }: { user?: User }) {
  if (!user) return <span className="muted">—</span>;
  return (
    <span className="person">
      <Avatar name={user.name} size={20} inactive={user.status !== 'active'} />
      <span>
        {user.name}
        {user.status !== 'active' && <small className="muted"> (inactive)</small>}
      </span>
    </span>
  );
}

const ACT_ICON: Partial<Record<ActivityType, IconName>> = {
  created: 'plus',
  assigned: 'send',
  reassigned: 'users',
  status_changed: 'circle-half',
  due_changed: 'calendar',
  progress: 'arrow-up',
  acknowledged: 'check',
  extension_requested: 'clock',
  extension_decided: 'clock',
  comment: 'message',
  review_submitted: 'review',
  review_decided: 'review',
  escalated: 'alert',
  escalation_acknowledged: 'check',
  completed: 'circle-check',
  reopened: 'rotate',
  cancelled: 'circle-x',
  attachment_added: 'clip',
  attachment_removed: 'clip',
  edited: 'edit',
  rated: 'check',
};

/** PERF: the 3-working-day rating window after completion (display only; rating stays possible later). */
function withinRateWindow(completedAt: string): boolean {
  let d = new Date(completedAt);
  for (let left = 3; left > 0; ) {
    d = new Date(d.getTime() + 86_400_000);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return Date.now() < d.getTime();
}

/** PERF facts on the task page (server mode; the prototype has none). */
function measuredFacts(t: TaskView, time?: { worked: number; standard: number } | null): [string, ReactNode][] {
  const out: [string, ReactNode][] = [];
  if (t.target != null) out.push(['Target', `${t.achieved ?? 0} of ${t.target} ${t.unit ?? ''}`]);
  if (t.estimatedHours != null) out.push(['Estimated effort', `${t.estimatedHours} h`]);
  // D-125: working hours since the clock started (scheduled start, else assignment) against the standard.
  if (time) {
    const over = time.worked > time.standard;
    out.push(['Working time', <span key="wt" className={cx(over && 'tone-warn')}>{time.worked.toFixed(1)} h of {time.standard} h standard{over ? ` (+${Math.round(((time.worked - time.standard) / time.standard) * 100)} %)` : ''}</span>]);
  }
  if (t.purpose) out.push(['Purpose', t.purpose === 'revenue' ? 'Revenue-oriented' : 'Support']);
  if (t.result) out.push(['Result', t.result]);
  if (t.shortfallReason) out.push(['Shortfall / delay reason', `${t.shortfallReason}${t.shortfallAccepted == null ? '' : t.shortfallAccepted ? ' (accepted)' : ' (not accepted)'}`]);
  if (t.qualityScore != null) out.push(['Quality score', String(t.qualityScore)]);
  if (t.outcomeScore != null) out.push(['Outcome score', String(t.outcomeScore)]);
  return out;
}

function Timeline({ items, users }: { items: Activity[]; users: User[] }) {
  const [filter, setFilter] = useState<'all' | 'progress' | 'system'>('all');
  const list = items.filter((a) => filter === 'all' || (filter === 'progress' ? a.type === 'progress' : a.type === 'escalated' || a.actorId === null));
  return (
    <div>
      <div className="row-gap mb">
        {(['all', 'progress', 'system'] as const).map((f) => (
          <button key={f} type="button" className={cx('chip', filter === f && 'on')} onClick={() => setFilter(f)} aria-pressed={filter === f}>
            {f === 'all' ? 'Everything' : f === 'progress' ? 'Progress updates' : 'System & escalations'}
          </button>
        ))}
      </div>
      <ol className="timeline">
        {list.map((a) => (
          <li key={a.id} className={cx(`act-${a.type}`)}>
            <span className={cx('tl-icon', a.type === 'escalated' && `lvl-bg-${a.data?.level ?? 0}`)}>
              <Icon name={ACT_ICON[a.type] ?? 'circle'} size={12} />
            </span>
            <div className="tl-body">
              <span>
                <strong>{a.actorId ? users.find((u) => u.id === a.actorId)?.name ?? 'Unknown' : 'TaskWatch'}</strong> {a.text}
              </span>
              <time className="muted" dateTime={a.at} title={formatDateTime(a.at)}>
                {formatShort(a.at)}
              </time>
            </div>
          </li>
        ))}
        {list.length === 0 && <li className="muted">Nothing here yet.</li>}
      </ol>
    </div>
  );
}

function EscalationTimeline({ d }: { d: TaskDetail }) {
  const name = (uid: string | null) => d.users.find((u) => u.id === uid)?.name ?? '—';
  if (d.escalations.length === 0) return <Empty icon="shield" title="No escalations">This task has stayed within its update window and due date.</Empty>;
  const cycles = [...new Set(d.escalations.map((e) => e.cycle))];
  return (
    <div className="esc-timeline">
      <p className="muted small">Each level fires once per silence cycle. A progress update starts a new cycle; past-due levels remain until the due date moves or the task closes. History is never deleted.</p>
      {cycles.map((c, i) => (
        <section key={c} className="esc-cycle">
          <h4>
            Cycle {i + 1} · clock started {formatShort(c)}
          </h4>
          <ol>
            {d.escalations
              .filter((e) => e.cycle === c)
              .map((e) => (
                <li key={e.id} className={cx('esc-item', `esc-${e.status}`)}>
                  <LevelBadge level={e.level} long acked={e.status === 'acknowledged'} />
                  <div>
                    <span>
                      Reached {formatDateTime(e.at)} · {e.reason === 'overdue' ? 'past due' : e.reason === 'blocked' ? 'marked Blocked' : 'no update'} · to {e.recipientIds.map(name).join(', ')}{e.ccIds?.length ? `, cc ${e.ccIds.map(name).join(', ')}` : ''}
                    </span>
                    <small className="muted">
                      {e.status === 'active' && 'Active'}
                      {e.status === 'acknowledged' && `Acknowledged by ${name(e.ackBy)} · ${formatShort(e.ackAt)}${e.ackNote ? ` — “${e.ackNote}”` : ''}`}
                      {e.status === 'resolved' && `Resolved ${formatShort(e.resolvedAt)}`}
                    </small>
                  </div>
                </li>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function FileChip({ id, name, size }: { id: string; name: string; size: number }) {
  const url = attachmentUrl(id);
  const download = () => {
    const href = url ?? URL.createObjectURL(new Blob([`TaskWatch prototype placeholder for "${name}".\nThe original file was not stored: attachments live only in the browser tab where they were added.`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = url ? name : `${name}.placeholder.txt`;
    a.click();
  };
  return (
    <button type="button" className="file-chip" onClick={download} title={url ? 'Download' : 'Original not stored in this prototype; downloads a placeholder'}>
      <Icon name="file" size={13} /> {name} <span className="muted">{bytes(size)}</span>
    </button>
  );
}

function Files({ d }: { d: TaskDetail }) {
  const user = useMe();
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; mime: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const add = useAction(addAttachments, { success: 'Files attached (kept in this browser tab only).', onSuccess: () => setFiles([]) });
  const rm = useAction(removeAttachment, { success: 'Attachment removed', onSuccess: () => setConfirm(null) });
  const canAttach = d.actions.includes('attach');
  const name = (uid: string) => d.users.find((u) => u.id === uid)?.name ?? '—';
  const overseer = d.actions.includes('reassign') || d.actions.includes('edit');
  return (
    <div className="stack">
      {canAttach && (
        <div className="attach-row">
          <FilePicker files={files} onChange={setFiles} label="Choose files" />
          {files.length > 0 && <Button variant="primary" size="sm" loading={add.pending} onClick={() => add.run(d.task.id, files)}>Upload {files.length}</Button>}
        </div>
      )}
      {d.attachments.length === 0 ? (
        <Empty icon="clip" title="No attachments" />
      ) : (
        <table className="table compact">
          <caption className="sr-only">Attachments</caption>
          <thead>
            <tr>
              <th>File</th>
              <th>Size</th>
              <th>Uploaded by</th>
              <th>Date</th>
              <th className="right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {d.attachments.map((a) => {
              const url = attachmentUrl(a.id);
              const previewable = url && (a.mime.startsWith('image/') || a.mime === 'application/pdf' || a.mime.startsWith('text/'));
              return (
                <tr key={a.id}>
                  <td data-label="File"><Icon name="file" size={13} /> {a.name} <small className="muted">· {a.context}</small></td>
                  <td data-label="Size">{bytes(a.size)}</td>
                  <td data-label="Uploaded by">{name(a.uploadedBy)}</td>
                  <td data-label="Date">{formatShort(a.at)}</td>
                  <td className="right" data-label="Actions">
                    <span className="row-gap end">
                      {previewable && <Button size="sm" variant="ghost" icon="eye" onClick={() => setPreview({ url: url!, name: a.name, mime: a.mime })}>Preview</Button>}
                      <FileChip id={a.id} name="Download" size={a.size} />
                      {(a.uploadedBy === user.id || overseer) && <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${a.name}`} onClick={() => setConfirm(a.id)} />}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">Prototype: files are not uploaded or stored on any server. Seeded files are placeholders.</p>
      {preview && (
        <ConfirmDialog open onClose={() => setPreview(null)} onConfirm={() => setPreview(null)} title={preview.name} confirmLabel="Close">
          {preview.mime.startsWith('image/') ? <img src={preview.url} alt={preview.name} className="preview-img" /> : <iframe src={preview.url} title={preview.name} className="preview-frame" />}
        </ConfirmDialog>
      )}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => rm.run(confirm!)} title="Remove attachment?" danger confirmLabel="Remove" loading={rm.pending}>
        <p>The file is removed from the task. The removal is recorded in the activity log.</p>
      </ConfirmDialog>
    </div>
  );
}

function Comments({ d }: { d: TaskDetail }) {
  const user = useMe();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const add = useAction(addComment, { success: 'Comment added', onSuccess: () => (setBody(''), setFiles([]), setReplyTo(null)) });
  const edit = useAction(editComment, { success: 'Comment updated', onSuccess: () => setEditing(null) });
  const del = useAction(deleteComment, { success: 'Comment deleted', onSuccess: () => setConfirm(null) });
  const name = (uid: string) => d.users.find((u) => u.id === uid)?.name ?? '—';
  const roots = d.comments.filter((c) => !c.parentId).sort((a, b) => a.at.localeCompare(b.at));
  const replies = (id: string) => d.comments.filter((c) => c.parentId === id).sort((a, b) => a.at.localeCompare(b.at));

  const renderComment = (c: Comment, nested = false) => (
    <li key={c.id} className={cx('comment', nested && 'nested')}>
      <Avatar name={name(c.authorId)} size={26} />
      <div className="comment-body">
        <div className="comment-head">
          <strong>{name(c.authorId)}</strong>
          <span className="muted" title={formatDateTime(c.at)}>{relative(c.at)}{c.editedAt && ' · edited'}</span>
        </div>
        {c.deleted ? (
          <p className="muted"><em>Comment deleted.</em></p>
        ) : editing?.id === c.id ? (
          <form className="stack-sm" onSubmit={(e) => (e.preventDefault(), edit.run(c.id, editing.body))}>
            <Textarea aria-label="Edit comment" rows={3} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
            <div className="row-gap">
              <Button size="sm" type="submit" variant="primary" loading={edit.pending}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <p className="comment-text">{c.body}</p>
        )}
        {!c.deleted && editing?.id !== c.id && (
          <div className="comment-actions">
            {!nested && <button type="button" className="link-btn" onClick={() => setReplyTo(c.id)}>Reply</button>}
            {c.authorId === user.id && <button type="button" className="link-btn" onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>}
            {(c.authorId === user.id || user.role === 'cos') && <button type="button" className="link-btn danger" onClick={() => setConfirm(c.id)}>Delete</button>}
          </div>
        )}
      </div>
    </li>
  );

  return (
    <div className="stack">
      <Banner tone="info">Comments are for discussion and don't reset the escalation clock. Use <strong>Post update</strong> to report progress. Mention someone with @Full Name.</Banner>
      <ul className="comments">
        {roots.map((c) => (
          <li key={c.id} className="thread">
            <ul>{renderComment(c)}</ul>
            {replies(c.id).length > 0 && <ul className="replies">{replies(c.id).map((r) => renderComment(r, true))}</ul>}
          </li>
        ))}
        {roots.length === 0 && <li className="muted">No comments yet.</li>}
      </ul>
      {d.actions.includes('comment') && (
        <form className="comment-form" noValidate onSubmit={(e) => (e.preventDefault(), add.run(d.task.id, { body, parentId: replyTo, files }))}>
          {replyTo && (
            <div className="replying">
              Replying to {name(d.comments.find((c) => c.id === replyTo)?.authorId ?? '')}
              <button type="button" className="link-btn" onClick={() => setReplyTo(null)}>Cancel reply</button>
            </div>
          )}
          <Textarea aria-label="Write a comment" rows={3} placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} invalid={!!add.fields.body} />
          {add.fields.body && <span className="field-msg">{add.fields.body}</span>}
          <div className="row-between">
            <FilePicker files={files} onChange={setFiles} label="Attach" />
            <Button type="submit" variant="primary" loading={add.pending}>{replyTo ? 'Reply' : 'Comment'}</Button>
          </div>
        </form>
      )}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => del.run(confirm!)} title="Delete comment?" danger confirmLabel="Delete" loading={del.pending}>
        <p>The comment text is removed. A record that it existed stays in the audit log.</p>
      </ConfirmDialog>
    </div>
  );
}
