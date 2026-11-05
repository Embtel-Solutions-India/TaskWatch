# Security Architecture

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Findings S-1..S-17 are defined in [EXISTING_SYSTEM_ANALYSIS.md §3.8](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md); NFRs SEC-1..SEC-10 in [PRODUCT_REQUIREMENTS.md §4](../02-product-requirements/PRODUCT_REQUIREMENTS.md). Controls not already covered by an accepted ADR are **Proposed — needs approval**. No control described here has been implemented or tested.

Related: [ADR-0002](decisions/ADR-0002.md) · [ADR-0004](decisions/ADR-0004.md) · [ADR-0008](decisions/ADR-0008.md) · [API_CONTRACTS.md](API_CONTRACTS.md) · [DATABASE_DESIGN.md §3.11](DATABASE_DESIGN.md)

## 1. Authentication (ADR-0002)

### 1.1 Google Workspace OAuth (existing)
Authorization-code flow with `state` and `nonce` held in the session, ID-token verification against `GOOGLE_CLIENT_ID`, `email_verified` required, optional domain allow-list `GOOGLE_ALLOWED_DOMAINS`, user must exist and be active in the TaskWatch directory, session regenerated before `userId` is set [V-S `server/src/routes/auth.ts:33-76`]. Kept as is. Additions: record each callback outcome in `login_attempts` and successful sign-ins in `admin_log` (S-10). 2FA on this path = Workspace 2-Step Verification (D-21); the server cannot see it — D-64 (decided).

### 1.2 Email + password (new)
- **Hash:** `crypto.scrypt(password, salt16, 64, {N, r, p, maxmem})`, stored as `scrypt$N$r$p$salt$hash` in `user_credentials.password_hash`. Proposed parameters N = 2^17, r = 8, p = 1 (OWASP Password Storage Cheat Sheet) [A]; stored per hash so they can be raised. Compare with `crypto.timingSafeEqual`.
- **Policy:** ≥ 10 characters with letters and a number (AUTH-04, from [V-C `client/src/services/api/misc.ts:63-64`]).
- **Responses:** unknown email and wrong password give the same `401` and take similar time (always run scrypt, against a dummy hash for unknown emails). Inactive → `403` (AUTH-01).
- **Reset:** token = `crypto.randomBytes(32)` base64url, emailed as a link; DB stores `sha256(token)` only, 1 h expiry, single use (`used_at`); request endpoint always answers `{ok:true}`. On reset: all sessions of the user are deleted. Admin "reset access" (AUTH-05) emails the link; it is **never returned in the response** (the prototype returns it to the admin [V-C `client/src/services/api/admin.ts:155-165`]).

### 1.3 TOTP for `manager`, `cos`, `ceo` on the password path (D-21)
- RFC 6238: HMAC-SHA1 over the 30 s counter, 6 digits, accept the current step ±1; reject any step ≤ `totp_last_step` (replay). Implemented with `crypto.createHmac`; base32 for the `otpauth://` URI is ~15 lines, no dependency.
- Secret: 20 random bytes; stored as AES-256-GCM ciphertext (`iv ‖ tag ‖ ciphertext`) in `user_credentials.totp_secret_enc`. Key from env var **`TOTP_ENCRYPTION_KEY`** (32 bytes, base64) — *new env var name, Proposed — needs approval*; production loads it from the secrets store (§8).
- Flow: password OK → session `{pendingUserId, mfa:'required'|'enrol'}` (no `userId` yet) → `POST /api/auth/totp` → session regenerated → `userId` set. A pending session expires after 5 minutes [A].
- Applies when the user **currently** holds one of the three roles; granting such a role to a password user forces enrolment at next sign-in.
- Recovery when the device is lost: D-65 (decided).

### 1.4 Dev directory login (existing)
Allowed only when `!isProd` and (`no Google` or `ALLOW_DEV_LOGIN=true`) [V-S `server/src/config.ts:60`]. Hardening (S-2): require `NODE_ENV` to be `development` or `test` explicitly (not merely "not production") [A]; log each use in `login_attempts` (`method='dev'`).

