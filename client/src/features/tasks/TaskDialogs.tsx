import { useState } from 'react';
import { HOUR, ROLE_LABEL } from '../../constants';
import { Banner, Button, Dialog, Field, FilePicker, Input, Select, Textarea } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { BACKEND } from '../../services/http';
import type { TaskView } from '../../services/api/base';
import { ackEscalation, assigneeOptions, cancelTask, completeTask, decideExtension, postProgress, reassignTask, reopenTask, requestExtension, reviewTask, submitForReview } from '../../services/api/tasks';
import { getDb, now } from '../../services/mock/store';
import type { Extension, Review } from '../../types';

/** A name for someone on the task: the prototype looks them up; the server names the task's own people. */
const personOn = (task: TaskView, id: string | null) =>
  BACKEND === 'server' ? [task.assignee, task.giver].find((u) => u?.id === id)?.name : getDb().users.find((u) => u.id === id)?.name;
import { formatDateTime, toDateInput, toTimeInput } from '../../utils/format';

export type DialogKind = 'progress' | 'submit' | 'complete' | 'review' | 'extension' | 'decide' | 'reassign' | 'cancel' | 'reopen' | 'ack_escalation' | null;

interface Base {
  task: TaskView;
  onClose: () => void;
}

function Foot({ onClose, label, pending, danger, form }: { onClose: () => void; label: string; pending: boolean; danger?: boolean; form: string }) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={form} variant={danger ? 'danger' : 'primary'} loading={pending}>
        {label}
      </Button>
    </>
  );
}

export function ProgressDialog({ task, onClose }: Base) {
  const [message, setMessage] = useState('');
  const [percent, setPercent] = useState(Math.min(100, task.progress + 10));
  const [files, setFiles] = useState<File[]>([]);
  const a = useAction(postProgress, { success: 'Progress posted. The silence clock has been reset.', onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title="Post a progress update" description="Progress updates reset the silence clock. Comments do not." footer={<Foot onClose={onClose} label="Post update" pending={a.pending} form="f-progress" />}>
      <form id="f-progress" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { message, percent, files }))}>
        <Field label="What changed?" required htmlFor="p-msg" error={a.fields.message}>
          <Textarea id="p-msg" rows={4} autoFocus value={message} onChange={(e) => setMessage(e.target.value)} invalid={!!a.fields.message} placeholder="Done, in progress, blockers, next step…" />
        </Field>
        <Field label={`Progress: ${percent}%`} htmlFor="p-pct" error={a.fields.percent}>
          <input id="p-pct" type="range" min={0} max={100} step={5} value={percent} onChange={(e) => setPercent(Number(e.target.value))} className="range" />
        </Field>
        <Field label="Supporting files">
          <FilePicker files={files} onChange={setFiles} />
        </Field>
      </form>
    </Dialog>
  );
}

export function SubmitDialog({ task, onClose }: Base) {
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const a = useAction(submitForReview, { success: `${task.id} submitted for review`, onSuccess: onClose });
  const reviewerName = personOn(task, task.reviewerId);
  return (
    <Dialog open onClose={onClose} title="Submit for review" description={`${reviewerName ?? 'The reviewer'} will be asked to approve or request changes.`} footer={<Foot onClose={onClose} label="Submit" pending={a.pending} form="f-submit" />}>
      <form id="f-submit" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { note, files }))}>
        <Field label="Submission summary" required htmlFor="s-note" error={a.fields.note}>
          <Textarea id="s-note" rows={4} autoFocus value={note} onChange={(e) => setNote(e.target.value)} invalid={!!a.fields.note} placeholder="What you delivered and where to find it" />
        </Field>
        <Field label="Deliverables">
          <FilePicker files={files} onChange={setFiles} />
        </Field>
      </form>
    </Dialog>
  );
}

