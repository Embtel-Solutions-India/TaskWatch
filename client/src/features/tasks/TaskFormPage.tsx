import { labelDepartments } from '@taskwatch/shared/permissions';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { HOUR, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { Banner, Button, Card, Checkbox, ErrorState, Field, FilePicker, Input, PageHeader, Segmented, Select, Skeleton, Textarea } from '../../components/ui';
import { useAction, useApi, useAuth, useMe } from '../../hooks';
import { saveRecurrence } from '../../services/api/admin';
import { assigneeOptions, createTask, getSchedule, getTask, taskFormLookups, updateTask, type TaskInput } from '../../services/api/tasks';
import { outsideWorkingHours, overlaps } from '@taskwatch/shared/schedule';
import { DEFAULT_SETTINGS } from '@taskwatch/shared/settings';
import { silenceThresholds } from '../../services/engine/escalation';
import { describeRecurrence } from '../../services/engine/recurrence';
import { now } from '../../services/mock/store';
import type { Frequency, Priority } from '../../types';
import { PRIORITIES } from '../../types';
import { toDateInput, toTimeInput } from '../../utils/format';
import { workingHours } from '@taskwatch/shared/performance';

export function NewTaskPage() {
  const due = now() + 2 * 24 * HOUR;
  return (
    <TaskForm
      initial={{ title: '', description: '', instructions: '', category: '', priority: 'normal', assigneeId: '', teamId: null, dueDate: toDateInput(due), dueTime: '17:00', startDate: '', startTime: '09:00', submissionRequirements: '', reviewerId: '', alsoAssigneeIds: [], reviewRequired: false, parentId: '', draft: false, files: [], target: '', unit: '', estimatedHours: '', purpose: '' }}
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
      initial={{ title: t.title, description: t.description, instructions: t.instructions, category: t.category, priority: t.priority, assigneeId: t.assigneeId, teamId: t.teamId, dueDate: toDateInput(Date.parse(t.dueAt)), dueTime: toTimeInput(Date.parse(t.dueAt)), startDate: t.startAt ? toDateInput(Date.parse(t.startAt)) : '', startTime: t.startAt ? toTimeInput(Date.parse(t.startAt)) : '09:00', submissionRequirements: t.submissionRequirements ?? '', reviewerId: t.reviewerId ?? '', alsoAssigneeIds: [], reviewRequired: t.reviewRequired, parentId: t.parentId ?? '', draft: false, files: [], target: t.target != null ? String(t.target) : '', unit: t.unit ?? '', estimatedHours: t.estimatedHours != null ? String(t.estimatedHours) : '', purpose: t.purpose ?? '' }}
      currentAssignee={t.assignee}
    />
  );
}

/**
 * D-151: soft warnings while scheduling, never a block: the due time falls outside the assignee's working day (in their
 * zone), or the window overlaps their other scheduled work that day (US-01).
 */
function ScheduleWarnings({ f, taskId, name }: { f: TaskInput; taskId?: string; name?: string }) {
  const auth = useAuth();
  const settings = auth.bootstrap?.settings ?? DEFAULT_SETTINGS;
  const on = !!f.assigneeId && !!f.dueDate;
  const q = useApi(['schedule', f.dueDate, 'user', f.assigneeId], () => (on ? getSchedule(f.dueDate, { userId: f.assigneeId }) : null));
  const person = q.data?.people[0];
  if (!on || !person) return null;
  const due = Date.parse(`${f.dueDate}T${f.dueTime || '17:00'}`);
  const start = f.startDate ? Date.parse(`${f.startDate}T${f.startTime || '00:00'}`) : null;
  const others = person.tasks.filter((t) => t.id !== taskId && t.status !== 'completed');
  const clash = overlaps([{ id: '__new', start, end: due }, ...others.map((t) => ({ id: t.id, start: t.startAt ? Date.parse(t.startAt) : null, end: Date.parse(t.dueAt) }))]);
  const n = [...clash].filter((id) => id !== '__new').length;
  const outside = outsideWorkingHours(due, person.timeZone, settings.workdayStart, settings.workdayEnd);
  if (!outside && !clash.has('__new')) return null;
  const who = name ?? 'the assignee';
  return (
    <Banner tone="warn">
      {outside && <>The due time is outside {who}'s working hours ({settings.workdayStart}–{settings.workdayEnd}, their time). </>}
      {clash.has('__new') && <>This overlaps {n} of {who}'s other task{n === 1 ? '' : 's'} that day.</>}
    </Banner>
  );
}

/**
 * Owner 2026-11-13: the estimate defaults to the working hours between the scheduled start (else now) and the due time,
 * in the assignee's zone, on the organization's workday (Mon–Fri). Rounded to 0.25 h, within the API's 0.25–200 h.
 * ponytail: uses the org workday, not a night-team person's own shift (shiftOf needs quiet hours the picker lacks).
 */
function autoEstimate(f: Pick<TaskInput, 'startDate' | 'startTime' | 'dueDate' | 'dueTime'>, zone: string, workday: { start: string; end: string }): number | null {
  if (!f.dueDate) return null;
  const from = f.startDate ? Date.parse(`${f.startDate}T${f.startTime || '00:00'}`) : now();
  const to = Date.parse(`${f.dueDate}T${f.dueTime || '17:00'}`);
  if (!(to > from)) return null;
  const h = workingHours(new Date(from), new Date(to), zone, workday);
  return Math.min(200, Math.max(0.25, Math.round(h * 4) / 4));
}

function TaskForm({ initial, taskId, currentAssignee }: { initial: TaskInput; taskId?: string; currentAssignee?: { id: string; name: string } }) {
  const user = useMe();
  const auth = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState<TaskInput>(initial);
  const [recur, setRecur] = useState<{ on: boolean; frequency: Frequency; interval: number; weekdays: number[]; endDate: string }>({ on: false, frequency: 'weekly', interval: 1, weekdays: [new Date(now()).getDay()], endDate: '' });
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((x) => ({ ...x, [k]: v }));
  // Pickers and lookups come from the API (mock or server); the form waits for them below.
  const optionsQ = useApi(['task-assignees'], assigneeOptions);
  const lookQ = useApi(['task-form-lookups'], taskFormLookups);
  const options = optionsQ.data ?? [];
  const look = lookQ.data;
  // Title: typed, or a row of the standard task list (Settings) whose name becomes the title.
  const [titleMode, setTitleMode] = useState<'custom' | 'standard' | null>(null);
  // Estimate: follows the schedule until the person types their own (a saved task keeps its saved value).
  const [estAuto, setEstAuto] = useState(!taskId && initial.estimatedHours === '');
  const [showAlso, setShowAlso] = useState(false);
  const [showScope, setShowScope] = useState(!!initial.teamId);

  const several = f.alsoAssigneeIds.length > 0; // D-153: one task per person
  const create = useAction(createTask, {
    success: (t) => (several ? `${f.alsoAssigneeIds.length + 1} tasks ${f.draft ? 'saved as drafts' : 'assigned'}, one per person` : f.draft ? `Draft ${t.id} saved` : `${t.id} assigned`),
    onSuccess: (t) => nav(several ? '/tasks/assigned-by-me' : `/tasks/${t.id}`),
  });
  const update = useAction(updateTask, { success: `${taskId} updated`, onSuccess: () => nav(`/tasks/${taskId}`) });
  const rec = useAction(saveRecurrence, { success: 'Recurring schedule created; the first instance is generated on its start date.', onSuccess: () => nav('/recurring') });
  const fields = { ...create.fields, ...update.fields, ...rec.fields };
  const pending = create.pending || update.pending || rec.pending;

  const settings = auth.bootstrap?.settings ?? DEFAULT_SETTINGS;
  const assignee = options.find((o) => o.id === f.assigneeId) ?? currentAssignee;
  const zone = (assignee as { timezone?: string } | undefined)?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const auto = autoEstimate(f, zone, { start: settings.workdayStart, end: settings.workdayEnd });
  const estimate = estAuto ? (auto === null ? '' : String(auto)) : f.estimatedHours;

  const submit = (draft: boolean) => (e?: FormEvent) => {
    e?.preventDefault();
    const input = { ...f, estimatedHours: estimate, draft };
    if (taskId) update.run(taskId, input);
    else if (recur.on && !draft) {
      if (!f.assigneeId) return create.run(input); // surfaces field errors
      rec.run(null, { title: f.title, description: f.description, category: f.category, priority: f.priority, assigneeId: f.assigneeId, teamId: f.teamId || options.find((u) => u.id === f.assigneeId)?.teamId || null, reviewRequired: f.reviewRequired, frequency: recur.frequency, interval: recur.interval, weekdays: recur.weekdays, startDate: f.startDate || f.dueDate, endDate: recur.endDate || null, dueHour: Number(f.dueTime.split(':')[0] ?? 17), target: f.target ? Number(f.target) : null, unit: f.unit || null, estimatedHours: estimate ? Number(estimate) : null, purpose: f.purpose || null });
    } else create.run(input);
  };

  if (optionsQ.error || lookQ.error) return <ErrorState error={(optionsQ.error ?? lookQ.error)!} />;
  if (!optionsQ.data || !look) return <Skeleton rows={8} />;
  const windows = silenceThresholds(f.priority, look.rules);
  const teams = labelDepartments(look.teams, (t) => t.departmentId); // ADR-0011: "Sales · BAIS" across verticals
  const teamName = (id: string | null | undefined) => teams.find((t) => t.id === id)?.name;
  const outsideScope = currentAssignee && !options.some((o) => o.id === currentAssignee.id);
  // D-63: the entity is derived on the server from the chosen team, else the assignee; shown here read-only.
  const entityId = (f.teamId ? look.teams.find((t) => t.id === f.teamId)?.departmentId : undefined) ?? (() => {
    const o = options.find((x) => x.id === f.assigneeId);
    return o?.entityId ?? look.teams.find((t) => t.id === o?.teamId)?.departmentId;
  })();
  const entityName = look.entities.find((e) => e.id === entityId)?.name;
  const stdIndex = look.standardTasks.findIndex((s) => s.name === f.title);
  const mode = titleMode ?? (f.title && stdIndex >= 0 ? 'standard' : 'custom');
  const pickStandard = (i: string) => {
    const s = i === '' ? null : look.standardTasks[Number(i)];
    setF((x) => ({ ...x, title: s?.name ?? '', unit: s ? x.unit || s.unit : x.unit }));
  };
  const scopeTeam = teamName(f.teamId) ?? teamName(options.find((u) => u.id === f.assigneeId)?.teamId);
  const detailsUsed = !!(f.instructions || f.submissionRequirements);

  return (
    <div className="page narrow">
      <PageHeader title={taskId ? `Edit ${taskId}` : 'New task'} description={taskId ? 'Changes are recorded in the task history and audit log.' : 'Assign work to someone in your reporting line. They are notified immediately.'} />
      {options.length === 0 && !taskId && <Banner tone="warn">You have no one below you in the reporting line, so you can't assign tasks yet. Ask your Chief of Staff to update reporting relationships.</Banner>}
      <form onSubmit={submit(false)} noValidate className="task-form">
        {/* 1 · What */}
        <Card title="What" sub="The work and what done looks like.">
          <div className="stack">
            {look.standardTasks.length > 0 && (
              <Segmented label="Title source" value={mode} onChange={(m) => setTitleMode(m)} options={[{ value: 'custom', label: 'Custom' }, { value: 'standard', label: 'Standard task' }]} />
            )}
            {mode === 'standard' ? (
              <Field label="Standard task" required htmlFor="t-std" error={fields.title} hint="From the standard task list in Settings; its name becomes the title.">
                <Select id="t-std" value={stdIndex >= 0 ? String(stdIndex) : ''} onChange={(e) => pickStandard(e.target.value)} invalid={!!fields.title}>
                  <option value="">Choose…</option>
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
            ) : (
              <Field label="Title" required htmlFor="t-title" error={fields.title}>
                <Input id="t-title" value={f.title} onChange={(e) => set('title', e.target.value)} invalid={!!fields.title} maxLength={140} autoFocus placeholder="e.g. Reconcile October carrier invoices" />
              </Field>
            )}
            <div className="grid-2">
              <Field label="Target" htmlFor="t-target" error={fields.target} hint="Optional: how many.">
                <Input id="t-target" type="number" min={0} step="any" value={f.target} onChange={(e) => set('target', e.target.value)} invalid={!!fields.target} placeholder="e.g. 150" />
              </Field>
              <Field label="Unit" htmlFor="t-unit" error={fields.unit}>
                <Input id="t-unit" maxLength={40} value={f.unit} onChange={(e) => set('unit', e.target.value)} invalid={!!fields.unit} placeholder="e.g. calls, posts, leads" />
              </Field>
            </div>
            <Field label="Description" htmlFor="t-desc" hint="What does done look like?">
              <Textarea id="t-desc" rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <details className="more-details" open={detailsUsed || !!fields.submissionRequirements}>
              <summary>More details · instructions, hand-in, files</summary>
              <div className="stack">
                <Field label="Assignment instructions" htmlFor="t-inst" hint="Shown to the assignee and recorded with the assignment.">
                  <Textarea id="t-inst" rows={2} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} />
                </Field>
                <Field label="Submission requirements" htmlFor="t-req" hint="What the assignee must hand in, e.g. the signed PDF." error={fields.submissionRequirements}>
                  <Textarea id="t-req" rows={2} maxLength={2000} value={f.submissionRequirements} onChange={(e) => set('submissionRequirements', e.target.value)} />
                </Field>
                {!taskId && (
                  <Field label="Attachments">
                    <FilePicker files={f.files} onChange={(files) => set('files', files)} />
                  </Field>
                )}
              </div>
            </details>
          </div>
        </Card>

        {/* 2 · Who */}
        <Card title="Who" sub="Only people below you in the reporting line are listed.">
          <div className="stack">
            <Field label="Assignee" required htmlFor="t-assignee" error={fields.assigneeId}>
              <Select id="t-assignee" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)} invalid={!!fields.assigneeId}>
                <option value="">Choose…</option>
                {outsideScope && <option value={currentAssignee!.id}>{currentAssignee!.name} (current)</option>}
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} — {ROLE_LABEL[o.role]}, {teamName(o.teamId) ?? 'no department'}{o.load ? ` · load ${o.load.loadPercent}% (${o.load.band})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {!taskId && !recur.on && options.length > 1 && (
              showAlso || several ? (
                <fieldset className="assign-also">
                  <legend>Also assign to</legend>
                  <p className="muted small">Each person gets their own copy, with its own deadline and escalations.</p>
                  <div className="assign-also-list">
                    {options
                      .filter((o) => o.id !== f.assigneeId)
                      .map((o) => (
                        <Checkbox key={o.id} label={o.name} checked={f.alsoAssigneeIds.includes(o.id)} onChange={(e) => set('alsoAssigneeIds', e.target.checked ? [...f.alsoAssigneeIds, o.id] : f.alsoAssigneeIds.filter((x) => x !== o.id))} />
                      ))}
                  </div>
                  {fields.assigneeIds && <span className="field-msg">{fields.assigneeIds}</span>}
                </fieldset>
              ) : (
                <button type="button" className="link-btn add-more" onClick={() => setShowAlso(true)}>
                  + Add more people
                </button>
              )
            )}
            {showScope ? (
              <Field label="Department / reporting scope" htmlFor="t-team" hint={`Vertical: ${entityName ?? (taskId ? 'unchanged' : 'set from the assignee')}`}>
                <Select id="t-team" value={f.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)}>
                  <option value="">{assignee ? `Assignee's department (${teamName(options.find((u) => u.id === assignee.id)?.teamId) ?? 'none'})` : "Assignee's department"}</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="scope-line muted small">
                {entityName || scopeTeam ? [entityName, scopeTeam].filter(Boolean).join(' · ') : 'Department and vertical follow the assignee.'}{' '}
                <button type="button" className="link-btn" onClick={() => setShowScope(true)}>
                  Change
                </button>
              </p>
            )}
          </div>
        </Card>

        {/* 3 · When */}
        <Card title="When" sub="Starting earlier or later never moves the due time.">
          <div className="stack">
            <div className="when-grid">
              <Field label="Start" htmlFor="t-start" error={fields.startDate} hint="Optional; blank = from now.">
                <div className="date-time">
                  <Input id="t-start" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} invalid={!!fields.startDate} />
                  <Input id="t-start-time" aria-label="Start time" type="time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} disabled={!f.startDate} />
                </div>
              </Field>
              <Field label="Due" required htmlFor="t-due" error={fields.dueDate}>
                <div className="date-time">
                  <Input id="t-due" type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} invalid={!!fields.dueDate} />
                  <Input id="t-time" aria-label="Due time" type="time" value={f.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
                </div>
              </Field>
            </div>
            <Field
              label="Estimated hours"
              required
              htmlFor="t-est"
              error={fields.estimatedHours}
              hint={
                estAuto ? (
                  `Working hours between start and due (${settings.workdayStart}–${settings.workdayEnd}, Mon–Fri, assignee's time). Type to override.`
                ) : (
                  <>
                    Set by hand.{' '}
                    {auto !== null && (
                      <button type="button" className="link-btn" onClick={() => setEstAuto(true)}>
                        Use schedule ({auto} h)
                      </button>
                    )}
                  </>
                )
              }
            >
              <div className="est-row">
                <Input id="t-est" type="number" min={0.25} max={200} step={0.25} value={estimate} onChange={(e) => (setEstAuto(false), set('estimatedHours', e.target.value))} invalid={!!fields.estimatedHours} />
                <span className="muted">h</span>
                {estAuto && <span className="tag tag-info">Auto</span>}
              </div>
            </Field>
            <ScheduleWarnings f={f} taskId={taskId} name={assignee?.name} />
          </div>
        </Card>

        {/* 4 · Priority & settings */}
        <Card title="Priority & settings">
          <div className="stack">
            <Field label="Priority" required hint={`Update required every ${windows[0]} h · L1 at ${windows[1]} h · L2 at ${windows[2]} h · L3 at ${windows[3]} h of silence.`}>
              <Segmented label="Priority" value={f.priority} onChange={(p) => set('priority', p as Priority)} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} />
            </Field>
            <Field label="Purpose" required error={fields.purpose}>
              <Segmented label="Purpose" value={f.purpose} onChange={(p) => set('purpose', p as TaskInput['purpose'])} options={[{ value: 'revenue', label: 'Revenue-oriented' }, { value: 'support', label: 'Support' }]} />
            </Field>
            <div className="switch">
              <Checkbox label="Review required" hint="The assignee submits for review; the reviewer approves before it completes." checked={f.reviewRequired} onChange={(e) => set('reviewRequired', e.target.checked)} />
            </div>
            {f.reviewRequired && (
              <Field label="Reviewer" htmlFor="t-reviewer" error={fields.reviewerId} hint="Defaults to you.">
                <Select id="t-reviewer" value={f.reviewerId} onChange={(e) => set('reviewerId', e.target.value)} invalid={!!fields.reviewerId}>
                  <option value="">You</option>
                  {options
                    .filter((o) => o.role !== 'staff' && o.id !== f.assigneeId && o.id !== user.id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} — {ROLE_LABEL[o.role]}
                      </option>
                    ))}
                </Select>
              </Field>
            )}
            {!taskId && (
              <>
                <div className="switch">
                  <Checkbox label="Repeat this task" hint="Creates a recurring schedule; each occurrence becomes its own task." checked={recur.on} onChange={(e) => setRecur({ ...recur, on: e.target.checked })} />
                </div>
                {recur.on && (
                  <div className="recur-box stack-sm">
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
              </>
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