## 2. Session

Existing: `express-session` + `connect-pg-simple`, cookie `tw.sid`, `httpOnly`, `sameSite: lax`, `secure` derived from `APP_URL`, rolling 12 h `maxAge` [V-S `server/src/app.ts:32-46`]; `SESSION_SECRET` required in production [V-S `config.ts:19-21`].

| Control | Design |
|---|---|
| Idle timeout (AUTH-03) | `settings.sessionTimeoutMinutes` (5–480). `requireUser` compares `session.lastSeenAt` with now; expired → destroy, `401 {error:"SESSION_EXPIRED"}`; otherwise sets `lastSeenAt` and `req.session.cookie.maxAge` to the idle timeout. |
| Absolute lifetime | `session.createdAt` set at sign-in; reject after **12 h** [A] (current cookie `maxAge` [V-S `app.ts:44`]); value to confirm — D-68 (decided). |
| Regenerate on login | Existing for Google and dev login [V-S `auth.ts:69, 95`]; also after password and after the TOTP step (SEC-6). |
| Logout | `req.session.destroy()` **and** `res.clearCookie('tw.sid', same options)` (S-6; today only destroy [V-S `auth.ts:100-102`]). |
| Revocation | Deactivation, password reset and role removal delete that user's rows from `"session"` (`sess->>'userId'`), in the same transaction (STAFF-03, S-9). |
| Cookie `secure` | `true` whenever `NODE_ENV=production`, independent of `APP_URL` (S-6); `trust proxy` stays on in production [V-S `app.ts:21`]. |

## 3. Authorization (ADR-0004)

- **Per-request identity, no stale cache (S-7).** `requireUser` reads the signed-in row (`id, active, roles, team_id, manager_id`) with one primary-key query per request instead of the 30 s per-process `getDirectory()` cache [V-S `server/src/services/directory.ts:111-119`, `http/middleware.ts:26-38`]. Effective permissions = union of `role_permissions` rows for `roles[]` (cos = all), loaded in the same request. *Proposed.*
- **Server-side, every request (C-2, SEC-1).** Route guards check permissions; services check `allowedActions` for task mutations [V-C `client/src/services/engine/workflow.ts:45-73`]. UI hiding is never the control.
- **Object level (IDOR/BOLA).** Every `:id` is loaded with the scope predicate; invisible → `404` (D-60 (decided)). Child objects are checked through their parent: comment → task, attachment → task (`a.task_id = :id` is already checked on download [V-S `routes/tasks.ts:129-135`]), extension → task, escalation → task, notification → `user_id = me`.
- **Scope queries.** Reporting-line scope computed in SQL with a recursive CTE over `users.manager_id` (cycle-safe), joined into list, report, dashboard and search queries; never "load all, filter in JS" (DASH-03, RPT-04). See [SCALABILITY_AND_RELIABILITY.md §4](SCALABILITY_AND_RELIABILITY.md).
- **Founder's Office.** `cos` all permissions and org-wide scope; `ceo` org-wide visibility, permissions from the matrix (read-only by default) [WO p.1] — D-70 (decided).
- **Mass assignment (SEC-7).** zod `.strict()` on every body; server-owned fields (`id`, `status`, timestamps, `createdBy`, `assignedBy`, `level`) are never accepted from input.
- **Invariants in the DB where possible:** last active `cos` check in a transaction with `for update` on `cos` users (S-9); reporting-loop check with the user row locked.

## 4. CSRF and CORS
- Keep the custom-header guard `x-taskwatch: 1` on non-GET requests [V-S `middleware.ts:48-55`] plus `SameSite=lax` (SEC-4). This is sound **only while no CORS is enabled** (S-3): a cross-site page cannot add custom headers without a CORS preflight that the server never answers.
- **CORS stays off**: no `cors` middleware, no `Access-Control-Allow-*` headers. Same-origin deployment (ADR-0008); in development Vite proxies `/api` (to be added to `client/vite.config.ts`).
- No state change on GET. The Google callback is a GET but is protected by `state`/`nonce` [V-S `auth.ts:54, 61`].

