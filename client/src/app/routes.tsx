// Central route table. Navigation, breadcrumbs and route guards are all derived from it.
import type { ReactNode } from 'react';
import type { Db, Permission, User } from '../types';
import { hasPerm, reportsOf } from '../services/authz/permissions';
import { AccountSettingsPage, ProfilePage } from '../features/account/AccountPages';
import { AuditPage } from '../features/admin/AuditPage';
import { DeliveryLogPage } from '../features/admin/DeliveryLogPage';
import { PoliciesPage, RolesPage, SettingsPage } from '../features/admin/AdminPages';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { OrgPage } from '../features/org/OrgPage';
import { ReportPage, ReportsIndexPage } from '../features/reports/ReportsPages';
import { StaffDirectoryPage, StaffProfilePage } from '../features/staff/StaffPages';
import { TeamPage } from '../features/staff/TeamPage';
import { CalendarPage } from '../features/tasks/CalendarPage';
import { TaskDetailPage } from '../features/tasks/TaskDetailPage';
import { EditTaskPage, NewTaskPage } from '../features/tasks/TaskFormPage';
import { TaskListPage } from '../features/tasks/TaskListPage';
import { EscalationsPage } from '../features/work/EscalationsPage';
import { ExtensionsPage, ReviewsPage } from '../features/work/QueuePages';
import { RecurringPage } from '../features/work/RecurringPage';

type Allow = (db: Db, user: User) => boolean;
export type NavSection = 'General' | 'Management' | 'Administration';
export type BadgeKey = 'notifications' | 'escalations' | 'reviews' | 'extensions' | 'mine';

export interface RouteDef {
  path: string;
  title: string;
  element: ReactNode;
  allow?: Allow;
  parent?: string;
  nav?: { section: NavSection; icon: string; label?: string; badge?: BadgeKey };
  /**
   * Server mode: the screen is connected to the real API (T-3.8 onward). `true` = any signed-in person (the API
   * scopes the data); a permission = only those holding it, checked against /api/me. Absent = not connected yet.
   */
  server?: true | Permission;
}

const supervises: Allow = (db, u) => hasPerm(db, u, 'view_tasks') && (u.role === 'cos' || reportsOf(db, u.id).size > 0);
const creates: Allow = (db, u) => hasPerm(db, u, 'create_tasks');
const reports: Allow = (db, u) => hasPerm(db, u, 'view_team_reports') || hasPerm(db, u, 'view_org_reports');
const perm = (p: Parameters<typeof hasPerm>[2]): Allow => (db, u) => hasPerm(db, u, p);

