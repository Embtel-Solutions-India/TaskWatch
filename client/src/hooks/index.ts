import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Permission, User } from '../types';
import { ApiError, hasPerm } from '../services/authz/permissions';
import { getDb } from '../services/mock/store';
import { useToast } from '../components/ui';
import type { Bootstrap } from '../services/api/session';
import { BACKEND } from '../services/http';

// The prototype's simulated network delay; the real server has its own.
const latency = () => (BACKEND === 'server' ? Promise.resolve() : new Promise((r) => setTimeout(r, 120 + Math.random() * 220)));

/** Read through the API (mock or server). The mock store invalidates ['db'] on every commit; server writes do it in useAction. */
export function useApi<T>(key: unknown[], fn: () => T | Promise<T>) {
  return useQuery<T, ApiError>({
    queryKey: ['db', ...key],
    queryFn: async () => {
      await latency();
      return fn();
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Run a mutation with simulated latency, a success toast and an error toast. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, opts: { success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {}) {
  const toast = useToast();
  const qc = useQueryClient();
  const auth = useContext(AuthContext);
  const m = useMutation<R, ApiError, A>({
    mutationFn: async (args: A) => {
      await latency();
      return fn(...args);
    },
    onSuccess: (r) => {
      if (BACKEND === 'server') {
        // The mock store announces its own commits; server writes refresh the pages and the /me bootstrap here.
        void qc.invalidateQueries({ queryKey: ['db'] });
        void auth?.refresh();
      }
      const msg = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (msg) toast({ tone: 'success', text: msg });
      opts.onSuccess?.(r);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) return; // shown inline next to the fields
      toast({ tone: 'error', text: e.message });
    },
  });
  const run = useCallback((...args: A) => m.mutate(args), [m]);
  const runAsync = useCallback((...args: A) => m.mutateAsync(args), [m]);
  return { run, runAsync, pending: m.isPending, error: m.error, fields: m.error instanceof ApiError ? m.error.fields ?? {} : {}, reset: m.reset };
}

export interface AuthCtx {
  user: User;
  refresh: () => Promise<void>;
  /** Server mode: the effective permissions and the /api/me bootstrap. Absent in mock mode. */
  permissions?: Permission[];
  bootstrap?: Bootstrap;
}
export const AuthContext = createContext<AuthCtx | null>(null);

export function useMe(): User {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useMe outside the app shell');
  return ctx.user;
}
export function useAuth(): AuthCtx {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside the app shell');
  return ctx;
}

export function useCan(p: Permission): boolean {
  const ctx = useAuth();
  return ctx.permissions ? ctx.permissions.includes(p) : hasPerm(getDb(), ctx.user, p);
}

/** Per-viewer UI preference in localStorage (never business data). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`taskwatch.ui.${key}`);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(`taskwatch.ui.${key}`, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [v, set];
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · TaskWatch`;
  }, [title]);
}
