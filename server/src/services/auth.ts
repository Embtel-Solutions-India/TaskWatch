// Password sign-in (T-2.1; AUTH-01b, ADR-0002, SECURITY_ARCHITECTURE §1–2, §6). Node crypto only, no new dependency.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from '../db/pool.js';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';

/** AUTH-04: the password rule, shared by password reset and the production bootstrap. */
export const passwordRule = z
  .string({ error: 'Use at least 10 characters.' })
  .min(10, { error: 'Use at least 10 characters.' })
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), { error: 'Use letters and at least one number.' });

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** Work factor stored with each hash, so it can be raised later without invalidating existing passwords. */
const PARAMS = { N: 2 ** 17, r: 8, p: 1 };
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024; // N=2^17, r=8 needs ~128 MiB

/** 'scrypt$N$r$p$<salt b64>$<hash b64>' */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return crypto.timingSafeEqual(actual, expected);
}

// An unknown email still costs one full hash, so response time does not reveal which accounts exist.
let decoy: Promise<string> | null = null;
const decoyHash = () => (decoy ??= hashPassword(crypto.randomBytes(16).toString('hex')));

const WINDOW_MS = 15 * 60_000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;
const GENERIC = 'That email and password combination is not recognized.';

/** One row per sign-in or reset attempt: the audit of attempts and the throttle counter (SECURITY §6). */
export async function recordAttempt(a: { method: 'password' | 'google' | 'dev' | 'reset_request' | 'reset'; ok: boolean; email?: string | null; userId?: number | null; ip?: string; reason?: string | null; at?: Date }): Promise<void> {
  await pool.query(`insert into login_attempts (at, email_lower, user_id, ip, method, ok, reason) values ($1,$2,$3,$4,$5,$6,$7)`, [
    a.at ?? new Date(),
    a.email?.toLowerCase() ?? null,
    a.userId ?? null,
    a.ip ?? null,
    a.method,
    a.ok,
    a.reason ?? null,
  ]);
}

/**
 * Check a password sign-in. Throttles before verifying (so a correct password does not bypass the limit),
 * records every attempt in login_attempts, and returns the user id.
 * Real time, not the demo clock: limits concern actual request rates.
 */
export async function passwordSignIn(emailInput: string, password: string, ip: string | undefined): Promise<number> {
  const email = emailInput.trim().toLowerCase();
  const now = new Date();
  const { rows: lim } = await pool.query<{ by_email: number; by_ip: number; oldest: Date | null }>(
    `select count(*) filter (where email_lower = $1)::int by_email, count(*) filter (where ip = $2::inet)::int by_ip, min(at) oldest
       from login_attempts
      where method = 'password' and not ok and at > $3 and (email_lower = $1 or ip = $2::inet)`,
    [email, ip ?? null, new Date(now.getTime() - WINDOW_MS)],
  );
  const l = lim[0]!;
  if (l.by_email >= MAX_PER_EMAIL || l.by_ip >= MAX_PER_IP) {
    const retry = Math.max(1, Math.ceil(((l.oldest?.getTime() ?? now.getTime()) + WINDOW_MS - now.getTime()) / 1000));
    throw new HttpError(429, 'Too many attempts. Try again later.', undefined, retry);
  }

  const { rows } = await pool.query<{ id: number; active: boolean; password_hash: string | null }>(
    `select u.id, u.active, c.password_hash
       from users u left join user_credentials c on c.user_id = u.id
      where lower(u.email) = $1`,
    [email],
  );
  const u = rows[0];
  const ok = u?.password_hash ? await verifyPassword(u.password_hash, password) : (await verifyPassword(await decoyHash(), password), false);
  const record = (success: boolean, reason: string | null) => recordAttempt({ method: 'password', ok: success, email, userId: u?.id, ip, reason, at: now });

  if (!u || !ok) {
    await record(false, !u ? 'unknown_email' : u.password_hash ? 'bad_password' : 'no_password');
    throw new HttpError(401, GENERIC);
  }
  // Only now, after the password matched, reveal that the account is deactivated.
  if (!u.active) {
    await record(false, 'inactive');
    throw new HttpError(403, 'This account is deactivated. Contact your Chief of Staff.');
  }
  await record(true, null);
  return u.id;
}

/** Revoke every session of a person (password reset, reset access; SECURITY §2). */
export async function endAllSessions(userId: number): Promise<void> {
  await pool.query(`delete from "session" where (sess->>'userId')::int = $1`, [userId]);
}
