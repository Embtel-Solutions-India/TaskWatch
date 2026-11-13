import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_SHORT } from '../../constants';
import { DataTable } from '../../components/DataTable';
import { Icon } from '../../components/icons';
import { Avatar, Banner, Button, Card, Dialog, ErrorState, Input, PageHeader, Segmented, Select, Stat, Tag } from '../../components/ui';
import { useAction, useApi, useCan } from '../../hooks';
import { listDeliveries, sendWeeklyDigestNow } from '../../services/api/admin';
import { TEMPLATES } from '../../services/channels';
import { getDb } from '../../services/mock/store';
import { BACKEND } from '../../services/http';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import type { Delivery, WhatsAppTemplate } from '../../types';
import { cx, downloadCsv, formatDateTime, formatShort, relative } from '../../utils/format';

/** Recipient name: from the server row, or the prototype's store. */
const nameOf = (d: Delivery) => d.recipientName ?? getDb().users.find((u) => u.id === d.userId)?.name ?? d.userId;

/** All seven delivery states (NTF-02). In the prototype every "sent" message is simulated. */
export function StatusTag({ d }: { d: Delivery }) {
  if (d.status === 'sent' && d.heldUntil) return <Tag tone="ok"><Icon name="check" size={11} /> Sent {formatShort(d.sentAt)} (after quiet hours)</Tag>;
  if (d.status === 'sent') return <Tag tone="ok"><Icon name="check" size={11} /> {BACKEND === 'server' ? 'Sent' : 'Sent (simulated)'}</Tag>;
  if (d.status === 'simulated') return <Tag tone="ok"><Icon name="check" size={11} /> Simulated</Tag>;
  if (d.status === 'held') return <Tag tone="warn"><Icon name="clock" size={11} /> Held until {formatShort(d.heldUntil)}</Tag>;
  if (d.status === 'pending' || d.status === 'sending') return <Tag tone="info"><Icon name="clock" size={11} /> Queued</Tag>;
  if (d.status === 'failed') return <Tag tone="danger"><Icon name="x" size={11} /> Failed</Tag>;
  return <Tag tone="muted"><Icon name="x" size={11} /> Skipped</Tag>;
}

function ChannelIcon({ channel }: { channel: Delivery['channel'] }) {
  return (
    <span className={cx('ch-icon', `ch-${channel}`)} title={channel === 'email' ? 'Email' : 'WhatsApp'}>
      <Icon name={channel === 'email' ? 'inbox' : 'message'} size={13} />
      <span className="sr-only">{channel === 'email' ? 'Email' : 'WhatsApp'}</span>
    </span>
  );
}

export function DeliveryRow({ d, compact }: { d: Delivery; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="dlv-row">
      <ChannelIcon channel={d.channel} />
      <div className="dlv-main">
        <strong>{d.channel === 'email' ? d.subject : d.template}</strong>
        <span className="muted small">
          {!compact && <>{nameOf(d)} · </>}
          {d.address ?? 'no address'} · {relative(d.createdAt)}
          {d.reason && d.status === 'skipped' && <> · {d.reason}</>}
        </span>
      </div>
      <StatusTag d={d} />
      <Button size="sm" variant="ghost" icon="eye" onClick={() => setOpen(true)}>
        Preview
      </Button>
      {open && <PreviewDialog d={d} onClose={() => setOpen(false)} />}
    </li>
  );
}

