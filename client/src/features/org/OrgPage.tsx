import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABEL, ROLE_RANK } from '../../constants';
import { Icon } from '../../components/icons';
import { Avatar, Banner, Button, Card, Dialog, ErrorState, Field, Input, PageHeader, RoleBadge, Segmented, Select, Skeleton, Stat, Tag } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { getOrg, setPlacement, type OrgData, type StaffRow } from '../../services/api/admin';
import { ancestorsOf, wouldCreateLoop } from '../../services/authz/permissions';
import { cx } from '../../utils/format';

export function OrgPage() {
  const q = useApi(['org'], getOrg);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'tree' | 'teams'>('tree');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<StaffRow | null>(null);
  const users = q.data?.users ?? [];
  const match = query.trim().toLowerCase();
  const hits = useMemo(() => (match ? users.filter((u) => u.name.toLowerCase().includes(match) || u.title.toLowerCase().includes(match)) : []), [users, match]);
  const highlight = useMemo(() => {
    const s = new Set<string>();
    for (const h of hits) {
      s.add(h.id);
      ancestorsOf({ users }, h.id).forEach((a) => s.add(a.id));
    }
    return s;
  }, [hits, users]);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={10} />;
  const org = q.data;
  const roots = users.filter((u) => !u.managerId || !users.some((x) => x.id === u.managerId)).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]);
  const orphans = users.filter((u) => !u.managerId && u.role !== 'cos');
  const childrenOf = (id: string) => users.filter((u) => u.managerId === id).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name));
  const toggle = (id: string) => setCollapsed((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const Node = ({ u, depth }: { u: StaffRow; depth: number }) => {
    const kids = childrenOf(u.id);
    const open = !collapsed.has(u.id) || (match && kids.some((k) => highlight.has(k.id)));
    const l = { open: u.openTasks, overdue: u.overdueTasks };
    const team = org.teams.find((t) => t.id === u.teamId);
    return (
      <li className={cx('org-node', match && !highlight.has(u.id) && 'dim', hits.some((h) => h.id === u.id) && 'hit')}>
        <div className={cx('org-card', u.status !== 'active' && 'inactive', `role-edge-${u.role}`)}>
          {kids.length > 0 ? (
            <button type="button" className="org-toggle" onClick={() => toggle(u.id)} aria-expanded={!!open} aria-label={`${open ? 'Collapse' : 'Expand'} ${u.name}'s reports`}>
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
            </button>
          ) : (
            <span className="org-toggle-spacer" />
          )}
          <Avatar name={u.name} size={30} inactive={u.status !== 'active'} />
          <div className="org-info">
            <Link to={`/admin/staff/${u.id}`} className="org-name">
              {u.name}
            </Link>
            <span className="muted small">
              {u.title}
              {team && ` · ${team.name}`}
            </span>
          </div>
          <RoleBadge role={u.role} />
          {kids.length > 0 && <span className="org-count" title="Direct reports">{kids.length}</span>}
          <span className={cx('org-load', l.overdue ? 'danger' : l.open > org.overloadThreshold ? 'warn' : 'ok')} title={`${l.open} open, ${l.overdue} overdue`}>
            {l.open}
            {l.overdue > 0 && <small> · {l.overdue}!</small>}
          </span>
          {!u.managerId && u.role !== 'cos' && <Tag tone="warn">No manager</Tag>}
          {u.status !== 'active' && <Tag tone="muted">Inactive</Tag>}
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setMoving(u)} aria-label={`Change reporting for ${u.name}`} />
        </div>
        {open && kids.length > 0 && (
          <ul className="org-children">
            {kids.map((k) => (
              <Node key={k.id} u={k} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Organization Structure" description="The reporting hierarchy drives task visibility, who can assign to whom, and escalation routing." actions={<Segmented label="View" value={view} onChange={setView} options={[{ value: 'tree', label: 'Reporting tree' }, { value: 'teams', label: 'Teams' }]} />} />
      <div className="stats">
        <Stat label="People" value={users.length} />
        <Stat label="Entities" value={org.departments.length} />
        <Stat label="Teams" value={org.teams.length} />
        <Stat label="Without a manager" value={orphans.length} tone={orphans.length ? 'warn' : undefined} help="Escalations skip their missing level and go to the next existing one (ultimately the Chief of Staff)." />
      </div>
      {orphans.length > 0 && (
        <Banner tone="warn" icon="users">
          {orphans.map((o) => o.name).join(', ')} {orphans.length === 1 ? 'has' : 'have'} no manager. Use the edit button to assign one.
        </Banner>
      )}
      {view === 'tree' ? (
        <Card
          title="Reporting tree"
          sub="Badge numbers: direct reports · open tasks (! = overdue)"
          actions={
            <div className="row-gap">
              <Input aria-label="Search staff" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} className="input-sm" />
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
                Expand all
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(users.filter((u) => u.role === 'manager' || u.role === 'lead').map((u) => u.id)))}>
                Collapse
              </Button>
            </div>
          }
        >
          {match && <p className="muted small">{hits.length} match(es); reporting paths highlighted.</p>}
          <ul className="org-tree">
            {roots.map((r) => (
              <Node key={r.id} u={r} depth={0} />
            ))}
          </ul>
        </Card>
      ) : (
        <div className="team-grid">
          {org.departments.map((d) => (
            <Card key={d.id} title={d.name} sub={`Head: ${users.find((u) => u.id === d.headId)?.name ?? '—'}`}>
              {org.teams
                .filter((t) => t.departmentId === d.id)
                .map((t) => {
                  const members = users.filter((u) => u.teamId === t.id);
                  return (
                    <div key={t.id} className="team-block">
                      <div className="row-between">
                        <strong>{t.name}</strong>
                        <span className="muted small">{members.length} people · lead {users.find((u) => u.id === t.leadId)?.name ?? '—'}</span>
                      </div>
                      <ul className="avatar-row">
                        {members.map((m) => (
                          <li key={m.id}>
                            <Link to={`/admin/staff/${m.id}`} title={`${m.name} — ${ROLE_LABEL[m.role]}`}>
                              <Avatar name={m.name} size={28} inactive={m.status !== 'active'} />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
            </Card>
          ))}
          <Card title="No team">
            <ul className="avatar-row">
              {users.filter((u) => !u.teamId).map((m) => (
                <li key={m.id}>
                  <Link to={`/admin/staff/${m.id}`} title={m.name}>
                    <Avatar name={m.name} size={28} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
      {moving && <MoveDialog user={moving} org={org} onClose={() => setMoving(null)} />}
    </div>
  );
}

function MoveDialog({ user, org, onClose }: { user: StaffRow; org: OrgData; onClose: () => void }) {
  const [managerId, setManagerId] = useState(user.managerId ?? '');
  const [teamId, setTeamId] = useState(user.teamId ?? '');
  // ORG-02: one call, so the manager and the team change together or not at all.
  const place = useAction(setPlacement, { onSuccess: onClose });
  const loop = wouldCreateLoop(org, user.id, managerId || null);
  const teams = org.teams.filter((t) => !user.entityId || t.departmentId === user.entityId);
  const save = () => place.run(user.id, managerId || null, teamId || null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reporting for ${user.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={loop} loading={place.pending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Reports to" htmlFor="mv-mgr" error={loop ? `${user.name} cannot report to someone in their own reporting line.` : place.fields.managerId}>
          <Select id="mv-mgr" value={managerId} onChange={(e) => setManagerId(e.target.value)} invalid={loop}>
            <option value="">No manager</option>
            {org.users
              .filter((u) => u.id !== user.id && u.status === 'active' && ROLE_RANK[u.role] > ROLE_RANK[user.role])
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} — {ROLE_LABEL[u.role]}
                  {wouldCreateLoop(org, user.id, u.id) ? ' (would create a loop)' : ''}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Team" htmlFor="mv-team" error={place.fields.teamId}>
          <Select id="mv-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} invalid={!!place.fields.teamId}>
            <option value="">No team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Banner tone="info">Changing a reporting line immediately changes who can see and assign this person's tasks, and where their escalations go. The change is audited.</Banner>
      </div>
    </Dialog>
  );
}
