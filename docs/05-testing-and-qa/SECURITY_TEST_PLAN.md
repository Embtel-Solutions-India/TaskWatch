# Security Test Plan

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Findings S-1…S-17 are defined in [EXISTING_SYSTEM_ANALYSIS §3.8](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md). NFR SEC-1…SEC-10 are in [PRD §4](../02-product-requirements/PRODUCT_REQUIREMENTS.md). Test IDs refer to [TEST_CASE_INVENTORY.md](TEST_CASE_INVENTORY.md).
> **Status of every item: planned or "existing test, not run". Nothing here has been executed.**

## 1. Method

- **Automated** checks are integration tests through real HTTP against the isolated test DB ([TESTING_STRATEGY.md §2](TESTING_STRATEGY.md)), so they can run in CI and before every release.
- **Manual** checks are run once per release from [RELEASE_READINESS.md](RELEASE_READINESS.md) and recorded with date and tester.
- Tests run against `NODE_ENV=test` unless the item says production config. A production-config test boots `createApp()` with `NODE_ENV=production` and a dummy `SESSION_SECRET` (required by `config.ts:19-21`). [V-S]

## 2. Authentication, 2FA and session

| # | Check | Expected | Maps to | Test |
|---|---|---|---|---|
| SA-1 | Google callback: bad `state`/nonce, unverified email, wrong domain, unknown or archived user | Refused, no session | AUTH-01 | TC-AUTH-01-01…03 |
| SA-2 | Session id changes on sign-in (fixation) | New `tw.sid` value after login | SEC-6 [V-S] `auth.ts:69,95` | TC-AUTH-01-03 |
| SA-3 | Password sign-in gives no user enumeration (body and timing) | Same 401 for wrong password and unknown email | AUTH-01, D-2 | TC-AUTH-01-04 |
| SA-4 | **TOTP required** for anyone holding manager, cos or ceo, at password sign-in; replayed code refused; codes outside ±1 step refused [A] | No session without a valid code | WO "2FA", D-21 | TC-AUTH-01-06 |
| SA-5 | Google sign-ins of those roles have Workspace 2-Step Verification enforced | Evidence from the Workspace admin console (manual) | WO "2FA", D-21, D-89 | RELEASE_READINESS R-S4 |
| SA-6 | Brute-force throttling on sign-in, TOTP and reset | 429 after the threshold (D-82) | SEC-3, **S-1** | TC-AUTH-01-07 |
| SA-7 | Logout destroys the server session **and** clears the cookie | `Set-Cookie: tw.sid=; Expires=past` | AUTH-02, **S-6** [V-S] `auth.ts:101` | TC-AUTH-02-01 |
| SA-8 | Cookie flags in production: `HttpOnly`, `SameSite=Lax`, `Secure` | `Secure` present when served over HTTPS. Today it depends on `APP_URL` starting with `https://` (`app.ts:43`) | **S-6** | manual, production config |
| SA-9 | Idle timeout and absolute lifetime | 401 `SESSION_EXPIRED` after idle; forced re-login after the absolute cap [A] | AUTH-03, **S-6** | TC-AUTH-03-01/02 |
| SA-10 | Deactivated user loses access on the next request, on every instance | 401 at once. Today a 30 s per-process directory cache delays this (`directory.ts:111`) | STAFF-03, **S-7** | TC-STAFF-03-01 |
| SA-11 | Role change affects live sessions on the next request | New permissions enforced without re-login | ROLE-02, **S-9** | TC-AUTH-06-02 |
| SA-12 | Reset tokens: `crypto.randomBytes`, single use, 1 h expiry, stored hashed [A] | As stated | AUTH-04, D-2 | TC-AUTH-04-02 |
| SA-13 | Dev login and dev user list are unreachable in production | 404 | SEC-10, **S-2** [V-S] `auth.ts:79-98`, `config.ts:60` | TC-AUTH-01-08 |