## 5. HTTP headers (SEC-5)
helmet defaults with CSP; `upgrade-insecure-requests` only on https [V-S `app.ts:23-28`]; `x-powered-by` off [V-S `app.ts:22`]. Additions: `Cache-Control: no-store` on `/api` responses; downloads keep `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` [V-S `routes/tasks.ts:138-139`]; inline preview only for the safe-type list in §7, with `Content-Security-Policy: sandbox` on the file response.

## 6. Rate limits (SEC-3, S-1) — no new dependency
| Surface | Limit [A] | Mechanism |
|---|---|---|
| `POST /api/auth/login`, `/auth/totp` | 5 failures / 15 min per email, 20 / 15 min per IP | count `login_attempts` rows (indexed) before verifying |
| `POST /api/auth/reset-request`, `/auth/reset` | 3 / hour per email, 10 / hour per IP | same table |
| `GET /api/search` | 60 / min per user | in-process fixed-window map |
| Uploads | 30 files / 10 min per user | in-process fixed-window map: **live 2026-11-04** (`server/src/routes/tasks.ts`, multipart only, before multer) |
| `GET /api/auth/google/callback` | 100 / 15 min per IP (generous: one office may share a NAT address) | in-process fixed-window map: **live 2026-11-04** (`server/src/routes/auth.ts`) |

Exceeded → `429` with `Retry-After`. The helper is `server/src/http/rateLimit.ts` (T-1.13). Sign-in, reset and search attach to it when their endpoints exist (T-2.1, T-2.x, T-8.4). The in-process counters are per instance — acceptable for the single-instance deployment assumed in [SCALABILITY_AND_RELIABILITY.md §1](SCALABILITY_AND_RELIABILITY.md); move them to a Postgres table if more instances are added.

## 7. Uploads (ATT-01..03, SEC-8, S-4, S-5)
Today: `multer.diskStorage` writes the file into `UPLOAD_DIR` before task authorization runs; the client MIME type is stored and echoed on download [V-S `routes/tasks.ts:20-27, 75-97, 137`; `config.ts:65`].

Target order (store-then-validate fix):
1. `requireUser` → load task → `canViewTask` (404) → `allowedActions` has `attach`/`progress`/`submit`/`comment` (403) → rate limit. **Only then** run multer.
2. multer writes to a temp sub-directory of `UPLOAD_DIR` with a random name; `limits.fileSize` = the agreed limit (15 MiB server vs 25 MB client [D-13, decided]), `files` ≤ 10 [A].
3. Validate: extension and sniffed magic bytes must both be on the allow-list; the stored `mime` is the **server-derived** type, never the client's. Proposed allow-list [A] (needs business confirmation — D-69 (decided)): PDF, PNG, JPEG, GIF, WebP, TXT, CSV, DOCX, XLSX, PPTX. Inline-safe: PNG, JPEG, GIF, WebP, PDF, TXT. Filename checked by the sensitive-ID guard (S-12) and length-capped.
4. SHA-256, then rename into place inside the DB transaction that inserts the row; any failure → unlink the temp file (the existing cleanup at `routes/tasks.ts:92-94` covers only the service call).
Orphan sweep: delete temp files older than 1 h on the recurring job tick (temp files are not evidence).

