// The one path from the client to the TaskWatch API (T-1.16; API_CONTRACTS §1, ERROR_HANDLING §3).
// Same-origin only: the session cookie travels automatically and the dev server proxies /api (vite.config.ts).
import { ApiError, type ApiStatus } from './authz/permissions';

/**
 * Which backend the screens use. 'mock' (default) keeps the prototype's in-browser data; 'server' is switched on
 * with VITE_BACKEND=server once a feature's endpoints exist. Each feature moves its own API functions over.
 * A production build is always 'server': without client/.env (git-ignored) it would otherwise save into the browser.
 */
export const BACKEND: 'mock' | 'server' = import.meta.env?.PROD || import.meta.env?.VITE_BACKEND === 'server' ? 'server' : 'mock';

const KNOWN: readonly ApiStatus[] = [400, 401, 403, 404, 409, 413, 422, 429, 500];

const FALLBACK: Partial<Record<ApiStatus, string>> = {
  401: 'Please sign in.',
  403: "You don't have permission to do that.",
  404: 'Not found.',
  413: 'That file is too large.',
  429: 'Too many requests. Please wait and try again.',
  500: 'Something went wrong on the server.',
};

/** Call the API. Resolves with the parsed JSON body (null when there is none); rejects with an ApiError. */
export async function http<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      // The server refuses state changes without this header (CSRF guard); harmless on reads.
      headers: { 'x-taskwatch': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(500, "Can't reach TaskWatch. Check your connection and try again.");
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (res.ok) return data as T;

  const status: ApiStatus = KNOWN.includes(res.status as ApiStatus) ? (res.status as ApiStatus) : 500;
  const message = typeof data?.error === 'string' ? data.error : (FALLBACK[status] ?? 'The request could not be completed.');
  const retryAfter = Number(res.headers.get('retry-after'));
  throw new ApiError(status, message, data?.fields, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}
