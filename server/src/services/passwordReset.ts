// Forgot / reset password and admin "reset access" (T-2.6; AUTH-04, AUTH-05). Tokens come from randomBytes, only
// their sha256 is stored, they expire after 1 h and work once. No API response and no stored message ever holds one.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { sendEmail } from '../notify/channels.js';
import { welcomeEmail } from '../notify/emailTemplates.js';
import { appendAdmin } from './audit.js';
import { endAllSessions, hashPassword, recordAttempt, signInMethod } from './auth.js';
import { getDirectory } from './directory.js';

const TOKEN_TTL_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
/** D-172: an onboarding link may wait in a new person's inbox for a few days, not one hour. */
const WELCOME_TTL_MS = 7 * 24 * HOUR_MS;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest();
export const BAD_TOKEN = 'This reset link is invalid or has expired. Request a new one.';

/** SECURITY §6: reset requests 3 per hour per email and 10 per IP; reset attempts 10 per hour per IP. */
async function throttle(method: 'reset_request' | 'reset', email: string | null, ip: string | undefined, maxEmail: number, maxIp: number) {
  const { rows } = await pool.query<{ by_email: number; by_ip: number }>(
    `select count(*) filter (where email_lower = $1)::int by_email, count(*) filter (where ip = $2::inet)::int by_ip
       from login_attempts where method = $3 and at > $4 and (email_lower = $1 or ip = $2::inet)`,
    [email, ip ?? null, method, new Date(Date.now() - HOUR_MS)],
  );
  if ((email && rows[0]!.by_email >= maxEmail) || rows[0]!.by_ip >= maxIp) throw new HttpError(429, 'Too many attempts. Try again later.', undefined, 3600);
}

/**
 * Issue a token for an active user and send the link by email (the only place the token ever goes). With `welcome`,
 * the email is the D-172 onboarding email and the link lasts 7 days.
 */
async function issueToken(user: { id: number; email: string }, createdBy: number | null, welcome?: { name: string }): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  await pool.query(`insert into password_reset_tokens (token_hash, user_id, created_at, expires_at, created_by) values ($1,$2,$3,$4,$5)`, [
    hashToken(token),
    user.id,
    now,
    new Date(now.getTime() + (welcome ? WELCOME_TTL_MS : TOKEN_TTL_MS)),
    createdBy,
  ]);
  const link = `${config.appUrl}/reset-password?token=${token}${welcome ? '&welcome=1' : ''}`;
  const status = await sendAccountEmail(
    welcome
      ? {
          userId: user.id,
          address: user.email,
          event: 'welcome',
          subject: 'Welcome to TaskWatch',
          body: 'Welcome to TaskWatch. Use this link within 7 days to choose your password.',
          loggedBody: 'Welcome email with a set-password link (redacted)',
          link,
          html: welcomeEmail(welcome.name, link),
        }
      : {
          userId: user.id,
          address: user.email,
          event: 'password_reset',
          subject: 'Reset your TaskWatch password',
          body: 'Use this link within one hour to choose a new TaskWatch password. If you did not ask for it, ignore this email.',
          loggedBody: 'Password reset link (redacted)', // the delivery log never holds the link
          link,
        },
  );
  // Development without SMTP: the link would go nowhere, so show it on the server console. Never in production.
  if (status === 'simulated' && !config.isProd) console.log(`[dev] password reset link for ${user.email}: ${link}`);
}

/**
 * Send an account email straight away (not through the alert queue, which follows preferences and quiet hours) and
 * record it in the delivery log. A send failure never throws: it is logged as failed.
 */
export async function sendAccountEmail(m: { userId: number; address: string; event: string; subject: string; body: string; loggedBody?: string; link?: string; html?: string }) {
  const now = new Date();
  let status: 'sent' | 'simulated' | 'failed' = 'failed';
  try {
    const result = await sendEmail({ address: m.address, subject: m.subject, body: m.body, template: null, templateParams: null, link: m.link ?? null, taskId: null }, m.html);
    status = result.simulated ? 'simulated' : 'sent';
  } catch (err) {
    console.error(`[account] ${m.event} email failed:`, (err as Error).message); // never the body or link
  }
  await pool.query(
    `insert into notifications (user_id, event, channel, status, address, subject, body, send_after, created_at, sent_at, organization_id)
     values ($1, $2, 'email', $3, $4, $5, $6, $7, $7, $8, (select organization_id from users where id = $1))`,
    [m.userId, m.event, status, m.address, m.subject, m.loggedBody ?? m.body, now, status === 'failed' ? null : now],
  );
  return status;
}