### 2a. Auth security review, 2026-11-04 (code review of the Auth phase after D-94)
- **SA-4 is void under D-94** (no 2FA). It stays as a work order deviation for the Founder's Office to sign off ([RELEASE_READINESS](RELEASE_READINESS.md)).
- **SA-13 fixed:** dev login was on whenever `NODE_ENV` was not `production` and Google was off, so a misconfigured deployment would allow "sign in as anyone". It is now opt-in (`ALLOW_DEV_LOGIN=true`) and never in production (`config.ts` `devLoginAllowed`, `config.test.ts`).
- **SA-6 fixed:** the `login_attempts` throttle counts before hashing and records after, so a parallel burst passed it in full. In-memory caps now run first: sign-in 60/min per IP and 10 per 15 min per email; forgot and reset 10/min per IP (`routes/auth.ts`). The per-IP sign-in cap is 60, not the planned 30, because of shared office NAT. Test: "SA-6: a parallel burst…" in `api.test.ts`.
- **SA-3 (forgot) fixed:** forgot no longer awaits the token write and the email send, which made known emails measurably slower (`passwordReset.ts` `requestReset`).
- Checked and passing on review: SA-2, SA-3 (sign-in, with a decoy hash), SA-7, SA-9, SA-10, SA-12, SC-1/2, Google `state`/`nonce`/verified-email/domain checks, no raw HTML rendering, the Google client secret is redacted by gaxios in error logs.
- Open: D-98 (reset-access scope), D-99 (email change takeover), KI-19, KI-20.

## 3. IDOR / BOLA: every `:id` resource

Each row: one in-scope positive and one out-of-scope negative call, as StaffA1 against an EMB object (and MgrA where relevant). Expected negative: 403 or 404 per D-81, with no object data in the body. [WO "Access control enforced on the server for every request"] · SEC-1 · **AC-6**

| Route [V-S] | Object check today | Test |
|---|---|---|
| `GET /api/tasks/:id` | `canView` → 403 (`queries.ts:162`) | TC-TASK-05-01 (existing, not run) |
| `POST /api/tasks/:id/updates` | assignee only; **file written to disk before the check** (S-4) | TC-WF-03-02 (existing, not run), TC-ATT-01-01 |
| `POST /api/tasks/:id/comments` | `taskPermissions.comment` | TC-CMT-01-02 (existing, not run) |
| `POST /api/tasks/:id/due` | `extendDue` | TC-EXT-02-04 |
| `POST /api/tasks/:id/reassign` | cos or manager; new assignee in scope | TC-WF-07-01 (existing, not run) |
| `POST /api/tasks/:id/status` | close/reopen permission | TC-WF-05-01, TC-WF-09-01 |
| `GET /api/tasks/:id/attachments/:aid` | `canView` and `a.task_id = :id` → 404 (`routes/tasks.ts:129-135`) | TC-ATT-02-01 |
| `POST /api/escalations/:id/ack` | must be a recipient (D-84) | TC-ESC-06-02 (existing, not run) |
| `PUT /api/people/:id`, `POST /api/people/:id/active` | `requireRole('cos')` | TC-STAFF-02-04 |
| `POST /api/recurring/:id/active` | owner or cos (`recurring.ts:74`) | TC-REC-03-01 |
| `PUT` / `DELETE /api/rules/:scope` | `requireRole('cos')`; scope must exist | TC-POL-01-02/04 |
| Future: extensions, reviews, comment edit/delete, schedule edit, staff profile, search | per PRD | TC-EXT-02-01, TC-WF-06-01, TC-CMT-02/03, TC-REC-02-02, TC-STAFF-04-01, TC-SRCH-01-01 |

A route-sweep test (TC-SEC1-01) enumerates the router so that a new `:id` route without a negative test fails the build. [A]

## 4. Privilege escalation

