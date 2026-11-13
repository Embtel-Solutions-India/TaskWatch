import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LEVEL_LABEL, ROLE_LABEL, ROLE_RANK, PERMISSION_LABEL } from '../../constants';
import { DataTable } from '../../components/DataTable';
import { Avatar, Banner, Button, Card, Checkbox, ConfirmDialog, Dialog, ErrorState, Field, Input, KV, LevelBadge, Menu, PageHeader, RoleBadge, Select, Skeleton, Stat, StatusBadge, TabPanel, Tabs, Tag, useToast } from '../../components/ui';
import { useAction, useApi, useAuth, useCan, useMe } from '../../hooks';
import { createStaff, getOrg, getRoles, getStaffProfile, listStaff, resetAccess, sendOnboarding, setStaffStatus, updateStaff, type OrgData, type StaffInput, type StaffRow } from '../../services/api/admin';
import { primaryRole } from '../../services/api/adminServer';
import { BACKEND } from '../../services/http';
import { WHATSAPP_ENABLED } from '@taskwatch/shared/notifications';
import { labelDepartments, needsManager } from '@taskwatch/shared/permissions';
import { wouldCreateLoop } from '../../services/authz/permissions';
import type { Role, User } from '../../types';
import { PERMISSIONS, ROLES } from '../../types';
import { downloadCsv, formatDate, formatShort, pct, relative } from '../../utils/format';
import { DueCell, TaskTitle } from '../tasks/shared';

