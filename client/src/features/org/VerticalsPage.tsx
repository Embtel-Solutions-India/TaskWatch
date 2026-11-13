// ADR-0011 / D-131: the CoS manages verticals (entities) and their departments (teams), and sets general managers and
// department leads. Reporting lines follow automatically on the server (D-130). Server mode only; nothing is deleted.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, Card, Checkbox, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi, useAuth } from '../../hooks';
import { getOrg, type OrgData, type StaffRow } from '../../services/api/admin';
import { adminServer } from '../../services/api/adminServer';
import { BACKEND } from '../../services/http';
import type { Department, Team, Worktime } from '../../types';
import { applyPolicy } from '../../services/api/admin';

type Edit =
  | { kind: 'vertical'; vertical?: Department }
  | { kind: 'department'; verticalId: string; team?: Team }
  | { kind: 'archive-vertical'; vertical: Department }
  | { kind: 'archive-department'; team: Team }
  | { kind: 'worktime'; vertical: Department };

export function VerticalsPage() {
  const q = useApi(['org'], getOrg);
  const [edit, setEdit] = useState<Edit | null>(null);
  const auth = useAuth();
  const isCos = !auth.bootstrap || !!auth.permissions?.includes('manage_staff');
  const mine = (id: string) => isCos || !!auth.bootstrap?.headOf?.includes(id);
  if (BACKEND !== 'server') return <div className="page"><PageHeader title="Verticals & departments" /><Card><Empty icon="building" title="Managing verticals needs the server backend." /></Card></div>;
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={8} />;
  const org = q.data;
  const nameOf = (id: string | null) => org.users.find((u) => u.id === id)?.name;
  const close = () => setEdit(null);
  return (
    <div className="page">
      <PageHeader
        title="Verticals & departments"
        description="Each vertical has a general manager and its own departments (Sales, Marketing, …). People report to their department lead, else the vertical's general manager, else the Chief of Staff, automatically."
        actions={isCos ? <Button variant="primary" icon="plus" onClick={() => setEdit({ kind: 'vertical' })}>Add vertical</Button> : undefined}
      />
      {org.departments.length === 0 && <Card><Empty icon="building" title="No verticals yet" /></Card>}
      <div className="team-grid">
        {org.departments.filter((v) => mine(v.id)).map((v) => {
          const teams = org.teams.filter((t) => t.departmentId === v.id);
          const people = org.users.filter((u) => u.entityId === v.id && u.status === 'active');
          return (
            <Card
              key={v.id}
              title={<>{v.name} <Tag>{v.id}</Tag></>}
              sub={`${people.length} active ${people.length === 1 ? 'person' : 'people'} · ${teams.length} ${teams.length === 1 ? 'department' : 'departments'}`}
              actions={
                <div className="vt-actions">
                  <Button size="sm" variant="ghost" icon="clock" onClick={() => setEdit({ kind: 'worktime', vertical: v })} aria-label={`Working time for ${v.name}`} title="Working time" />
                  {isCos && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ kind: 'vertical', vertical: v })} aria-label={`Edit ${v.name}`} />}
                  {isCos && <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ kind: 'archive-vertical', vertical: v })} aria-label={`Archive ${v.name}`} />}
                </div>
              }
            >
              <div className="vt-gm">
                <span className="muted small">General manager</span>
                {nameOf(v.headId) ? <Link to={`/admin/staff/${v.headId}`}>{nameOf(v.headId)}</Link> : <Tag tone="warn">Not set</Tag>}
              </div>
              {!v.headId && <p className="muted small vt-note">Until one is set, people without a department lead report to the Chief of Staff.</p>}
              <div className="vt-head">
                <strong className="small">Departments</strong>
                <Button size="sm" variant="ghost" icon="plus" onClick={() => setEdit({ kind: 'department', verticalId: v.id })}>Add</Button>
              </div>
              {teams.length ? (
                <ul className="vt-depts">
                  {teams.map((t) => (
                    <li key={t.id}>
                      <div className="vt-dept-text">
                        <strong>{t.name}</strong>
                        <span className="muted small">
                          {nameOf(t.leadId) ? `Lead ${nameOf(t.leadId)}` : 'No lead (members report to the GM)'} · {org.users.filter((u) => u.teamId === t.id && u.status === 'active').length} people
                        </span>
                      </div>
                      <div className="vt-actions">
                        <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ kind: 'department', verticalId: v.id, team: t })} aria-label={`Edit ${t.name}`} />
                        <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ kind: 'archive-department', team: t })} aria-label={`Archive ${t.name}`} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No departments yet.</p>
              )}
            </Card>
          );
        })}
      </div>
      {edit?.kind === 'vertical' && <VerticalDialog org={org} vertical={edit.vertical} onClose={close} />}
      {edit?.kind === 'department' && <DepartmentDialog org={org} verticalId={edit.verticalId} team={edit.team} onClose={close} />}
      {edit?.kind === 'archive-vertical' && <ArchiveDialog label={`vertical ${edit.vertical.name}`} run={() => adminServer.archiveVertical(edit.vertical.id)} onClose={close} />}
      {edit?.kind === 'archive-department' && <ArchiveDialog label={`department ${edit.team.name}`} run={() => adminServer.archiveDepartment(edit.team.id)} onClose={close} />}
      {edit?.kind === 'worktime' && <WorktimeDialog vertical={edit.vertical} onClose={close} />}
    </div>
  );
}

