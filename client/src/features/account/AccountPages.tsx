import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NOTIFICATION_LABEL, PERMISSION_LABEL, ROLE_LABEL } from '../../constants';
import { Avatar, Banner, Button, Card, ErrorState, KV, PageHeader, RoleBadge, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi, useAuth, useMe } from '../../hooks';
import { BACKEND } from '../../services/http';
import { WHATSAPP_ENABLED, WHATSAPP_TYPES } from '@taskwatch/shared/notifications';
import { getStaffProfile, myDeliveries } from '../../services/api/admin';
import { DeliveryRow } from '../admin/DeliveryLogPage';
import { MANDATORY_TYPES } from '../../services/channels';
import { getPrefs, setPrefs } from '../../services/api/misc';
import { getDb } from '../../services/mock/store';
import type { NotificationPrefs, NotificationType } from '../../types';
import { formatDate, pct } from '../../utils/format';

export function ProfilePage() {
  const user = useMe();
  const q = useApi(['profile', user.id], () => getStaffProfile(user.id));
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={8} />;
  const p = q.data;
  return (
    <div className="page narrow">
      <div className="profile-head">
        <Avatar name={user.name} size={56} />
        <div>
          <h1>{user.name}</h1>
          <p className="muted">
            {user.title} · <RoleBadge role={user.role} /> · {p.team?.name ?? 'No team'}
          </p>
        </div>
        <Link to="/settings/account" className="btn btn-secondary">
          Account settings
        </Link>
      </div>
      <div className="grid-2">
        <Card title="Details">
          <KV
            items={[
              ['Email', user.email],
              ['Phone', user.phone],
              ['Location', user.location],
              ['Joined', formatDate(user.joinedAt)],
              ['Reports to', p.manager?.name ?? <span className="muted">No manager</span>],
              ['Direct reports', p.reports.length ? p.reports.map((r) => r.name).join(', ') : '—'],
            ]}
          />
        </Card>
        <Card title="My accountability">
          <KV
            items={[
              ['Open tasks', p.stats.open],
              ['Overdue now', p.stats.overdue],
              ['Completed', p.stats.completed],
              ['On-time completion', pct(p.stats.onTimeRate)],
            ]}
          />
        </Card>
      </div>
      <Card title="What I can do" sub={`Permissions from the ${ROLE_LABEL[user.role]} role. Access to individual tasks also depends on your reporting line.`}>
        <div className="tag-cloud">
          {p.permissions.map((perm) => (
            <Tag key={perm}>{PERMISSION_LABEL[perm]}</Tag>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function AccountSettingsPage() {
  const user = useMe();
  const q = useApi(['prefs', user.id], getPrefs);
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data));
  }, [q.data]);
  useEffect(() => {
    if (location.hash === '#notifications') document.getElementById('notifications')?.scrollIntoView();
  }, [draft]);
  const save = useAction(setPrefs, { success: 'Notification preferences saved' });
  const { bootstrap } = useAuth();
  const timeout = bootstrap?.settings.sessionTimeoutMinutes ?? getDb().settings.sessionTimeoutMinutes;
  const sim = BACKEND === 'server' ? '' : ' (simulated)';
  if (q.error) return <ErrorState error={q.error} />;
  if (!draft) return <Skeleton rows={8} />;
  const types = Object.keys(NOTIFICATION_LABEL) as NotificationType[];
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data);
  return (
    <div className="page narrow">
      <PageHeader title="Account settings" />
      <Card title="Sign-in">
        <KV
          items={[
            ['Email', user.email],
            ['Password', <span key="pw">Managed by your organization · <Link to="/forgot-password">Reset password</Link></span>],
            ['Session timeout', `${timeout} minutes of inactivity`],
          ]}
        />
      </Card>
      <section id="notifications">
        <Card
          title="Notification preferences"
          sub={BACKEND === 'server' ? 'Choose where each kind of notification reaches you. Required ones are always on.' : 'Escalations always appear in-app for the people responsible; email delivery is simulated in this prototype.'}
          actions={
            <Button variant="primary" disabled={!dirty} loading={save.pending} onClick={() => save.run(draft)}>
              Save preferences
            </Button>
          }
        >
          <table className="table compact prefs">
            <caption className="sr-only">Notification preferences</caption>
            <thead>
              <tr>
                <th>Type</th>
                <th>In-app</th>
                <th>Email{sim}</th>
                {WHATSAPP_ENABLED && <th>WhatsApp{sim}</th>}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t}>
                  <td data-label="Type">
                    {NOTIFICATION_LABEL[t]}
                    {MANDATORY_TYPES.includes(t) && <small className="muted block">Required by the work order</small>}
                  </td>
                  <td data-label="In-app">
                    <input type="checkbox" aria-label={`${NOTIFICATION_LABEL[t]} in-app`} checked={MANDATORY_TYPES.includes(t) || draft.inApp[t]} disabled={MANDATORY_TYPES.includes(t)} onChange={(e) => setDraft({ ...draft, inApp: { ...draft.inApp, [t]: e.target.checked } })} />
                  </td>
                  <td data-label="Email">
                    <input type="checkbox" aria-label={`${NOTIFICATION_LABEL[t]} email`} checked={MANDATORY_TYPES.includes(t) || draft.email[t]} disabled={MANDATORY_TYPES.includes(t)} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, [t]: e.target.checked } })} />
                  </td>
                  {WHATSAPP_ENABLED && <td data-label="WhatsApp">
                    {WA_TYPES.includes(t) ? (
                      <input type="checkbox" aria-label={`${NOTIFICATION_LABEL[t]} WhatsApp`} checked={!!user.whatsapp && user.whatsappOptIn && (MANDATORY_TYPES.includes(t) || (draft.whatsapp?.[t] ?? false))} disabled={!user.whatsapp || !user.whatsappOptIn || MANDATORY_TYPES.includes(t)} onChange={(e) => setDraft({ ...draft, whatsapp: { ...draft.whatsapp, [t]: e.target.checked } })} />
                    ) : (
                      <span className="muted small" title="No approved WhatsApp template for this event">n/a</span>
                    )}
                  </td>}
                </tr>
              ))}
            </tbody>
          </table>
          <Banner tone="info">{WHATSAPP_ENABLED ? 'New assignments and L0–L3 escalations always go to WhatsApp, email and in-app (work order: WhatsApp first, email always, in-app always). Your preferences apply to everything else.' : 'New assignments, escalations, Blocked tasks and system alerts always go to email and in-app. Your preferences apply to everything else.'}</Banner>
          {!WHATSAPP_ENABLED ? null : !user.whatsapp || !user.whatsappOptIn ? (
            <Banner tone="warn">WhatsApp alerts are off for you: {!user.whatsapp ? 'no WhatsApp number is on file' : "you haven't opted in"}. Ask your Chief of Staff to update your profile.</Banner>
          ) : (
            <p className="muted small">WhatsApp goes to {user.whatsapp} using approved message templates. Only assignments and escalations have templates.</p>
          )}
        </Card>
      </section>
      <MyMessages />
    </div>
  );
}

const WA_TYPES = WHATSAPP_TYPES;

function MyMessages() {
  const user = useMe();
  const q = useApi(['my-deliveries', user.id], myDeliveries);
  const rows = q.data ?? [];
  return (
    <Card title="Messages sent to you" sub={BACKEND === 'server' ? 'Your last 30 emails, including any held by quiet hours and why.' : 'Simulated email and WhatsApp messages from the last alerts. Nothing actually left this browser.'}>
      {rows.length === 0 ? <p className="muted">{WHATSAPP_ENABLED ? 'No email or WhatsApp messages yet.' : 'No emails yet.'}</p> : <ul className="dlv-list">{rows.slice(0, 10).map((d) => <DeliveryRow key={d.id} d={d} compact />)}</ul>}
    </Card>
  );
}
