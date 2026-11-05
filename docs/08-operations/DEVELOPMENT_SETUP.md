# Development Setup

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Commands that write to a database need the user's approval when an AI agent runs them ([AI_AGENT_GUARDRAILS §2.6](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)). They are marked ⚠ below.

## 1. Prerequisites

| Need | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 (README.md:23). This machine has v24.14.1, npm 11.6.1 (observed 2026-11-03). | Built-in `node:test` and `--env-file` are required. [V-S] `server/package.json` |
| PostgreSQL | ≥ 15 (README.md:23). This machine runs **PostgreSQL 18** as the Windows service `postgresql-x64-18` (Running, Automatic; observed 2026-11-03). | The README's setup notes describe a Mac with Homebrew Postgres 17 (README.md:23-24); see §5. |
| Git | not used | The folder is not a git repository. Do not initialise one without the user ([guardrail G-1](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)). |

## 2. First-time setup (Windows, PowerShell)

```powershell
# from the repo root
npm install                                 # installs both workspaces (server, client)
Copy-Item .env.example .env                 # only if .env does not exist yet; never overwrite an existing .env
# edit .env: set DATABASE_URL for your local Postgres user (see ENVIRONMENT_CONFIGURATION.md)
npm run db:setup                            # ⚠ creates DB "taskwatch" if missing, migrates, seeds when the directory is empty
```

- Check the service: `Get-Service postgresql-x64-18`. Start it with `Start-Service postgresql-x64-18` (needs an elevated shell).
- `DATABASE_URL` defaults to `postgres://localhost:5432/taskwatch` (`config.ts:30`) [V-S]. On Windows the installer's `postgres` user normally needs a password, so put user and password in **your local `.env` only**. Never write them in docs or code.
- `.env` is git-ignored (`.gitignore`). [V-S]
- The sample Chief of Staff's real mailbox comes from `SEED_COS_EMAIL` in `.env` (default `rahul@example.com`), so no real address is in the repo.

## 3. Running

| Command | What it actually does [V-S] | Port |
|---|---|---|
| `npm run dev` | **Client only** (Vite) on the localStorage mock (root `package.json:11`, `client/vite.config.ts`) | 5173 (strict) |
| `npm run dev:server` | ⚠ API in watch mode with `../.env`; **applies pending migrations and starts the scheduler** (`index.ts:9,18`) | `API_PORT` or 4000 (`config.ts:28`) |
| `npm run build` | Type-checks and builds the client into `client/dist` | — |
| `npm start` | ⚠ Server with `server/production.env` + `../.env`, serves `/api` and `client/dist` on one port; migrates at start-up | `PORT` (production) |
| `npm run typecheck` | `tsc --noEmit` for both workspaces | — |
| `npx tsx client/src/selfcheck.ts` | Pure rule self-check of the client prototype; no DB | — |

Notes:
- `npm run dev` runs the web app only; run `npm run dev:server` in a second terminal for the API. Vite proxies `/api` to it (T-1.14). `VITE_BACKEND=server` is read from the command line or `client/.env`, not the root `.env`. [D-19, decided] (D-88 (decided)) README updated 2026-11-06.
- Until client integration (tracker step 8), the web app does **not** talk to the API. It runs on mock data with demo password `taskwatch` (README.md:10).
- In dev, Google sign-in is off unless configured, so the API allows directory sign-in as any seeded user (`config.ts:60`). [V-S]

## 4. Database scripts and their risks

| Command | Effect | Risk |
|---|---|---|
| `npm run db:setup` ⚠ | Create DB if missing → migrate → seed if `users` is empty (`setup.ts`) | Writes schema and data |
| `npm run db:migrate` ⚠ | Apply new migration files only | Schema change; see [DATABASE_MIGRATION_POLICY.md](../04-engineering-standards/DATABASE_MIGRATION_POLICY.md) |
| `npm run db:seed` ⚠ | Load sample data; refuses if people already exist (`seed.ts:470`) | Writes data |
| `npm run db:seed -- --reset` ⚠⚠ | **`drop schema public cascade`** on `DATABASE_URL`, then reseed (`seed.ts:457-459`). Refuses only when `NODE_ENV=production`. | **Destroys all local data**, including anything you entered. Ask before running. |
| `npm test` ⚠⚠ | Creates `taskwatch_test` if missing, then **`drop schema public cascade`** on it (`api.test.ts:13-21,54`) | Destroys the test DB. Safe for dev data **only if** `TEST_DATABASE_URL` points at a `_test` DB. Needs approval (D-18). |

Never point `TEST_DATABASE_URL` at the `taskwatch` dev DB.

## 5. Mac notes (from the README)

The README was written on a Mac (README.md:23-24):
- Postgres 17 via Homebrew: `brew services start postgresql@17`.
- `cp .env.example .env` instead of `Copy-Item`.
- With Homebrew Postgres the current OS user is usually a superuser with no password, so the default `DATABASE_URL` works as-is. [A]

Everything else is the same.

## 6. Demo personas
Sign-in personas and what each shows are in README.md:36-43 and [QA_STRATEGY.md §2](../05-testing-and-qa/QA_STRATEGY.md). The demo clock (CoS → Audit & admin → +1/+4/+12/+24 h) is dev-only (`config.ts:62`). [V-S]

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | Service stopped: `Get-Service postgresql-x64-18` |
| `password authentication failed` | `DATABASE_URL` user/password in `.env` |
| `Migration 00x_… failed: …` | Read the message; the file was rolled back (`migrate.ts:25-26`). Do not edit an applied file. |
| Port 5173 in use | Vite uses `strictPort` and will not pick another port |
| `SESSION_SECRET must be set in production` | `NODE_ENV=production` without the secret (`config.ts:19-21`) |

## Auth in server mode (added 2026-11-04)
- **2FA key.** Add `TOTP_ENCRYPTION_KEY` (64 hex characters, e.g. `openssl rand -hex 32`) to `.env`. Without it, Managers, Chiefs of Staff and CEOs cannot finish password sign-in: the 2FA step answers 503 "not configured".
- **Passwords.** No one has a password until they get one through "Forgot password" or an admin "Reset access". Without SMTP the reset link is printed on the API console (development only).
- **Server mode.** To try the real sign-in in the browser: `VITE_BACKEND=server npm run dev` (client). Screens other than sign-in still say "not connected to the server yet".
- **Browser tests:** `npm run e2e` (isolated, see TESTING_STRATEGY).
