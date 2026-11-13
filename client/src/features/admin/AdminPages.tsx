import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HOUR, LEVEL_LABEL, ORG_WIDE_PERMISSIONS, PERMISSION_HELP, PERMISSION_LABEL, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { Icon } from '../../components/icons';
import { Banner, Button, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi, useAuth } from '../../hooks';
import { PRE_DEADLINE_WARNING_MINUTES, diffPolicy } from '@taskwatch/shared/policy';
import { assigneeOptions } from '../../services/api/tasks';
import { BACKEND } from '../../services/http';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import { DEFAULT_SETTINGS } from '@taskwatch/shared/settings';
import type { StandardTask } from '@taskwatch/shared/standardTasks';

/** Mandatory alert channels (D-106: WhatsApp only when switched on). */
const CHANNELS = WHATSAPP_ENABLED ? 'WhatsApp, email, in-app' : 'Email, in-app';
import { applyPolicy, getPolicies, getRoles, getSettings, resetPolicy, setRolePermissions, setRules, setSettings } from '../../services/api/admin';
import { computeLevel } from '../../services/engine/escalation';
import type { Permission, Role, RulesConfig, Settings } from '../../types';
import { PRIORITIES, ROLES } from '../../types';
import { cx } from '../../utils/format';

const GROUPS: { name: string; perms: Permission[] }[] = [
  { name: 'Tasks', perms: ['view_tasks', 'create_tasks', 'update_assigned_tasks'] },
  { name: 'Assignments', perms: ['assign_tasks', 'reassign_tasks', 'approve_extensions'] },
  { name: 'Reviews', perms: ['review_tasks'] },
  { name: 'Staff', perms: ['manage_team', 'manage_staff'] },
  { name: 'Reports', perms: ['view_team_reports', 'view_org_reports'] },
  { name: 'Administration', perms: ['manage_roles', 'manage_escalation_policies', 'manage_system_settings'] },
  { name: 'Audit', perms: ['view_audit_logs'] },
];