/** AUTH-04 request: the same answer whether or not the account exists (no enumeration). */
export async function requestReset(emailInput: string, ip: string | undefined): Promise<void> {
  const email = emailInput.trim().toLowerCase();
  await throttle('reset_request', email, ip, 3, 10);
  await recordAttempt({ method: 'reset_request', ok: true, email, ip });
  const { rows } = await pool.query<{ id: number; email: string }>('select id, email from users where lower(email) = $1 and active', [email]);
  // Not awaited: waiting for the token write and the email send would make known emails measurably slower (enumeration).
  if (rows[0]) void issueToken(rows[0], null).catch((err) => console.error('[auth] password reset issue failed:', (err as Error).message));
}

/** AUTH-04 reset: one use, within the hour; sets the password, ends every session of that person, audited. */
export async function resetPassword(token: string, password: string, ip: string | undefined): Promise<void> {
  await throttle('reset', null, ip, 0, 10);
  const userId = await tx(async (c) => {
    const { rows } = await c.query<{ user_id: number }>(
      `update password_reset_tokens set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id`,
      [hashToken(token)],
    );
    if (!rows[0]) return null;
    const id = rows[0].user_id;
    await c.query(
      `insert into user_credentials (user_id, password_hash, password_changed_at) values ($1, $2, now())
       on conflict (user_id) do update set password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
      [id, await hashPassword(password)],
    );
    await appendAdmin(c, { actorId: id, kind: 'password_reset', target: `user:${id}`, targetType: 'auth' });
    return id;
  });
  await recordAttempt({ method: 'reset', ok: userId !== null, userId, ip, reason: userId === null ? 'bad_token' : null });
  if (userId === null) throw new HttpError(400, BAD_TOKEN);
  await endAllSessions(userId); // AUTH-04-AC-5
}

/**
 * AUTH-05: someone with manage_staff sends another person a reset link and ends their sessions. Resetting a Chief of Staff needs the CoS role, so manage_staff alone cannot take over a CoS account.
 */
/** AUTH-05: end someone's sessions and email them a reset link. D-98: a non-CoS may reset only themselves and people below them. */
type Actor = { id: number; roles: string[]; organizationId: number };

/** The person `actor` may send account emails to: a CoS only by a CoS; D-98: otherwise only oneself or people below. */
async function accountTarget(actor: Actor, targetId: number) {
  const { rows } = await pool.query<{ id: number; email: string; name: string; roles: string[]; active: boolean; google_domains: string[] | null; has_password: boolean }>(
    `select u.id, u.email, u.name, u.roles, u.active, o.google_domains,
            exists (select 1 from user_credentials c where c.user_id = u.id and c.password_hash is not null) as has_password
       from users u join organizations o on o.id = u.organization_id where u.id = $1 and u.organization_id = $2`,
    [targetId, actor.organizationId],
  ); // KI-39: never across organizations
  const target = rows[0];
  if (!target) throw new HttpError(404, 'Person not found.');
  if (target.roles.includes('cos') && !actor.roles.includes('cos')) throw new HttpError(403, 'Only a Chief of Staff can reset another Chief of Staff.');
  if (!actor.roles.includes('cos') && targetId !== actor.id && !(await getDirectory(actor.organizationId)).descendants(actor.id).has(targetId)) {
    throw new HttpError(403, 'You can only reset access for yourself or people below you in the reporting line.');
  }
  return target;
}

export async function resetAccess(actor: Actor, targetId: number): Promise<void> {
  const target = await accountTarget(actor, targetId);
  await endAllSessions(targetId);
  if (target.active) await issueToken(target, actor.id);
  await appendAdmin(null, { actorId: actor.id, kind: 'access_reset', target: `user:${targetId}`, targetType: 'user' });
}

/**
 * D-172 (replaces D-126's "no welcome email"): someone who may reset a person's access sends them the onboarding
 * email by hand. Password users get a 7-day set-password link; a Google-only person (D-101) just gets the welcome.
 * Sessions are not touched. May be sent again (a new link; the old one still works until it expires).
 */
export async function sendOnboarding(actor: Actor, targetId: number): Promise<void> {
  const target = await accountTarget(actor, targetId);
  if (!target.active) throw new HttpError(409, 'This person is deactivated. Reactivate them first.');
  if (signInMethod(target.email, target.google_domains, target.has_password) === 'google') {
    await sendAccountEmail({ userId: target.id, address: target.email, event: 'welcome', subject: 'Welcome to TaskWatch', body: 'Welcome to TaskWatch. Sign in with your Google work account.', html: welcomeEmail(target.name) });
  } else {
    await issueToken(target, actor.id, { name: target.name });
  }
  await appendAdmin(null, { actorId: actor.id, kind: 'onboarding_sent', target: `user:${targetId}`, targetType: 'user' });
}
