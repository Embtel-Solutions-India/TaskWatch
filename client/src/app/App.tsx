import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AccessDenied, Empty, Skeleton, ToastProvider } from '../components/ui';
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SessionExpiredPage } from '../features/auth/AuthPages';
import { AuthContext, useAuth, useDocumentTitle, useMe, type AuthCtx } from '../hooks';
import { sessionApi, toClientUser, type Bootstrap } from '../services/api/session';
import { ApiError } from '../services/authz/permissions';
import { BACKEND } from '../services/http';
import { getDb, getSession, setSession, subscribe, tick } from '../services/mock/store';
import type { User } from '../types';
import { ROUTES, type RouteDef } from './routes';
import { Shell } from './Shell';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });

// Every committed change to the mock database refreshes all reads.
subscribe(() => queryClient.invalidateQueries({ queryKey: ['db'] }));

type AuthState = { user: User; bootstrap?: Bootstrap } | { user: null; expired: boolean } | { loading: true; user: null };

function resolveAuth(): AuthState {
  const s = getSession();
  if (!s) return { user: null, expired: false };
  const db = getDb();
  const u = db.users.find((x) => x.id === s.userId);
  if (!u || u.status !== 'active') {
    setSession(null);
    return { user: null, expired: false };
  }
  if (Date.now() - s.lastActive > db.settings.sessionTimeoutMinutes * 60_000) {
    setSession(null);
    return { user: null, expired: true };
  }
  return { user: u };
}

/** Server mode: who is signed in comes from GET /api/me (T-2.7). Expiry and sign-out arrive as 401s. */
async function resolveServerAuth(): Promise<AuthState> {
  try {
    const bootstrap = await sessionApi.me();
    return { user: toClientUser(bootstrap), bootstrap };
  } catch (e) {
    return { user: null, expired: e instanceof ApiError && e.message === 'SESSION_EXPIRED' };
  }
}

/** Server mode: screens that still run on the prototype's data say so instead of failing against it. */
function NotYetConnected({ title }: { title: string }) {
  return (
    <Empty icon="layers" title={`${title} is not connected to the server yet`}>
      You are signed in to the real TaskWatch server. This screen still runs on the prototype's sample data and moves to the server in a later phase.
    </Empty>
  );
}

function Guarded({ route }: { route: RouteDef }) {
  const user = useMe();
  const auth = useAuth();
  useDocumentTitle(route.title);
  if (BACKEND === 'server') {
    if (!route.server) return <NotYetConnected title={route.title} />;
    if (route.server !== true && ![route.server].flat().some((p) => auth.permissions?.includes(p))) return <AccessDenied message={`"${route.title}" is not available for your role and scope.`} />;
    return <>{route.element}</>;
  }
  if (route.allow && !route.allow(getDb(), user)) return <AccessDenied message={`"${route.title}" is not available for your role and scope.`} />;
  return <>{route.element}</>;
}

function AppRoutes() {
  const [auth, setAuthState] = useState<AuthState>(() => (BACKEND === 'server' ? { loading: true, user: null } : resolveAuth()));
  // H4: cached queries are keyed by resource, not by person, so a change of who is signed in (sign-out, expiry, a
  // different sign-in) drops them all. Otherwise the next person on a shared machine sees the last one's pages.
  const signedInId = useRef<string | undefined>(auth.user?.id);
  const setAuth = useCallback((next: AuthState) => {
    if (next.user?.id !== signedInId.current) {
      queryClient.clear();
      signedInId.current = next.user?.id;
    }
    setAuthState(next);
  }, []);
  const nav = useNavigate();
  const loc = useLocation();
  /** Server mode resolves asynchronously; callers that navigate afterwards await it (no sign-in page bounce). */
  const refresh = useCallback((): Promise<void> => {
    if (BACKEND === 'server') return resolveServerAuth().then(setAuth);
    setAuth(resolveAuth());
    return Promise.resolve();
  }, []);

  useEffect(() => {
    if (BACKEND === 'server') void refresh();
  }, [refresh]);
  // Re-resolve on data changes (role edits, deactivation) and on 401s from the API.
  useEffect(() => (BACKEND === 'mock' ? subscribe(() => void refresh()) : undefined), [refresh]);
  useEffect(() => {
    const unsub = queryClient.getQueryCache().subscribe((ev) => {
      const err = ev.query.state.error;
      if (!(err instanceof ApiError && err.status === 401)) return;
      if (BACKEND === 'server') setAuth({ user: null, expired: err.message === 'SESSION_EXPIRED' });
      else void refresh();
    });
    return unsub;
  }, [refresh]);
  // Server mode: every open screen, the bell and the badges pick up other people's changes without a reload (NTF-01),
  // every 60 s while the tab is visible and at once when it becomes visible again. Screens not on display refetch when opened.
  // ponytail: 60 s polling; server push (SSE/WebSocket) needs an ADR if minutes are too slow.
  const signedIn = Boolean(auth.user);
  useEffect(() => {
    if (BACKEND !== 'server' || !signedIn) return;
    const sync = () => {
      if (document.visibilityState !== 'visible') return;
      void queryClient.invalidateQueries({ queryKey: ['db'] });
      void refresh();
    };
    const t = setInterval(sync, 60_000);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [signedIn, refresh]);
  useEffect(() => {
    if (auth.user === null && 'expired' in auth && auth.expired) nav('/session-expired', { replace: true, state: { from: loc.pathname } });
  }, [auth, nav, loc.pathname]);
  // Background engine tick (prototype only): escalations and recurrences advance with real time too.
  useEffect(() => {
    if (BACKEND === 'server') return;
    tick();
    const id = setInterval(() => {
      tick();
      const next = resolveAuth();
      if (next.user?.id !== signedInId.current) setAuth(next); // H4: another person; clears the cache
      else setAuthState((a) => (next.user?.role === a.user?.role ? a : next));
    }, 30_000);
    return () => clearInterval(id);
  }, [setAuth]);

  const ctx = useMemo<AuthCtx | null>(() => {
    if (!auth.user) return null;
    const bootstrap = 'bootstrap' in auth ? auth.bootstrap : undefined;
    return { user: auth.user, refresh, bootstrap, permissions: bootstrap?.permissions };
  }, [auth, refresh]);

  if ('loading' in auth) return <Skeleton rows={4} />;

  if (!ctx) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={refresh} />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/session-expired" element={<SessionExpiredPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />} />
      </Routes>
    );
  }

  return (
    <AuthContext.Provider value={ctx}>
      <Shell>
        <Routes>
          {ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={<Guarded route={r} />} />
          ))}
          <Route path="/403" element={<AccessDenied />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/session-expired" element={<Navigate to="/" replace />} />
          <Route path="*" element={<AccessDenied message="That page does not exist or is not available to you." />} />
        </Routes>
      </Shell>
    </AuthContext.Provider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </QueryClientProvider>
  );
}