## 8. Secrets and PII
- **Secrets**: only env var names appear in code or docs: `SESSION_SECRET`, `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SMTP_USER`, `SMTP_PASS`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, proposed `TOTP_ENCRYPTION_KEY`, optional proposed `AUDIT_HMAC_KEY` (§9). WO: "no credentials in source code or config files; use a managed secrets store", applying FO-2026-CRM-01 WP-1 [WO p.5]. Production injects them as process env from the secrets store [D-73, decided].
- `npm start` loads `server/production.env` (`--env-file=production.env`) [V-S `server/package.json` "start"]. Its contents were not opened for this document. It must contain no credentials (WO rule); verify and, if needed, rotate (D-73).
- No secrets were found in `server/` during discovery; `seed.ts:45` holds one real-domain email (not a credential) [EXISTING_SYSTEM_ANALYSIS §3.1].
- **PII minimisation (SEC-9):**
  - Task detail returns only the people it references (`people` map), not the directory (prototype leak `users: db.users` [V-C `client/src/services/api/tasks.ts:54`]).
  - Delivery log `address` (email/phone) and provider errors: visible only with `view_audit_logs`, and one's own rows on `GET /api/me/deliveries` (S-16, DLV-01); provider error text truncated (500 chars today [V-S `notify/dispatcher.ts:73`]) and stripped of tokens/URLs.
  - Dev user list (`/auth/dev-users`) is unauthenticated (S-2): non-production only, returns `id, name, title, roles` (no email) [V-S `auth.ts:79-88`].
  - Request logs: method, path template, status, duration, user id — never bodies, cookies, tokens, emails or phone numbers.
- **Client data rule** [WO p.5]: sensitive-ID guard (C-6) [V-S `server/src/services/sensitive.ts`] on all free text including filenames, people fields and rule notes (S-12).

## 9. Audit and tamper evidence (S-11)
Existing: per-task SHA-256 chain on `activity_log`, append-only triggers, nightly verification at 02:00 `NIGHTLY_TZ` that alerts every CoS, results in `chain_checks` [V-S `services/activity.ts:42-156`, `jobs/scheduler.ts:16-48`, `001_init.sql:104-112, 200-208`].
Gap: anyone with DB write access can drop the trigger and rebuild a consistent chain; `admin_log` is not chained [S-11]. **Update 2026-11-04 (T-1.9):** `admin_log` is chained (option A), with a trigger that refuses unchained rows. The external anchor and HMAC options remain proposals.

| Option | Protects against | Cost | Recommendation |
|---|---|---|---|
| A. Chain `admin_log` (global chain, same `hashRow`) | silent edit/delete of admin rows by someone without the ability to recompute | small; [DATABASE_DESIGN.md §3.10](DATABASE_DESIGN.md) | **Proposed** — do it |
| B. External anchor: the nightly job emails the CoS a digest = `sha256` of all chain heads (`tasks.log_head` + `admin_log` head) and stores it in `chain_checks` | a DB-level rewrite after the anchor date becomes detectable by comparing with the emailed value | ~20 lines, uses the existing notify path | **Proposed** — do it |
| C. HMAC rows with `AUDIT_HMAC_KEY` from the secrets store | rewrite by a DB-only attacker without the key | key management; all existing hashes stay SHA-256 (cannot be rewritten), so needs a per-row algorithm marker | Optional; only if the WO sign-off requires more than A+B |
| D. Separate DB role: the app user lacks `ALTER`/`DROP TRIGGER` (migrations run with an owner role) | dropping triggers through the app's credentials | ops change | **Proposed** — cheap, pair with A |

## 10. Findings and defects → required controls

