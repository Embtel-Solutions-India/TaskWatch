import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NOTIFICATION_LABEL } from '../../constants';
import { Icon } from '../../components/icons';
import { Button, Card, Empty, ErrorState, PageHeader, Segmented, Select, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi, useMe } from '../../hooks';
import { listNotifications, markAllRead, markRead } from '../../services/api/misc';
import type { NotificationType } from '../../types';
import { cx, formatDateTime, formatShort, relative } from '../../utils/format';
import { BACKEND } from '../../services/http';
import { getDb } from '../../services/mock/store';
import type { Delivery } from '../../types';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';

/** Email/WhatsApp status of one notification: from the server row, or the prototype's store. */
const tagsOf = (n: { id: string; deliveries?: { channel: Delivery['channel']; status: Delivery['status'] }[] }): Pick<Delivery, 'channel' | 'status' | 'heldUntil'>[] =>
  (n.deliveries?.map((d) => ({ ...d, heldUntil: null })) ?? getDb().deliveries.filter((d) => d.notificationId === n.id))
    // D-106: past WhatsApp rows stay stored but are not shown while WhatsApp is off.
    .filter((d) => WHATSAPP_ENABLED || d.channel !== 'whatsapp');

const TAG_TEXT: Partial<Record<Delivery['status'], string>> = { sent: 'sent', simulated: 'simulated', pending: 'queued', sending: 'queued', failed: 'failed', skipped: 'skipped' };

export function NotificationsPage() {
  const user = useMe();
  const nav = useNavigate();
  const q = useApi(['notifications', user.id], listNotifications);
  const [read, setRead] = useState<'all' | 'unread'>('all');
  const [type, setType] = useState<'' | NotificationType>('');
  const all = useAction(markAllRead, { success: (n) => (n ? `Marked ${n} as read` : 'Nothing unread') });
  const toggle = useAction(markRead);
  if (q.error) return <ErrorState error={q.error} />;
  const rows = (q.data ?? []).filter((n) => (read === 'all' || !n.read) && (!type || n.type === type));
  const unread = (q.data ?? []).filter((n) => !n.read).length;
  return (
    <div className="page narrow">
      <PageHeader
        title="Notifications"
        description={BACKEND === 'server' ? 'Your in-app notifications. Email follows your preferences and quiet hours.' : 'In-app notifications are the baseline. Email delivery is simulated: nothing is actually sent.'}
        actions={
          <>
            <Button onClick={() => nav('/settings/account#notifications')} icon="settings">
              Preferences
            </Button>
            <Button variant="primary" onClick={() => all.run()} disabled={!unread} loading={all.pending}>
              Mark all as read
            </Button>
          </>
        }
      />
      <div className="row-gap wrap mb">
        <Segmented label="Read state" value={read} onChange={setRead} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread', count: unread }]} />
        <Select aria-label="Notification type" value={type} onChange={(e) => setType(e.target.value as NotificationType | '')} className="w-auto">
          <option value="">All types</option>
          {(Object.keys(NOTIFICATION_LABEL) as NotificationType[]).map((t) => (
            <option key={t} value={t}>
              {NOTIFICATION_LABEL[t]}
            </option>
          ))}
        </Select>
      </div>
      <Card pad={false}>
        {q.isLoading && !q.data ? (
          <div className="card-body"><Skeleton rows={6} /></div>
        ) : rows.length === 0 ? (
          <Empty icon="bell" title={read === 'unread' ? 'No unread notifications' : 'No notifications'}>You're all caught up.</Empty>
        ) : (
          <ul className="notif-list">
            {rows.map((n) => (
              <li key={n.id} className={cx(!n.read && 'unread')}>
                <button
                  type="button"
                  className="notif-row"
                  onClick={() => {
                    if (!n.read) toggle.run(n.id, true);
                    if (n.taskId) nav(`/tasks/${n.taskId}`);
                  }}
                >
                  <span className={cx('notif-dot', n.type)} aria-hidden />
                  <span className="notif-text">
                    <strong>{n.title}</strong>
                    <span>{n.body}</span>
                    <small>
                      {NOTIFICATION_LABEL[n.type]} · <time title={formatDateTime(n.at)}>{relative(n.at)}</time>
                      {tagsOf(n).map((d) => (
                        <span key={d.channel}>
                          {' · '}
                          <Tag tone={d.status === 'held' ? 'warn' : d.status === 'failed' ? 'danger' : 'muted'}>
                            {d.channel === 'email' ? 'Email' : 'WhatsApp'}{' '}
                            {d.status === 'held' ? (d.heldUntil ? `held to ${formatShort(d.heldUntil)}` : 'held (quiet hours)') : BACKEND === 'mock' && d.status === 'sent' ? 'sent (sim)' : TAG_TEXT[d.status]}
                          </Tag>
                        </span>
                      ))}
                    </small>
                  </span>
                  {!n.read && <span className="sr-only">Unread</span>}
                </button>
                <button type="button" className="icon-btn" aria-label={n.read ? 'Mark as unread' : 'Mark as read'} title={n.read ? 'Mark as unread' : 'Mark as read'} onClick={() => toggle.run(n.id, !n.read)}>
                  <Icon name={n.read ? 'circle' : 'circle-check'} size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
