import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorState, PageHeader, PriorityBadge, Segmented, Skeleton, Tag, Button, LevelBadge } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { listExtensions, listReviewQueue } from '../../services/api/admin';
import { getDb } from '../../services/mock/store';
import { BACKEND } from '../../services/http';
import { formatDateTime, formatShort, relative } from '../../utils/format';
import { DecideExtensionDialog, ReviewDialog } from '../tasks/TaskDialogs';

export function ReviewsPage() {
  const user = useMe();
  const q = useApi(['reviews', user.id], listReviewQueue);
  const [open, setOpen] = useState<string | null>(null);
  const db = getDb();
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data ?? [];
  const current = rows.find((r) => r.task.id === open);
  // ponytail: "recent decisions" reads the prototype store; the server has no such list yet, so it is hidden in server mode.
  const recent = BACKEND === 'server' ? [] : db.reviews.filter((r) => r.reviewerId === user.id && r.decidedAt).sort((a, b) => b.decidedAt!.localeCompare(a.decidedAt!)).slice(0, 8);
  return (
    <div className="page">
      <PageHeader title="Reviews" description="Work submitted to you for approval. You cannot review your own work." />
      {q.isLoading && !q.data ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon="review" title="Nothing waiting for review">Submissions from your team will appear here.</Empty>
        </Card>
      ) : (
        <div className="queue">
          {rows.map(({ task, submission }) => (
            <article key={task.id} className="queue-item">
              <div className="queue-main">
                <div className="row-gap">
                  <span className="mono">{task.id}</span>
                  <PriorityBadge priority={task.priority} />
                  <Tag>Round {submission.round}</Tag>
                </div>
                <h3>
                  <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                </h3>
                <p className="muted small">
                  {task.assignee?.name} submitted {relative(submission.submittedAt)} · due {formatShort(task.dueAt)}
                </p>
                <blockquote className="quote">{submission.note}</blockquote>
              </div>
              <div className="queue-actions">
                <Button variant="primary" icon="review" onClick={() => setOpen(task.id)}>
                  Review
                </Button>
                <Link className="btn btn-ghost" to={`/tasks/${task.id}`}>
                  Open task
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <Card title="Your recent decisions">
          <ul className="history">
            {recent.map((r) => (
              <li key={r.id}>
                <span className="muted">{formatDateTime(r.decidedAt)}</span>
                <span>
                  <Link to={`/tasks/${r.taskId}`}>{r.taskId}</Link> round {r.round} · <Tag tone={r.decision === 'approved' ? 'ok' : 'warn'}>{r.decision?.replace('_', ' ')}</Tag>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {current && <ReviewDialog task={current.task} submission={current.submission} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function ExtensionsPage() {
  const user = useMe();
  const q = useApi(['extensions', user.id], listExtensions);
  const [filter, setFilter] = useState<'pending' | 'decided' | 'all'>('pending');
  const [open, setOpen] = useState<string | null>(null);
  const db = getDb();
  if (q.error) return <ErrorState error={q.error} />;
  const rows = (q.data ?? []).filter((r) => filter === 'all' || (filter === 'pending' ? r.ext.status === 'pending' : r.ext.status !== 'pending'));
  const current = (q.data ?? []).find((r) => r.ext.id === open);
  const name = (id: string | null) =>
    BACKEND === 'server' ? (q.data ?? []).flatMap((r) => [r.task.assignee, r.task.giver]).find((u) => u?.id === id)?.name ?? '—' : (db.users.find((u) => u.id === id)?.name ?? '—');
  return (
    <div className="page">
      <PageHeader title="Due-date extensions" description="Requests in your scope. The due date only changes after approval, and the decision is audited." />
      <Segmented
        label="Filter"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'pending', label: 'Pending', count: (q.data ?? []).filter((r) => r.ext.status === 'pending').length },
          { value: 'decided', label: 'Decided' },
          { value: 'all', label: 'All' },
        ]}
      />
      {q.isLoading && !q.data ? (
        <Skeleton rows={5} />
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon="clock" title={filter === 'pending' ? 'No pending requests' : 'No requests'} />
        </Card>
      ) : (
        <div className="queue">
          {rows.map(({ ext, task, canDecide }) => (
            <article key={ext.id} className="queue-item">
              <div className="queue-main">
                <div className="row-gap">
                  <span className="mono">{task.id}</span>
                  <PriorityBadge priority={task.priority} />
                  <LevelBadge level={task.level} />
                  <Tag tone={ext.status === 'approved' ? 'ok' : ext.status === 'rejected' ? 'danger' : 'warn'}>{ext.status}</Tag>
                </div>
                <h3>
                  <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                </h3>
                <p className="small">
                  <strong>{name(ext.requestedBy)}</strong> · {formatShort(ext.currentDue)} → <strong>{formatShort(ext.requestedDue)}</strong> · requested {relative(ext.at)}
                </p>
                <blockquote className="quote">{ext.reason}</blockquote>
                {ext.decidedBy && (
                  <p className="muted small">
                    {ext.status} by {name(ext.decidedBy)} {formatShort(ext.decidedAt)}
                    {ext.decisionNote && ` — ${ext.decisionNote}`}
                  </p>
                )}
              </div>
              <div className="queue-actions">
                {canDecide ? (
                  <Button variant="primary" onClick={() => setOpen(ext.id)}>
                    Decide
                  </Button>
                ) : ext.status === 'pending' ? (
                  <span className="muted small">{ext.requestedBy === user.id ? 'Your request' : 'Awaiting an authorized senior'}</span>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
      {current && <DecideExtensionDialog task={current.task} ext={current.ext} onClose={() => setOpen(null)} />}
    </div>
  );
}