export function CompleteDialog({ task, onClose }: Base) {
  const [note, setNote] = useState('');
  const a = useAction(completeTask, { success: `${task.id} completed`, onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title="Mark as complete" footer={<Foot onClose={onClose} label="Complete task" pending={a.pending} form="f-complete" />}>
      <form id="f-complete" className="stack" onSubmit={(e) => (e.preventDefault(), a.run(task.id, note))}>
        <p>This task does not require review, so completing it closes it immediately. The task giver is notified.</p>
        <Field label="Closing note" htmlFor="c-note" hint="Optional.">
          <Textarea id="c-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

export function ReviewDialog({ task, submission, onClose }: Base & { submission?: Review }) {
  const [decision, setDecision] = useState<'approved' | 'changes_requested' | 'rejected'>('approved');
  const [comment, setComment] = useState('');
  const a = useAction(reviewTask, { success: decision === 'approved' ? `${task.id} approved and completed` : `Sent back to ${task.assignee?.name}`, onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title={`Review ${task.id}`} description={submission ? `Round ${submission.round} · submitted ${formatDateTime(submission.submittedAt)}` : undefined} footer={<Foot onClose={onClose} label={decision === 'approved' ? 'Approve' : decision === 'rejected' ? 'Reject' : 'Request changes'} danger={decision === 'rejected'} pending={a.pending} form="f-review" />}>
      <form id="f-review" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { decision, comment }))}>
        {submission && (
          <blockquote className="quote">
            <strong>{task.assignee?.name}:</strong> {submission.note}
          </blockquote>
        )}
        <fieldset className="radio-cards">
          <legend>Decision</legend>
          {(
            [
              ['approved', 'Approve', 'Completes the task.'],
              ['changes_requested', 'Request changes', 'Returns it to the assignee to rework and resubmit.'],
              ['rejected', 'Reject', 'The submission is not acceptable; the assignee must redo the work.'],
            ] as const
          ).map(([v, l, h]) => (
            <label key={v} className={decision === v ? 'on' : ''}>
              <input type="radio" name="decision" value={v} checked={decision === v} onChange={() => setDecision(v)} />
              <span>
                <strong>{l}</strong>
                <small>{h}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Review comments" required={decision !== 'approved'} htmlFor="r-comment" error={a.fields.comment}>
          <Textarea id="r-comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} invalid={!!a.fields.comment} />
        </Field>
      </form>
    </Dialog>
  );
}

export function ExtensionDialog({ task, onClose }: Base) {
  const cur = Date.parse(task.dueAt);
  const [date, setDate] = useState(toDateInput(Math.max(cur, now()) + 2 * 24 * HOUR));
  const [time, setTime] = useState(toTimeInput(cur));
  const [reason, setReason] = useState('');
  const [info, setInfo] = useState('');
  const a = useAction(requestExtension, { success: 'Extension requested. The due date changes only if it is approved.', onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} title="Request a due-date extension" footer={<Foot onClose={onClose} label="Send request" pending={a.pending} form="f-ext" />}>
      <form id="f-ext" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { requestedDate: date, requestedTime: time, reason, info }))}>
        <Field label="Current due date">
          <Input value={formatDateTime(task.dueAt)} readOnly disabled />
        </Field>
        <div className="grid-2">
          <Field label="Requested due date" required htmlFor="e-date" error={a.fields.requestedDate}>
            <Input id="e-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} invalid={!!a.fields.requestedDate} />
          </Field>
          <Field label="Time" htmlFor="e-time">
            <Input id="e-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <Field label="Reason" required htmlFor="e-reason" error={a.fields.reason}>
          <Textarea id="e-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!a.fields.reason} />
        </Field>
        <Field label="Supporting information" htmlFor="e-info" hint="Optional.">
          <Textarea id="e-info" rows={2} value={info} onChange={(e) => setInfo(e.target.value)} />
        </Field>
        <Banner tone="info">Until approved, escalation keeps using the current due date.</Banner>
      </form>
    </Dialog>
  );
}

export function DecideExtensionDialog({ task, ext, onClose }: Base & { ext: Extension }) {
  const [approve, setApprove] = useState(true);
  const [note, setNote] = useState('');
  const a = useAction(decideExtension, { success: approve ? 'Extension approved; due date updated and escalation recalculated.' : 'Extension rejected.', onSuccess: onClose });
  const requesterName = personOn(task, ext.requestedBy) ?? 'The assignee';
  return (
    <Dialog open onClose={onClose} title="Decide extension request" description={`${requesterName} · ${task.id}`} footer={<Foot onClose={onClose} label={approve ? 'Approve extension' : 'Reject extension'} danger={!approve} pending={a.pending} form="f-decide" />}>
      <form id="f-decide" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(ext.id, { approve, note }))}>
        <dl className="kv">
          <div>
            <dt>Current due</dt>
            <dd>{formatDateTime(ext.currentDue)}</dd>
          </div>
          <div>
            <dt>Requested due</dt>
            <dd>
              <strong>{formatDateTime(ext.requestedDue)}</strong>
            </dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{ext.reason}</dd>
          </div>
          {ext.info && (
            <div>
              <dt>Supporting info</dt>
              <dd>{ext.info}</dd>
            </div>
          )}
        </dl>
        <fieldset className="radio-cards two">
          <legend>Decision</legend>
          <label className={approve ? 'on' : ''}>
            <input type="radio" name="ext" checked={approve} onChange={() => setApprove(true)} />
            <span>
              <strong>Approve</strong>
              <small>Due date moves; due-based escalation recalculates.</small>
            </span>
          </label>
          <label className={!approve ? 'on' : ''}>
            <input type="radio" name="ext" checked={!approve} onChange={() => setApprove(false)} />
            <span>
              <strong>Reject</strong>
              <small>Due date stays as is.</small>
            </span>
          </label>
        </fieldset>
        <Field label="Note to the assignee" required={!approve} htmlFor="d-note" error={a.fields.note}>
          <Textarea id="d-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!a.fields.note} />
        </Field>
      </form>
    </Dialog>
  );
}

