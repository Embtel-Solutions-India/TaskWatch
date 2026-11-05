# Existing System Analysis

> **Snapshot date:** 2026-11-03.
>
> **Method:** I read all of `server/src`, `server/test` and `client/src` (except `styles.css`). Every fact below has a file:line reference, and anything marked *(inferred)* is not directly verified. Paths are relative to the repo root.
>
> **Snapshot note (2026-11-04):** this describes the code as of 2026-11-03. Since then T-1.11–T-1.14 and T-1.17 changed `server/src/http/{errors,middleware,rateLimit}.ts`, `services/{tasks,queries}.ts`, `routes/{tasks,recurring,auth}.ts`, `jobs/scheduler.ts`, `db/{migrate,pool}.ts`, `server/test/api.test.ts` and `client/vite.config.ts`. Line numbers into those files may be off by a few lines; the function or route named next to each reference is authoritative (KNOWN_ISSUES KI-11).
>
> **Not verified:** no server test, migration or app run was executed during discovery (see [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) D-18).

## 1. Repository layout

```
package.json        npm workspaces: server, client (Node ≥22; local machine has v24.14.1)
.env / .env.example configuration (.env is gitignored; never commit secrets)
server/             Express 5 + pg + zod API, built for the PREVIOUS frontend (deleted 2026-11-03)
client/             React 19 + Vite 8 + react-query 5 + react-router 7 prototype — runs on a localStorage mock
docs/               this documentation; docs/whatsapp-templates.md (Meta template definitions)
```

Not a git repository (as of 2026-11-03). Local PostgreSQL 18 service `postgresql-x64-18` is running.

Root scripts (`package.json`):

| Script | Runs |
|---|---|
| `dev` | client only |
| `dev:server` | API on :4000 |
| `build` | client build |
| `start` | server |
| `db:setup`, `db:migrate`, `db:seed` | database setup, migrations, seed data |
| `test` | server tests |
| `typecheck` | type-checks both workspaces |

**The README was partly stale** (old client layout, Mac setup). Refreshed 2026-11-06 (KI-9 closed).

## 2. Client (the functional reference)

### 2.1 Architecture

| Layer | Files | Role |
|---|---|---|
| Types | `client/src/types/index.ts` | Domain model: `Db`, `User`, `Task`, `Status`, `Permission` and others. **This is the target data model.** |
| Constants | `client/src/constants/index.ts` | Labels, role ranks, `DEFAULT_RULES`, categories |
| Authorization | `client/src/services/authz/permissions.ts` | `hasPerm`, `reportsOf`, `ancestorsOf`, `visibleUserIds`, `isOverseer`, `canViewTask`, `assignableUsers`, `canViewUser`, `wouldCreateLoop` |
| Workflow | `client/src/services/engine/workflow.ts` | `TRANSITIONS` (the state machine) and `allowedActions` (per-user action set) |
| Escalation math | `client/src/services/engine/escalation.ts` | `computeLevel`, `silenceThresholds`, `levelApplies`, `isQuietTime`. **This duplicates `server/src/engine/levels.ts`.** |
| Recurrence | `client/src/services/engine/recurrence.ts` | `occursOn`, `occurrencesBetween`, `describeRecurrence` (UTC days) |
| Core mutations | `client/src/services/core.ts` | `createTaskRecord`, `recordAssignment`, `notify`, `escalationRecipients`, `processEscalations`, `processRecurrences`, `runTicks` |
| Channels | `client/src/services/channels.ts` | Simulated email and WhatsApp dispatch, quiet hours, digest, `MANDATORY_TYPES` |
| Mock API | `client/src/services/api/{base,tasks,admin,misc,demo}.ts` | **The executable spec of every backend operation.** All functions are synchronous and throw `ApiError(status, message, fields?)`. |
| Store | `client/src/services/mock/{store,seed}.ts` | localStorage database, simulated clock, session |
| Hooks | `client/src/hooks/index.ts` | `useApi` (react-query) and `useAction` (mutation, toast, 422 field errors) add a fake latency of 120–340 ms |