| Finding | Control | Where |
|---|---|---|
| S-1 no rate limiting | §6 limits on sign-in, reset, TOTP, search, uploads. **Uploads + Google callback live (T-1.13)**; the rest with their endpoints | ADR-0002 |
| S-2 dev login impersonation, unauthenticated user list | §1.4: explicit dev/test env only; minimal fields; logged; never in production (existing `config.ts:60`) | — |
| S-3 CSRF = static header + lax | keep; CORS permanently off; same origin (§4) | ADR-0008 |
| S-4 upload stored before validation/authz; any user can upload to any task | §7 order: authorize → store temp → validate → move; cleanup | — |
| S-5 no MIME/extension allow-list; client MIME echoed | §7 allow-list + magic bytes; server-derived MIME | [D-13, decided], D-69 |
| S-6 `secure` from `APP_URL`; no absolute lifetime; logout keeps cookie | §2 | D-68 |
| S-7 30 s directory cache delays revocation | §3 per-request user read; sessions deleted on deactivate | — |
| S-8 duplicate email / unknown entity → 500 | map `23505`/`23503` to `409`/`422`: **live (T-1.11)**; case-insensitive unique index still planned (migration) | [DATABASE_DESIGN.md §3.2](DATABASE_DESIGN.md) |
| S-9 last `cos` removable; role changes don't reach live sessions | locked last-cos check (409); permissions read per request; sessions deleted on role removal | ADR-0004 |
| S-10 no audit of recurring toggles, logins, logouts | `admin_log` rows for recurrence create/edit/toggle/delete, sign-in, sign-out, failed MFA, reset | — |
| S-11 chain without HMAC/anchor; `admin_log` unchained | §9 A + B + D | A live (T-1.9); B, D proposed |
| S-12 sensitive guard misses filenames, people fields, rule notes | apply `findSensitiveId` to every free-text input | C-6 |
| S-13 CSV guard misses leading TAB/CR | prefix `'` when the first char is any of `= + - @ \t \r` [V-S `services/exports.ts:9-10`] | RPT-03 |
| S-14 rows stuck in `sending` | lease via `send_after` | [SCALABILITY_AND_RELIABILITY.md §3](SCALABILITY_AND_RELIABILITY.md) |
| S-15 scheduler in every instance | advisory-lock leader: **live (T-1.17)** | [SCALABILITY_AND_RELIABILITY.md §2](SCALABILITY_AND_RELIABILITY.md) |
| S-16 outbox returns raw addresses, provider errors | §8 PII rules | DLV-01 |
| S-17 no pagination, hard caps | scoped + capped lists with `truncated` | ADR-0009 (proposed) |
| Client: `getTask` returns the whole directory [V-C `api/tasks.ts:54`] | `people` map of referenced users only | TASK-05 |
| Client: `Math.random()` reset tokens [V-C `misc.ts:55`, `admin.ts:159`]; shared `DEMO_PASSWORD` [V-C `misc.ts:12`] | §1.2 `randomBytes`, hashed storage, per-user scrypt passwords | ADR-0002 |
| Client: admin sees reset token [V-C `admin.ts:155-165`] | emailed only | AUTH-05 |
| Client: dashboard/report widgets unscoped [V-C `DashboardPage.tsx:107-119`, `ReportsPages.tsx:85-111` per PRD] | server-computed payloads over scoped SQL | DASH-03, RPT-04 |
| Client: demo bar for everyone [V-C `Shell.tsx:126` per PRD] | dev endpoints 404 in production; UI hidden unless `me.demo` | [D-17, decided] |
| Client: org move = two calls, no transaction [V-C `OrgPage.tsx:185-193`] | single `PUT /api/people/:id/placement` in one transaction | ORG-02 |
| Client: engine and session timeout enforced in the browser [V-C `App.tsx:20-34, 62-72` per PRD] | server scheduler; server idle timeout (§2) | ESC-08, AUTH-03 |
| Client: invisible task → 403 reveals existence [V-C `permissions.ts:85`] | 404 | D-60 |

## 11. Validation and errors
zod at every boundary, `.strict()`, field errors → `422 {error, fields}` (C-3; today `400` single message [V-S `middleware.ts:73-77`]); DB constraint errors mapped to 409/422, never 500; no stack traces in responses (existing handler logs server-side only [V-S `middleware.ts:82-83`]).

## 12. Open items

> Authoritative list with defaults: [OPEN_QUESTIONS §8](../01-discovery/OPEN_QUESTIONS.md).
D-60 (decided), D-64, D-65, D-68, D-69, D-70, D-73, D-75 — question texts in [SYSTEM_ARCHITECTURE.md §7](SYSTEM_ARCHITECTURE.md#7-proposed-new-questions-d-60) (not yet added to OPEN_QUESTIONS.md). Still open from discovery: [D-13, decided], [D-16, decided], [D-17, decided].
