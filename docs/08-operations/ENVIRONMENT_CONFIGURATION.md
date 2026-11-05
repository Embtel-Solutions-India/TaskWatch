# Environment Configuration

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Source of truth: `server/src/config.ts` (all reads of `process.env` happen there, except the test harness) and `.env.example`. This page lists **names and non-secret defaults only**. Values live in your local `.env` (dev) or the managed secrets store (production) [WO "Secrets"].

## 1. Variables

| Variable | Purpose | Default (code) | Required in prod | Secret | Evidence |
|---|---|---|---|---|---|
| `NODE_ENV` | `production` turns on prod mode: `trust proxy`, `PORT`, dev login and demo tools forced off, `SESSION_SECRET` mandatory; `test` is set by the test harness | unset (dev) | yes, `production` | no | `config.ts:6-7`; set by `server/production.env` for `npm start` |
| `PORT` | Listen port in production | 4000 | yes [A] | no | `config.ts:28` |
| `API_PORT` | Listen port in dev and test (ignored in production) | 4000 | no | no | `config.ts:28` |
| `APP_URL` | Public base URL: links in alerts, Google redirect URI, cookie `Secure` flag, CSP upgrade | `http://localhost:5173` | yes (`https://…`) | no | `config.ts:29`, `app.ts:26,43` |
| `DATABASE_URL` | Postgres connection | `postgres://localhost:5432/taskwatch` | yes | **yes** (embeds credentials) | `config.ts:30` |
| `SESSION_SECRET` | Signs the `tw.sid` session cookie. Without it a random per-process value is used and sessions die on restart | random per process | **yes** (start fails without it, `config.ts:19-21`) | **yes** | `config.ts:32` |
| `GOOGLE_CLIENT_ID` | Google OAuth client | empty → Google off | yes (D-2) | no [A] (public identifier) | `config.ts:36` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret | empty → Google off | yes | **yes** | `config.ts:37` |
| `GOOGLE_ALLOWED_DOMAINS` | Comma list of email domains allowed to sign in; lower-cased | empty = any verified domain | yes [A] (empty allows any domain whose users are in the directory) | no | `config.ts:38`, `auth.ts:64` |
| `WHATSAPP_TOKEN` | WhatsApp Cloud API token; empty → WhatsApp simulated | empty | yes for live WhatsApp (WO-D6) | **yes** | `config.ts:43` |
| `WHATSAPP_PHONE_NUMBER_ID` | Sending number id; empty → simulated | empty | yes for live WhatsApp | no [A] | `config.ts:44` |
| `WHATSAPP_API_VERSION` | Graph API version | `v23.0` | no | no | `config.ts:45` |
| `WHATSAPP_TEMPLATE_LANG` | Template language code | `en` | no | no | `config.ts:46`, `docs/whatsapp-templates.md:8` |
| `SMTP_HOST` | SMTP server (Workspace) | empty → email simulated | yes for live email | no | `config.ts:51` |
| `SMTP_PORT` | SMTP port | 465 | no | no | `config.ts:52` |
| `SMTP_USER` | SMTP login (mailbox) | empty | yes for live email | no [A] (it is an address; treat as personal data) | `config.ts:53` |
| `SMTP_PASS` | SMTP app password | empty | yes for live email | **yes** | `config.ts:54` |
| `EMAIL_FROM_ADDRESS` | From address; sender name is fixed "TaskWatch" | `SMTP_USER` | no | no | `config.ts:55-56` |
| `ALLOW_DEV_LOGIN` | `true` turns on directory ("pick a person") sign-in. Off unless set, whatever `NODE_ENV` or Google say (auth review 2026-11-04) | off | must be unset (refused in prod) | no | `config.ts` `devLoginAllowed` |
| `DEMO_TOOLS` | `false` turns off the simulated clock in dev | on in dev | ignored in prod (always off) | no | `config.ts:62` |
| `UPLOAD_DIR` | Where uploaded files are stored, relative to `server/` | `uploads` (→ `server/uploads`) | yes [A] (a persistent, backed-up volume) | no | `config.ts:64` |
| `ENGINE_INTERVAL_MS` | Escalation engine cadence | 60 000 | no; **must be ≤ 300 000** (WO FR-8) — not validated today | no | `config.ts:67` |
| `NIGHTLY_TZ` | Zone for the 02:00 nightly chain check | `America/Los_Angeles` | no | no | `config.ts:70` |
| `TEST_DATABASE_URL` | DB the integration tests **drop and recreate** | `postgres://localhost:5432/taskwatch_test` | never set in prod | **yes** (credentials) | `api.test.ts:9` |

`.env.example` lists every variable above except `UPLOAD_DIR`, `ENGINE_INTERVAL_MS`, `NIGHTLY_TZ`, `API_PORT` and `TEST_DATABASE_URL`, which exist only in code. [V-S] Adding them to `.env.example` (as commented names) is recommended when it is next edited.

## 2. Hard-coded values (not configurable today) [V-S]

| Value | Where | Related decision |
|---|---|---|
| Upload limit 15 MiB | `config.ts:65` (and the 413 text, `middleware.ts:79`) | D-13 |
| Dispatcher every 15 s | `config.ts:68` | — |
| Digest time zone `Asia/Kolkata` (Monday 09:00 IST) | `config.ts:69` | D-14 (decided: WO schedule) |
| Sender name "TaskWatch" | `config.ts:56` | WO |
| Session max age 12 h rolling | `app.ts:44` | AUTH-03, S-6 |
| JSON body limit 200 kb | `app.ts:29` | — |
| DB pool size 10 | `pool.ts:8` | — |

## 3. How values are loaded

| Run | Files loaded (Node `--env-file`) | Evidence |
|---|---|---|
| `npm run dev:server`, `db:*`, `npm test` | `../.env` if present | `server/package.json:7-13` |
| `npm start` | `server/production.env` (required), then `../.env` if present | `server/package.json:8` |

**Gap.** The WO says "no credentials in source code or config files; use a managed secrets store". `npm start` will still read a `.env` file if one is on the host. Production must inject secrets as process environment from the secrets store, and the host must have no `.env` (D-87 (decided)). [WO] See [DEPLOYMENT.md](DEPLOYMENT.md).

## 4. Rules
- Do not commit or share `.env`. Do not paste values into tickets, docs or chat ([guardrail G-4](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)).
- A new variable is added in three places in one change: `config.ts`, `.env.example` (name and a comment, no real value), and this table.
- Rotation: [RUNBOOK.md §6](RUNBOOK.md).