### 2.2 Integration seam and how it leaks

- Pages are supposed to call `services/api/*` through `useApi` and `useAction`. Because these already wrap react-query, turning the API functions into `async fetch` calls is a contained change.
- **22 UI files import the mock store** (21 call `getDb()`, 1 only `now()`; grep 2026-11-03); `AdminPages.tsx` additionally imports the engine (`computeLevel`) without the store. Several also call engine/authz functions directly. Files (23 incl. AdminPages):
  `App.tsx`, `SearchPalette.tsx`, `Shell.tsx`, `AccountPages.tsx`, `AdminPages.tsx`, `AuditPage.tsx`, `DeliveryLogPage.tsx`, `AuthPages.tsx`, `DashboardPage.tsx`, `DemoBar.tsx`, `NotificationsPage.tsx`, `OrgPage.tsx`, `ReportsPages.tsx`, `StaffPages.tsx`, `TeamPage.tsx`, `CalendarPage.tsx`, `tasks/shared.tsx`, `TaskDetailPage.tsx`, `TaskDialogs.tsx`, `TaskFormPage.tsx`, `EscalationsPage.tsx`, `QueuePages.tsx`, `RecurringPage.tsx`.
  Details per page are in [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) under "Client-side logic that must move to / be enforced by the server".
- The escalation engine runs **in the browser**: `setInterval(tick, 30 s)` in `App.tsx:62-72`.
- `vite.config.ts` has no `/api` proxy.
- The only client test is the self-check script `client/src/selfcheck.ts`, run with `npx tsx client/src/selfcheck.ts`.

### 2.3 Mock API defects that must not be carried into the backend

- `getTask` returns `users: db.users`, the whole directory including emails and phone numbers (`services/api/tasks.ts:54`).
- Reset tokens are generated with `Math.random()` (`misc.ts:55`, `admin.ts:159`), and the password is a shared `DEMO_PASSWORD` (`misc.ts:12`).
- Dashboard and report widgets read the raw store without applying scope (see the FEATURE_INVENTORY final list, items 7 and 13).
- The org move is two calls with no transaction (`OrgPage.tsx:185-193`).

## 3. Server (existing; built for the previous frontend)

### 3.1 Stack and configuration

**Stack:** Express 5, `pg`, zod 4, `express-session` + `connect-pg-simple`, `helmet`, `luxon`, `multer`, `nodemailer`, `pdfkit`, `google-auth-library`, and `tsx` for running TypeScript. There is no ORM: raw parameterized SQL.

**Environment variables** (`server/src/config.ts`):

