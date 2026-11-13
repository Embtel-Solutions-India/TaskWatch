import { Link } from 'react-router-dom';
import { ROLE_LABEL } from '../../constants';
import { BarList } from '../../components/charts';
import { Avatar, Card, ErrorState, PageHeader, RoleBadge, Skeleton, Stat, Tag } from '../../components/ui';
import { useApi, useMe } from '../../hooks';
import { getTeamOverview } from '../../services/api/misc';
import type { Role } from '../../types';
import { pct } from '../../utils/format';

/** The highest-ranked of a person's roles (D-8). */
const topRole = (roles: readonly string[]) => (['ceo', 'cos', 'manager', 'lead', 'staff'] as const).find((r) => roles.includes(r)) as Role;

// DASH-02: every figure and name comes from getTeamOverview() (scoped on the server); nothing is read from the store.
export function TeamPage() {
  const user = useMe();
  const q = useApi(['team-overview', user.id], getTeamOverview);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton rows={8} />;
  const d = q.data;
  return (
    <div className="page">
      <PageHeader title="Team Overview" description={`${d.reportCount} people in your reporting line, ${d.directCount} reporting directly to you.`} />
      <div className="stats">
        <Stat label="Open team tasks" value={d.stats.open} to="/tasks/team" />
        <Stat label="Overdue" value={d.stats.overdue} tone={d.stats.overdue ? 'danger' : undefined} to="/tasks/team?due=overdue" />
        <Stat label="Escalated (L1+)" value={d.stats.escalated} tone={d.stats.escalated ? 'warn' : undefined} to="/escalations" />
        <Stat label="Awaiting update" value={d.stats.awaitingUpdate} help="Open tasks whose assignee has not posted a progress update within the required window." to="/tasks/team?status=open" />
        <Stat label="On-time completion" value={pct(d.stats.onTimeRate)} help="Completed tasks in scope finished by their due date." />
      </div>
      <div className="grid-2">
        <Card title="Workload" sub="Current open tasks per person (not historical performance).">
          <BarList label="Open tasks per person" data={d.workload.map((w) => ({ label: w.name, value: w.open, tone: w.overdue ? 'tone-danger-bg' : 'series-1', hint: `${w.overdue} overdue, ${w.escalated} escalated` }))} />
        </Card>
        <Card title="Departments in scope">
          <table className="table compact">
            <caption className="sr-only">Departments</caption>
            <thead>
              <tr>
                <th>Department</th>
                <th className="right">Open</th>
                <th className="right">Overdue</th>
                <th className="right">Escalated</th>
                <th className="right">Completion</th>
              </tr>
            </thead>
            <tbody>
              {d.teams.map((t) => (
                <tr key={t.id}>
                  <td data-label="Department">
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
              {d.people.map((u) => {
                return (
                  <tr key={u.id}>
                    <td data-label="Name">
                      <span className="person">
                        <Avatar name={u.name} size={24} inactive={!u.active} />
                        <Link to={`/admin/staff/${u.id}`}>{u.name}</Link>
                      </span>
                    </td>
                    <td data-label="Role"><RoleBadge role={topRole(u.roles)} /></td>
                    <td data-label="Reports to">{u.managerName ?? '—'}</td>
                    <td data-label="Open" className="right">{u.open}</td>
                    <td data-label="Overdue" className="right">{u.overdue ? <span className="tone-danger">{u.overdue}</span> : 0}</td>
                    <td data-label="Escalated" className="right">{u.escalated}</td>
                    <td data-label="Status"><Tag tone={u.active ? 'ok' : 'muted'}>{u.active ? 'Active' : 'Inactive'}</Tag></td>
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
