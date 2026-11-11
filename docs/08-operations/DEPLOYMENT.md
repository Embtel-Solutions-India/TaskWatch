# Deployment

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Delivery decision: **standalone app** with its own directory and sign-in (D-22, WO-D1). Gates before any release: [RELEASE_READINESS.md](../05-testing-and-qa/RELEASE_READINESS.md). Variables: [ENVIRONMENT_CONFIGURATION.md](ENVIRONMENT_CONFIGURATION.md).
> No hosting target has been chosen. No staging, pilot or production environment exists as of 2026-11-03. **[A]** for anything about a host.

## 1. What exists today [V-S]

```
npm install
npm run build        # tsc --noEmit + vite build → client/dist
npm start            # tsx --env-file=production.env --env-file-if-exists=../.env src/index.ts
```

At start-up `server/src/index.ts`:
1. runs `migrate()`: **pending migrations are applied automatically** (`index.ts:9`);
2. loads the demo clock offset if demo tools are on (never in production, `index.ts:12-15`, `config.ts:62`);
3. creates the app and **starts the scheduler** in the same process: engine 60 s, dispatcher 15 s, recurring, digest and nightly chain check checks every 60 s (`index.ts:17-18`, `scheduler.ts:67-75`);
4. listens on `PORT` and serves `/api` plus `client/dist` with an SPA fallback, **on one port** (`app.ts:62-69`).

Other production behaviour already in code:
- `trust proxy` = 1 when `NODE_ENV=production`, so it expects one reverse proxy in front (`app.ts:21`).
- Helmet with CSP; `upgrade-insecure-requests` only when `APP_URL` is `https://` (`app.ts:23-28`).
- Session cookie `Secure` only when `APP_URL` is `https://` (`app.ts:43`).
- Start-up fails without `SESSION_SECRET` (`config.ts:19-21`).
- Dev login and demo tools forced off (`config.ts:60-62`).
- Uploads on local disk under `UPLOAD_DIR` (`config.ts:64`).

## 2. Required vs current

| # | Requirement | Source | Current | Gap |
|---|---|---|---|---|
| DP-1 | HTTPS end to end at the edge | [WO "Login"/security], S-6 | Plain HTTP on `PORT`; TLS expected from a proxy (README.md:106) | **Gap**: choose a reverse proxy / platform; set `APP_URL=https://…` |
| DP-2 | Secrets from a **managed secrets store**; no credentials in config files | [WO "Secrets", FO-2026-CRM-01 WP-1] | `npm start` loads `server/production.env` and any `../.env` | **Gap**: inject env from the store; no `.env` on the host; change the start command to stop loading `../.env` in production (D-87 (decided)) |
| DP-3 | Daily backups, 90-day retention, quarterly restore test | [WO "Backups"] | None. README suggests `pg_dump` (README "Going live"); `.gitignore` reserves `backups/` | **Gap**: schedule + off-host storage + restore drill ([RUNBOOK.md §5](RUNBOOK.md)) |
| DP-4 | **Single scheduler leader** | NFR Scalability, S-15 | Every process runs every job; only digest and chain check dedupe via `job_runs` (`scheduler.ts:43-47`, `digest.ts:114`); dispatcher uses `skip locked` | **Gap**: run exactly one instance, or add leader election (advisory lock) before scaling out |
| DP-5 | Engine at least every 5 min | [WO FR-8] | 60 s default | Met by default; add a start-up check that `ENGINE_INTERVAL_MS ≤ 300000` [A] |
| DP-6 | Uploads durable and backed up | WO retention 7 years | Local disk `server/uploads` | **Gap**: persistent volume included in backups, or object storage (ADR) |
| DP-7 | Session revocation across instances | S-7 | 30 s per-process directory cache | Acceptable with one instance; fix before scaling |
| DP-8 | Health check for uptime monitoring | NFR Observability [A] | No health endpoint | **Gap** ([MONITORING.md](MONITORING.md)) |
| DP-9 | Data retention 7 years; archive, never delete | [WO "Retention"] | No delete endpoints for tasks, people or logs [V-S] | Keep; backups must cover 90 days, the live DB holds 7 years |
| DP-10 | 2FA for manager/CoS/CEO | [WO "Login"], D-21 | Google path relies on Workspace 2SV (README.md:93-94); TOTP not built | **Gap** |
| DP-11 | Approved WhatsApp templates; email from Workspace | [WO], WO-D6 | Templates defined in `docs/whatsapp-templates.md`; simulated without keys | **Gap**: Meta approval |
| DP-12 | Migrations backed up before they run | [DATABASE_MIGRATION_POLICY §5](../04-engineering-standards/DATABASE_MIGRATION_POLICY.md) | Server migrates on start | Deploy procedure §3 takes the backup first |

## 3. Target procedure (once the gaps are closed) [A]

1. Confirm every gate in [RELEASE_READINESS.md](../05-testing-and-qa/RELEASE_READINESS.md) is `met` or waived.
2. On a build machine: `npm ci`, `npm run typecheck`, `npm run build`. Record the commands and their output.
3. **Back up the production DB** (`pg_dump -Fc`) and the uploads volume; confirm both files are non-empty.
4. Stop the running instance (one scheduler at a time).
5. Deploy the code and `client/dist`. Secrets come from the store as process environment.
6. Start **one** instance. Watch the start log for `[db] applied migrations: …`, `Google sign-in: on` with no "directory sign-in (dev)", and `WhatsApp: live · Email: live` (`index.ts:10,21-23`).
7. Smoke test: sign in as a CoS, open the dashboard, open one task (chain ok), check that the delivery log shows recent `sent` rows and that the engine has run in the last 5 minutes ([MONITORING.md](MONITORING.md)).
8. Rollback: stop, restore the step-3 backup if a migration ran, redeploy the previous build. Migrations are forward-only, so a rollback after a migration **is** a restore ([RUNBOOK.md §5](RUNBOOK.md)).

## 4. Not in scope
StatCommand module delivery (WO-D1 decided standalone, D-22); phase 2 GoHighLevel webhook, ImmigrationCRM link and mobile app. [WO]

## First production start (owner, 2026-11-11)

Production is seeded by hand with one SQL transaction: organization 1's name and settings, the verticals, and the first Chief of Staff (`users`) with a scrypt password hash in `user_credentials` (never in `users`). Run `npm run db:migrate` with the production `DATABASE_URL` first (`npm start` also migrates). `db:setup` and `db:seed` refuse to load the demo company when `NODE_ENV=production`.

- **The hash** must be in the app's format, `scrypt$131072$8$1$<salt>$<hash>`: produce it with `hashPassword` (`server/src/services/auth.ts`). Never keep the password or the hash in the repository.
- **Run the SQL from a file or the psql prompt**: the hash contains `$`, which a shell would expand inside `-c "…"`.
- **No audit entry** is written for the hand seed: the admin log is hash-chained and refuses direct inserts.
- **Order:** set `server/production.env` / the environment (`NODE_ENV=production`, `APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `UPLOAD_DIR`, SMTP for live email; see `.env.example`) → `npm run db:migrate` → the seed SQL → `npm start`.
- **The CoS then sets up:** Settings (check the priority weights), Verticals (general managers, departments and leads), Staff (add people, then "Reset access" each, D-126), and roles or the escalation policy if needed. The CoS should change the seeded password after the first sign-in.
