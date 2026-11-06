import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/**
 * Directory sign-in is a development fallback (SEC-10). Opt-in only: a deployment that forgets NODE_ENV must not
 * fall open to "sign in as anyone". Never in production, even when asked for.
 */
/** DEMO-01 G-1/G-4 (D-47): the dev clock is off unless DEMO_TOOLS=true, and never in production. */
export function demoToolsAllowed(e: NodeJS.ProcessEnv): boolean {
  return e.NODE_ENV !== 'production' && e.DEMO_TOOLS === 'true';
}

export function devLoginAllowed(e: NodeJS.ProcessEnv): boolean {
  return e.NODE_ENV !== 'production' && e.ALLOW_DEV_LOGIN === 'true';
}

/** WO FR-8: the engine runs at least every 5 minutes. A misconfigured interval stops the server instead of running late. */
export function engineIntervalMs(e: NodeJS.ProcessEnv): number {
  const ms = Number(e.ENGINE_INTERVAL_MS ?? 60_000);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 300_000) {
    throw new Error('ENGINE_INTERVAL_MS must be a whole number of milliseconds between 1000 and 300000 (WO FR-8: at least every 5 minutes).');
  }
  return ms;
}

if (isProd && !env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production (load it from your secrets store).');
}

export const config = {
  isProd,
  isTest,
  serverRoot,
  // Dev ignores PORT (meant for `npm start`) so the Vite proxy target stays 4000.
  port: Number((isProd ? env.PORT : env.API_PORT) ?? 4000),
  appUrl: (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://localhost:5432/taskwatch',
  // Without a configured secret, sessions only last until the server restarts.
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  google: {
    enabled: googleEnabled,
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    allowedDomains: list(env.GOOGLE_ALLOWED_DOMAINS),
  },

  whatsapp: {
    enabled: Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
    token: env.WHATSAPP_TOKEN ?? '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
    lang: env.WHATSAPP_TEMPLATE_LANG || 'en',
  },

  smtp: {
    enabled: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
    host: env.SMTP_HOST ?? '',
    port: Number(env.SMTP_PORT ?? 465),
    user: env.SMTP_USER ?? '',
    pass: env.SMTP_PASS ?? '',
    fromAddress: env.EMAIL_FROM_ADDRESS || env.SMTP_USER || '',
    fromName: 'TaskWatch',
  },

  devLogin: devLoginAllowed(env),
  // Simulated-clock controls for demonstrating the ladder; never available in production.
  demoTools: demoToolsAllowed(env),

  uploadDir: path.resolve(serverRoot, env.UPLOAD_DIR ?? 'uploads'),
  maxUploadBytes: 15 * 1024 * 1024,

  engineIntervalMs: engineIntervalMs(env),
  dispatchIntervalMs: 15_000,
  digestTimeZone: 'Asia/Kolkata',
  nightlyTimeZone: env.NIGHTLY_TZ || 'America/Los_Angeles',
};

export type Config = typeof config;
