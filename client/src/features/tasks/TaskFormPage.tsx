import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { HOUR, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { Banner, Button, Card, Checkbox, ErrorState, Field, FilePicker, Input, PageHeader, Select, Skeleton, Textarea } from '../../components/ui';
import { useAction, useApi, useMe } from '../../hooks';
import { saveRecurrence } from '../../services/api/admin';
import { assigneeOptions, createTask, getTask, parentOptions, taskFormLookups, updateTask, type TaskInput } from '../../services/api/tasks';
import { silenceThresholds } from '../../services/engine/escalation';
import { describeRecurrence } from '../../services/engine/recurrence';
import { now } from '../../services/mock/store';
import type { Frequency, Priority } from '../../types';
import { PRIORITIES } from '../../types';
import { toDateInput, toTimeInput } from '../../utils/format';
import { recommendedHours, type StandardTask } from '@taskwatch/shared/standardTasks';

export function NewTaskPage() {
  const due = now() + 2 * 24 * HOUR;
  return (
    <TaskForm
      initial={{ title: '', description: '', instructions: '', category: '', priority: 'normal', assigneeId: '', teamId: null, dueDate: toDateInput(due), dueTime: '17:00', startDate: '', reviewRequired: false, parentId: '', draft: false, files: [], target: '', unit: '', estimatedHours: '', purpose: '' }}
    />
  );
}

export function EditTaskPage() {
  const { id = '' } = useParams();
  const q = useApi(['task', id], () => getTask(id));
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={8} />;
  const t = q.data.task;
  if (!q.data.actions.includes('edit')) return <ErrorState error={{ status: 403, message: `You can't edit ${t.id} in its current state.` }} />;
  return (
    <TaskForm
      taskId={t.id}
      initial={{ title: t.title, description: t.description, instructions: t.instructions, category: t.category, priority: t.priority, assigneeId: t.assigneeId, teamId: t.teamId, dueDate: toDateInput(Date.parse(t.dueAt)), dueTime: toTimeInput(Date.parse(t.dueAt)), startDate: t.startAt ? toDateInput(Date.parse(t.startAt)) : '', reviewRequired: t.reviewRequired, parentId: t.parentId ?? '', draft: false, files: [], target: t.target != null ? String(t.target) : '', unit: t.unit ?? '', estimatedHours: t.estimatedHours != null ? String(t.estimatedHours) : '', purpose: t.purpose ?? '' }}
      currentAssignee={t.assignee}
    />
  );
}

function TaskForm({ initial, taskId, currentAssignee }: { initial: TaskInput; taskId?: string; currentAssignee?: { id: string; name: string } }) {
  const user = useMe();
  const nav = useNavigate();
  const [f, setF] = useState<TaskInput>(initial);
  const [recur, setRecur] = useState<{ on: boolean; frequency: Frequency; interval: number; weekdays: number[]; endDate: string }>({ on: false, frequency: 'weekly', interval: 1, weekdays: [new Date(now()).getDay()], endDate: '' });
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((x) => ({ ...x, [k]: v }));
  // Pickers and lookups come from the API (mock or server); the form waits for them below.
  const optionsQ = useApi(['task-assignees'], assigneeOptions);
  const parentsQ = useApi(['task-parents'], parentOptions);
  const lookQ = useApi(['task-form-lookups'], taskFormLookups);
  const options = optionsQ.data ?? [];
  const parents = (parentsQ.data ?? []).filter((p) => p.id !== taskId);
  const look = lookQ.data;
  // D-125: a standard task recommends the estimate (average time × quantity); the manager may keep or change it.
  const [std, setStd] = useState<StandardTask | null>(null);
  const quantityOf = (target: TaskInput['target']) => (Number(target) > 0 ? Number(target) : undefined);
  const quantity = quantityOf(f.target);
  const recommended = std ? recommendedHours(std, quantity) : null;
  const pickStandard = (i: string) => {
    const s = i === '' ? null : (look?.standardTasks[Number(i)] ?? null);
    setStd(s);
    if (s) setF((x) => ({ ...x, unit: x.unit || s.unit, estimatedHours: String(recommendedHours(s, quantityOf(x.target))) }));
  };

  const create = useAction(createTask, { success: (t) => (f.draft ? `Draft ${t.id} saved` : `${t.id} assigned`), onSuccess: (t) => nav(`/tasks/${t.id}`) });
  const update = useAction(updateTask, { success: `${taskId} updated`, onSuccess: () => nav(`/tasks/${taskId}`) });
  const rec = useAction(saveRecurrence, { success: 'Recurring schedule created; the first instance is generated on its start date.', onSuccess: () => nav('/recurring') });
  const fields = { ...create.fields, ...update.fields, ...rec.fields };
  const pending = create.pending || update.pending || rec.pending;

  const submit = (draft: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    const input = { ...f, draft };
    if (taskId) update.run(taskId, input);
    else if (recur.on && !draft) {
      if (!f.assigneeId) return create.run(input); // surfaces field errors
      rec.run(null, { title: f.title, description: f.description, category: f.category, priority: f.priority, assigneeId: f.assigneeId, teamId: f.teamId || options.find((u) => u.id === f.assigneeId)?.teamId || null, reviewRequired: f.reviewRequired, frequency: recur.frequency, interval: recur.interval, weekdays: recur.weekdays, startDate: f.startDate || f.dueDate, endDate: recur.endDate || null, dueHour: Number(f.dueTime.split(':')[0] ?? 17), target: f.target ? Number(f.target) : null, unit: f.unit || null, estimatedHours: f.estimatedHours ? Number(f.estimatedHours) : null, purpose: f.purpose || null });
    } else create.run(input);
  };

  if (optionsQ.error || lookQ.error) return <ErrorState error={(optionsQ.error ?? lookQ.error)!} />;
  if (!optionsQ.data || !look) return <Skeleton rows={8} />;
  const windows = silenceThresholds(f.priority, look.rules);
  const teamName = (id: string | null | undefined) => look.teams.find((t) => t.id === id)?.name;
  const assignee = options.find((o) => o.id === f.assigneeId) ?? currentAssignee;
  const outsideScope = currentAssignee && !options.some((o) => o.id === currentAssignee.id);
  // D-63: the entity is derived on the server from the chosen team, else the assignee; shown here read-only.
  const entityId = (f.teamId ? look.teams.find((t) => t.id === f.teamId)?.departmentId : undefined) ?? (() => {
    const o = options.find((x) => x.id === f.assigneeId);
    return o?.entityId ?? look.teams.find((t) => t.id === o?.teamId)?.departmentId;
  })();
  const entityName = look.entities.find((e) => e.id === entityId)?.name;

  return (
    <div className="page narrow">
      <PageHeader title={taskId ? `Edit ${taskId}` : 'New task'} description={taskId ? 'Changes are recorded in the task history and audit log.' : 'Assign work to someone in your reporting line. They are notified immediately.'} />
      {options.length === 0 && !taskId && <Banner tone="warn">You have no one below you in the reporting line, so you can't assign tasks yet. Ask your Chief of Staff to update reporting relationships.</Banner>}
      <form onSubmit={submit(false)} noValidate className="form-grid">
        <Card title="Task">
          <div className="stack">
            <Field label="Title" required htmlFor="t-title" error={fields.title}>
              <Input id="t-title" value={f.title} onChange={(e) => set('title', e.target.value)} invalid={!!fields.title} maxLength={140} autoFocus placeholder="e.g. Reconcile October carrier invoices" />
            </Field>
            <Field label="Description" htmlFor="t-desc" hint="What does done look like?">
              <Textarea id="t-desc" rows={4} value={f.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <Field label="Assignment instructions" htmlFor="t-inst" hint="Shown to the assignee and recorded with the assignment.">
              <Textarea id="t-inst" rows={2} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} />
            </Field>
            <div className="grid-2">
              <Field label="Category" required htmlFor="t-cat" error={fields.category}>
                <Select id="t-cat" value={f.category} onChange={(e) => set('category', e.target.value)} invalid={!!fields.category}>
                  <option value="">Choose…</option>
                  {look.categories.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Parent task" htmlFor="t-parent" error={fields.parentId}>
                <Select id="t-parent" value={f.parentId} onChange={(e) => set('parentId', e.target.value)}>
                  <option value="">None</option>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id} · {p.title}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {!taskId && (
              <Field label="Attachments">
                <FilePicker files={f.files} onChange={(files) => set('files', files)} />
              </Field>
            )}
          </div>
        </Card>

        <Card title="Assignment & schedule">
          <div className="stack">
            <Field label="Assignee" required htmlFor="t-assignee" error={fields.assigneeId} hint="Only people below you in the reporting line are listed.">
              <Select id="t-assignee" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)} invalid={!!fields.assigneeId}>
                <option value="">Choose…</option>
                {outsideScope && <option value={currentAssignee!.id}>{currentAssignee!.name} (current)</option>}
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} — {ROLE_LABEL[o.role]}, {teamName(o.teamId) ?? 'no team'}{o.load ? ` · load ${o.load.loadPercent}% (${o.load.band})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team / reporting scope" htmlFor="t-team" hint="Defaults to the assignee's team.">
              <Select id="t-team" value={f.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)}>
                <option value="">{assignee ? `Assignee's team (${teamName(options.find((u) => u.id === assignee.id)?.teamId) ?? 'none'})` : "Assignee's team"}</option>
                {look.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Vertical" htmlFor="t-entity" hint="Set automatically from the department, else the assignee.">
              <Input id="t-entity" value={entityName ?? (taskId ? 'Unchanged' : 'Choose an assignee')} readOnly />
            </Field>
            <Field label="Priority" required htmlFor="t-prio" hint={`Update required every ${windows[0]} h · L1 at ${windows[1]} h · L2 at ${windows[2]} h · L3 at ${windows[3]} h of silence.`}>
              <Select id="t-prio" value={f.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            {!!look?.standardTasks.length && (
              <Field label="Standard task" htmlFor="t-std" hint="Optional: recommends the estimate from the standard time list (Settings).">
                <Select id="t-std" value={std ? String(look.standardTasks.indexOf(std)) : ''} onChange={(e) => pickStandard(e.target.value)}>
                  <option value="">None</option>
                  {[...new Set(look.standardTasks.map((s) => s.section))].map((section) => (
                    <optgroup key={section} label={section}>
                      {look.standardTasks.map((s, i) =>
                        s.section === section ? (
                          <option key={i} value={i}>
                            {s.name}
                          </option>
                        ) : null,
                      )}
                    </optgroup>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid-2">
              <Field label="Target" htmlFor="t-target" error={fields.target} hint="Optional: how many, e.g. 150.">
                <Input id="t-target" type="number" min={0} step="any" value={f.target} onChange={(e) => set('target', e.target.value)} invalid={!!fields.target} />
              </Field>
              <Field label="Unit" htmlFor="t-unit" error={fields.unit} hint="e.g. emails, posts, leads.">
                <Input id="t-unit" maxLength={40} value={f.unit} onChange={(e) => set('unit', e.target.value)} invalid={!!fields.unit} />
              </Field>
              <Field
                label="Estimated hours"
                required
                htmlFor="t-est"
                error={fields.estimatedHours}
                hint={
                  std && recommended !== null ? (
                    <>
                      Recommended {recommended} h: {std.minMinutes === std.maxMinutes ? std.minMinutes : `${std.minMinutes}–${std.maxMinutes}`} min per {std.per > 1 ? `${std.per} ` : ''}
                      {std.unit}, for {quantity ?? std.per}.{' '}
                      {String(recommended) !== String(f.estimatedHours) && (
                        <button type="button" className="link-btn" onClick={() => set('estimatedHours', String(recommended))}>
                          Use it
                        </button>
                      )}
                    </>
                  ) : (
                    'Expected effort; used for workload and the over-time check.'
                  )
                }
              >
                <Input id="t-est" type="number" min={0.25} max={200} step={0.25} value={f.estimatedHours} onChange={(e) => set('estimatedHours', e.target.value)} invalid={!!fields.estimatedHours} />
              </Field>
              <Field label="Purpose" required htmlFor="t-purpose" error={fields.purpose}>
                <Select id="t-purpose" value={f.purpose} onChange={(e) => set('purpose', e.target.value as TaskInput['purpose'])} invalid={!!fields.purpose}>
                  <option value="">Choose…</option>
                  <option value="revenue">Revenue-oriented</option>
                  <option value="support">Support</option>
                </Select>
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Due date" required htmlFor="t-due" error={fields.dueDate}>
                <Input id="t-due" type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} invalid={!!fields.dueDate} />
              </Field>
              <Field label="Due time" htmlFor="t-time">
                <Input id="t-time" type="time" value={f.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
              </Field>
            </div>
            <Field label="Start date" htmlFor="t-start" error={fields.startDate} hint="Optional.">
              <Input id="t-start" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} invalid={!!fields.startDate} />
            </Field>
            <Checkbox label="Review required" hint="The assignee submits for review; you approve before it completes." checked={f.reviewRequired} onChange={(e) => set('reviewRequired', e.target.checked)} />
            {!taskId && (
              <div className="recur-box">
                <Checkbox label="Repeat this task" hint="Creates a recurring schedule; each occurrence becomes its own task." checked={recur.on} onChange={(e) => setRecur({ ...recur, on: e.target.checked })} />
                {recur.on && (
                  <div className="stack-sm">
                    <div className="grid-2">
                      <Field label="Frequency" htmlFor="r-freq">
                        <Select id="r-freq" value={recur.frequency} onChange={(e) => setRecur({ ...recur, frequency: e.target.value as Frequency })}>
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="interval">Every N days</option>
                        </Select>
                      </Field>
                      <Field label={recur.frequency === 'interval' ? 'Every N days' : 'Every'} htmlFor="r-int" error={fields.interval}>
                        <Input id="r-int" type="number" min={1} max={365} value={recur.interval} onChange={(e) => setRecur({ ...recur, interval: Number(e.target.value) })} />
                      </Field>
                    </div>
                    {recur.frequency === 'weekly' && (
                      <fieldset className="weekdays">
                        <legend>Repeat on</legend>
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                          <label key={d} className="weekday">
                            <input type="checkbox" checked={recur.weekdays.includes(i)} onChange={(e) => setRecur({ ...recur, weekdays: e.target.checked ? [...recur.weekdays, i].sort() : recur.weekdays.filter((x) => x !== i) })} />
                            <span>{d}</span>
                          </label>
                        ))}
                        {fields.weekdays && <span className="field-msg">{fields.weekdays}</span>}
                      </fieldset>
                    )}
                    <Field label="End date" htmlFor="r-end" hint="Optional." error={fields.endDate}>
                      <Input id="r-end" type="date" value={recur.endDate} onChange={(e) => setRecur({ ...recur, endDate: e.target.value })} />
                    </Field>
                    <p className="muted small">
                      {describeRecurrence({ frequency: recur.frequency, interval: recur.interval, weekdays: recur.weekdays, startDate: f.startDate || f.dueDate, endDate: recur.endDate || null })}, starting {f.startDate || f.dueDate}. Each task is due at {f.dueTime}.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="form-actions">
          <Link to={taskId ? `/tasks/${taskId}` : '/tasks/assigned-by-me'} className="btn btn-ghost">
            Cancel
          </Link>
          {!taskId && !recur.on && (
            <Button onClick={() => submit(true)()} disabled={pending}>
              Save as draft
            </Button>
          )}
          <Button type="submit" variant="primary" loading={pending} disabled={!taskId && options.length === 0}>
            {taskId ? 'Save changes' : recur.on ? 'Create schedule' : 'Assign task'}
          </Button>
        </div>
      </form>
    </div>
  );
}
