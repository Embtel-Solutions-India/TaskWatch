import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABEL, ROLE_RANK } from '../../constants';
import { Icon } from '../../components/icons';
import { Avatar, Banner, Button, Card, Dialog, ErrorState, Field, Input, PageHeader, Segmented, Select, Skeleton, Stat, Tag } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { getOrg, setPlacement, type OrgData, type StaffRow } from '../../services/api/admin';
import { ancestorsOf, wouldCreateLoop } from '../../services/authz/permissions';
import { cx } from '../../utils/format';
import { BACKEND } from '../../services/http';
import { needsManager } from '@taskwatch/shared/permissions';

/** Entity pill colours, cycled in entity order (theme tokens, so dark mode follows). */
const PILL = ['var(--violet)', 'var(--ok)', 'var(--primary)', 'var(--warn)', 'var(--muted)'];

export function OrgPage() {
  const q = useApi(['org'], getOrg);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'tree' | 'teams'>('tree');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<StaffRow | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loaded = Boolean(q.data);
  // Open zoomed to fit the canvas width (50–100 %); the buttons take over from there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const chart = el?.firstElementChild;
    if (el && chart) setZoom(Math.max(0.5, Math.min(1, Math.floor(((el.clientWidth - 32) / chart.scrollWidth) * 10) / 10)));
  }, [loaded]);
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
  const orphans = users.filter(needsManager);
  const byRank = (a: StaffRow, b: StaffRow) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name);
  const childrenOf = (id: string) => users.filter((u) => u.managerId === id).sort(byRank);
  // Chart layout: the top person's entity (and anyone without a known entity) forms the top band; every other entity is a
  // column headed by its pill. Columns are cut from the reporting line, so the chart never disagrees with the tree.
  const deptIds = new Set(org.departments.map((d) => d.id));
  const top = users.filter((u) => !u.managerId || !users.some((x) => x.id === u.managerId)).sort(byRank)[0];
  const group = (u: StaffRow) => (u.entityId && deptIds.has(u.entityId) && u.entityId !== top?.entityId ? u.entityId : '');
  const headsOf = (g: string) => users.filter((u) => group(u) === g && !users.some((m) => m.id === u.managerId && group(m) === g)).sort(byRank);
  const columns = org.departments.map((d) => ({ d, heads: headsOf(d.id) })).filter((c) => c.heads.length > 0);
  const toggle = (id: string) => setCollapsed((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const Node = ({ u }: { u: StaffRow }) => {
    const kids = childrenOf(u.id);
    const shown = kids.filter((k) => group(k) === group(u)); // reports in other entities sit in their own column
    const open = !collapsed.has(u.id) || (match && shown.some((k) => highlight.has(k.id)));
    const l = { open: u.openTasks, overdue: u.overdueTasks };
    const team = org.teams.find((t) => t.id === u.teamId);
    return (
      <li className={cx('oc-node', match && !highlight.has(u.id) && 'dim', hits.some((h) => h.id === u.id) && 'hit')}>
        <div className={cx('oc-card', u.status !== 'active' && 'inactive')}>
          <Avatar name={u.name} size={36} inactive={u.status !== 'active'} />
          <div className="oc-info">
            <Link to={`/admin/staff/${u.id}`} className="oc-name">
              {u.name}
            </Link>
            <span className="oc-title" title={team ? `${u.title} · ${team.name}` : u.title}>
              {u.title || ROLE_LABEL[u.role]}
            </span>
          </div>
          <Button size="sm" variant="ghost" icon="edit" onClick={() => setMoving(u)} aria-label={`Change reporting for ${u.name}`} />
          <div className="oc-meta">
            <span className={cx('org-load', l.overdue ? 'danger' : l.open > org.overloadThreshold ? 'warn' : 'ok')} title={`${l.open} open, ${l.overdue} overdue`}>
              {l.open}
              {l.overdue > 0 && <small> · {l.overdue}!</small>}
            </span>
            {shown.length > 0 ? (
              <button type="button" className="org-count oc-toggle" onClick={() => toggle(u.id)} aria-expanded={!!open} aria-label={`${open ? 'Collapse' : 'Expand'} ${u.name}'s reports`} title="Direct reports">
                {kids.length}
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
              </button>
            ) : (
              kids.length > 0 && <span className="org-count" title="Direct reports">{kids.length}</span>
            )}
            {needsManager(u) && <Tag tone="warn">No manager</Tag>}
            {u.status !== 'active' && <Tag tone="muted">Inactive</Tag>}
          </div>
        </div>
        {open && shown.length > 0 && (
          <ul className="oc-children">
            {shown.map((k) => (
              <Node key={k.id} u={k} />
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="page">
      <PageHeader title="Organization Structure" description="The reporting hierarchy drives task visibility, who can assign to whom, and escalation routing." actions={<Segmented label="View" value={view} onChange={setView} options={[{ value: 'tree', label: 'Reporting tree' }, { value: 'teams', label: 'Departments' }]} />} />
      <div className="stats">
        <Stat label="People" value={users.length} />
        <Stat label="Verticals" value={org.departments.length} />
        <Stat label="Departments" value={org.teams.length} />
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
          <div className="oc-canvas">
            <div className="oc-scroll" ref={scrollRef}>
            <div className="oc-chart" style={{ zoom }}>
              <ul className="oc-top">
                {headsOf('').map((r) => (
                  <Node key={r.id} u={r} />
                ))}
              </ul>
              {columns.length > 0 && (
                <div className="oc-cols">
                  {columns.map(({ d, heads }, i) => (
                    <section key={d.id} className="oc-col" aria-label={d.name}>
                      <div className="oc-pill" style={{ background: PILL[i % PILL.length] }} title={d.name}>
                        {d.name}
                      </div>
                      <ul className="oc-branch">
                        {heads.map((h) => (
                          <Node key={h.id} u={h} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
            </div>
            <div className="oc-zoom" role="group" aria-label="Zoom">
              <button type="button" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))} aria-label="Zoom in" disabled={zoom >= 1.5}>
                +
              </button>
              <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom" className="oc-zoom-level">
                {Math.round(zoom * 100)}%
              </button>
              <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} aria-label="Zoom out" disabled={zoom <= 0.5}>
                −
              </button>
            </div>
          </div>
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
        {BACKEND === 'server' ? (
          <Field label="Reports to" htmlFor="mv-mgr" hint="Set automatically: the department lead, else the vertical's general manager, else the Chief of Staff.">
            <Input id="mv-mgr" value={org.users.find((u) => u.id === user.managerId)?.name ?? 'No manager'} readOnly />
          </Field>
        ) : (
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
        )}
        <Field label="Department" htmlFor="mv-team" error={place.fields.teamId}>
          <Select id="mv-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} invalid={!!place.fields.teamId}>
            <option value="">No department</option>
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