export function ReassignDialog({ task, onClose }: Base) {
  const options = (useApi(['task-assignees'], assigneeOptions).data ?? []).filter((u) => u.id !== task.assigneeId);
  const [toId, setToId] = useState('');
  const [reason, setReason] = useState('');
  const a = useAction(reassignTask, { success: `${task.id} reassigned`, onSuccess: onClose });
  // The server sends team and load with each option; the prototype computes them from its store.
  const extra = (u: (typeof options)[number] & { teamName?: string | null; openCount?: number }) => {
    if (BACKEND === 'server') return `${u.teamName ?? 'no team'} (${u.openCount ?? 0} open)`;
    const db = getDb();
    return `${db.teams.find((t) => t.id === u.teamId)?.name ?? 'no team'} (${db.tasks.filter((t) => t.assigneeId === u.id && ['assigned', 'in_progress', 'changes_requested', 'reopened'].includes(t.status)).length} open)`;
  };
  return (
    <Dialog open onClose={onClose} title={`Reassign ${task.id}`} description="History and escalation events stay with the task. The new assignee gets a fresh update window; past-due levels still apply." footer={<Foot onClose={onClose} label="Reassign" pending={a.pending} form="f-reassign" />}>
      <form id="f-reassign" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { toId, reason }))}>
        <Field label="Current assignee">
          <Input value={task.assignee?.name ?? ''} readOnly disabled />
        </Field>
        <Field label="New assignee" required htmlFor="ra-to" error={a.fields.toId} hint="People in your assignment scope.">
          <Select id="ra-to" value={toId} onChange={(e) => setToId(e.target.value)} invalid={!!a.fields.toId}>
            <option value="">Choose…</option>
            {options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {ROLE_LABEL[u.role]}, {extra(u)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" required htmlFor="ra-reason" error={a.fields.reason}>
          <Textarea id="ra-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!a.fields.reason} />
        </Field>
      </form>
    </Dialog>
  );
}

export function CancelDialog({ task, onClose }: Base) {
  const [reason, setReason] = useState('');
  const a = useAction(cancelTask, { success: `${task.id} cancelled`, onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Cancel ${task.id}?`} footer={<Foot onClose={onClose} label="Cancel task" danger pending={a.pending} form="f-cancel" />}>
      <form id="f-cancel" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, reason))}>
        <p>Cancelled tasks are closed permanently and stop escalating. All history is kept.</p>
        <Field label="Reason" required htmlFor="cx-reason" error={a.fields.reason}>
          <Textarea id="cx-reason" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!a.fields.reason} />
        </Field>
      </form>
    </Dialog>
  );
}

export function ReopenDialog({ task, onClose }: Base) {
  const [reason, setReason] = useState('');
  const [due, setDue] = useState(toDateInput(Math.max(Date.parse(task.dueAt), now() + 2 * 24 * HOUR)));
  const a = useAction(reopenTask, { success: `${task.id} reopened`, onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Reopen ${task.id}`} footer={<Foot onClose={onClose} label="Reopen" pending={a.pending} form="f-reopen" />}>
      <form id="f-reopen" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, { reason, dueDate: due }))}>
        <p>The previous history, reviews and completion are preserved. The assignee is notified.</p>
        <Field label="Reason" required htmlFor="ro-reason" error={a.fields.reason}>
          <Textarea id="ro-reason" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!a.fields.reason} />
        </Field>
        <Field label="New due date" required htmlFor="ro-due" error={a.fields.dueDate}>
          <Input id="ro-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} invalid={!!a.fields.dueDate} />
        </Field>
      </form>
    </Dialog>
  );
}

/** ESC-06/06a (WO FR-9): acknowledge with a note. Repeat alerts at that level pause; the level and the clock do not change. */
export function AckEscalationDialog({ task, eventId, onClose }: Base & { eventId?: string }) {
  const [note, setNote] = useState('');
  const a = useAction(ackEscalation, { success: 'Escalation acknowledged. The level is unchanged; repeat alerts are paused.', onSuccess: onClose });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Acknowledge the escalation on “${task.title}”`} footer={<Foot onClose={onClose} label="Acknowledge" pending={a.pending} form="f-escack" />}>
      <form id="f-escack" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), a.run(task.id, note, eventId))}>
        <p>Say what you are doing about it. This pauses repeat alerts at this level; it does not lower the level or reset the clock.</p>
        <Field label="Note" required htmlFor="ea-note" error={a.fields.note}>
          <Textarea id="ea-note" rows={3} autoFocus maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!a.fields.note} />
        </Field>
      </form>
    </Dialog>
  );
}