export function RolesPage() {
  const q = useApi(['roles'], getRoles);
  const [draft, setDraft] = useState<Record<Role, readonly Permission[]> | null>(null);
  const [confirm, setConfirm] = useState<Role | null>(null);
  const save = useAction(setRolePermissions, { success: (_) => 'Role permissions updated', onSuccess: () => setConfirm(null) });
  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data.matrix));
  }, [q.data]);
  if (q.error) return <ErrorState error={q.error} />;
  if (!draft || !q.data) return <Skeleton rows={10} />;
  const editable: Role[] = ['ceo', 'manager', 'lead', 'staff'];
  const dirty = (r: Role) => [...draft[r]].sort().join() !== [...q.data!.matrix[r]].sort().join();
  const toggle = (r: Role, p: Permission) => setDraft({ ...draft, [r]: draft[r].includes(p) ? draft[r].filter((x) => x !== p) : [...draft[r], p] });
  const diff = confirm ? { added: draft[confirm].filter((p) => !q.data!.matrix[confirm].includes(p)), removed: q.data.matrix[confirm].filter((p) => !draft[confirm].includes(p)) } : null;

  return (
    <div className="page">
      <PageHeader title="Roles & Permissions" description="What each role may do. Access to individual tasks is always further limited by the reporting line: a role never grants access to every task." />
      <Banner tone="info" icon="lock">
        Chief of Staff always holds every permission and can't be edited, so the platform can't be locked out. Permissions marked <Tag tone="danger">Org-wide</Tag> reach across the whole organization.
      </Banner>
      <div className="table-card">
        <div className="table-scroll">
          <table className="table matrix">
            <caption className="sr-only">Permission matrix</caption>
            <thead>
              <tr>
                <th>Permission</th>
                {ROLES.map((r) => (
                  <th key={r} className="center">
                    {ROLE_LABEL[r]}
                    <small className="muted block">{q.data!.counts[r]} people</small>
                  </th>
                ))}
              </tr>
            </thead>
            {GROUPS.map((g) => (
              <tbody key={g.name}>
                <tr className="group-row">
                  <th colSpan={ROLES.length + 1} scope="colgroup">
                    {g.name}
                  </th>
                </tr>
                {g.perms.map((p) => (
                  <tr key={p}>
                    <th scope="row" className="perm-name">
                      <span>
                        {PERMISSION_LABEL[p]} {ORG_WIDE_PERMISSIONS.includes(p) && <Tag tone="danger">Org-wide</Tag>}
                      </span>
                      <small className="muted">{PERMISSION_HELP[p]}</small>
                    </th>
                    {ROLES.map((r) => {
                      const on = r === 'cos' || draft[r].includes(p);
                      return (
                        <td key={r} className="center" data-label={ROLE_LABEL[r]}>
                          {r === 'cos' ? (
                            <span className="perm-state on" aria-label="Granted (locked)">
                              <Icon name="lock" size={12} /> Granted
                            </span>
                          ) : (
                            <label className={cx('perm-toggle', on && 'on')}>
                              <input type="checkbox" checked={on} onChange={() => toggle(r, p)} aria-label={`${PERMISSION_LABEL[p]} for ${ROLE_LABEL[r]}`} />
                              <span>{on ? 'Granted' : 'Denied'}</span>
                            </label>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr>
                <th>Save changes</th>
                {ROLES.map((r) => (
                  <td key={r} className="center">
                    {editable.includes(r) && (
                      <div className="row-gap center">
                        <Button size="sm" variant="primary" disabled={!dirty(r)} onClick={() => setConfirm(r)}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!dirty(r)} onClick={() => setDraft({ ...draft, [r]: [...q.data!.matrix[r]] })}>
                          Reset
                        </Button>
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} onConfirm={() => save.run(confirm!, draft[confirm!])} title={`Change ${confirm ? ROLE_LABEL[confirm] : ''} permissions?`} confirmLabel="Apply to all" loading={save.pending} danger={!!diff?.added.some((p) => ORG_WIDE_PERMISSIONS.includes(p))}>
        <p>This applies immediately to all {confirm ? q.data.counts[confirm] : 0} active {confirm ? ROLE_LABEL[confirm] : ''}(s).</p>
        {diff && diff.added.length > 0 && (
          <>
            <strong>Granting</strong>
            <ul className="tight">{diff.added.map((p) => <li key={p}>{PERMISSION_LABEL[p]}{ORG_WIDE_PERMISSIONS.includes(p) && <strong className="tone-danger"> — organization-wide access</strong>}</li>)}</ul>
          </>
        )}
        {diff && diff.removed.length > 0 && (
          <>
            <strong>Removing</strong>
            <ul className="tight">{diff.removed.map((p) => <li key={p}>{PERMISSION_LABEL[p]}</li>)}</ul>
          </>
        )}
        {diff?.added.some((p) => ORG_WIDE_PERMISSIONS.includes(p)) && <Banner tone="danger">You are granting organization-wide access. Make sure this is intended; it is a privilege escalation for every holder of this role.</Banner>}
      </ConfirmDialog>
    </div>
  );
}

export function PoliciesPage() {
  const q = useApi(['rules'], getPolicies);
  const auth = useAuth();
  /** The CoS (manage_escalation_policies) sees every scope; a general manager only their own vertical (D-141, D-150). */
  const isAdmin = !auth.bootstrap || !!auth.permissions?.includes('manage_escalation_policies');
  /** 'default' or a vertical id. A vertical stores only the fields it changes; the rest is inherited (ADR-0014, D-142). */
  const [scope, setScope] = useState('default');
  const [r, setR] = useState<RulesConfig | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'reset' | 'apply' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const isDefault = scope === 'default';
  const base = q.data ? (isDefault ? q.data.defaults : (q.data.overrides[scope] ?? q.data.defaults)) : null;
  const save = useAction(setRules, {
    success: isDefault ? 'Escalation policy saved; new and rescheduled tasks use it.' : 'Vertical policy saved; new and rescheduled tasks use it.',
    onSuccess: () => (setConfirm(null), setSaved(scope)),
  });
  const reset = useAction(resetPolicy, { success: 'The vertical follows the global policy again.', onSuccess: () => (setConfirm(null), setSaved(scope)) });
  const apply = useAction(applyPolicy, { success: (x) => `${x.updated} open task${x.updated === 1 ? '' : 's'} rescheduled to the current policy.`, onSuccess: () => (setConfirm(null), setSaved(null)) });
  const peopleQ = useApi(['task-assignees'], assigneeOptions);
  useEffect(() => {
    if (q.data && !isAdmin && q.data.headOf[0] && scope === 'default') setScope(q.data.headOf[0]);
  }, [q.data, isAdmin, scope]);
  useEffect(() => {
    if (base) setR(structuredClone(base));
  }, [q.data, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error) return <ErrorState error={q.error} />;
  if (!r || !q.data || !base) return <Skeleton rows={10} />;
  const f = save.fields;
  const editable = isDefault ? isAdmin : true;
  const dirty = JSON.stringify(r) !== JSON.stringify(base);
  const num = (v: string) => Number(v);
  const discard = () => setR(structuredClone(base));
  /** A vertical field that differs from the global policy (ADR-0014: "Custom", else "Inherited"). */
  const custom = (a: unknown, b: unknown) => !isDefault && JSON.stringify(a) !== JSON.stringify(b);
  const g = q.data.defaults;
  const people = (peopleQ.data ?? []).filter((u) => u.entityId === scope);
  const history = q.data.history.filter((h) => h.target === scope);
  return (
    <div className="page">
      <PageHeader
        title="Escalation Policies"
        description="Deadline escalation, update windows and recipients. Changes are versioned and audited; open tasks keep their schedule unless you apply the change to them."
        actions={
          <>
            {!isDefault && q.data.stored[scope] && (
              <Button variant="ghost" onClick={() => setConfirm('reset')}>
                Reset to default
              </Button>
            )}
            <Button variant="ghost" disabled={!dirty} onClick={discard}>
              Discard
            </Button>
            <Button variant="primary" disabled={!dirty || !editable} onClick={() => setConfirm('save')}>
              {isDefault ? 'Save policy' : 'Save vertical policy'}
            </Button>
          </>
        }
      />
      {isAdmin && q.data.entities.length > 0 && (
        <Field label="Policy for" htmlFor="pol-scope" hint="Each vertical follows the global policy except for the fields it changes.">
          <select id="pol-scope" className="input select" value={scope} onChange={(e) => (setScope(e.target.value), setSaved(null))}>
            <option value="default">Global (every vertical)</option>
            {q.data.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {q.data!.stored[e.id] && Object.keys(q.data!.stored[e.id]!).length ? ' (customised)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!isDefault && (
        <Banner tone="info">
          {q.data.entities.find((e) => e.id === scope)?.name ?? scope}: fields marked Custom apply to this vertical only; everything else follows the global policy. Quiet hours, acknowledgement and the CEO on L3 are organization-wide.
        </Banner>
      )}
      {saved === scope && (
        <Banner tone="info" action={<Button size="sm" onClick={() => setConfirm('apply')}>Apply to open tasks</Button>}>
          Open tasks keep the schedule they were given. New, rescheduled and reassigned tasks use this policy.
        </Banner>
      )}
      <Card title="Deadline escalation" sub={`L1 reaches the team lead at the due time if the task is not submitted. A warning goes to the assignee ${PRE_DEADLINE_WARNING_MINUTES} minutes before (system-controlled).`}>
        <div className="table-scroll">
          <table className="table policy">
            <caption className="sr-only">Deadline escalation by priority</caption>
            <thead>
              <tr>
                <th>Priority</th>
                <th>L1 Team lead</th>
                <th>L2 Manager, after due</th>
                <th>L3 Founder's Office, after due</th>
                <th>Reviewer deadline</th>
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => {
                const d = r.deadlineDelaysMinutes[p];
                const setD = (i: 0 | 1, v: number) => setR({ ...r, deadlineDelaysMinutes: { ...r.deadlineDelaysMinutes, [p]: (i === 0 ? [v, d[1]] : [d[0], v]) as [number, number] } });
                return (
                  <tr key={p}>
                    <th scope="row">
                      {PRIORITY_LABEL[p]} {custom(d, g.deadlineDelaysMinutes[p]) || custom(r.reviewSlaMinutes[p], g.reviewSlaMinutes[p]) ? <Tag tone="info">Custom</Tag> : null}
                    </th>
                    <td className="muted">At due time</td>
                    {([0, 1] as const).map((i) => (
                      <td key={i}>
                        <DurationInput minutes={d[i]} disabled={!editable} label={`${PRIORITY_LABEL[p]} L${i + 2} after due`} invalid={!!f[`d_${p}`]} onChange={(v) => setD(i, v)} />
                      </td>
                    ))}
                    <td>
                      <DurationInput minutes={r.reviewSlaMinutes[p]} disabled={!editable} label={`${PRIORITY_LABEL[p]} reviewer deadline`} invalid={!!f[`sla_${p}`]} onChange={(v) => setR({ ...r, reviewSlaMinutes: { ...r.reviewSlaMinutes, [p]: v } })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {PRIORITIES.map((p) => (f[`d_${p}`] || f[`sla_${p}`] ? <span key={p} className="field-msg">{PRIORITY_LABEL[p]}: {f[`d_${p}`] ?? f[`sla_${p}`]}</span> : null))}
        {!isDefault && editable && (() => {
          const differs = custom(r.deadlineDelaysMinutes, g.deadlineDelaysMinutes) || custom(r.reviewSlaMinutes, g.reviewSlaMinutes);
          return (
            <div className="policy-foot">
              <span className="muted small">{differs ? 'Some values here differ from the global policy.' : 'These values match the global policy.'}</span>
              <Button size="sm" icon="refresh" disabled={!differs} onClick={() => setR({ ...r, deadlineDelaysMinutes: structuredClone(g.deadlineDelaysMinutes), reviewSlaMinutes: structuredClone(g.reviewSlaMinutes) })}>
                Reset to global values
              </Button>
            </div>
          );
        })()}
      </Card>
      <Card title="Resulting ladder" sub="Silence thresholds = update window × level multiple">
        <div className="table-scroll">
          <table className="table policy">
            <caption className="sr-only">Escalation thresholds by priority</caption>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Update required every</th>
                {LEVEL_LABEL.map((l) => (
                  <th key={l}>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRIORITIES.map((p) => (
                <tr key={p}>
                  <th scope="row">{PRIORITY_LABEL[p]}</th>
                  <td>
                    <Input type="number" min={1} max={720} disabled={!editable} aria-label={`${PRIORITY_LABEL[p]} update window (hours)`} className="input-sm num" value={r.windowsHours[p]} onChange={(e) => setR({ ...r, windowsHours: { ...r.windowsHours, [p]: num(e.target.value) } })} invalid={!!f[`w_${p}`]} /> h
                  </td>
                  {r.multiples.map((m, k) => (
                    <td key={k}>
                      <span className={cx('lvl', `lvl-${k}`)}>{Math.round(r.windowsHours[p] * m * 10) / 10} h</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid-2">
        {/* D-155: multiples, extra recipients and the simulator are for the CoS; a GM sees deadlines, windows and history. */}
        {isAdmin && (
        <Card title="Level multiples" sub="Applied to each priority's update window">
          <div className="grid-4">
            {r.multiples.map((m, k) => (
              <Field key={k} label={`L${k}`} htmlFor={`mult-${k}`}>
                <Input id={`mult-${k}`} type="number" step={0.5} min={0.5} disabled={!editable} value={m} onChange={(e) => setR({ ...r, multiples: r.multiples.map((x, j) => (j === k ? num(e.target.value) : x)) as RulesConfig['multiples'] })} />
              </Field>
            ))}
          </div>
          {f.multiples && <span className="field-msg">{f.multiples}</span>}
        </Card>
        )}
        {isAdmin && !isDefault && (
          <Card title="Extra recipients" sub="Copied on each level in addition to the reporting line. People of this vertical only.">
            {(['l1', 'l2', 'l3'] as const).map((k, i) => (
              <fieldset key={k} className="assign-also">
                <legend>
                  {LEVEL_LABEL[i + 1]} {custom(r.extraRecipients[k], g.extraRecipients[k]) ? <Tag tone="info">Custom</Tag> : null}
                </legend>
                <div className="assign-also-list">
                  {people.map((u) => (
                    <Checkbox
                      key={u.id}
                      label={u.name}
                      disabled={!editable}
                      checked={r.extraRecipients[k].includes(Number(u.id))}
                      onChange={(e) => setR({ ...r, extraRecipients: { ...r.extraRecipients, [k]: e.target.checked ? [...r.extraRecipients[k], Number(u.id)] : r.extraRecipients[k].filter((x) => x !== Number(u.id)) } })}
                    />
                  ))}
                  {!people.length && <span className="muted small">No people in this vertical are listed for you.</span>}
                </div>
                {f[`rcpt_${k}`] && <span className="field-msg">{f[`rcpt_${k}`]}</span>}
              </fieldset>
            ))}
          </Card>
        )}
        {isDefault && (
        <>
        <Card title="Acknowledgement & reminders">
          <div className="grid-2">
            <Field label="Acknowledgement snooze" htmlFor="snooze" hint="Repeat notifications pause for this long. Clocks keep running." error={f.ackSnoozeHours}>
              <Input id="snooze" type="number" min={1} max={72} value={r.ackSnoozeHours} onChange={(e) => setR({ ...r, ackSnoozeHours: num(e.target.value) })} />
            </Field>
            <Field label="'Due soon' notice" htmlFor="duesoon" hint="Hours before the due time." error={f.dueSoonHours}>
              <Input id="duesoon" type="number" min={1} max={168} value={r.dueSoonHours} onChange={(e) => setR({ ...r, dueSoonHours: num(e.target.value) })} />
            </Field>
          </div>
        </Card>
        <Card title={`Quiet hours (${WHATSAPP_ENABLED ? 'email & WhatsApp' : 'email'})`} sub={`Hold L0/L1 ${WHATSAPP_ENABLED ? 'email and WhatsApp' : 'email'} overnight in the recipient's zone; in-app alerts are never held.`}>
          <Checkbox label="Enable quiet hours" checked={r.quietHours.enabled} onChange={(e) => setR({ ...r, quietHours: { ...r.quietHours, enabled: e.target.checked } })} />
          <div className="grid-2">
            <Field label="Start" htmlFor="qs">
              <Input id="qs" type="time" value={r.quietHours.start} onChange={(e) => setR({ ...r, quietHours: { ...r.quietHours, start: e.target.value } })} />
            </Field>
            <Field label="End" htmlFor="qe">
              <Input id="qe" type="time" value={r.quietHours.end} onChange={(e) => setR({ ...r, quietHours: { ...r.quietHours, end: e.target.value } })} />
            </Field>
          </div>
        </Card>
        </>
        )}
      </div>
      {isDefault && (
      <Card title="Work-order routing" sub="Who receives each level. Missing roles in a reporting line skip to the next level up.">
        <table className="table compact">
          <caption className="sr-only">Escalation recipients</caption>
          <thead>
            <tr><th>Event</th><th>Recipient</th><th>Copied</th><th>Channels</th></tr>
          </thead>
          <tbody>
            <tr><td>New task assigned</td><td>Assignee</td><td>—</td><td>{CHANNELS}</td></tr>
            <tr><td><span className="lvl lvl-0">L0</span> Reminder</td><td>Assignee</td><td>—</td><td>{CHANNELS}</td></tr>
            <tr><td><span className="lvl lvl-1">L1</span> Team lead</td><td>Assignee's team lead</td><td>Assignee</td><td>{CHANNELS}</td></tr>
            <tr><td><span className="lvl lvl-2">L2</span> Manager</td><td>Manager</td><td>Lead and assignee</td><td>{CHANNELS}</td></tr>
            <tr><td><span className="lvl lvl-3">L3</span> Founder's Office</td><td>Chief of Staff{r.l3NotifyCeo ? ' and CEO' : ''}</td><td>Manager</td><td>{CHANNELS}, top of dashboard</td></tr>
            <tr><td>Weekly digest</td><td>Managers, Founder's Office</td><td>—</td><td>Email</td></tr>
          </tbody>
        </table>
        <Checkbox label="L3 also goes to the CEO (decision D7)" hint="When off, L3 goes to the Chief of Staff only." checked={r.l3NotifyCeo} onChange={(e) => setR({ ...r, l3NotifyCeo: e.target.checked })} />
      </Card>
      )}
      {isAdmin && <PolicySimulator rules={r} />}
      {!isDefault && (
        <Card title="Change history" sub="Every saved version of this vertical's policy.">
          {history.length ? (
            <ul className="plain-list">
              {history.map((h) => (
                <li key={h.id}>
                  <strong>{h.version != null ? `v${h.version}` : h.after === null ? 'Reset to global' : 'Applied to open tasks'}</strong> · {h.actor ?? 'System'} · {new Date(h.at).toLocaleString()}
                  {h.note ? <span className="muted"> — {h.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No changes yet: this vertical follows the global policy.</p>
          )}
        </Card>
      )}
      <ConfirmDialog open={confirm === 'save'} onClose={() => setConfirm(null)} onConfirm={() => save.run(isDefault ? r : (diffPolicy(r, g) as Partial<RulesConfig>), scope)} title={isDefault ? 'Save the global policy?' : 'Save this vertical policy?'} confirmLabel="Save" loading={save.pending}>
        <p>New, rescheduled and reassigned tasks use it. Open tasks keep their escalation times until you apply the change to them. Update windows apply at once. Existing escalation history is never altered.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'reset'} onClose={() => setConfirm(null)} onConfirm={() => reset.run(scope)} title="Follow the global policy?" confirmLabel="Follow the global policy" loading={reset.pending}>
        <p>Every custom field of this vertical is removed. Open tasks keep their escalation times until you apply the change to them.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'apply'} onClose={() => setConfirm(null)} onConfirm={() => apply.run(scope)} title="Apply to open tasks?" confirmLabel="Apply" loading={apply.pending}>
        <p>Every open task {isDefault ? '' : 'in this vertical '}gets new L2 and L3 times from the policy as it now stands, and may escalate at once. This is recorded in the audit log.</p>
      </ConfirmDialog>
    </div>
  );
}

/** "30 min", "2 h", "1 d 2 h". */
function minutesLabel(m: number): string {
  if (!(m > 0)) return '—';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d} d`, h && `${h} h`, mm && `${mm} min`].filter(Boolean).join(' ');
}

/**
 * A duration typed in minutes or hours (the dropdown); the value is always minutes. Whole hours open in hours.
 * Changing the unit keeps the duration and only re-expresses the number.
 */
function DurationInput({ minutes, onChange, label, disabled, invalid }: { minutes: number; onChange: (minutes: number) => void; label: string; disabled?: boolean; invalid?: boolean }) {
  const [unit, setUnit] = useState<'min' | 'h'>(minutes >= 60 && minutes % 60 === 0 ? 'h' : 'min');
  const per = unit === 'h' ? 60 : 1;
  return (
    <span className="duration-input">
      <Input type="number" min={unit === 'h' ? 0.5 : 5} step={unit === 'h' ? 0.5 : 5} disabled={disabled} aria-label={`${label} (${unit === 'h' ? 'hours' : 'minutes'})`} className="input-sm num" value={Number.isFinite(minutes) ? +(minutes / per).toFixed(2) : ''} onChange={(e) => onChange(Math.round(Number(e.target.value) * per))} invalid={invalid} />
      <Select aria-label={`${label} unit`} className="input-sm" disabled={disabled} value={unit} onChange={(e) => setUnit(e.target.value as 'min' | 'h')}>
        <option value="min">min</option>
        <option value="h">h</option>
      </Select>
      <span className="muted small">({minutesLabel(minutes)})</span>
    </span>
  );
}

function PolicySimulator({ rules }: { rules: RulesConfig }) {
  const [priority, setPriority] = useState<keyof RulesConfig['windowsHours']>('critical');
  const [silent, setSilent] = useState(5);
  const [overdue, setOverdue] = useState(-10);
  const t0 = 1_000 * HOUR;
  const res = computeLevel({ priority, clockStartedAt: t0 - silent * HOUR, dueAt: t0 - overdue * HOUR }, rules, t0);
  return (
    <Card title="Try the policy" sub="See which level a task would be at, using the unsaved values above.">
      <div className="grid-3">
        <Field label="Priority" htmlFor="sim-p">
          <select id="sim-p" className="input select" value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Hours since last update: ${silent}`} htmlFor="sim-s">
          <input id="sim-s" type="range" min={0} max={240} value={silent} onChange={(e) => setSilent(Number(e.target.value))} className="range" />
        </Field>
        <Field label={overdue >= 0 ? `Past due by ${overdue} h` : `Due in ${-overdue} h`} htmlFor="sim-o">
          <input id="sim-o" type="range" min={-96} max={120} value={overdue} onChange={(e) => setOverdue(Number(e.target.value))} className="range" />
        </Field>
      </div>
      <p className="sim-result">
        Result: <span className={cx('lvl', res.level < 0 ? 'lvl-ok' : `lvl-${res.level}`)}>{res.level < 0 ? 'On track' : LEVEL_LABEL[res.level]}</span>
        {res.level >= 0 && <span className="muted"> from {res.reason === 'overdue' ? 'the deadline rule' : 'the silence rule'} (silence L{res.silenceLevel < 0 ? '–' : res.silenceLevel}, deadline L{res.overdueLevel < 0 ? '–' : res.overdueLevel}; highest wins)</span>}
      </p>
    </Card>
  );
}

/** A removable tag list with an Add box (Google sign-in domains). */
function TagList({ items, noun, placeholder, normalize = (v) => v, error, onChange }: { items: string[]; noun: string; placeholder?: string; normalize?: (v: string) => string; error?: string; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <div className="tag-cloud mb">
        {items.map((c) => (
          <span key={c} className="tag removable">
            {c}
            <button type="button" aria-label={`Remove ${c}`} onClick={() => onChange(items.filter((x) => x !== c))}>
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="row-gap"
        onSubmit={(e) => {
          e.preventDefault();
          const v = normalize(draft.trim());
          if (v && !items.includes(v)) onChange([...items, v]);
          setDraft('');
        }}
      >
        <Input aria-label={`New ${noun}`} placeholder={placeholder ?? `Add ${noun}`} value={draft} onChange={(e) => setDraft(e.target.value)} className="input-sm" />
        <Button size="sm" type="submit">
          Add
        </Button>
      </form>
      {error && <span className="field-msg">{error}</span>}
    </>
  );
}

export function SettingsPage() {
  const q = useApi(['settings'], getSettings);
  const [s, setS] = useState<Settings | null>(null);
  const save = useAction(setSettings, { success: 'Settings saved' });
  useEffect(() => {
    if (q.data) setS(structuredClone(q.data));
  }, [q.data]);
  if (q.error) return <ErrorState error={q.error} />;
  if (!s || !q.data) return <Skeleton rows={10} />;
  const f = save.fields;
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data);
  return (
    <div className="page narrow">
      <PageHeader
        title="System Settings"
        actions={
          <Button variant="primary" disabled={!dirty} loading={save.pending} onClick={() => save.run(s)}>
            Save settings
          </Button>
        }
      />
      <Card title="Organization">
        <div className="grid-2">
          <Field label="Organization name" htmlFor="st-org" error={f.orgName}>
            <Input id="st-org" value={s.orgName} onChange={(e) => setS({ ...s, orgName: e.target.value })} invalid={!!f.orgName} />
          </Field>
          <Field label="Default time zone" htmlFor="st-tz">
            <select id="st-tz" className="input select" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata'].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </Field>
          <Field label="Workday starts" htmlFor="st-ws">
            <Input id="st-ws" type="time" value={s.workdayStart} onChange={(e) => setS({ ...s, workdayStart: e.target.value })} />
          </Field>
          <Field label="Workday ends" htmlFor="st-we">
            <Input id="st-we" type="time" value={s.workdayEnd} onChange={(e) => setS({ ...s, workdayEnd: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="Security & workload">
        <div className="grid-2">
          <Field label="Session timeout (minutes)" htmlFor="st-sess" hint="Inactive sessions end after this long." error={f.sessionTimeoutMinutes}>
            <Input id="st-sess" type="number" min={5} max={480} value={s.sessionTimeoutMinutes} onChange={(e) => setS({ ...s, sessionTimeoutMinutes: Number(e.target.value) })} />
          </Field>
          <Field label="Overload threshold (active tasks)" htmlFor="st-ol" hint="Workload charts flag people above this.">
            <Input id="st-ol" type="number" min={1} max={50} value={s.overloadThreshold} onChange={(e) => setS({ ...s, overloadThreshold: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="stack-sm">
          <strong className="small">Notification channels</strong>
          {/* D-41: on the real server these show whether credentials are set; they cannot be switched here. */}
          <Checkbox label={BACKEND === 'server' ? `Email: ${s.emailSimulation ? 'simulated' : 'live'}` : 'Email (simulated)'} hint={BACKEND === 'server' ? 'Set by the server: live once SMTP credentials are configured.' : 'Render email for each alert into the Delivery Log. Live sending is done by the server with SMTP credentials.'} checked={s.emailSimulation} disabled={BACKEND === 'server'} onChange={(e) => setS({ ...s, emailSimulation: e.target.checked })} />
          {WHATSAPP_ENABLED && <Checkbox label="WhatsApp Business (simulated)" hint={BACKEND === 'server' ? 'Set by the server: live once WhatsApp credentials and approved templates are configured.' : 'Render WhatsApp template messages for assignments and escalations. Live sending needs WHATSAPP_TOKEN and approved templates on the server.'} checked={s.whatsappSimulation} disabled={BACKEND === 'server'} onChange={(e) => setS({ ...s, whatsappSimulation: e.target.checked })} />}
          <Link to="/admin/deliveries" className="link-more">Open the Delivery Log</Link>
        </div>
      </Card>
      <Card title="Weekly digest" sub="Email to every Manager and the Founder's Office, scoped to their reporting line.">
        <div className="grid-2">
          <Field label="Send on" htmlFor="st-dd">
            <select id="st-dd" className="input select" value={s.digestDay} onChange={(e) => setS({ ...s, digestDay: Number(e.target.value) })}>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="At (hour, local)" htmlFor="st-dh">
            <Input id="st-dh" type="number" min={0} max={23} value={s.digestHour} onChange={(e) => setS({ ...s, digestHour: Number(e.target.value) })} />
          </Field>
        </div>
      </Card>
      <Card title="Performance scoring" sub="The leaderboard ranks on the Performance score: Outcome 50 %, Quality 30 %, Timeliness 20 %. These priority weights set how much each task counts in the Outcome part, Σ(task outcome % × weight) ÷ Σ(weight); all 1 counts every task equally.">
        <div className="grid-2">
          {PRIORITIES.map((p) => (
            <Field key={p} label={`${PRIORITY_LABEL[p]} task weight`} htmlFor={`st-w-${p}`} error={f[`priorityWeights.${p}`]}>
              <Input id={`st-w-${p}`} type="number" min={1} max={10} value={(s.priorityWeights ?? DEFAULT_SETTINGS.priorityWeights)[p]} onChange={(e) => setS({ ...s, priorityWeights: { ...(s.priorityWeights ?? DEFAULT_SETTINGS.priorityWeights), [p]: Number(e.target.value) } })} />
            </Field>
          ))}
        </div>
      </Card>
      <StandardTasksCard rows={s.standardTasks ?? DEFAULT_SETTINGS.standardTasks} errors={f} onChange={(standardTasks) => setS({ ...s, standardTasks })} />
      {BACKEND === 'server' && (
        <Card title="Google sign-in domains" sub="People whose email is on one of these domains may sign in with Google (they must also be in the directory). Add a new vertical's domain here. With none listed, the server's default list applies.">
          <TagList items={s.googleDomains ?? []} noun="domain" placeholder="example.com" normalize={(d) => d.toLowerCase().replace(/^@/, '')} error={f.googleDomains ?? Object.entries(f).find(([k]) => k.startsWith('googleDomains.'))?.[1]} onChange={(googleDomains) => setS({ ...s, googleDomains })} />
        </Card>
      )}
      <Card title="Data retention">
        <p>
          Audit records are kept for <strong>{s.retentionYears} years</strong> (policy requirement; not editable).
        </p>
        {BACKEND === 'mock' && <Banner tone="warn">Prototype: records live in this browser's storage. Immutable, 7-year retention requires a backend with write-once storage — this prototype does not implement it.</Banner>}
      </Card>
    </div>
  );
}

/** D-125: the standard task times behind the task form's recommended estimate (default: the owner's SLA guide). */
function StandardTasksCard({ rows, errors, onChange }: { rows: StandardTask[]; errors: Record<string, string | undefined>; onChange: (rows: StandardTask[]) => void }) {
  const edit = (i: number, patch: Partial<StandardTask>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const err = (i: number) => Object.entries(errors).find(([k]) => k.startsWith(`standardTasks.${i}.`))?.[1];
  return (
    <Card title="Standard task times" sub={`${rows.length} tasks. The task form recommends an estimate: the average of the range × the quantity. An assignee over the estimate must give a reason.`}>
      <details>
        <summary className="link-btn">Show and edit the list</summary>
        <div className="table-scroll mt">
          <table className="table">
            <caption className="sr-only">Standard task times</caption>
            <thead>
              <tr>
                <th>Section</th>
                <th>Task</th>
                <th className="right">Min (min)</th>
                <th className="right">Max (min)</th>
                <th className="right">Per</th>
                <th>Unit</th>
                <th>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td data-label="Section"><Input aria-label={`Section, row ${i + 1}`} value={r.section} maxLength={80} style={{ minWidth: '12em' }} onChange={(e) => edit(i, { section: e.target.value })} /></td>
                  <td data-label="Task">
                    <Input aria-label={`Task, row ${i + 1}`} value={r.name} maxLength={120} style={{ minWidth: '18em' }} onChange={(e) => edit(i, { name: e.target.value })} invalid={!!err(i)} />
                    {err(i) && <span className="field-error small">{err(i)}</span>}
                  </td>
                  <td data-label="Min (min)"><Input aria-label={`Shortest minutes, row ${i + 1}`} type="number" min={1} value={r.minMinutes} style={{ width: '6em' }} onChange={(e) => edit(i, { minMinutes: num(e.target.value) })} /></td>
                  <td data-label="Max (min)"><Input aria-label={`Longest minutes, row ${i + 1}`} type="number" min={1} value={r.maxMinutes} style={{ width: '6em' }} onChange={(e) => edit(i, { maxMinutes: num(e.target.value) })} /></td>
                  <td data-label="Per"><Input aria-label={`Units per batch, row ${i + 1}`} type="number" min={1} value={r.per} style={{ width: '6em' }} onChange={(e) => edit(i, { per: num(e.target.value) })} /></td>
                  <td data-label="Unit"><Input aria-label={`Unit, row ${i + 1}`} value={r.unit} maxLength={40} style={{ width: '8em' }} onChange={(e) => edit(i, { unit: e.target.value })} /></td>
                  <td>
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${r.name || `row ${i + 1}`}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row-gap mt">
          <Button size="sm" icon="plus" onClick={() => onChange([...rows, { section: rows.at(-1)?.section ?? 'General', name: '', minMinutes: 30, maxMinutes: 60, per: 1, unit: 'tasks' }])}>
            Add a task
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(DEFAULT_SETTINGS.standardTasks)}>
            Restore the guide's list
          </Button>
        </div>
      </details>
    </Card>
  );
}
