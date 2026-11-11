import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, notFound } from '../http/errors.js';
import { me, requireUser, SESSION_COOKIE, sessionCookieOptions } from '../http/middleware.js';
import { rateLimit } from '../http/rateLimit.js';
import { appendAdmin } from '../services/audit.js';
import { passwordRule, passwordSignIn, recordAttempt } from '../services/auth.js';
import { BAD_TOKEN, requestReset, resetPassword } from '../services/passwordReset.js';
import { bootstrap } from '../services/me.js';

export const authRouter = Router();

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

/** The one way a sign-in completes: a fresh session id (SEC-6) and the clocks for the idle and absolute limits. */
async function startSession(req: Request, userId: number): Promise<void> {
  await regenerate(req);
  req.session.userId = userId;
  req.session.signedInAt = req.session.lastSeenAt = Date.now();
}

function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: `${config.appUrl}/api/auth/google/callback`,
  });
}

authRouter.get('/auth/config', (_req, res) => {
  res.json({ google: config.google.enabled, devLogin: config.devLogin });
});

// Google Workspace single sign-on. Only people already in the TaskWatch directory may sign in.
authRouter.get('/auth/google', (req, res) => {
  if (!config.google.enabled) throw notFound('Google sign-in is not configured');
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  const domains = config.google.allowedDomains;
  const url = oauthClient().generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
    prompt: 'select_account',
    ...(domains.length === 1 ? { hd: domains[0] } : {}),
  });
  res.redirect(url);
});

// Caps token-exchange abuse per IP. Generous on purpose: a whole office may sign in from one NAT address.
// Failed-password counting (login_attempts) arrives with password sign-in, T-2.1.
const googleCallbackLimit = rateLimit({ max: 100, windowMs: 15 * 60_000, key: (req) => `ip:${req.ip}` });

authRouter.get('/auth/google/callback', googleCallbackLimit, async (req, res) => {
  if (!config.google.enabled) throw notFound(); // like /auth/google: no Google, no callback
  let email: string | null = null;
  const fail = async (msg: string, reason: string) => {
    await recordAttempt({ method: 'google', ok: false, email, ip: req.ip, reason }).catch(() => {});
    res.redirect(`/login?error=${encodeURIComponent(msg)}`);
  };
  try {
    const { code, state } = req.query as Record<string, string | undefined>;
    if (!code || !state || state !== req.session.oauthState) return fail('Sign-in expired. Please try again.', 'bad_state');
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) return fail('Google did not return an identity token.', 'no_id_token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    const p = ticket.getPayload();
    email = p?.email?.toLowerCase() ?? null;
    if (!p?.email || !p.email_verified) return fail('Your Google account email is not verified.', 'unverified_email');
    if (p.nonce !== req.session.oauthNonce) return fail('Sign-in could not be verified. Please try again.', 'bad_nonce');
    const domain = (p.hd ?? p.email.split('@')[1] ?? '').toLowerCase();
    const { rows } = await pool.query<{ id: number; active: boolean; google_domains: string[] }>(
      'select u.id, u.active, o.google_domains from users u join organizations o on o.id = u.organization_id where lower(u.email) = $1',
      [email],
    );
    // D-101: the person's organization's domains; GOOGLE_ALLOWED_DOMAINS when it has none (or the email is unknown).
    const allowed = rows[0]?.google_domains.length ? rows[0].google_domains : config.google.allowedDomains;
    if (allowed.length && !allowed.includes(domain)) {
      return fail(`${email} is not on an allowed company domain.`, 'domain');
    }
    if (!rows[0]?.active) return fail(`${email} is not in the TaskWatch directory. Ask the Chief of Staff to add you.`, rows[0] ? 'inactive' : 'not_in_directory');
    await startSession(req, rows[0].id);
    await recordAttempt({ method: 'google', ok: true, email, userId: rows[0].id, ip: req.ip });
    await appendAdmin(null, { actorId: rows[0].id, kind: 'sign_in', target: `user:${rows[0].id}`, targetType: 'auth', context: 'google' });
    res.redirect('/');
  } catch (err) {
    console.error('[auth] Google callback failed', err);
    await fail('Google sign-in failed. Please try again.', 'error');
  }
});