export const ROUTES: RouteDef[] = [
  { path: '/', title: 'Overview', element: <DashboardPage />, nav: { section: 'General', icon: 'home' } },
  { path: '/tasks/mine', title: 'My Tasks', element: <TaskListPage scope="mine" />, server: true, nav: { section: 'General', icon: 'check-square', badge: 'mine' } },
  { path: '/tasks/assigned-by-me', title: 'Assigned by Me', element: <TaskListPage scope="assigned_by_me" />, allow: creates, server: true, nav: { section: 'General', icon: 'send' } },
  { path: '/tasks/team', title: 'Team Tasks', element: <TaskListPage scope="team" />, allow: supervises, server: true, nav: { section: 'General', icon: 'layers' } },
  { path: '/calendar', title: 'Task Calendar', element: <CalendarPage />, server: true, nav: { section: 'General', icon: 'calendar' } },
  { path: '/notifications', title: 'Notifications', element: <NotificationsPage />, server: true, nav: { section: 'General', icon: 'bell', badge: 'notifications' } },
  { path: '/tasks/new', title: 'New task', element: <NewTaskPage />, allow: creates, server: true, parent: '/tasks/assigned-by-me' },
  { path: '/tasks/:id', title: 'Task', element: <TaskDetailPage />, server: true, parent: '/tasks/mine' },
  { path: '/tasks/:id/edit', title: 'Edit task', element: <EditTaskPage />, server: true, parent: '/tasks/:id' },

  { path: '/team', title: 'Team Overview', element: <TeamPage />, allow: supervises, nav: { section: 'Management', icon: 'users' } },
  { path: '/escalations', title: 'Escalations', element: <EscalationsPage />, allow: supervises, server: 'view_tasks', nav: { section: 'Management', icon: 'alert', badge: 'escalations' } },
  { path: '/reviews', title: 'Reviews', element: <ReviewsPage />, allow: perm('review_tasks'), server: 'review_tasks', nav: { section: 'Management', icon: 'review', badge: 'reviews' } },
  { path: '/extensions', title: 'Extensions', element: <ExtensionsPage />, allow: supervises, server: true, nav: { section: 'Management', icon: 'clock', badge: 'extensions' } },
  { path: '/recurring', title: 'Recurring Tasks', element: <RecurringPage />, allow: (db, u) => creates(db, u) && hasPerm(db, u, 'assign_tasks'), server: 'create_tasks', nav: { section: 'Management', icon: 'repeat' } },
  { path: '/reports', title: 'Accountability Reports', element: <ReportsIndexPage />, allow: reports, nav: { section: 'Management', icon: 'chart', label: 'Reports' } },
  { path: '/reports/:reportId', title: 'Report', element: <ReportPage />, allow: reports, parent: '/reports' },

  { path: '/admin/staff', title: 'Staff Management', element: <StaffDirectoryPage />, allow: perm('manage_staff'), server: 'manage_staff', nav: { section: 'Administration', icon: 'users', label: 'Staff' } },
  { path: '/admin/staff/:id', title: 'Staff profile', element: <StaffProfilePage />, parent: '/admin/staff', server: true },
  { path: '/admin/org', title: 'Organization Structure', element: <OrgPage />, allow: perm('manage_staff'), server: 'manage_staff', nav: { section: 'Administration', icon: 'tree', label: 'Organization' } },
  { path: '/admin/roles', title: 'Roles & Permissions', element: <RolesPage />, allow: perm('manage_roles'), server: 'manage_roles', nav: { section: 'Administration', icon: 'key' } },
  { path: '/admin/policies', title: 'Escalation Policies', element: <PoliciesPage />, allow: perm('manage_escalation_policies'), server: 'manage_escalation_policies', nav: { section: 'Administration', icon: 'sliders' } },
  { path: '/admin/audit', title: 'Audit Logs', element: <AuditPage />, allow: perm('view_audit_logs'), server: 'view_audit_logs', nav: { section: 'Administration', icon: 'file' } },
  { path: '/admin/deliveries', title: 'Delivery Log', element: <DeliveryLogPage />, allow: perm('view_audit_logs'), server: 'view_audit_logs', nav: { section: 'Administration', icon: 'message' } },
  { path: '/admin/settings', title: 'System Settings', element: <SettingsPage />, allow: perm('manage_system_settings'), server: 'manage_system_settings', nav: { section: 'Administration', icon: 'settings' } },

  { path: '/profile', title: 'My profile', element: <ProfilePage /> },
  { path: '/settings/account', title: 'Account settings', element: <AccountSettingsPage />, server: true },
];

export function matchRoute(pathname: string): { route: RouteDef; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const a = route.path.split('/');
    const b = pathname.replace(/\/$/, '').split('/');
    if (pathname === '/' && route.path === '/') return { route, params: {} };
    if (a.length !== b.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.startsWith(':')) params[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
      else if (a[i] !== b[i]) ok = false;
    }
    if (ok) return { route, params };
  }
  return null;
}

/** Breadcrumb trail: parent routes with params filled in. */
export function crumbs(pathname: string): { path: string; title: string }[] {
  const m = matchRoute(pathname);
  if (!m) return [];
  const out: { path: string; title: string }[] = [];
  let r: RouteDef | undefined = m.route;
  while (r) {
    const path = r.path.replace(/:(\w+)/g, (_, k: string) => m.params[k] ?? k);
    out.unshift({ path, title: r.path.includes(':id') && m.params.id && r.title === 'Task' ? m.params.id : r.title });
    r = r.parent ? ROUTES.find((x) => x.path === r!.parent) : undefined;
  }
  return out;
}
