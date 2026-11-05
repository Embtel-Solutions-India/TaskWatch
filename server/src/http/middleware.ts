import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Role } from '../domain.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getDirectory, hasRole, toDirUser, type Directory, type DirUser } from '../services/directory.js';
import { getSettings } from '../services/settings.js';
import { effectivePermissions, getRoleMatrix } from '../services/permissions.js';
import type { Permission } from '@taskwatch/shared/permissions';
import { forbidden, HttpError } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: DirUser;
      dir?: Directory;
    }
  }
}

declare module 'express-session' {
  interface SessionData {
    /** Set once the person is signed in. */
    userId?: number;
    /** Real time (ms) the sign-in completed: the absolute lifetime counts from here (D-68). */
    signedInAt?: number;
    /** Real time (ms) of the last authenticated request: the idle timeout counts from here (AUTH-03). */
    lastSeenAt?: number;
    oauthState?: string;
    oauthNonce?: string;
  }
}

/** Absolute session lifetime (D-68): even a busy session must sign in again after 12 hours. */
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;

/** The session cookie, defined once: set by express-session (app.ts) and cleared at sign-out with the same options. */
export const SESSION_COOKIE = 'tw.sid';
export const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProd || config.appUrl.startsWith('https://'), // S-6: always secure in production
});

function endSession(req: Request): Promise<void> {
  return new Promise((resolve) => req.session.destroy(() => resolve()));
}

/**
 * Every API request re-reads the signed-in person's own row (no cache), so deactivation and role changes apply on
 * the very next request on every instance (S-7, AUTH-03-AC-3). Idle and absolute limits use real time, never the
 * demo clock. The shared directory (other people) stays cached for scope lookups.
 */
export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.session.userId;
  if (!id) throw new HttpError(401, 'Please sign in');
  const now = Date.now();
  const { rows } = await pool.query('select * from users where id = $1', [id]);
  if (!rows[0]?.active) {
    await endSession(req);
    throw new HttpError(401, 'Your account has been deactivated.');
  }
  const signedInAt = req.session.signedInAt ?? now; // sessions from before this rule start counting now
  const lastSeenAt = req.session.lastSeenAt ?? now;
  const settings = await getSettings(rows[0].organization_id);
  if (now - signedInAt > SESSION_MAX_MS || now - lastSeenAt > settings.sessionTimeoutMinutes * 60_000) {
    await endSession(req);
    throw new HttpError(401, 'SESSION_EXPIRED');
  }
  req.session.signedInAt = signedInAt;
  req.session.lastSeenAt = now;
  req.user = toDirUser(rows[0]);
  req.dir = await getDirectory(req.user.organizationId);
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !hasRole(req.user, ...roles)) throw forbidden('Your role cannot do this');
    next();
  };
}

/** The caller must hold `perm` through their roles in their organization's matrix, read fresh on every request (S-9). */
export function requirePermission(perm: Permission, what: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const { user } = me(req);
    if (!effectivePermissions(user, await getRoleMatrix(user.organizationId)).includes(perm)) {
      throw new HttpError(403, `You don't have permission to ${what}.`);
    }
    next();
  };
}

/** State-changing requests must carry a custom header, which cross-site forms cannot send. */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-taskwatch') !== '1') {
    res.status(403).json({ error: 'Request blocked: missing TaskWatch header' });
    return;
  }
  next();
}

export function me(req: Request): { user: DirUser; dir: Directory } {
  if (!req.user || !req.dir) throw new HttpError(401, 'Please sign in');
  return { user: req.user, dir: req.dir };
}

export function idParam(req: Request, name = 'id'): number {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

/** Postgres constraint errors that escaped service validation. Never echo constraint names or values. */
const PG_ERRORS: Record<string, [number, string]> = {
  '23505': [409, 'That record already exists'],
  '23503': [422, 'A referenced record does not exist'],
  '23514': [422, 'A value is outside the allowed range'],
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.status).json(err.fields ? { error: err.message, fields: err.fields } : { error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join('.') || '_'] ??= issue.message;
    res.status(422).json({ error: Object.values(fields)[0] ?? 'Invalid input', fields });
    return;
  }
  const code = (err as any)?.code;
  if (code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'That file is too large (15 MB maximum)' });
    return;
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON' });
    return;
  }
  const pg = PG_ERRORS[code];
  if (pg) {
    res.status(pg[0]).json({ error: pg[1] });
    return;
  }
  // P0001 comes from taskwatch_forbid_change: a code path tried to modify an append-only table.
  if (code === 'P0001') console.error('SECURITY: attempted change to an append-only table', err);
  else console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}