// Development fallback: pick a person from the directory. Off once Google is configured, and never in production.
authRouter.get('/auth/dev-users', async (_req, res) => {
  if (!config.devLogin) throw notFound();
  const { rows } = await pool.query(`select id, name, title, entity_id as "entityId", roles from users where active order by organization_id, id`);
  res.json(rows);
});

authRouter.post('/auth/dev-login', async (req, res) => {
  if (!config.devLogin) throw notFound();
  const { userId } = z.object({ userId: z.number().int() }).parse(req.body);
  const { rows } = await pool.query('select active from users where id = $1', [userId]);
  if (!rows[0]?.active) throw new HttpError(400, 'Unknown user');
  await startSession(req, userId);
  await recordAttempt({ method: 'dev', ok: true, userId, ip: req.ip });
  await appendAdmin(null, { actorId: userId, kind: 'sign_in', target: `user:${userId}`, targetType: 'auth', context: 'dev', source: 'demo' });
  res.json({ ok: true });
});

const loginSchema = z
  .object({
    email: z.string({ error: 'Enter your work email.' }).trim().min(1, { error: 'Enter your work email.' }),
    password: z.string({ error: 'Enter your password.' }).min(1, { error: 'Enter your password.' }),
  })
  .strict();

// In-memory caps checked before any DB count or password hash. The login_attempts throttle counts first and
// records after hashing, so a parallel burst would all pass it; these count synchronously, so they cannot be raced.
const perIp = (max: number, windowMs: number) => rateLimit({ max, windowMs, key: (req) => `ip:${req.ip}` });
const perEmail = (max: number, windowMs: number) =>
  rateLimit({ max, windowMs, key: (req) => (typeof req.body?.email === 'string' ? `email:${req.body.email.trim().toLowerCase()}` : undefined) });
// 60/min per IP, not the planned 30: a whole office signs in from one NAT address (as for the Google callback).
const loginLimits = [perIp(60, 60_000), perEmail(10, 15 * 60_000)];

/**
 * Password sign-in (T-2.1, AUTH-01b). A fresh session id on success (SEC-6). No second factor (D-94).
 */
authRouter.post('/auth/login', ...loginLimits, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const userId = await passwordSignIn(email, password, req.ip);
  await startSession(req, userId);
  await appendAdmin(null, { actorId: userId, kind: 'sign_in', target: `user:${userId}`, targetType: 'auth', context: 'password' });
  res.json({ ok: true });
});

/* ---------- Forgot / reset password (T-2.6, AUTH-04) ---------- */

const EMAIL_MSG = 'Enter a valid email address.';
const forgotSchema = z.object({ email: z.string({ error: EMAIL_MSG }).trim().email({ error: EMAIL_MSG }) }).strict();
const resetSchema = z
  .object({
    token: z.string().default(''),
    password: passwordRule,
    confirm: z.string().default(''),
  })
  .strict()
  .refine((b) => b.confirm === b.password, { error: 'The passwords do not match.', path: ['confirm'] });

/** Always the same answer, whether or not the account exists (AUTH-04-AC-1). */
authRouter.post('/auth/password/forgot', perIp(10, 60_000), async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  await requestReset(email, req.ip);
  res.json({ ok: true });
});

authRouter.post('/auth/password/reset', perIp(10, 60_000), async (req, res) => {
  const { token, password } = resetSchema.parse(req.body);
  if (!token) throw new HttpError(400, BAD_TOKEN);
  await resetPassword(token, password, req.ip);
  res.json({ ok: true });
});

/** Sign out (AUTH-02): destroy the session, clear the cookie (S-6), audit. Always 200, signed in or not. */
authRouter.post('/auth/logout', async (req, res) => {
  const userId = req.session.userId;
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  if (userId) await appendAdmin(null, { actorId: userId, kind: 'sign_out', target: `user:${userId}`, targetType: 'auth' });
  res.json({ ok: true });
});

/** Bootstrap for the client: the caller, their effective permissions, settings, rules and badges (T-1.15). */authRouter.get('/me', requireUser, async (req, res) => {  const { user, dir } = me(req);  res.json(await bootstrap(user, dir));});