export function StaffDirectoryPage() {
  const nav = useNavigate();
  const q = useApi(['staff'], listStaff);
  const gmOf = useGmVerticals();
  const me = useMe();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [team, setTeam] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState<StaffRow | 'new' | null>(null);
  const [toggling, setToggling] = useState<StaffRow | null>(null);
  const toast = useToast();
  const st = useAction(setStaffStatus, {
    success: (r) => (toggling?.status === 'active' ? `${toggling?.name} deactivated${r.openTasks ? `. ${r.openTasks} open task(s) still assigned — reassign them from Team Tasks.` : ''}` : `${toggling?.name} reactivated`),
    onSuccess: () => setToggling(null),
  });
  const reset = useAction(resetAccess, {
    onSuccess: () => toast({ tone: 'info', text: BACKEND === 'server' ? 'A password reset link was emailed. Their sessions were ended.' : 'Simulated: a password reset link was issued. No email was sent.' }),
  });
  // D-172: offered right after Add staff, and from each active person's Actions menu.
  const [welcome, setWelcome] = useState<{ id: string; name: string } | null>(null);
  const onboard = useAction(sendOnboarding, {
    success: BACKEND === 'server' ? 'Onboarding email sent.' : 'Simulated: no email was sent.',
    onSuccess: () => setWelcome(null),
  });
  const org = useApi(['org'], getOrg);
  // ADR-0011: "Sales · BAIS" when departments of several verticals are listed.
  const depts = labelDepartments(org.data?.teams ?? [], (t) => t.departmentId);
  const deptName = (id: string | null) => depts.find((t) => t.id === id)?.name ?? null;
  const rows = useMemo(
    () =>
      (q.data ?? []).filter((u) => {
        const s = query.toLowerCase();
        return (!gmOf || gmOf.includes(u.entityId)) && (!s || u.name.toLowerCase().includes(s) || u.email.includes(s) || u.title.toLowerCase().includes(s)) && (!role || u.roles.includes(role as Role)) && (!team || (team === 'none' ? !u.teamId : u.teamId === team)) && (!status || u.status === status || (status === 'nomanager' && needsManager(u)));
      }),
    [q.data, query, role, team, status, gmOf],
  );
  if (q.error) return <ErrorState error={q.error} />;
  const all = q.data ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Staff Management"
        description="Create and manage staff accounts, roles and reporting relationships."
        actions={
          <>
            <Button icon="download" onClick={() => downloadCsv('taskwatch-staff.csv', [['Name', 'Email', 'Title', 'Role', 'Manager', 'Department', 'Status', 'Joined', 'Open tasks', 'Overdue tasks'], ...rows.map((u) => [u.name, u.email, u.title, ROLE_LABEL[u.role], u.managerName, u.teamName, u.status, u.joinedAt.slice(0, 10), u.openTasks, u.overdueTasks])])}>
              Export CSV
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Add staff
            </Button>
          </>
        }
      />
      <div className="stats">
        <Stat label="Total staff" value={all.length} />
        <Stat label="Active" value={all.filter((u) => u.status === 'active').length} />
        <Stat label="Inactive" value={all.filter((u) => u.status === 'inactive').length} />
        <Stat label="Without a manager" value={all.filter(needsManager).length} tone={all.some(needsManager) ? 'warn' : undefined} help="Escalations for their reports skip straight to the next existing level." />
      </div>
      <DataTable<StaffRow>
        caption="Staff directory"
        storageKey="staff"
        rows={rows}
        loading={q.isLoading}
        rowKey={(u) => u.id}
        onRowClick={(u) => nav(`/admin/staff/${u.id}`)}
        initialSort={{ id: 'name', dir: 'asc' }}
        toolbar={
          <div className="filters">
            <div className="filter-search">
              <Input aria-label="Search staff" placeholder="Search name, email, title…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">Any role</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <Select aria-label="Department" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Any department</option>
              <option value="none">No department</option>
              {depts.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="nomanager">Without manager</option>
            </Select>
          </div>
        }
        columns={[
          { id: 'name', header: 'Name', fixed: true, cell: (u) => <span className="person"><Avatar name={u.name} size={26} inactive={u.status !== 'active'} /><span className="task-title"><Link to={`/admin/staff/${u.id}`} className="task-link">{u.name}</Link><span className="task-sub">{u.title}</span></span></span>, sort: (u) => u.name },
          {
            id: 'email',
            header: 'Email',
            cell: (u) =>
              u.signIn === 'google' || u.signIn === 'both' ? (
                <span title={u.signIn === 'google' ? 'Signs in with Google: no password needed' : 'Signs in with Google or their existing password'}>
                  {u.email} <Tag tone="info">{u.signIn === 'google' ? 'Google' : 'Google + password'}</Tag>
                </span>
              ) : (
                u.email
              ),
            sort: (u) => u.email,
          },
          { id: 'role', header: 'Role', cell: (u) => <RoleBadge role={u.role} />, sort: (u) => -ROLE_RANK[u.role] },
          { id: 'manager', header: 'Manager', cell: (u) => u.managerName ?? (u.role === 'cos' ? '—' : <Tag tone="warn">None</Tag>), sort: (u) => u.managerName ?? '' },
          { id: 'team', header: 'Department', cell: (u) => deptName(u.teamId) ?? u.teamName ?? '—', sort: (u) => deptName(u.teamId) ?? u.teamName ?? '' },
          { id: 'status', header: 'Status', cell: (u) => <Tag tone={u.status === 'active' ? 'ok' : 'muted'}>{u.status === 'active' ? 'Active' : 'Inactive'}</Tag>, sort: (u) => u.status },
          { id: 'joined', header: 'Joined', defaultHidden: true, cell: (u) => formatDate(u.joinedAt), sort: (u) => u.joinedAt },
          { id: 'open', header: 'Assigned', align: 'right', cell: (u) => u.openTasks, sort: (u) => u.openTasks },
          { id: 'overdue', header: 'Overdue', align: 'right', cell: (u) => (u.overdueTasks ? <span className="tone-danger">{u.overdueTasks}</span> : 0), sort: (u) => u.overdueTasks },
          {
            id: 'actions',
            header: 'Actions',
            fixed: true,
            cell: (u) => (
              <Menu
                label={`Actions for ${u.name}`}
                items={[
                  { label: 'View profile', icon: 'user', onClick: () => nav(`/admin/staff/${u.id}`) },
                  { label: 'Edit', icon: 'edit', onClick: () => setEditing(u) },
                  // Google-only (no password set) has nothing to reset; someone with a password keeps the option (2026-11-12).
                  u.signIn === 'google' || (gmOf && u.id === me.id) ? null : { label: BACKEND === 'server' ? 'Send password reset' : 'Send password reset (simulated)', icon: 'key', onClick: () => reset.run(u.id) },
                  u.status !== 'active' || (gmOf && u.id === me.id) ? null : { label: 'Send onboarding email', icon: 'send', onClick: () => setWelcome(u) },
                  gmOf && u.id === me.id ? null : { label: u.status === 'active' ? 'Deactivate' : 'Reactivate', icon: u.status === 'active' ? 'lock' : 'check', danger: u.status === 'active', onClick: () => setToggling(u) },
                ]}
              />
            ),
          },
        ]}
      />
      {editing && <StaffDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onCreated={setWelcome} />}
      <ConfirmDialog open={!!welcome} onClose={() => setWelcome(null)} onConfirm={() => onboard.run(welcome!.id)} title={`Send ${welcome?.name} their onboarding email?`} confirmLabel="Send onboarding email" loading={onboard.pending}>
        They get a welcome email with a link to set their password (valid 7 days). People who sign in with Google get the welcome only. You can send it later from Actions.
      </ConfirmDialog>
      <ConfirmDialog
        open={!!toggling}
        onClose={() => setToggling(null)}
        onConfirm={() => st.run(toggling!.id, toggling!.status === 'active' ? 'inactive' : 'active')}
        title={toggling?.status === 'active' ? `Deactivate ${toggling?.name}?` : `Reactivate ${toggling?.name}?`}
        danger={toggling?.status === 'active'}
        confirmLabel={toggling?.status === 'active' ? 'Deactivate' : 'Reactivate'}
        loading={st.pending}
      >
        {toggling?.status === 'active' ? (
          <>
            <p>They will be signed out and can no longer sign in or receive notifications. Their history is kept.</p>
            {toggling.openTasks > 0 && <Banner tone="warn">{toggling.openTasks} open task(s) are assigned to them. Reassign these so work isn't stranded.</Banner>}
          </>
        ) : (
          <p>They will be able to sign in again with their existing role and reporting line.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Every role a person holds; prototype rows carry one. */
const rolesOf = (u: User): Role[] => (u as Partial<StaffRow>).roles ?? [u.role];
const sameRoles = (a: readonly Role[], b: readonly Role[]) => [...a].sort().join() === [...b].sort().join();

export function StaffDialog({ row, onClose, onCreated }: { row: User | null; onClose: () => void; onCreated?: (u: User) => void }) {
  const org = useApi(['org'], getOrg);
  if (org.error) return <Dialog open onClose={onClose} title={row ? `Edit ${row.name}` : 'Add staff'}><ErrorState error={org.error} /></Dialog>;
  if (!org.data) return <Dialog open onClose={onClose} title={row ? `Edit ${row.name}` : 'Add staff'}><Skeleton rows={6} /></Dialog>;
  return <StaffForm row={row} org={org.data} onClose={onClose} onCreated={onCreated} />;
}

function StaffForm({ row, org, onClose, onCreated }: { row: User | null; org: OrgData; onClose: () => void; onCreated?: (u: User) => void }) {
  const me = useMe();
  const gmOf = useGmVerticals();
  const canRoles = useCan('manage_roles') || !!gmOf;
  const roleChoices = gmOf ? ROLES.filter((r) => r === 'staff' || r === 'lead' || r === 'manager') : ROLES;
  const [f, setF] = useState<StaffInput>(
    row
      ? { name: row.name, email: row.email, title: row.title, roles: rolesOf(row), entityId: (row as Partial<StaffRow>).entityId ?? '', managerId: row.managerId, teamId: row.teamId, location: row.location, phone: row.phone, whatsapp: row.whatsapp ?? '', whatsappOptIn: row.whatsappOptIn, timezone: row.timezone, quietStart: row.quietStart ?? '', quietEnd: row.quietEnd ?? '' }
      : { name: '', email: '', title: '', roles: ['staff'], entityId: '', managerId: null, teamId: null, location: '', phone: '', whatsapp: '', whatsappOptIn: false, timezone: org.timezone },
  );
  const [confirmRole, setConfirmRole] = useState(false);
  const set = <K extends keyof StaffInput>(k: K, v: StaffInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const create = useAction(createStaff, { success: (u) => `${u.name} added`, onSuccess: (u) => (onClose(), onCreated?.(u)) });
  const update = useAction(updateStaff, { success: 'Staff details saved', onSuccess: onClose });
  const fields = { ...create.fields, ...update.fields };
  const primary = primaryRole(f.roles);
  const roleChanged = !!row && !sameRoles(rolesOf(row), f.roles);
  const toggleRole = (r: Role, on: boolean) => set('roles', on ? ROLES.filter((x) => x === r || f.roles.includes(x)) : f.roles.filter((x) => x !== r));
  const managers = org.users.filter((u) => u.status === 'active' && u.id !== row?.id && ROLE_RANK[u.role] > ROLE_RANK[primary] && (!row || !wouldCreateLoop(org, row.id, u.id)));
  const teams = labelDepartments(org.teams.filter((t) => !f.entityId || t.departmentId === f.entityId), (t) => t.departmentId);
  const submit = () => {
    if (roleChanged && !confirmRole) return setConfirmRole(true);
    setConfirmRole(false);
    row ? update.run(row.id, f) : create.run(f);
  };
  const rolesLocked = !canRoles || row?.id === me.id;
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={row ? `Edit ${row.name}` : 'Add staff'}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="f-staff" loading={create.pending || update.pending}>
              {row ? 'Save changes' : 'Add staff'}
            </Button>
          </>
        }
      >
        <form id="f-staff" className="stack" noValidate onSubmit={(e) => (e.preventDefault(), submit())}>
          <div className="grid-2">
            <Field label="Full name" required htmlFor="sf-name" error={fields.name}>
              <Input id="sf-name" value={f.name} onChange={(e) => set('name', e.target.value)} invalid={!!fields.name} autoFocus />
            </Field>
            <Field label="Work email" required htmlFor="sf-email" error={fields.email}>
              <Input id="sf-email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} invalid={!!fields.email} />
            </Field>
            <Field label="Job title" required htmlFor="sf-title" error={fields.title}>
              <Input id="sf-title" value={f.title} onChange={(e) => set('title', e.target.value)} invalid={!!fields.title} />
            </Field>
            <Field label="Roles" required htmlFor="sf-role-staff" error={fields.roles} hint={!canRoles ? 'Changing roles requires the Manage roles permission.' : row?.id === me.id ? "You can't change your own role." : 'Anyone may hold a second role; permissions are combined.'}>
              <div className="row-gap" role="group" aria-label="Roles">
                {roleChoices.map((r) => (
                  <Checkbox key={r} id={`sf-role-${r}`} label={ROLE_LABEL[r]} checked={f.roles.includes(r)} onChange={(e) => toggleRole(r, e.target.checked)} disabled={rolesLocked} />
                ))}
              </div>
            </Field>
            <Field label="Vertical" required htmlFor="sf-entity" error={fields.entityId}>
              <Select id="sf-entity" value={f.entityId} onChange={(e) => setF((x) => ({ ...x, entityId: e.target.value, teamId: null }))} invalid={!!fields.entityId}>
                <option value="">Choose a vertical</option>
                {org.departments.filter((d) => !gmOf || gmOf.includes(d.id)).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            {BACKEND === 'server' ? (
              <Field label="Reports to" htmlFor="sf-mgr" hint="Set automatically: the department lead, else the vertical's general manager, else the Chief of Staff.">
                <Input id="sf-mgr" value={row?.managerId ? (org.users.find((u) => u.id === row.managerId)?.name ?? '—') : 'Placed when saved'} readOnly />
              </Field>
            ) : (
            <Field label="Manager" htmlFor="sf-mgr" error={fields.managerId} hint="Only people senior to this role. Loops are prevented.">
              <Select id="sf-mgr" value={f.managerId ?? ''} onChange={(e) => set('managerId', e.target.value || null)} invalid={!!fields.managerId}>
                <option value="">No manager</option>
                {managers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {ROLE_LABEL[u.role]}
                  </option>
                ))}
              </Select>
            </Field>
            )}
            <Field label="Department" htmlFor="sf-team" error={fields.teamId}>
              <Select id="sf-team" value={f.teamId ?? ''} onChange={(e) => set('teamId', e.target.value || null)} invalid={!!fields.teamId}>
                <option value="">No department</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Location" htmlFor="sf-loc">
              <Input id="sf-loc" value={f.location} onChange={(e) => set('location', e.target.value)} />
            </Field>
            <Field label="Phone" htmlFor="sf-phone" error={fields.phone}>
              <Input id="sf-phone" value={f.phone} onChange={(e) => set('phone', e.target.value)} invalid={!!fields.phone} />
            </Field>
            {WHATSAPP_ENABLED && (
            <Field label="WhatsApp number" htmlFor="sf-wa" error={fields.whatsapp} hint="International format, e.g. +14155550123. Leave empty for email and in-app only.">
              <Input id="sf-wa" type="tel" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} invalid={!!fields.whatsapp} />
            </Field>
            )}
            {BACKEND === 'server' ? (
              <p className="muted small">Time zone, quiet hours and working days follow the vertical (set on Verticals, ADR-0015).</p>
            ) : (
              <Field label="Time zone" htmlFor="sf-tz" error={fields.timezone} hint="Quiet hours apply in this zone.">
                <Select id="sf-tz" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
                  {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata'].map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {WHATSAPP_ENABLED && <Checkbox label="Agreed to receive work alerts on WhatsApp" hint={fields.whatsappOptIn ?? 'Required before any WhatsApp alert is sent. Without it, WhatsApp alerts are logged as skipped.'} checked={f.whatsappOptIn} onChange={(e) => set('whatsappOptIn', e.target.checked)} />}
          {f.roles.includes('cos') && (!row || !rolesOf(row).includes('cos')) && <Banner tone="warn">Chief of Staff has full platform administration authority, including all staff, roles and audit logs.</Banner>}
          {!f.managerId && !f.roles.includes('cos') && <Banner tone="info">Without a manager, escalations for this person route to the next existing level up.</Banner>}
        </form>
      </Dialog>
      <ConfirmDialog open={confirmRole} onClose={() => setConfirmRole(false)} onConfirm={submit} title="Change roles?" confirmLabel="Change roles" danger={f.roles.includes('cos')}>
        <p>
          {row?.name} will move from <strong>{row ? rolesOf(row).map((r) => ROLE_LABEL[r]).join(' + ') : ''}</strong> to <strong>{f.roles.map((r) => ROLE_LABEL[r]).join(' + ')}</strong>. Their permissions change immediately:
        </p>
        {confirmRole && <RolePermissionList roles={f.roles} />}
      </ConfirmDialog>
    </>
  );
}

/** The union of the roles' permissions (D-8), read from the role matrix in force. */
function RolePermissionList({ roles }: { roles: Role[] }) {
  const q = useApi(['roles'], getRoles);
  if (roles.includes('cos')) return <ul className="tight"><li>All permissions</li></ul>;
  if (!q.data) return <Skeleton rows={3} />;
  const perms = PERMISSIONS.filter((p) => roles.some((r) => q.data!.matrix[r].includes(p)));
  return (
    <ul className="tight">
      {perms.map((p) => (
        <li key={p}>{PERMISSION_LABEL[p]}</li>
      ))}
    </ul>
  );
}

type ProfileTab = 'assigned' | 'created' | 'escalations' | 'activity';

export function StaffProfilePage() {
  const { id = '' } = useParams();
  const q = useApi(['staff-profile', id], () => getStaffProfile(id));
  const canManage = useCan('manage_staff');
  const [tab, setTab] = useState<ProfileTab>('assigned');
  const [editing, setEditing] = useState(false);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data || q.data.user.id !== id) return <Skeleton rows={10} />;
  const p = q.data;
  const u = p.user;
  return (
    <div className="page">
      <div className="profile-head">
        <Avatar name={u.name} size={56} inactive={u.status !== 'active'} />
        <div>
          <h1>
            {u.name} {u.status !== 'active' && <Tag tone="muted">Inactive</Tag>}
          </h1>
          <p className="muted">
            {u.title} · <RoleBadge role={u.role} /> · {p.team?.name ?? 'No department'}
          </p>
        </div>
        {canManage && (
          <Button icon="edit" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </div>
      <div className="stats">
        <Stat label="Open tasks" value={p.stats.open} />
        <Stat label="Overdue now" value={p.stats.overdue} tone={p.stats.overdue ? 'danger' : undefined} />
        <Stat label="Completed" value={p.stats.completed} />
        <Stat label="On-time completion" value={pct(p.stats.onTimeRate)} help="Completed tasks finished on or before their due date (latest approved due date)." />
      </div>
      <div className="task-grid">
        <div className="task-main">
          <Card pad={false}>
            <Tabs
              label="Profile sections"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'assigned', label: 'Assigned tasks', count: p.assigned.length },
                { id: 'created', label: 'Created tasks', count: p.created.length },
                { id: 'escalations', label: 'Escalation history', count: p.escalations.length },
                { id: 'activity', label: 'Recent activity' },
              ]}
            />
            <div className="card-body">
              {(tab === 'assigned' || tab === 'created') && (
                <TabPanel id={tab}>
                  <ul className="mini-tasks">
                    {(tab === 'assigned' ? p.assigned : p.created).slice(0, 25).map((t) => (
                      <li key={t.id}>
                        <span className="mono">{t.id}</span>
                        <TaskTitle t={t} sub={false} />
                        <StatusBadge status={t.status} />
                        <LevelBadge level={t.level} />
                        <DueCell t={t} />
                      </li>
                    ))}
                    {(tab === 'assigned' ? p.assigned : p.created).length === 0 && <li className="muted">None you can see.</li>}
                  </ul>
                </TabPanel>
              )}
              {tab === 'escalations' && (
                <TabPanel id="escalations">
                  <ul className="history">
                    {p.escalations.map((e) => (
                      <li key={e.id}>
                        <span className="muted">{formatShort(e.at)}</span>
                        <span>
                          <LevelBadge level={e.level} acked={e.status === 'acknowledged'} /> <Link to={`/tasks/${e.taskId}`}>{e.taskId}</Link> · {LEVEL_LABEL[e.level]} · {e.reason === 'overdue' ? 'past due' : 'no update'} · {e.status}
                        </span>
                      </li>
                    ))}
                    {p.escalations.length === 0 && <li className="muted">No escalations.</li>}
                  </ul>
                </TabPanel>
              )}
              {tab === 'activity' && (
                <TabPanel id="activity">
                  <ul className="history">
                    {p.activity.map((a) => (
                      <li key={a.id}>
                        <span className="muted">{relative(a.at)}</span>
                        <span>
                          <Link to={`/tasks/${a.taskId}`}>{a.taskId}</Link> · {a.text}
                        </span>
                      </li>
                    ))}
                    {p.activity.length === 0 && <li className="muted">No recent activity you can see.</li>}
                  </ul>
                </TabPanel>
              )}
            </div>
          </Card>
        </div>
        <aside className="task-side">
          <Card title="Details">
            <KV
              items={[
                ['Email', u.email],
                ['Phone', u.phone],
                ...(WHATSAPP_ENABLED ? [['WhatsApp', u.whatsapp ? <span key="wa">{u.whatsapp} {u.whatsappOptIn ? <Tag tone="ok">Opted in</Tag> : <Tag tone="warn">Not opted in</Tag>}</span> : <span className="muted">No number: email and in-app only</span>] as [string, ReactNode]] : []),
                ['Time zone', u.timezone],
                ...(BACKEND === 'server' ? [['Quiet hours', u.quietStart ? `${u.quietStart}–${u.quietEnd} (own)` : "Organization's"] as [string, ReactNode]] : []),
                ['Location', u.location],
                ['Joined', formatDate(u.joinedAt)],
                ['Reports to', p.manager ? <Link key="m" to={`/admin/staff/${p.manager.id}`}>{p.manager.name}</Link> : <Tag tone="warn">No manager</Tag>],
                ['Reporting chain', p.chain.map((c) => c.name).join(' → ') || '—'],
                ['Direct reports', p.reports.length ? p.reports.map((r) => r.name).join(', ') : '—'],
              ]}
            />
          </Card>
          <Card title="Permissions" sub={rolesOf(u).map((r) => ROLE_LABEL[r]).join(' + ')}>
            <div className="tag-cloud">
              {p.permissions.map((perm) => (
                <Tag key={perm}>{PERMISSION_LABEL[perm]}</Tag>
              ))}
            </div>
          </Card>
        </aside>
      </div>
      {editing && <StaffDialog row={u} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** ADR-0015 (D-162): a general manager without manage_staff works in their own verticals only; null = no limit. */
function useGmVerticals(): string[] | null {
  const auth = useAuth();
  if (!auth.bootstrap || auth.permissions?.includes('manage_staff')) return null;
  return auth.bootstrap.headOf ?? [];
}
