import { Link } from 'react-router-dom';
import { ROLE_LABEL } from '../../constants';
import { BarList } from '../../components/charts';
import { Avatar, Card, ErrorState, PageHeader, RoleBadge, Skeleton, Stat, Tag } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { getDashboard } from '../../services/api/misc';
import { reportsOf } from '../../services/authz/permissions';
import { getDb } from '../../services/mock/store';
import { pct } from '../../utils/format';

export function TeamPage() {
  const user = useMe();
  const q = useApi(['dashboard', user.id], getDashboard);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={8} />;
  const d = q.data;
  const db = getDb();
  const reports = user.role === 'cos' ? db.users.filter((u) => u.id !== user.id) : db.users.filter((u) => reportsOf(db, user.id).has(u.id));
  const direct = reports.filter((u) => u.managerId === user.id);
  return (
    <div className="page">
      <PageHeader title="Team Overview" description={`${reports.length} people in your reporting line, ${direct.length} reporting directly to you.`} />
      <div className="stats">
        <Stat label="Open team tasks" value={d.scope.open.length} to="/tasks/team" />
        <Stat label="Overdue" value={d.scope.overdue.length} tone={d.scope.overdue.length ? 'danger' : undefined} to="/tasks/team?due=overdue" />
        <Stat label="Escalated (L1+)" value={d.scope.escalated.length} tone={d.scope.escalated.length ? 'warn' : undefined} to="/escalations" />
        <Stat label="Awaiting update" value={d.scope.stale.length} help="Open tasks whose assignee has not posted a progress update within the required window." to="/tasks/team?status=open" />
        <Stat label="On-time completion" value={pct(d.scope.onTimeRate)} help="Completed tasks in scope finished by their due date." />
      </div>
      <div className="grid-2">
        <Card title="Workload" sub="Current open tasks per person (not historical performance).">
          <BarList label="Open tasks per person" data={d.workload.slice(0, 14).map((w) => ({ label: w.name, value: w.open, tone: w.overdue ? 'tone-danger-bg' : 'series-1', hint: `${w.overdue} overdue, ${w.escalated} escalated` }))} />
        </Card>
        <Card title="Teams in scope">
          <table className="table compact">
            <caption className="sr-only">Teams</caption>
            <thead>
              <tr>
                <th>Team</th>
                <th className="right">Open</th>
                <th className="right">Overdue</th>
                <th className="right">Escalated</th>
                <th className="right">Completion</th>
              </tr>
            </thead>
            <tbody>
              {d.teams.map((t) => (
                <tr key={t.id}>
                  <td data-label="Team">
                    <Link to={`/tasks/team?team=${t.id}`}>{t.name}</Link>
                  </td>
                  <td data-label="Open" className="right">{t.open}</td>
                  <td data-label="Overdue" className="right">{t.overdue ? <span className="tone-danger">{t.overdue}</span> : 0}</td>
                  <td data-label="Escalated" className="right">{t.escalated}</td>
                  <td data-label="Completion" className="right">{pct(t.completionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <Card title="People" pad={false}>
        <div className="table-scroll">
          <table className="table">
            <caption className="sr-only">People in your reporting line</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Reports to</th>
                <th className="right">Open</th>
                <th className="right">Overdue</th>
                <th className="right">Escalated</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((u) => {
                const w = d.workload.find((x) => x.id === u.id);
                return (
                  <tr key={u.id}>
                    <td data-label="Name">
                      <span className="person">
                        <Avatar name={u.name} size={24} inactive={u.status !== 'active'} />
                        <Link to={`/admin/staff/${u.id}`}>{u.name}</Link>
                      </span>
                    </td>
                    <td data-label="Role"><RoleBadge role={u.role} /></td>
                    <td data-label="Reports to">{db.users.find((m) => m.id === u.managerId)?.name ?? '—'}</td>
                    <td data-label="Open" className="right">{w?.open ?? 0}</td>
                    <td data-label="Overdue" className="right">{w?.overdue ? <span className="tone-danger">{w.overdue}</span> : 0}</td>
                    <td data-label="Escalated" className="right">{w?.escalated ?? 0}</td>
                    <td data-label="Status"><Tag tone={u.status === 'active' ? 'ok' : 'muted'}>{u.status === 'active' ? 'Active' : 'Inactive'}</Tag></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="muted small">Roles: {Object.values(ROLE_LABEL).join(' · ')}. Profiles open with details you're allowed to see.</p>
    </div>
  );
}