const withRole = (org: OrgData, role: StaffRow['role']) => org.users.filter((u) => u.status === 'active' && u.roles.includes(role)).sort((a, b) => a.name.localeCompare(b.name));

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];

/** ADR-0015 (D-159, D-165): a vertical's time zone, working days and hours, and quiet hours. Empty = organization default. */
function WorktimeDialog({ vertical, onClose }: { vertical: Department; onClose: () => void }) {
  const w0 = vertical.worktime ?? { timeZone: null, quietHours: null, workDays: null, workStart: null, workEnd: null };
  const [w, setW] = useState<Worktime>(w0);
  const [saved, setSaved] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const save = useAction(() => adminServer.setWorktime(vertical.id, w), { success: 'Working time saved; members follow it now.', onSuccess: () => (setSaved(true), setConfirmApply(true)) });
  const apply = useAction(() => applyPolicy(vertical.id), { success: (x) => `${x.updated} open task${x.updated === 1 ? '' : 's'} rescheduled.`, onSuccess: onClose });
  const days = w.workDays ?? [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
    setW({ ...w, workDays: next.length ? next : null });
  };
  const f = save.fields;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Working time · ${vertical.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" loading={save.pending} onClick={() => save.run()}>Save</Button></>}
    >
      <div className="stack">
        <Field label="Time zone" htmlFor="wt-zone" hint="Every member of this vertical uses it for dates, quiet hours and working time." error={f.timeZone}>
          <Select id="wt-zone" value={w.timeZone ?? ''} onChange={(e) => setW({ ...w, timeZone: e.target.value || null })}>
            <option value="">Each person's own (not set)</option>
            {ZONES.map((z) => <option key={z}>{z}</option>)}
          </Select>
        </Field>
        <fieldset className="assign-also">
          <legend>Working days {w.workDays ? null : <span className="muted small">(organization default: Mon–Fri)</span>}</legend>
          <div className="assign-also-list">
            {DAYS.map((d, i) => <Checkbox key={d} label={d} checked={days.includes(i)} onChange={() => toggleDay(i)} />)}
          </div>
          {f.workDays && <span className="field-msg">{f.workDays}</span>}
        </fieldset>
        <div className="grid-2">
          <Field label="Work starts" htmlFor="wt-start" hint="Empty = organization default." error={f.workStart}>
            <Input id="wt-start" type="time" value={w.workStart ?? ''} onChange={(e) => setW({ ...w, workStart: e.target.value || null })} />
          </Field>
          <Field label="Work ends" htmlFor="wt-end" error={f.workEnd}>
            <Input id="wt-end" type="time" value={w.workEnd === '24:00' ? '' : (w.workEnd ?? '')} onChange={(e) => setW({ ...w, workEnd: e.target.value || null })} />
          </Field>
        </div>
        <Field label="Quiet hours" htmlFor="wt-quiet" hint="Reminders and L1 for non-Critical tasks are held at night; L2/L3 always go out.">
          <Select id="wt-quiet" value={w.quietHours === null ? '' : w.quietHours.enabled ? 'on' : 'off'} onChange={(e) => setW({ ...w, quietHours: e.target.value === '' ? null : { enabled: e.target.value === 'on', start: w.quietHours?.start ?? '21:00', end: w.quietHours?.end ?? '08:00' } })}>
            <option value="">Organization default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
        </Field>
        {w.quietHours?.enabled && (
          <div className="grid-2">
            <Field label="Quiet from" htmlFor="wt-qs"><Input id="wt-qs" type="time" value={w.quietHours.start} onChange={(e) => setW({ ...w, quietHours: { ...w.quietHours!, start: e.target.value } })} /></Field>
            <Field label="Quiet until" htmlFor="wt-qe"><Input id="wt-qe" type="time" value={w.quietHours.end} onChange={(e) => setW({ ...w, quietHours: { ...w.quietHours!, end: e.target.value } })} /></Field>
          </div>
        )}
        <Banner tone="info" action={saved ? <Button size="sm" onClick={() => setConfirmApply(true)}>Apply to open tasks</Button> : undefined}>
          Non-Critical tasks count escalation time in these working hours. Open tasks keep their escalation times until you apply the change to them.
        </Banner>
      </div>
      <ConfirmDialog open={confirmApply} onClose={() => setConfirmApply(false)} onConfirm={() => apply.run()} title="Working time saved. Apply it to open tasks?" confirmLabel="Apply to open tasks" cancelLabel="Not now" loading={apply.pending}>
        <p>Every open task in {vertical.name} gets new escalation times from these working hours, and may escalate at once. This is recorded in the audit log.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function VerticalDialog({ org, vertical, onClose }: { org: OrgData; vertical?: Department; onClose: () => void }) {
  const [code, setCode] = useState(vertical?.id ?? '');
  const [name, setName] = useState(vertical?.name ?? '');
  const [headId, setHeadId] = useState(vertical?.headId ?? '');
  const save = useAction(
    () => (vertical ? adminServer.updateVertical(vertical.id, { name, headId: headId || null }) : adminServer.createVertical({ id: code, name, headId: headId || null })),
    { success: vertical ? 'Vertical saved; reporting lines updated.' : 'Vertical added.', onSuccess: onClose },
  );
  return (
    <Dialog open onClose={onClose} title={vertical ? `Edit ${vertical.name}` : 'Add vertical'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.pending} onClick={() => save.run()}>Save</Button></>}>
      <div className="stack">
        {!vertical && (
          <Field label="Code" htmlFor="v-code" required hint="2–10 capital letters or digits, e.g. BAIS. It cannot change later." error={save.fields.id}>
            <Input id="v-code" value={code} maxLength={10} onChange={(e) => setCode(e.target.value.toUpperCase())} invalid={!!save.fields.id} />
          </Field>
        )}
        <Field label="Name" htmlFor="v-name" required error={save.fields.name}>
          <Input id="v-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} invalid={!!save.fields.name} />
        </Field>
        <Field label="General manager" htmlFor="v-head" hint="Someone with the Manager role. They move into this vertical and see everything in it." error={save.fields.headId}>
          <Select id="v-head" value={headId} onChange={(e) => setHeadId(e.target.value)} invalid={!!save.fields.headId}>
            <option value="">Not set</option>
            {withRole(org, 'manager').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field>
        <Banner tone="info">Changing the general manager re-points this vertical's reporting lines at once. Each change is audited.</Banner>
      </div>
    </Dialog>
  );
}

function DepartmentDialog({ org, verticalId, team, onClose }: { org: OrgData; verticalId: string; team?: Team; onClose: () => void }) {
  const [name, setName] = useState(team?.name ?? '');
  const [leadId, setLeadId] = useState(team?.leadId ?? '');
  const vertical = org.departments.find((d) => d.id === verticalId);
  const auth = useAuth();
  // Review C-1: a GM picks leads from their own vertical only (the server refuses anyone else).
  const isCos = !auth.bootstrap || !!auth.permissions?.includes('manage_staff');
  const save = useAction(
    () => (team ? adminServer.updateDepartment(team.id, { name, leadId: leadId || null }) : adminServer.createDepartment({ entityId: verticalId, name, leadId: leadId || null })),
    { success: team ? 'Department saved; reporting lines updated.' : 'Department added.', onSuccess: onClose },
  );
  return (
    <Dialog open onClose={onClose} title={team ? `Edit ${team.name}` : `Add a department to ${vertical?.name ?? verticalId}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.pending} onClick={() => save.run()}>Save</Button></>}>
      <div className="stack">
        <Field label="Name" htmlFor="d-name" required hint="e.g. Sales, Marketing." error={save.fields.name}>
          <Input id="d-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} invalid={!!save.fields.name} />
        </Field>
        <Field label="Team lead" htmlFor="d-lead" hint="Someone with the Team Lead role. A lead may run several departments in one vertical (D-137); anyone else joins this department. Without a lead, members report to the general manager." error={save.fields.leadId}>
          <Select id="d-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)} invalid={!!save.fields.leadId}>
            <option value="">No lead</option>
            {withRole(org, 'lead').filter((u) => isCos || u.entityId === verticalId).map((u) => {
              const led = org.teams.filter((t) => t.leadId === u.id && t.id !== team?.id);
              const here = led.filter((t) => t.departmentId === verticalId);
              const away = led.filter((t) => t.departmentId !== verticalId);
              const from = org.departments.find((d) => d.id === u.entityId)?.name ?? u.entityId;
              const note = away.length
                ? ` (leads ${away.map((t) => t.name).join(', ')} in ${from}; one vertical only)`
                : here.length
                  ? ` (also leads ${here.map((t) => t.name).join(', ')})`
                  : u.entityId !== verticalId
                    ? ` (moves from ${from})`
                    : '';
              return <option key={u.id} value={u.id} disabled={away.length > 0 && u.id !== leadId}>{u.name}{note}</option>;
            })}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function ArchiveDialog({ label, run, onClose }: { label: string; run: () => Promise<void>; onClose: () => void }) {
  const go = useAction(run, { success: 'Archived.', onSuccess: onClose });
  return (
    <ConfirmDialog open onClose={onClose} onConfirm={() => go.run()} loading={go.pending} title={`Archive the ${label}?`} confirmLabel="Archive" danger>
      <p>It is hidden from pickers and lists, but its history stays. Only possible when nobody active is in it; move or deactivate them first.</p>
    </ConfirmDialog>
  );
}
