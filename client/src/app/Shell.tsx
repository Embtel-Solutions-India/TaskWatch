import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../constants';
import { Icon } from '../components/icons';
import { Avatar, Button, IconButton, Popover } from '../components/ui';
import { DemoBar } from '../features/demo/DemoBar';
import { ServerClockBar } from '../features/demo/ServerClockBar';
import { useAction, useApi, useAuth, useLocalState, useMediaQuery } from '../hooks';
import { listNotifications, logout, markAllRead, markRead } from '../services/api/misc';
import { sessionApi } from '../services/api/session';
import { BACKEND } from '../services/http';
import { getDb, getRev, subscribe } from '../services/mock/store';
import { ACTIVE_STATUSES } from '../types';
import { allowedActions } from '../services/engine/workflow';
import { canViewTask, hasPerm } from '../services/authz/permissions';
import { cx, relative } from '../utils/format';
import { getThemePref, resolvedTheme, setThemePref, type ThemePref } from '../utils/theme';
import { NOTIFICATION_LABEL } from '../constants';
import { crumbs, ROUTES, supervises, supervisesOnServer, type BadgeKey, type NavSection } from './routes';
import { SearchPalette } from './SearchPalette';

function useBadges(): Record<BadgeKey, number> {
  useSyncExternalStore(subscribe, getRev);
  const { user, bootstrap } = useAuth();
  // Server mode: the counts come scoped from /api/me (T-1.15); 'mine' arrives with the task screens.
  if (bootstrap) {
    const b = bootstrap.badges;
    return { notifications: b.unread, escalations: b.escalations, reviews: b.reviews, extensions: b.extensions, mine: 0 };
  }
  const db = getDb();
  const visible = db.tasks.filter((t) => canViewTask(db, user, t));
  return {
    notifications: db.notifications.filter((n) => n.userId === user.id && !n.read).length,
    escalations: new Set(db.escalations.filter((e) => e.status === 'active' && e.level >= 1 && visible.some((t) => t.id === e.taskId && (t.assigneeId !== user.id || user.role === 'cos'))).map((e) => e.taskId)).size,
    reviews: hasPerm(db, user, 'review_tasks') ? visible.filter((t) => t.status === 'submitted' && allowedActions(db, user, t).has('review')).length : 0,
    extensions: db.extensions.filter((e) => e.status === 'pending' && visible.some((t) => t.id === e.taskId && allowedActions(db, user, t).has('decide_extension'))).length,
    mine: visible.filter((t) => t.assigneeId === user.id && ACTIVE_STATUSES.includes(t.status) && !t.acknowledgedAt).length,
  };
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, refresh, bootstrap } = useAuth();
  const [collapsed, setCollapsed] = useLocalState('sidebar.collapsed', false);
  const mobile = useMediaQuery('(max-width: 900px)');
  const [drawer, setDrawer] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const badges = useBadges();
  const db = getDb();

  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === '/' && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sections: NavSection[] = ['General', 'Management', 'Administration'];
  const allowed = (r: (typeof ROUTES)[number]) =>
    BACKEND === 'server' && r.allow === supervises && bootstrap
      ? supervisesOnServer(bootstrap.permissions, bootstrap.user.roles, bootstrap.user.reportCount)
      : !r.allow || r.allow(db, user);
  const items = ROUTES.filter((r) => r.nav && allowed(r));
  const trail = crumbs(loc.pathname);
  const isCollapsed = collapsed && !mobile;

  const sidebar = (
    <nav className={cx('sidebar', isCollapsed && 'collapsed', mobile && 'mobile', mobile && drawer && 'open')} aria-label="Main">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <Icon name="check" size={15} />
        </span>
        {!isCollapsed && (
          <span className="brand-text">
            <strong>TaskWatch</strong>
            <small>{BACKEND === 'server' ? bootstrap?.settings.orgName : db.settings.orgName}</small>
          </span>
        )}
        {mobile && <IconButton icon="x" label="Close menu" className="sidebar-close" onClick={() => setDrawer(false)} />}
      </div>
      {hasPerm(db, user, 'create_tasks') && (
        <Link to="/tasks/new" className={cx('btn btn-primary new-task', isCollapsed && 'icon-only')} aria-label="New task">
          <Icon name="plus" size={16} />
          {!isCollapsed && 'New task'}
        </Link>
      )}
      <div className="nav-scroll">
        {sections.map((s) => {
          const list = items.filter((r) => r.nav!.section === s);
          if (!list.length) return null;
          return (
            <div className="nav-group" key={s}>
              {!isCollapsed && <div className="nav-heading">{s}</div>}
              <ul>
                {list.map((r) => {
                  const b = r.nav!.badge ? badges[r.nav!.badge] : 0;
                  const label = r.nav!.label ?? r.title;
                  return (
                    <li key={r.path}>
                      <NavLink to={r.path} end={r.path === '/'} className={({ isActive }) => cx('nav-item', isActive && 'active')} title={isCollapsed ? label : undefined}>
                        <Icon name={r.nav!.icon} size={16} />
                        {!isCollapsed && <span className="nav-label">{label}</span>}
                        {b > 0 && <span className={cx('nav-badge', r.nav!.badge === 'escalations' && 'danger', isCollapsed && 'dot')}>{isCollapsed ? '' : b}</span>}
                        {isCollapsed && <span className="sr-only">{label}</span>}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {!mobile && (
        <button type="button" className="collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={15} />
          {!isCollapsed && <span>Collapse</span>}
        </button>
      )}
    </nav>
  );

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {BACKEND === 'mock' ? <DemoBar /> : <ServerClockBar />}
      <div className={cx('layout', isCollapsed && 'is-collapsed')}>
        {sidebar}
        {mobile && drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />}
        <div className="main-col">
          <header className="topbar">
            {mobile && <IconButton icon="menu" label="Open menu" onClick={() => setDrawer(true)} />}
            <nav aria-label="Breadcrumb" className="crumbs">
              <ol>
                {trail.map((c, i) => (
                  <li key={c.path}>
                    {i < trail.length - 1 ? <Link to={c.path}>{c.title}</Link> : <span aria-current="page">{c.title}</span>}
                  </li>
                ))}
              </ol>
            </nav>
            <button type="button" className="search-trigger" onClick={() => setSearchOpen(true)} aria-label="Search tasks, people and teams">
              <Icon name="search" size={15} />
              <span className="search-trigger-text">Search tasks, people, teams…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <ThemeButton />
            <NotificationBell count={badges.notifications} />
            <Popover
              trigger={({ toggle, open, id }) => (
                <button type="button" className="user-btn" onClick={toggle} aria-expanded={open} aria-controls={id} aria-haspopup="menu">
                  <Avatar name={user.name} size={28} />
                  <span className="user-btn-text">
                    <strong>{user.name}</strong>
                    <small>{ROLE_LABEL[user.role]}</small>
                  </span>
                  <Icon name="chevron-down" size={14} />
                </button>
              )}
            >
              {(close) => (
                <div className="menu" role="menu" aria-label="Account">
                  <div className="menu-title">
                    {user.email}
                  </div>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), nav('/profile'))}>
                    <Icon name="user" size={14} /> My profile
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => (close(), nav('/settings/account'))}>
                    <Icon name="settings" size={14} /> Account settings
                  </button>
                  <ThemeToggle />
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={async () => {
                      close();
                      if (BACKEND === 'server') await sessionApi.logout().catch(() => {});
                      else logout();
                      refresh();
                      nav('/login');
                    }}
                  >
                    <Icon name="logout" size={14} /> Sign out
                  </button>
                </div>
              )}
            </Popover>
          </header>
          <main id="main" className="content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function useTheme() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const [shown, setShown] = useState(() => resolvedTheme());
  useEffect(() => {
    const sync = () => {
      setPref(getThemePref());
      setShown(resolvedTheme());
    };
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    window.addEventListener('tw-theme', sync);
    mq.addEventListener('change', sync);
    return () => {
      window.removeEventListener('tw-theme', sync);
      mq.removeEventListener('change', sync);
    };
  }, []);
  return { pref, shown };
}

/** Top-bar sun/moon: flips between light and dark. */
export function ThemeButton() {
  const { shown } = useTheme();
  const next = shown === 'dark' ? 'light' : 'dark';
  return <IconButton icon={shown === 'dark' ? 'sun' : 'moon'} label={`Switch to ${next} mode`} onClick={() => setThemePref(next)} />;
}

function ThemeToggle() {
  const { pref } = useTheme();
  return (
    <div className="menu-theme" role="group" aria-label="Theme">
      {(['light', 'dark', 'system'] as const).map((t) => (
        <button key={t} type="button" className={cx('menu-theme-opt', pref === t && 'on')} aria-pressed={pref === t} onClick={() => setThemePref(t)}>
          <Icon name={t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'settings'} size={13} />
          {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

function NotificationBell({ count }: { count: number }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const q = useApi(['notifications', user.id], listNotifications);
  const readAll = useAction(markAllRead);
  const read = useAction(markRead);
  const list = (q.data ?? []).slice(0, 8);
  return (
    <Popover trigger={({ toggle, open, id }) => <IconButton icon="bell" label={`Notifications${count ? `, ${count} unread` : ''}`} badge={count} onClick={toggle} aria-expanded={open} aria-controls={id} />} className="notif-pop">
      {(close) => (
        <div>
          <div className="notif-pop-head">
            <strong>Notifications</strong>
            <Button
              size="sm"
              variant="ghost"
              disabled={!count}
              onClick={() => readAll.run()}
            >
              Mark all read
            </Button>
          </div>
          {list.length === 0 ? (
            <p className="muted pad">You're all caught up.</p>
          ) : (
            <ul className="notif-list compact">
              {list.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cx('notif-row', !n.read && 'unread')}
                    onClick={() => {

                      if (!n.read) read.run(n.id, true);
                      close();
                      if (n.taskId) nav(`/tasks/${n.taskId}`);
                    }}
                  >
                    <span className={cx('notif-dot', n.type)} aria-hidden />
                    <span className="notif-text">
                      <strong>{n.title}</strong>
                      <span>{n.body}</span>
                      <small>
                        {NOTIFICATION_LABEL[n.type]} · {relative(n.at)}
                      </small>
                    </span>
                    {!n.read && <span className="sr-only">Unread</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link to="/notifications" className="notif-pop-foot" onClick={close}>
            View all notifications
          </Link>
        </div>
      )}
    </Popover>
  );
}
