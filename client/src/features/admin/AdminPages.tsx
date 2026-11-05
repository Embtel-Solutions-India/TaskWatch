import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { HOUR, LEVEL_LABEL, ORG_WIDE_PERMISSIONS, PERMISSION_HELP, PERMISSION_LABEL, PRIORITY_LABEL, ROLE_LABEL } from '../../constants';
import { Icon } from '../../components/icons';
import { Banner, Button, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, PageHeader, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { BACKEND } from '../../services/http';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import { getPolicies, getRoles, getSettings, resetPolicy, setRolePermissions, setRules, setSettings } from '../../services/api/admin';
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
  /** 'default' or an entity id (POL-03). An entity override holds windows and multiples only (D-48). */
  const [scope, setScope] = useState('default');
  const [creating, setCreating] = useState(false);
  const [r, setR] = useState<RulesConfig | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'reset' | null>(null);
  const isDefault = scope === 'default';
  const base = q.data ? (isDefault ? q.data.defaults : (q.data.overrides[scope] ?? null)) : null;
  const save = useAction(setRules, {
    success: isDefault ? 'Escalation policy saved; all open tasks re-evaluated.' : "Override saved; that entity's open tasks re-evaluated.",
    onSuccess: () => (setConfirm(null), setCreating(false)),
  });
  const reset = useAction(resetPolicy, { success: 'Override removed; the entity follows the default policy again.', onSuccess: () => setConfirm(null) });
  useEffect(() => {
    if (q.data) setR(structuredClone(scope === 'default' ? q.data.defaults : (q.data.overrides[scope] ?? q.data.defaults)));
  }, [q.data, scope]);
  if (q.error) return <ErrorState error={q.error} />;
  if (!r || !q.data) return <Skeleton rows={10} />;
  const f = save.fields;
  const editable = isDefault || !!base || creating;
  const dirty = creating || JSON.stringify(r) !== JSON.stringify(base ?? q.data.defaults);
  const num = (v: string) => Number(v);
  const discard = () => (setR(structuredClone(base ?? q.data!.defaults)), setCreating(false));
  return (
    <div className="page">
      <PageHeader
        title="Escalation Policies"
        description="Update windows and thresholds that drive the escalation ladder. Changes apply to every open task immediately and are audited."
        actions={
          <>
            {!isDefault && base && (
              <Button variant="ghost" onClick={() => setConfirm('reset')}>
                Reset to default
              </Button>
            )}
            <Button variant="ghost" disabled={!dirty} onClick={discard}>
              Discard
            </Button>
            <Button variant="primary" disabled={!dirty || !editable} onClick={() => setConfirm('save')}>
              {isDefault ? 'Save policy' : 'Save override'}
            </Button>
          </>
        }
      />
      {q.data.entities.length > 0 && (
        <Field label="Policy for" htmlFor="pol-scope" hint="Each entity follows the default policy unless it has its own update windows and multiples.">
          <select id="pol-scope" className="input select" value={scope} onChange={(e) => (setScope(e.target.value), setCreating(false))}>
            <option value="default">Default (every entity)</option>
            {q.data.entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {q.data!.overrides[e.id] ? ' (override)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!isDefault && !editable && (
        <Banner tone="info" action={<Button size="sm" onClick={() => setCreating(true)}>Create override</Button>}>
          This entity follows the default policy.
        </Banner>
      )}
      {!isDefault && editable && <Banner tone="info">Only update windows and level multiples can differ per entity. Past-due floors, acknowledgement, quiet hours and routing come from the default policy.</Banner>}
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
              <tr>
                <th scope="row">Any, past due</th>
                <td className="muted">—</td>
                <td className="muted">—</td>
                {r.overdueOffsetsHours.map((o, i) => (
                  <td key={i}>
                    <span className={cx('lvl', `lvl-${i + 1}`)}>{o === 0 ? 'at due time' : `due +${o} h`}</span>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
      <div className="grid-2">
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
        {isDefault && (
        <>
        <Card title="Past-due floors" sub="Minimum level once a task passes its due time">
          <div className="grid-3">
            {r.overdueOffsetsHours.map((o, i) => (
              <Field key={i} label={`L${i + 1} at due +`} htmlFor={`off-${i}`} hint="hours">
                <Input id={`off-${i}`} type="number" min={0} value={o} onChange={(e) => setR({ ...r, overdueOffsetsHours: r.overdueOffsetsHours.map((x, j) => (j === i ? num(e.target.value) : x)) as RulesConfig['overdueOffsetsHours'] })} />
              </Field>
            ))}
          </div>
          {f.offsets && <span className="field-msg">{f.offsets}</span>}
        </Card>
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
        <Card title="Quiet hours (email & WhatsApp)" sub="Hold L0/L1 email and WhatsApp overnight in the recipient's zone; in-app alerts are never held.">
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
            <tr><td>New task assigned</td><td>Assignee</td><td>—</td><td>WhatsApp, email, in-app</td></tr>
            <tr><td><span className="lvl lvl-0">L0</span> Reminder</td><td>Assignee</td><td>—</td><td>WhatsApp, email, in-app</td></tr>
            <tr><td><span className="lvl lvl-1">L1</span> Team lead</td><td>Assignee's team lead</td><td>Assignee</td><td>WhatsApp, email, in-app</td></tr>
            <tr><td><span className="lvl lvl-2">L2</span> Manager</td><td>Manager</td><td>Lead and assignee</td><td>WhatsApp, email, in-app</td></tr>
            <tr><td><span className="lvl lvl-3">L3</span> Founder's Office</td><td>Chief of Staff{r.l3NotifyCeo ? ' and CEO' : ''}</td><td>Manager</td><td>WhatsApp, email, in-app, top of dashboard</td></tr>
            <tr><td>Weekly digest</td><td>Managers, Founder's Office</td><td>—</td><td>Email</td></tr>
          </tbody>
        </table>
        <Checkbox label="L3 also goes to the CEO (decision D7)" hint="When off, L3 goes to the Chief of Staff only." checked={r.l3NotifyCeo} onChange={(e) => setR({ ...r, l3NotifyCeo: e.target.checked })} />
      </Card>
      )}
      <PolicySimulator rules={r} />
      <ConfirmDialog open={confirm === 'save'} onClose={() => setConfirm(null)} onConfirm={() => save.run(r, scope)} title={isDefault ? 'Apply new escalation policy?' : 'Apply this override?'} confirmLabel="Apply policy" loading={save.pending}>
        <p>{isDefault ? 'Every open task' : "Every open task in this entity"} is re-evaluated immediately. Tasks may escalate (or stop escalating) as a result. Existing escalation history is never altered.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'reset'} onClose={() => setConfirm(null)} onConfirm={() => reset.run(scope)} title="Remove this override?" confirmLabel="Follow the default" loading={reset.pending}>
        <p>The entity's open tasks follow the default policy again and are re-evaluated immediately.</p>
      </ConfirmDialog>
    </div>
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
        {res.level >= 0 && <span className="muted"> from {res.reason === 'overdue' ? 'the past-due rule' : 'the silence rule'} (silence L{res.silenceLevel < 0 ? '–' : res.silenceLevel}, past-due L{res.overdueLevel < 0 ? '–' : res.overdueLevel}; highest wins)</span>}
      </p>
    </Card>
  );
}

export function SettingsPage() {
  const q = useApi(['settings'], getSettings);
  const [s, setS] = useState<Settings | null>(null);
  const [cat, setCat] = useState('');
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
      <Card title="Task categories">
        <div className="tag-cloud mb">
          {s.categories.map((c) => (
            <span key={c} className="tag removable">
              {c}
              <button type="button" aria-label={`Remove ${c}`} onClick={() => setS({ ...s, categories: s.categories.filter((x) => x !== c) })}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <form
          className="row-gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (cat.trim() && !s.categories.includes(cat.trim())) setS({ ...s, categories: [...s.categories, cat.trim()] });
            setCat('');
          }}
        >
          <Input aria-label="New category" placeholder="Add category" value={cat} onChange={(e) => setCat(e.target.value)} className="input-sm" />
          <Button size="sm" type="submit">
            Add
          </Button>
        </form>
        {f.categories && <span className="field-msg">{f.categories}</span>}
      </Card>
      <Card title="Data retention">
        <p>
          Audit records are kept for <strong>{s.retentionYears} years</strong> (policy requirement; not editable).
        </p>
        {BACKEND === 'mock' && <Banner tone="warn">Prototype: records live in this browser's storage. Immutable, 7-year retention requires a backend with write-once storage — this prototype does not implement it.</Banner>}
      </Card>
    </div>
  );
}