| # | Check | Expected | Maps to | Test |
|---|---|---|---|---|
| SP-1 | Non-CoS edits people, roles, rules | 403 | STAFF-02, ROLE-02, POL-01 | TC-STAFF-02-04, TC-ROLE-02-01, TC-POL-01-02 |
| SP-2 | A user changes their own role | 403 | STAFF-02 | TC-STAFF-02-03 |
| SP-3 | The last active CoS loses the role or is archived | Refused (409) | **S-9**, STAFF-02/03 | TC-STAFF-02-03, TC-STAFF-03-03 |
| SP-4 | The CoS column of the permission matrix is edited | 403 | ROLE-02 | TC-ROLE-02-01 |
| SP-5 | Mass assignment: extra fields (`roles`, `active`, `assignerId`, `createdAt`) in any body | Rejected (SEC-7) | SEC-7, C-4 | TC-TASK-01-08 |
| SP-6 | Lead uses a second extension; lead reassigns; staff assigns to a peer | 403 each | WO FR-5/FR-6 | TC-EXT-02-02, TC-WF-07-01, TC-TASK-01-02 (existing, not run) |
| SP-7 | CEO is read-only by default (`relation()` returns null) | Mutations on tasks refused for a CEO with no other role | WO roles table [V-S] `access.ts` | planned |
| SP-8 | Demo clock used by a non-CoS, or in production | 403 / 404 | SEC-10, D-17 | TC-DEMO-01-01/02 |
| SP-9 | Manual digest by a manager (allowed today, `admin.ts:47`) | Per D-93 | NTF-05 | TC-NTF-05-02 |

## 5. Scope isolation (AC-6)

TC-TASK-04-01/02, TC-TASK-05-01, TC-DASH-03-01/02, TC-RPT-03-03, TC-RPT-04-01, TC-SRCH-01-01, TC-STAFF-01-01. The rule is in [WO "Users, roles and visibility"]: each person sees only work they own, assigned or supervise; the Founder's Office sees everything. **It must be proven through the API, not the screen.** [WO AC-6] Every aggregate (dashboard, reports, digest, exports, filter option lists, search) is in scope of this section (DASH-03, RPT-04).

## 6. CSRF and CORS

| # | Check | Expected | Maps to | Test |
|---|---|---|---|---|
| SC-1 | Non-GET without `x-taskwatch: 1` | 403 | SEC-4, **S-3** | TC-SEC4-01 (existing, not run) |
| SC-2 | No `Access-Control-Allow-Origin` on any response; preflight from another origin is not granted | No CORS headers | **S-3** | planned |
| SC-3 | Every state-changing route is non-GET (no GET with side effects) | Route sweep | SEC-4 | planned |
| SC-4 | Multipart upload route also requires the header | 403 without it | **S-3**, S-4 | planned |

## 7. Rate limits

None exist today (**S-1**). Planned limits (values are [A], for approval): sign-in 10/min per account and 30/min per IP; TOTP 5 per login attempt; reset 5/hour per email; search 60/min per user; uploads 30/hour per user. Tests: TC-AUTH-01-07, TC-SRCH-01-02, plus one upload case. Status 429 (D-82).

## 8. Upload abuse

| # | Check | Expected | Maps to |
|---|---|---|---|
| SU-1 | Unauthorized upload leaves no file on disk | No new file in `UPLOAD_DIR` | **S-4** |
| SU-2 | Oversize file | 413; temp file removed | D-13 |
| SU-3 | Disallowed type or spoofed MIME (HTML with `image/png`) | 422; stored MIME derived on the server, not echoed from the client | **S-5**, SEC-8 |
| SU-4 | Path traversal in the file name (`../../x`) | Stored under a random UUID; `Content-Disposition` encoded | [V-S] `routes/tasks.ts:24,139` |
| SU-5 | Sensitive ID in a file name | 422 | **S-12** |
| SU-6 | Download headers | `attachment`, `nosniff` | ATT-02 [V-S] `routes/tasks.ts:137-139` |

## 9. Injection

| # | Check | Expected | Maps to |
|---|---|---|---|
| SI-1 | SQL metacharacters in `q`, `entity`, titles, names | Treated as data; no 500 | Parameterized SQL ([CODING_STANDARDS §3](../04-engineering-standards/CODING_STANDARDS.md)) |
| SI-2 | Grep the server for template-literal SQL that interpolates a non-placeholder value | None outside `visibilityFilter`-style placeholders | review |
| SI-3 | HTML/script in task text rendered in the UI, email and PDF | Escaped in every channel | SEC-5 |
| SI-4 | WhatsApp template parameters with newlines or very long values | Sanitised or truncated to Meta limits [A] | NTF-02 |
| SI-5 | Sensitive-ID guard on every free-text field: task text, updates, comments, reasons, notes, people fields, rule notes, file names | 422 | C-6, **S-12** |

## 10. CSV injection

