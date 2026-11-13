import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { Button, Card, Checkbox, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, Menu, PageHeader, PriorityBadge, Select, Skeleton, Tag, Textarea } from '../../components/ui';
import { useAction, useApi, useMe } from '../../hooks';
import { deleteRecurrence, listRecurrences, saveRecurrence, toggleRecurrence, type RecurrenceInput, type RecurrenceRow } from '../../services/api/admin';
import { assigneeOptions } from '../../services/api/tasks';
import { describeRecurrence, isoDay } from '../../services/engine/recurrence';
import { SCHEDULE_TITLE_MAX } from '@taskwatch/shared/recurrence';
import { BACKEND } from '../../services/http';
import { now } from '../../services/mock/store';
import type { Frequency, Priority } from '../../types';
import { PRIORITIES } from '../../types';
import { formatDate } from '../../utils/format';

type Row = RecurrenceRow;

export function RecurringPage() {
  const user = useMe();
  const q = useApi(['recurring', user.id], listRecurrences);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const toggle = useAction(toggleRecurrence, { success: (_) => 'Schedule updated' });
  const del = useAction(deleteRecurrence, { success: 'Schedule deleted. Existing tasks are kept.', onSuccess: () => setConfirm(null) });
  if (q.error) return <ErrorState error={q.error} />;
  const rows = q.data ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Recurring tasks"
        description="Schedules that create a new task on each occurrence. Each date produces exactly one task, so processing twice never creates duplicates."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            New schedule
          </Button>
        }
      />
      {q.isLoading && !q.data ? (
        <Skeleton rows={4} />
      ) : rows.length === 0 ? (
        <Card>
          <Empty icon="repeat" title="No recurring schedules" action={<Button onClick={() => setEditing('new')}>Create one</Button>} />
        </Card>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Recurring schedules</caption>
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Repeats</th>
                  <th>Assignee</th>
                  <th>Priority</th>
                  <th>Next</th>
                  <th className="right">Created</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Schedule">
                      <span className="task-title">
                        <strong>{r.title}</strong>
                        <span className="task-sub">Owner {r.ownerName}{r.reviewRequired ? ' · review required' : ''}</span>
                      </span>
                    </td>
                    <td data-label="Repeats">{r.summary}</td>
                    <td data-label="Assignee">{r.assigneeName}</td>
                    <td data-label="Priority">
                      <PriorityBadge priority={r.priority} />
                    </td>
                    <td data-label="Next">{r.active ? r.next.map((d) => formatDate(d + 'T12:00:00Z')).join(', ') || '—' : <span className="muted">Paused</span>}</td>
                    <td data-label="Created" className="right">
                      <Link to={`/tasks/assigned-by-me`}>{r.instances} tasks</Link>
                    </td>
                    <td data-label="Status">
                      <Tag tone={r.active ? 'ok' : 'muted'}>{r.active ? 'Active' : 'Paused'}</Tag>
                    </td>
                    <td data-label="Actions">
                      {r.canEdit && (
                        <Menu
                          label={`Actions for ${r.title}`}
                          items={[
                            { label: 'Edit', icon: 'edit', onClick: () => setEditing(r) },
                            { label: r.active ? 'Pause' : 'Resume', icon: r.active ? 'clock' : 'play', onClick: () => toggle.run(r.id, !r.active) },
                            { label: 'Delete', icon: 'trash', danger: true, onClick: () => setConfirm(r) },
                          ]}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && <RecurrenceDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => del.run(confirm!.id)} title="Delete schedule?" danger confirmLabel="Delete" loading={del.pending}>
        <p>No more tasks will be created from “{confirm?.title}”. The {confirm?.instances} tasks it already created are kept.</p>
      </ConfirmDialog>
    </div>
  );
}

function RecurrenceDialog({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const options = useApi(['task-assignees'], assigneeOptions).data ?? [];
  const [f, setF] = useState<RecurrenceInput>(
    row
      ? { title: row.title, description: row.description, category: row.category, priority: row.priority, assigneeId: row.assigneeId, teamId: row.teamId, reviewRequired: row.reviewRequired, frequency: row.frequency, interval: row.interval, weekdays: row.weekdays, startDate: row.startDate, endDate: row.endDate, dueHour: row.dueHour, target: row.target ?? null, unit: row.unit ?? null, estimatedHours: row.estimatedHours ?? null, purpose: row.purpose ?? null }
      : { title: '', description: '', category: '', priority: 'normal', assigneeId: '', teamId: null, reviewRequired: false, frequency: 'weekly', interval: 1, weekdays: [1], startDate: isoDay(now() + 86_400_000), endDate: null, dueHour: 17, target: null, unit: null, estimatedHours: null, purpose: null },
  );
  const set = <K extends keyof RecurrenceInput>(k: K, v: RecurrenceInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useAction(saveRecurrence, { success: row ? 'Schedule updated' : 'Schedule created', onSuccess: onClose });
  const e = save.fields;
  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? 'Edit schedule' : 'New recurring schedule'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="f-rec" loading={save.pending}>
            Save schedule
          </Button>
        </>
      }
    >
      <form id="f-rec" className="stack" noValidate onSubmit={(ev) => (ev.preventDefault(), save.run(row?.id ?? null, f))}>
        <Field label="Title" required htmlFor="rc-title" error={e.title}>
          <Input id="rc-title" value={f.title} onChange={(x) => set('title', x.target.value)} invalid={!!e.title} maxLength={SCHEDULE_TITLE_MAX} />
        </Field>
        <Field label="Template description" htmlFor="rc-desc">
          <Textarea id="rc-desc" rows={2} value={f.description} onChange={(x) => set('description', x.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Assignee" required htmlFor="rc-as" error={e.assigneeId}>
            <Select id="rc-as" value={f.assigneeId} onChange={(x) => set('assigneeId', x.target.value)} invalid={!!e.assigneeId}>
              <option value="">Choose…</option>
              {row && !options.some((o) => o.id === row.assigneeId) && <option value={row.assigneeId}>{row.assigneeName} (current)</option>}
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} — {ROLE_LABEL[o.role]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="rc-pr">
            <Select id="rc-pr" value={f.priority} onChange={(x) => set('priority', x.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due at (hour)" htmlFor="rc-hour" error={e.dueHour}>
            <Input id="rc-hour" type="number" min={0} max={23} value={f.dueHour} onChange={(x) => set('dueHour', Number(x.target.value))} />
          </Field>
          <Field label="Frequency" htmlFor="rc-freq">
            <Select id="rc-freq" value={f.frequency} onChange={(x) => set('frequency', x.target.value as Frequency)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="interval">Every N days</option>
            </Select>
          </Field>
          <Field label="Interval" htmlFor="rc-int" error={e.interval}>
            <Input id="rc-int" type="number" min={1} max={365} value={f.interval} onChange={(x) => set('interval', Number(x.target.value))} />
          </Field>
          <Field label="Start date" required htmlFor="rc-start" error={e.startDate}>
            <Input id="rc-start" type="date" value={f.startDate} onChange={(x) => set('startDate', x.target.value)} />
          </Field>
          <Field label="End date" htmlFor="rc-end" error={e.endDate} hint="Optional.">
            <Input id="rc-end" type="date" value={f.endDate ?? ''} onChange={(x) => set('endDate', x.target.value || null)} />
          </Field>
        </div>
        {f.frequency === 'weekly' && (
          <fieldset className="weekdays">
            <legend>Repeat on</legend>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
              <label key={d} className="weekday">
                <input type="checkbox" checked={f.weekdays.includes(i)} onChange={(x) => set('weekdays', x.target.checked ? [...f.weekdays, i].sort() : f.weekdays.filter((w) => w !== i))} />
                <span>{d}</span>
              </label>
            ))}
            {e.weekdays && <span className="field-msg">{e.weekdays}</span>}
          </fieldset>
        )}
        <div className="grid-2">
          <Field label="Target" htmlFor="rc-target" error={e.target} hint="Optional.">
            <Input id="rc-target" type="number" min={0} step="any" value={f.target ?? ''} onChange={(x) => set('target', x.target.value ? Number(x.target.value) : null)} />
          </Field>
          <Field label="Unit" htmlFor="rc-unit" error={e.unit}>
            <Input id="rc-unit" maxLength={40} value={f.unit ?? ''} onChange={(x) => set('unit', x.target.value || null)} />
          </Field>
          <Field label="Estimated hours" required htmlFor="rc-est" error={e.estimatedHours}>
            <Input id="rc-est" type="number" min={0.25} max={200} step={0.25} value={f.estimatedHours ?? ''} onChange={(x) => set('estimatedHours', x.target.value ? Number(x.target.value) : null)} />
          </Field>
          <Field label="Purpose" required htmlFor="rc-purpose" error={e.purpose}>
            <Select id="rc-purpose" value={f.purpose ?? ''} onChange={(x) => set('purpose', (x.target.value || null) as RecurrenceInput['purpose'])}>
              <option value="">Choose…</option>
              <option value="revenue">Revenue-oriented</option>
              <option value="support">Support</option>
            </Select>
          </Field>
        </div>
        <Checkbox label="Review required" checked={f.reviewRequired} onChange={(x) => set('reviewRequired', x.target.checked)} />
        <p className="muted small">{describeRecurrence(f)}. {BACKEND === 'server' ? 'Each task is due at that hour in the assignee’s time zone.' : 'Times are interpreted in UTC in this prototype.'}</p>
      </form>
    </Dialog>
  );
}
