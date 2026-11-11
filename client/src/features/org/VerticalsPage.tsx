// ADR-0011 / D-131: the CoS manages verticals (entities) and their departments (teams), and sets general managers and
// department leads. Reporting lines follow automatically on the server (D-130). Server mode only; nothing is deleted.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tag } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { getOrg, type OrgData, type StaffRow } from '../../services/api/admin';
import { adminServer } from '../../services/api/adminServer';
import { BACKEND } from '../../services/http';
import type { Department, Team } from '../../types';

type Edit =
  | { kind: 'vertical'; vertical?: Department }
  | { kind: 'department'; verticalId: string; team?: Team }
  | { kind: 'archive-vertical'; vertical: Department }
  | { kind: 'archive-department'; team: Team };

export function VerticalsPage() {
  const q = useApi(['org'], getOrg);
  const [edit, setEdit] = useState<Edit | null>(null);
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
        actions={<Button variant="primary" icon="plus" onClick={() => setEdit({ kind: 'vertical' })}>Add vertical</Button>}
      />
      {org.departments.length === 0 && <Card><Empty icon="building" title="No verticals yet" /></Card>}
      <div className="team-grid">
        {org.departments.map((v) => {
          const teams = org.teams.filter((t) => t.departmentId === v.id);
          const people = org.users.filter((u) => u.entityId === v.id && u.status === 'active');
          return (
            <Card
              key={v.id}
              title={<>{v.name} <Tag>{v.id}</Tag></>}
              sub={`${people.length} active ${people.length === 1 ? 'person' : 'people'} · ${teams.length} ${teams.length === 1 ? 'department' : 'departments'}`}
              actions={
                <div className="vt-actions">
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => setEdit({ kind: 'vertical', vertical: v })} aria-label={`Edit ${v.name}`} />
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setEdit({ kind: 'archive-vertical', vertical: v })} aria-label={`Archive ${v.name}`} />
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
    </div>
  );
}

const withRole = (org: OrgData, role: StaffRow['role']) => org.users.filter((u) => u.status === 'active' && u.roles.includes(role)).sort((a, b) => a.name.localeCompare(b.name));

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
        <Field label="Team lead" htmlFor="d-lead" hint="Someone with the Team Lead role; they join this department. Without a lead, members report to the general manager." error={save.fields.leadId}>
          <Select id="d-lead" value={leadId} onChange={(e) => setLeadId(e.target.value)} invalid={!!save.fields.leadId}>
            <option value="">No lead</option>
            {withRole(org, 'lead').map((u) => <option key={u.id} value={u.id}>{u.name}{u.entityId !== verticalId ? ` (moves from ${org.departments.find((d) => d.id === u.entityId)?.name ?? u.entityId})` : ''}</option>)}
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