`csvCell` neutralises `= + - @` but not leading tab or CR (`exports.ts:9`). [V-S] **S-13**. Test: TC-RPT-03-02 (unit), plus every CSV export (dashboard, reports, audit) using the one helper (no second CSV writer, guardrail G-5).

## 11. Log immutability and tamper evidence (AC-7)

| # | Check | Expected | Test |
|---|---|---|---|
| SL-1 | No endpoint edits or deletes a log row | 404 or no effect | TC-AUD-01-01 (existing, not run), TC-AUD-01-03 |
| SL-2 | DB triggers reject UPDATE, DELETE, TRUNCATE on `activity_log` and `admin_log` | "append-only" error | TC-AUD-01-01 (existing, not run) |
| SL-3 | Direct alteration (triggers bypassed) is detected by the chain check; CoS alerted | `ok=false`, `chain_break` notification | TC-AUD-01-02 (existing, not run) |
| SL-4 | Nightly check runs once per day | one `chain_checks` row per local day | TC-AUD-01-04 |
| SL-5 | Known limit: a DB writer can rebuild a consistent chain (no HMAC or anchor); `admin_log` is not chained | Documented risk until decided | **S-11** |
| SL-6 | Missing audit events: recurring toggles, logins, logouts | Audit rows exist | **S-10** |

## 12. Data exposure

| # | Check | Maps to |
|---|---|---|
| SD-1 | Task detail returns only referenced people (no directory dump) | TASK-05, SEC-9 · TC-TASK-05-02 |
| SD-2 | Outbox / delivery log hides addresses and provider errors from unauthorised roles | **S-16**, DLV-01 · TC-DLV-01-01 |
| SD-3 | Error responses contain no stack, SQL or constraint names | [ERROR_HANDLING.md](../04-engineering-standards/ERROR_HANDLING.md) · TC-C3-01 |
| SD-4 | Lists capped or paginated | **S-17**, D-10 · TC-TASK-04-04 |
| SD-5 | Server logs carry no PII or secrets | manual log review per release |

## 13. Jobs and availability

| # | Check | Maps to |
|---|---|---|
| SJ-1 | Rows stuck in `sending` are recovered | **S-14** · TC-NTF-02-04 |
| SJ-2 | Two instances do not double-run jobs | **S-15** · TC-ESC-08-03 |

## 14. Secrets scan

- Search the repo (excluding `node_modules`, `.env`, `server/production.env`) for token-shaped strings, `password=`, `secret`, `BEGIN PRIVATE KEY`, and real-domain emails. Expected: only env var **names**. Known item: `seed.ts:45` real-domain email (not a credential). [V-S]
- Confirm `.env` is git-ignored (`.gitignore`). [V-S]
- Production: confirm no `.env` file on the host and that the start command does not load one (D-87).
- Tool: plain `grep` (no new dependency). A dedicated scanner is *Proposed — needs approval*.

## 15. Dependency audit (planned)

- `npm audit --omit=dev` and `npm audit` at the repo root (workspaces). Report only; **do not** run `npm audit fix` without approval ([AI_AGENT_GUARDRAILS §2.6](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)).
- Gate: no high or critical advisory in runtime dependencies at release, or a written risk acceptance. [A]
- Status: **planned, not run.**

## 16. Traceability S-1…S-17

| Finding | Covered by |
|---|---|
| S-1 rate limiting | §7, SA-6 |
| S-2 dev login | SA-13 |
| S-3 CSRF/CORS | §6 |
| S-4 upload before authz | §8 SU-1, TC-ATT-01-01 |
| S-5 MIME allowlist | SU-3 |
| S-6 cookie / lifetime / logout | SA-7, SA-8, SA-9 |
| S-7 directory cache | SA-10 |
| S-8 DB errors as 500 | TC-STAFF-02-01, TC-REC-02-01, [ERROR_HANDLING §4](../04-engineering-standards/ERROR_HANDLING.md) |
| S-9 last CoS / live sessions | SP-3, SA-11 |
| S-10 missing audit | SL-6 |
| S-11 chain without HMAC | SL-5 |
| S-12 guard coverage | SI-5, SU-5 |
| S-13 CSV guard | §10 |
| S-14 stuck `sending` | SJ-1 |
| S-15 scheduler per instance | SJ-2 |
| S-16 outbox data | SD-2 |
| S-17 pagination | SD-4 |