| Variable | Notes |
|---|---|
| `NODE_ENV` | |
| `PORT` / `API_PORT` | default 4000 |
| `APP_URL` | |
| `DATABASE_URL` | |
| `SESSION_SECRET` | required in production (`config.ts:19-21`). Otherwise a random value is generated per process. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` | |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_LANG` | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM_ADDRESS` | |
| `ALLOW_DEV_LOGIN`, `DEMO_TOOLS` | forced off in production |
| `UPLOAD_DIR` | default `server/uploads` |
| `ENGINE_INTERVAL_MS` | default 60000 |
| `NIGHTLY_TZ` | default America/Los_Angeles |
| `TEST_DATABASE_URL` | |

Hard-coded values: upload limit 15 MiB, dispatcher interval 15 s, digest time zone `Asia/Kolkata`, sender name "TaskWatch".

**No secrets were found in `server/`.** `server/src/db/seed.ts:45` contains one real-domain email address. It is not a credential, but it can be impersonated through dev login.

### 3.2 Database (`server/src/db/migrations/001_init.sql`, the only migration; runner `migrate.ts`)

Enums are stored as text columns with CHECK constraints. All timestamps are `timestamptz`.

| Table | Purpose and key constraints |
|---|---|
| `entities` | BAIS, USAIS and so on (`id text`, `name`, `sort`) |
| `users` | `roles text[]` (CHECK ⊆ ceo/cos/manager/lead/staff, at least one), `entity_id`, `manager_id` (self-reference), `time_zone` (default Asia/Kolkata), `whatsapp_opt_in`, `active`, `archived_at`. The email UNIQUE constraint is case-sensitive. |
| `tasks` | status open/in_progress/blocked/done; priority critical/high/normal/low; `level` −1..3; `clock_started_at`, `last_update_at`, `original_due_at`, `lead_extension_used`, `blocked_reason`, `recurring_id`; `log_seq` and `log_head` (hash-chain head) |
| `assignments` | history of assignees per task, including `first_update_at` |
| `activity_log` | append-only (triggers reject UPDATE, DELETE and TRUNCATE). `unique(task_id, seq)`. `prev_hash` and `hash` hold a per-task SHA-256 chain. `kind` is one of: created, update, comment, status, due_change, reassign, escalation, deescalation, ack. |
| `attachments` | `sha256`, `storage_key`; linked to a log row |
| `escalations`, `escalation_recipients` | level 0–3; reason silence/overdue; unique active (task, level); ack note, `snooze_until`; recipients are to/cc |
| `notifications` | one row per channel (inapp/whatsapp/email); status is one of pending, held, sending, sent, simulated, failed, skipped; `send_after`, `attempts`, `template_params` |
| `sla_rules` | `scope` is `'default'` or an entity id; config stored as jsonb (per-entity overrides) |
| `admin_log` | append-only (triggers), **not** hash-chained |
| `chain_checks`, `job_runs`, `app_state`, `"session"` | integrity check results, job dedupe, demo clock offset, sessions |

### 3.3 HTTP API (all under `/api`; `server/src/app.ts:62`)

Middleware order: `helmet` → JSON body (200 kb) → session → `csrfGuard`. The CSRF guard requires the header `x-taskwatch: 1` on non-GET requests. Every router except auth runs `requireUser`. Errors are returned as `{error}`.

| Area | Endpoints (file) |
|---|---|
| Auth (`routes/auth.ts`) | `GET /auth/config` · `GET /auth/google` · `GET /auth/google/callback` (state, nonce, `email_verified`, domain allow-list, existing active user only, session regenerate) · `GET /auth/dev-users` and `POST /auth/dev-login` (non-production only) · `POST /auth/logout` · `GET /me` (user, `can{assign, editRules, editDirectory, seeAudit, seeAllOutbox}`, integrations, demo offset, server time) |
| Tasks (`routes/tasks.ts`) | `GET /tasks/summary` · `GET /tasks?view=open\|mine\|escalated\|red\|blocked\|closed&entity&q` (capped at 500) · `POST /tasks` (title 3–200, entityId, assigneeId, priority, dueLocal in the actor's zone, instructions ≤5000) · `GET /tasks/:id` (includes permissions, log, escalations, attachments, assignments, chain verification) · `POST /tasks/:id/updates` (multipart: one file, body, optional status) · `POST /tasks/:id/comments` · `POST /tasks/:id/due` · `POST /tasks/:id/reassign` · `POST /tasks/:id/status` (done/open) · `GET /tasks/:id/attachments/:aid` · `POST /escalations/:id/ack` (with note) |
| People (`routes/people.ts`) | `GET /entities` · `GET /users/assignable` · `GET /people` (cos and ceo) · `POST /people` · `PUT /people/:id` · `POST /people/:id/active` (all cos) |
| Rules (`routes/rules.ts`) | `GET /rules` (defaults, per-entity overrides, history) · `PUT /rules/:scope` · `DELETE /rules/:scope` (reset an override; cos) |
| Notifications (`routes/notifications.ts`) | `GET /notifications` (latest 40 in-app) · `POST /notifications/read` · `GET /outbox` (own rows; cos sees all) |
| Dashboard (`routes/dashboard.ts`) | `GET /dashboard?days=7\|30\|90` (accountability by entity and by person) · `/dashboard/export.csv` · `/dashboard/export.pdf` |
| Recurring (`routes/recurring.ts`) | `GET /recurring` · `POST /recurring` · `POST /recurring/:id/active` (no edit or delete) |
| Admin (`routes/admin.ts`) | `GET /admin/audit` · `POST /admin/chain-check` · `POST /admin/engine` · `POST /admin/digest` · `POST /dev/clock` (demo only) |

### 3.4 Authorization (`server/src/services/access.ts`)

- **Hard-coded by role.** There is no permission table.
- The Founder's Office (`ceo` or `cos`) sees everything.
- Everyone else sees tasks where the assignee is in their scope (themselves plus all transitive reports) or where they are the assigner.
- `relation()` returns `'cos'`, `'manager'`, `'lead'` or null. The CEO gets null, so the CEO is read-only on tasks.
- Task permissions:

  | Permission | Rule |
  |---|---|
  | `postUpdate` | assignee only |
  | `comment` | non-assignees only |
  | `extendDue` | cos, manager, or lead if `lead_extension_used` is false |
  | `reassign`, `close` | cos or manager |
  | `reopen` | cos, manager or assigner |

### 3.5 Background jobs (`server/src/jobs/scheduler.ts`)

| Job | Interval / trigger | Notes |
|---|---|---|
| engine | 60 s | |
| dispatcher | 15 s | |
| recurring | 60 s | |
| weekly digest | Monday from 09:00 IST | deduplicated through `job_runs` |
| hash-chain check | nightly at 02:00 `NIGHTLY_TZ` | deduplicated through `job_runs` |

Each job has a per-process busy flag. **There is no cross-instance leader election.**

### 3.6 Engine, notify, other services (keep these)

- **Ladder** (`engine/levels.ts`): silence thresholds = window × multiples; overdue offsets; highest level wins; `levelApplies`; `next`; quiet hours with wrap-around.
- **Routing** (`engine/routing.ts`):

  | Level | To | cc |
  |---|---|---|
  | L0 | assignee | — |
  | L1 | lead, else manager, else Founder's Office | assignee |
  | L2 | manager, else Founder's Office | lead, assignee |
  | L3 | CoS, plus the CEO if D7 | manager |

  Lookups skip inactive people and stop at a higher role.
- **Engine** (`engine/engine.ts`): runs in a transaction per task under a row lock; clears levels, fires escalations, sends repeats every `repeatAfterWindows × window` unless snoozed.
- **Notify** (`notify/*`):
  - Writes in-app, email and WhatsApp rows. WhatsApp is skipped when there is no phone number or no opt-in.
  - Quiet hours hold L0, L1 and blocked alerts.
  - Dispatcher: up to 3 attempts with a linear 5-minute backoff. Channels without credentials are marked "simulated".
  - Templates: `notify/messages.ts`.
- **Activity log** (`services/activity.ts`):
  - Row hash = `sha256(prevHash + "\n" + canonicalJSON(row))`.
  - `verifyChains` runs nightly, on demand, and on **every** `GET /tasks/:id`.
- **Sensitive-ID guard** (`services/sensitive.ts:4-11`): catches A-numbers, SSNs, USCIS receipt numbers, passport numbers and I-94 numbers. Applied to task text, updates, comments and reasons.
- **Exports** (`services/exports.ts`): CSV with a formula-injection guard, and PDF via pdfkit.
- **Recurring** (`services/recurring.ts`): next run computed in the assignee's time zone; missed runs are not backfilled.

### 3.7 Tests (`server/test`)

The README claims 38 tests. **None were executed during discovery.**

- **`rules.test.ts`** is pure and needs no database. It covers the ladder per priority, past-due levels, quiet-hour boundaries, routing, and the D7 switch.
- **`api.test.ts`** needs Postgres and **runs `drop schema public cascade` on `TEST_DATABASE_URL`** (default `taskwatch_test`). It covers:
  - the CSRF header check
  - cross-team visibility through the API
  - assignee-only updates
  - the sensitive-ID guard
  - log immutability and hash-break detection
  - the Critical 4/6/8/12 h ladder
  - past-due levels
  - blocked status alerting the lead
  - lead extending a due date once
  - acknowledgement pausing repeat alerts
  - reassignment restarting the clock
  - IST and PT time handling
  - quiet hours
  - dashboard counts matching a manual count, and CSV/PDF export
  - weekly recurrence
- **Not covered:**
  - Google OAuth
  - people CRUD
  - the rules endpoints
  - uploads and downloads
  - the outbox
  - the digest
  - dispatcher retries
  - the dev clock

### 3.8 Security observations (server)

| # | Finding | Ref |
|---|---|---|
| S-1 | No rate limiting anywhere. **Partly fixed 2026-11-04 (T-1.13):** uploads and the Google callback are limited; sign-in, reset and search follow with their endpoints. | `package.json` |
| S-2 | Outside production, dev login can impersonate any user, and the user list is unauthenticated | `auth.ts:79-98`, `config.ts:60` |
| S-3 | CSRF protection is one static header plus SameSite=lax. It is safe only while CORS stays off. | `middleware.ts:48-55` |
| S-4 | The upload is written to disk before validation and authorization, which leaves orphan files on failure. Any signed-in user can upload up to 15 MB to any task id. | `routes/tasks.ts:77-95` |
| S-5 | No MIME or extension allow-list; the client-supplied MIME type is echoed back | `tasks.ts:89,137` |
| S-6 | The cookie's `secure` flag is derived from `APP_URL`. There is no absolute session lifetime, and logout does not clear the cookie. | `app.ts:43`, `auth.ts:100` |
| S-7 | A 30 s per-process directory cache means revoking a user is delayed and does not apply across instances | `directory.ts:111` |
| S-8 | A duplicate email or an unknown entity id causes a 500 instead of a 400/422. **Fixed 2026-11-04 (T-1.11):** 409/422 mapping in `errorHandler`. | `people.ts:97,123`, `recurring.ts:66` |
| S-9 | A CoS can remove the last remaining `cos` role. Role changes don't affect live sessions. | `people.ts:114-148` |
| S-10 | No audit trail for recurring toggles, logins or logouts | `recurring.ts:75` |
| S-11 | The hash chain has no HMAC or external anchor, so someone with database write access can rebuild a consistent chain. `admin_log` is not chained. **Partly fixed 2026-11-04 (T-1.9):** `admin_log` is now chained and checked nightly. An external anchor or HMAC is still a proposal (SECURITY_ARCHITECTURE §9). | `activity.ts` *(inferred)* |
| S-12 | The sensitive-ID guard is not applied to filenames, people fields or rule notes | `sensitive.ts` |
| S-13 | The CSV guard misses leading tab and CR characters | `exports.ts:9-10` |
| S-14 | Dispatcher rows stuck in `sending` are never retried | `dispatcher.ts:41-46` |
| S-15 | The scheduler runs in every instance. **Fixed 2026-11-04 (T-1.17):** advisory-lock leader. | `scheduler.ts:67` |
| S-16 | The outbox returns raw addresses and provider errors | `notifications.ts:65` |
| S-17 | No pagination; hard caps of 500/40/500 rows | `queries.ts`, `notifications.ts` |

## 4. Client ↔ server model mismatch

See [FEATURE_GAP_ANALYSIS.md](FEATURE_GAP_ANALYSIS.md) §5.2 for the side-by-side table and [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) §7.1 for how each difference was decided.