export function PreviewDialog({ d, onClose }: { d: Delivery; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={d.channel === 'email' ? 'Email preview' : 'WhatsApp preview'} description={BACKEND === 'server' ? 'The message as TaskWatch rendered it.' : 'Exactly what the server would send. In this prototype nothing was actually sent.'}>
      <div className="stack">
        <dl className="kv">
          <div><dt>To</dt><dd>{nameOf(d)} &lt;{d.address ?? 'no address'}&gt;</dd></div>
          <div><dt>Status</dt><dd><StatusTag d={d} /> {d.reason && <span className="muted small"> {d.reason}</span>}</dd></div>
          <div><dt>Created</dt><dd>{formatDateTime(d.createdAt)}{d.sentAt && d.sentAt !== d.createdAt && <> · sent {formatDateTime(d.sentAt)}</>}</dd></div>
          {d.template && <div><dt>Template</dt><dd><code>{d.template}</code> · en · Utility</dd></div>}
        </dl>
        {d.channel === 'email' ? (
          <div className="email-preview">
            <div className="email-head">
              <span><strong>From:</strong> TaskWatch</span>
              <span><strong>Subject:</strong> {d.subject}</span>
            </div>
            <div className="email-body">
              <p className="pre">{d.body}</p>
              {d.link && <a className="email-btn" href={d.link} onClick={(e) => e.preventDefault()}>Open in TaskWatch</a>}
              <p className="email-foot">Sent by TaskWatch</p>
            </div>
          </div>
        ) : (
          <div className="wa-preview">
            <div className="wa-bubble">
              <p>{d.body}</p>
              <span className="wa-time">{new Date(d.sentAt ?? d.heldUntil ?? d.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
              {d.template && TEMPLATES[d.template].button && d.taskId && (
                <a className="wa-button" href={d.link ?? '#'} onClick={(e) => e.preventDefault()}>
                  <Icon name="external" size={13} /> Open task
                </a>
              )}
            </div>
            {d.templateParams && (
              <ol className="wa-params">
                {d.templateParams.map((p, i) => (
                  <li key={i}><code>{`{{${i + 1}}}`}</code> {TEMPLATES[d.template!].vars[i]}: <strong>{p}</strong></li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function DeliveryLogPage() {
  const q = useApi(['deliveries'], listDeliveries);
  const db = getDb(); // prototype only: quiet-hours end for the help text
  const [channel, setChannel] = useState<'all' | 'email' | 'whatsapp' | 'digest'>('all');
  const [status, setStatus] = useState('');
  const [person, setPerson] = useState('');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<Delivery | null>(null);
  const canDigest = useCan('manage_system_settings');
  const digest = useAction(sendWeeklyDigestNow, { success: (n) => `Weekly digest sent to ${n} recipients${BACKEND === 'server' ? '' : ' (simulated email)'}.` });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const emailLive = q.data?.integrations.email === 'live';
  const people = useMemo(() => [...new Map(rows.map((d) => [d.userId, nameOf(d)])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [rows]);
  const filtered = useMemo(
    () =>
      rows.filter(
        (d) =>
          (channel === 'all' || (channel === 'digest' ? d.kind === 'digest' : d.channel === channel)) &&
          (!status || d.status === status) &&
          (!person || d.userId === person) &&
          (!search || `${d.subject ?? ''} ${d.template ?? ''} ${d.body} ${d.taskId ?? ''} ${d.address ?? ''}`.toLowerCase().includes(search.toLowerCase())),
      ),
    [rows, channel, status, person, search],
  );
  const count = (c: Delivery['channel'], s?: Delivery['status']) => rows.filter((d) => d.channel === c && (!s || d.status === s)).length;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="page">
      <PageHeader
        title="Delivery Log"
        description={WHATSAPP_ENABLED ? 'Every email and WhatsApp message TaskWatch would send, with quiet-hour holds and skips. In-app notifications are always delivered and are not listed here.' : 'Every email TaskWatch sends, with quiet-hour holds and failures. In-app notifications are always delivered and are not listed here.'}
        actions={
          <>
          {canDigest && (
            <Button icon="inbox" loading={digest.pending} onClick={() => digest.run()}>
              Send weekly digest now
            </Button>
          )}
          <Button icon="download" disabled={!filtered.length} onClick={() => downloadCsv('taskwatch-deliveries.csv', [['Created', 'Channel', 'Recipient', 'Address', 'Template / subject', 'Task', 'Level', 'Status', 'Held until', 'Sent', 'Reason', 'Body'], ...filtered.map((d) => [d.createdAt, d.channel, nameOf(d), d.address, d.template ?? d.subject, d.taskId, d.level ?? '', d.status, d.heldUntil, d.sentAt, d.reason, d.body])])}>
            Export CSV
          </Button>
          </>
        }
      />
      {BACKEND === 'server' ? (
        <Banner tone={emailLive ? 'info' : 'warn'} icon="zap">
          {emailLive ? <><strong>Email is live.</strong> Messages go out through the organization's mail server.</> : <><strong>Email is simulated.</strong> Messages are rendered and logged but not sent until <code>SMTP_*</code> is set in the server's secrets.</>}
        </Banner>
      ) : (
      <Banner tone="warn" icon="zap">
        <strong>Simulated delivery.</strong> This prototype renders messages but sends nothing. Live sending is handled by the TaskWatch server (<code>server/src/notify</code>) once <code>SMTP_*</code> and <code>WHATSAPP_TOKEN</code> / <code>WHATSAPP_PHONE_NUMBER_ID</code> are set in its secrets, and the five templates below are approved in Meta WhatsApp Manager.
      </Banner>
      )}
      <div className="stats">
        <Stat label="Emails" value={count('email')} hint={`${count('email', 'sent') + count('email', 'simulated')} sent${BACKEND === 'server' && count('email', 'simulated') ? ' (simulated)' : ''} · ${count('email', 'held')} held`} />
        {WHATSAPP_ENABLED && <Stat label="WhatsApp messages" value={count('whatsapp')} hint={`${count('whatsapp', 'sent')} sent · ${count('whatsapp', 'held')} held`} />}
        <Stat label="Held by quiet hours" value={rows.filter((d) => d.status === 'held').length} tone={rows.some((d) => d.status === 'held') ? 'warn' : undefined} help={`L0 and L1 ${WHATSAPP_ENABLED ? 'email and WhatsApp' : 'email'} wait until ${db.rules.quietHours.end} in the recipient's zone. L2/L3 always go out; in-app is never held.`} />
        {WHATSAPP_ENABLED ? (
          <Stat label="Skipped" value={rows.filter((d) => d.status === 'skipped').length} help="WhatsApp alerts for people with no number on file or who haven't opted in. They still get email and in-app." />
        ) : (
          <Stat label="Failed" value={rows.filter((d) => d.status === 'failed').length} tone={rows.some((d) => d.status === 'failed') ? 'danger' : undefined} help="Emails the mail server refused three times. The reason is on the row." />
        )}
      </div>
      <DataTable<Delivery>
        caption="Delivery log"
        storageKey="deliveries"
        rows={filtered}
        loading={q.isLoading}
        rowKey={(d) => d.id}
        onRowClick={setPreview}
        initialSort={{ id: 'at', dir: 'desc' }}
        pageSize={50}
        toolbar={
          <div className="filters">
            <Segmented label="Channel" value={channel} onChange={setChannel} options={[{ value: 'all', label: 'All', count: rows.length }, { value: 'digest', label: 'Weekly digest', count: rows.filter((d) => d.kind === 'digest').length }, { value: 'email', label: 'Email', count: count('email') }, ...(WHATSAPP_ENABLED ? [{ value: 'whatsapp' as const, label: 'WhatsApp', count: count('whatsapp') }] : [])]} />
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              <option value="sent">Sent</option>
              {BACKEND === 'server' && <option value="simulated">Simulated</option>}
              {BACKEND === 'server' && <option value="pending">Queued</option>}
              <option value="held">Held (quiet hours)</option>
              {BACKEND === 'server' && <option value="failed">Failed</option>}
              <option value="skipped">Skipped</option>
            </Select>
            <Select aria-label="Recipient" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Any recipient</option>
              {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </Select>
            <div className="filter-search">
              <Input aria-label="Search messages" placeholder="Search subject, template, task…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        }
        columns={[
          { id: 'at', header: 'Time', width: '150px', cell: (d) => <span className="nowrap" title={formatDateTime(d.createdAt)}>{formatShort(d.createdAt)}</span>, sort: (d) => d.createdAt },
          { id: 'channel', header: 'Channel', width: '130px', cell: (d) => <span className="row-gap nowrap"><ChannelIcon channel={d.channel} />{d.channel === 'email' ? 'Email' : 'WhatsApp'}</span>, sort: (d) => d.channel },
          { id: 'to', header: 'Recipient', cell: (d) => <span className="person"><Avatar name={nameOf(d)} size={20} /><span className="task-title"><span>{nameOf(d)}</span><span className="task-sub">{d.address ?? 'no address'}</span></span></span>, sort: (d) => nameOf(d) },
          { id: 'what', header: 'Template / subject', cell: (d) => (d.template ? <code className="code">{d.template}</code> : <span className="task-title"><span>{d.subject}</span>{d.kind === 'digest' && <span className="task-sub">Weekly digest · Managers & Founder's Office</span>}{(d.copied ?? (d.notificationId && getDb().notifications.find((x) => x.id === d.notificationId)?.title.startsWith('Copy:'))) && <span className="task-sub">Copied recipient</span>}</span>), sort: (d) => d.template ?? d.subject ?? '' },
          { id: 'task', header: 'Task', cell: (d) => (d.taskId ? <Link to={`/tasks/${d.taskId}`} className="mono">{d.taskId}</Link> : '—'), sort: (d) => d.taskId ?? '' },
          { id: 'level', header: 'Level', width: '70px', cell: (d) => (d.level === null ? '—' : <span className={cx('lvl', `lvl-${d.level}`)}>{LEVEL_SHORT[d.level]}</span>), sort: (d) => d.level ?? -1 },
          { id: 'status', header: 'Status', cell: (d) => <span className="task-title fit"><StatusTag d={d} />{d.reason && <span className="task-sub">{d.reason}</span>}</span>, sort: (d) => d.status },
          { id: 'preview', header: 'Preview', fixed: true, cell: (d) => <Button size="sm" variant="ghost" icon="eye" onClick={() => setPreview(d)} aria-label="Preview message" /> },
        ]}
      />
      {WHATSAPP_ENABLED && (
      <Card title="WhatsApp Business templates" sub="Pre-approved Utility templates (docs/whatsapp-templates.md). Names and variable order must match exactly.">
        <div className="table-scroll">
          <table className="table compact">
            <caption className="sr-only">WhatsApp templates</caption>
            <thead>
              <tr><th>Template</th><th>Body</th><th>Used for</th><th>Sent here</th></tr>
            </thead>
            <tbody>
              {(Object.keys(TEMPLATES) as WhatsAppTemplate[]).map((t) => (
                <tr key={t}>
                  <td data-label="Template"><code className="code">{t}</code></td>
                  <td data-label="Body">{TEMPLATES[t].body}{TEMPLATES[t].button && <span className="muted small"> · button: Open task</span>}</td>
                  <td data-label="Used for">{TEMPLATES[t].used}</td>
                  <td data-label="Sent here" className="right">{rows.filter((d) => d.template === t).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      )}
      {preview && <PreviewDialog d={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
