# FRD: Authentication and Session (AUTH)

> Module index and cross-cutting rules C-1..C-7: [PRODUCT_REQUIREMENTS §2.1](../PRODUCT_REQUIREMENTS.md#21-authentication--session-auth). Tags: **[WO]** · **[V-C]** client (`client/src/…`) · **[V-S]** server (`server/src/…`) · **[A]** · **[OPEN D-n]** [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md). Every endpoint below is **PROPOSED**. All non-GET requests carry the CSRF header `x-taskwatch: 1` [V-S `http/middleware.ts:48-55`]. The error envelope is `{error, fields?}` (C-3).
>
> Decisions in force: **D-2** Google Workspace sign-in **and** email + password (scrypt, `crypto.randomBytes` reset tokens, rate-limited; dev login non-production only) · **D-94** (2026-11-04) no two-factor authentication: password sign-in completes in one step for every role; Google relies on Workspace 2-Step Verification where the Workspace admin enforces it. D-94 supersedes D-21 and deviates from the work order (RELEASE_READINESS R-S4) · **D-22** standalone directory · **D-8** multiple roles.
>
> Status 2026-11-04: AUTH-01…06 are built (Auth phase, T-2.1–T-2.7); see the [tracker](../../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md). The "Existing" / `[V-S]` references below describe the server before that work.

Features: AUTH-01 (01a Google, 01b password) · AUTH-02 · AUTH-03 · AUTH-04 · AUTH-05 · AUTH-06 · ~~AUTH-07~~ · ~~AUTH-08~~ (removed by D-94)

### Session states used below [A]

| State | Meaning | Endpoints allowed |
|---|---|---|
| `anonymous` | No session | auth endpoints only |
| `authenticated` | Fully signed in | everything the user's permissions allow (C-1) |

The `mfa_enroll` / `mfa_pending` states and the 401 `MFA_REQUIRED` error were removed with 2FA (D-94).

---

## AUTH-01 Sign in

**Description.** Starts an authenticated server session for an active directory user. There are two paths (D-2): AUTH-01a Google Workspace and AUTH-01b email + password.

**Roles.** Every role. Only people already in the TaskWatch directory can sign in. [V-S `routes/auth.ts:67-68`; D-22]

**User actions (UI).**
- Email + password form: `features/auth/AuthPages.tsx:47` (form `:76`, submit calls `login` at `:64`).
- Google button: **no UI yet**. It is a UI addition per D-2.
- The demo quick-fill accounts and the visible demo password (`AuthPages.tsx:91-117`) must be removed in production (PRD DEMO-01).

### AUTH-01a Google Workspace

**System behaviour.** The user is redirected to Google with `state`, `nonce`, `prompt=select_account` and an `hd` hint when there is one allowed domain. On callback the server checks, in order:
1. state matches
2. an ID token is present
3. the token verifies for this client id
4. `email_verified`
5. nonce matches
6. the domain is on the allow-list
7. the user exists and is active

It then regenerates the session, stores the user id and redirects to `/`. [V-S `routes/auth.ts:33-76`] Any second factor is Workspace's own 2-Step Verification; TaskWatch adds none. [D-94]

**API (PROPOSED, adapt the existing endpoints unchanged in contract).**

| Method | Path | Request | Response | Existing |
|---|---|---|---|---|
| GET | `/api/auth/config` | – | `{google: bool, password: bool, devLogin: bool}` | adapt `routes/auth.ts:28-30` (add `password`) |
| GET | `/api/auth/google` | – | 302 to Google | reuse `routes/auth.ts:33-48` |
| GET | `/api/auth/google/callback` | `code`, `state` | 302 `/` or 302 `/login?error=<msg>` | reuse `routes/auth.ts:50-76` |

**Failure messages (redirect `?error=`).** [V-S `routes/auth.ts:54-74`]
- `Sign-in expired. Please try again.`
- `Google did not return an identity token.`
- `Your Google account email is not verified.`
- `Sign-in could not be verified. Please try again.`
- `<email> is not on an allowed company domain.`
- `<email> is not in the TaskWatch directory. Ask the Chief of Staff to add you.`
- `Google sign-in failed. Please try again.`

### AUTH-01b Email + password

**System behaviour.**
1. Look up the user by email, case-insensitively.
2. Verify the password against its scrypt hash in constant time (D-2).
3. On failure: 401 with one generic message, so accounts cannot be enumerated.
4. If the account is inactive (checked only after the password matches): 403.
5. On success: regenerate the session (SEC-6); it becomes `authenticated` for every role. There is no second factor (D-94).
6. Write an audit record for success and for failure. [A] The server logs no sign-ins today (S-10).

**Data.**
- `users.email`, `users.status`/`active`, `users.roles`
- `users.password_hash` (scrypt, with salt and parameters)
- the session row

**API (PROPOSED, new; the server has no password path).**

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{email: string, password: string}` | 200 `{ok: true}` plus the session cookie (D-94; was `{next}`) |

**Validation (from the mock).** [V-C `services/api/misc.ts:17-22`]
- Empty email → 422 `fields.email = "Enter your work email."`
- Empty password → 422 `fields.password = "Enter your password."`
- Unknown email or wrong password → 401 `That email and password combination is not recognized.`
- Inactive → 403 `This account is deactivated. Contact your Chief of Staff.`

**Rate limiting.** D-2 requires throttling. The numbers are not set: **[A]** 5 failures per account per 15 min and 20 per IP per 15 min, then 429 `{error: "Too many attempts. Try again later."}`.

**Authorization.** Public endpoint. CSRF header required.

**Success and failure scenarios.**

| Scenario | Status |
|---|---|
| Any role (including Manager, CoS, CEO) with valid credentials | 200 `{ok: true}`, signed in |
| Missing field | 422 |
| Bad credentials | 401 |
| Deactivated | 403 |
| Throttled | 429 |
| Missing CSRF header | 403 `Request blocked: missing TaskWatch header` [V-S `http/middleware.ts:51`] |

**Dependencies.** STAFF-02 (directory), SEC-3 (rate limit), SEC-6 (session regeneration).

**Acceptance criteria.**
- AUTH-01-AC-1: A Staff user with a correct password receives 200 `{ok:true}`, and `GET /api/me` then returns 200 for that user.
- AUTH-01-AC-2: An unknown email and a wrong password for a known email both return 401 with the identical body.
- AUTH-01-AC-3: A deactivated user with the correct password receives 403 and no authenticated session.
- AUTH-01-AC-4: A user holding `manager` (alone or with other roles) with a correct password is signed in with no second step, and the removed 2FA endpoints (`/api/auth/2fa/*`) return 404. (Was: "never reaches `authenticated` without passing AUTH-08"; changed by D-94.)
- AUTH-01-AC-5: The session id changes on successful sign-in.
- AUTH-01-AC-6: After the configured number of failures, further attempts return 429 even with the correct password, until the window passes.
- AUTH-01-AC-7: The Google callback rejects a mismatched `state`, an unverified email, a disallowed domain and a user who is not in the directory, each with its message.
- AUTH-01-AC-8: Dev login (`/api/auth/dev-*`) returns 404 when `NODE_ENV=production`. [V-S `routes/auth.ts:79-98`; SEC-10]

**Test scenarios.**
- Valid sign-in for each role.
- Enumeration check: compare unknown-email and wrong-password responses.
- Inactive account.
- Mixed-case email.
- Brute-force throttle.
- Session fixation (the cookie changes).
- Manager signs in with password alone; 2FA endpoints 404 (D-94).
- Google callback negative cases.
- Dev login disabled in production.

---

## AUTH-02 Sign out

**Description.** Ends the session.

**Roles.** All signed-in users.

**User actions (UI).** User menu "Sign out": `app/Shell.tsx:179-184`.

**System behaviour.** Destroys the server session, clears the cookie (gap S-6: the server does not clear it today) and audits `auth.logout` [A]. Returns 200 even when there was no session.

**Data.** The session row.

**API (PROPOSED).** `POST /api/auth/logout` → 200 `{ok:true}`. This adapts `routes/auth.ts:100-102` by adding cookie clearing.

**Validation.** None.

**Authorization.** CSRF header required.

**Scenarios.** Signed in → 200 and the next API call returns 401. Not signed in → 200.

**Dependencies.** None.

**Acceptance criteria.**
- AUTH-02-AC-1: After sign-out, any authenticated endpoint returns 401 `Please sign in`.
- AUTH-02-AC-2: The response clears the session cookie (`Set-Cookie` with an expired date).

**Test scenarios.**
- Sign out then call `/api/me`.
- Sign out twice.

---

## AUTH-03 Session timeout

**Description.** The session ends after a period of inactivity set in System Settings.

**Roles.** All users.

**User actions (UI).**
- The UI routes to `/session-expired` when the API reports expiry (`app/App.tsx:59`); the page is `features/auth/AuthPages.tsx:214`.
- The timeout is set on the Settings page (SET-01).

**System behaviour.**
- Idle timeout = `settings.sessionTimeoutMinutes` (5–480). [V-C `services/api/admin.ts:259`]
- Activity extends the session (the mock refreshes it after 30 s of activity, `services/api/base.ts:24`).
- On expiry the next request returns 401 `SESSION_EXPIRED` and the session is destroyed. [V-C `services/api/base.ts:19-23`]
- An absolute lifetime cap is also applied (gap S-6). **[A]** 12 h, matching the server's current cookie `maxAge` [V-S `app.ts:39-44`].
- A deactivated user loses access on their next request. [V-S `http/middleware.ts:26-35`] The 30 s directory cache delays this (S-7) and must be removed or invalidated on deactivation. [A]

**Data.** `settings.sessionTimeoutMinutes`; session `lastActive` and `createdAt`.

**Backend processing.** Middleware compares now − `lastActive` against the setting read per request (or cached with invalidation on SET-01 save), then updates `lastActive`.

**API (PROPOSED).** There is no endpoint. This is behaviour of every authenticated endpoint (C-1). It adapts `app.ts:39-44` (fixed 12 h rolling) to the setting.

**Failure responses.** [V-C `services/api/base.ts:14-22`]
- No session → 401 `Please sign in.`
- Account deactivated → 401 `Your account has been deactivated.`
- Idle → 401 `SESSION_EXPIRED`

**Authorization.** Not applicable.

**Dependencies.** SET-01.

**Acceptance criteria.**
- AUTH-03-AC-1: With the timeout at 5 min, a request after 5 min of inactivity returns 401 `SESSION_EXPIRED`, and the following request returns 401 `Please sign in.`
- AUTH-03-AC-2: Steady activity keeps the session alive past the idle timeout, up to the absolute cap.
- AUTH-03-AC-3: Deactivating a user makes their very next request return 401, on every server instance.
- AUTH-03-AC-4: Changing the timeout in Settings applies to existing sessions on their next request.

**Test scenarios.**
- Idle expiry using the dev clock or a short timeout.
- Activity refresh.
- Absolute cap.
- Deactivation mid-session.
- Settings change takes effect.

---

## AUTH-04 Forgot and reset password

**Description.** Self-service reset for the password path (exists because D-2 keeps passwords).

**Roles.** Any directory user (signed out).

**User actions (UI).**
- ForgotPasswordPage `features/auth/AuthPages.tsx:122`.
- ResetPasswordPage `:164`.
- The demo token link must be removed.

**System behaviour.**
- Request: always answers the same way. If the account exists and is active, a single-use token is created and emailed. [V-C `services/api/misc.ts:50-58`]
- Token: from `crypto.randomBytes` (D-2), at least 32 bytes [A]; only its hash is stored [A]; it expires after 1 h [V-C `misc.ts:68`].
- Reset: validates the new password, sets the scrypt hash, consumes the token, invalidates every other session of that user, and audits `auth.password_reset`. [A]

**Data.** `password_resets(user_id, token_hash, created_at, used_at)`; `users.password_hash`.

**API (PROPOSED, new).**

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/auth/password/forgot` | `{email}` | 200 `{ok:true}` always (after validation) |
| POST | `/api/auth/password/reset` | `{token, password, confirm}` | 200 `{ok:true}` |

**Validation (from the mock).** [V-C `misc.ts:52, 63-68`]
- Bad email format → 422 `fields.email = "Enter a valid email address."`
- Password shorter than 10 → 422 `fields.password = "Use at least 10 characters."`
- No letter or no digit → 422 `fields.password = "Use letters and at least one number."`
- Mismatch → 422 `fields.confirm = "The passwords do not match."`
- Unknown, expired or used token → 400 `This reset link is invalid or has expired. Request a new one.`

**Authorization.** Public; rate-limited (D-2, SEC-3).

**Scenarios.**

| Scenario | Status |
|---|---|
| Existing email | 200 |
| Unknown email | 200 (identical body) |
| Valid reset | 200 |
| Second use of the same token | 400 |
| Token older than 1 h | 400 |
| Weak password | 422 |
| Throttled | 429 [A] |

**Dependencies.** NTF-02 (email), AUTH-01b.

**Acceptance criteria.**
- AUTH-04-AC-1: The forgot response body and status are identical for existing and non-existing emails.
- AUTH-04-AC-2: A token works once and fails with 400 on second use.
- AUTH-04-AC-3: A token older than 60 minutes fails with 400.
- AUTH-04-AC-4: Each password rule produces its exact 422 field message.
- AUTH-04-AC-5: After a reset, the user's other sessions return 401.
- AUTH-04-AC-6: No API response ever contains the token. (The mock returns it, `misc.ts:57`; the backend must not.)

**Test scenarios.**
- Enumeration parity.
- Token reuse.
- Token expiry.
- Each password rule.
- Session invalidation.
- Throttle.

---

## AUTH-05 Admin "reset access"

**Description.** An administrator issues a password-reset link for another user and ends that user's sessions. [A] (It no longer clears 2FA: there is none, D-94.)

**Roles.** Holders of `manage_staff` (default: CoS).

**User actions (UI).** Staff page "Reset access" action: `features/staff/StaffPages.tsx:29`.

**System behaviour.**
- Creates a reset token as in AUTH-04 and emails it to the user.
- Audits `staff.access_reset` with the target. [V-C `services/api/admin.ts:155-164`]
- Returns no token. The mock returns it (`admin.ts:163`) for demo purposes only.

**Data.** As AUTH-04, plus the target's sessions ended.

**API.** `POST /api/people/:id/reset-access` → 200 `{ok:true}` (built, `routes/people.ts`).

**Validation.**
- Unknown id → 404 `Person not found.` [V-C `services/api/base.ts:53`]
- Target is self → 422 [A]: use AUTH-04 instead.

**Authorization.**
- `manage_staff`, else 403 `You don't have permission to manage staff.` [V-C `admin.ts:157`]
- Resetting a CoS also requires holding `cos` [A], so that a manage_staff holder cannot take over a CoS account.

**Scenarios.**

| Scenario | Status |
|---|---|
| CoS resets a staff member | 200 |
| Manager without `manage_staff` | 403 |
| Unknown id | 404 |

**Dependencies.** AUTH-04, STAFF-01, AUD-01.

**Acceptance criteria.**
- AUTH-05-AC-1: Without `manage_staff`, the call returns 403 and writes no token.
- AUTH-05-AC-2: A successful call writes the audit entry `staff.access_reset` and returns no token in the body.
- AUTH-05-AC-3: After the reset, the target user's existing sessions return 401. (Was: TOTP enrolment cleared; removed by D-94.)
- AUTH-05-AC-4 (D-98, owner 2026-11-06): a non-CoS holder may reset only themselves and people below them in the reporting line (else 403); anyone may reset their own access (their own sessions end too). The lookup never crosses organizations (KI-39).

**Test scenarios.**
- Authorised reset.
- Unauthorised reset.
- Reset of a CoS by a non-CoS.
- Audit row present.
- Target's sessions ended.

---

## AUTH-06 Current user and capabilities

**Description.** Returns who is signed in and what they may do, so the UI can stop reading the mock store (`getDb()`) directly.

**Roles.** All users in the `authenticated` state.

**User actions (UI).** Called on app load. It replaces `resolveAuth` in `app/App.tsx:20-34` and the `useCan` checks.

**System behaviour.** Returns the user (without secrets), their roles, their effective permissions (D-8 union; all 15 for a CoS), whether they belong to the Founder's Office, their manager, their time zone, the integration status, the server time, the session timeout, and the demo clock offset when demo tools are on (non-production only).

**Data.** User; roles; the role-permission matrix; settings.

**API (PROPOSED).** `GET /api/me` → 200:

```
{
  user: {id, name, email, title, roles[], entityId, teamId, managerId, timezone},
  permissions: Permission[],
  founderOffice: bool,
  serverTime,
  sessionTimeoutMinutes,
  integrations: {google, whatsapp, email, password},
  demo?
}
```

It adapts `routes/auth.ts:104-125`, replacing the role-derived `can{}` with `permissions[]`.

**Validation.** None.

**Authorization.** C-1.

**Scenarios.** Signed in → 200. Not signed in → 401.

**Dependencies.** ROLE-01/02.

**Acceptance criteria.**
- AUTH-06-AC-1: For a user holding lead + staff, `permissions` equals the union of both role columns.
- AUTH-06-AC-2: For any CoS, `permissions` contains all 15, whatever the matrix says.
- AUTH-06-AC-3: After ROLE-02 removes a permission from a role, the next `/api/me` for a holder no longer lists it.
- AUTH-06-AC-4: The response never contains a password hash or reset token.

**Test scenarios.**
- Union for multi-role.
- CoS lock.
- Matrix change propagation.
- Secret-field absence.

---

## AUTH-07 TOTP 2FA enrolment (new, from WO)

**Description.** A user who must use 2FA and has not yet enrolled sets up an authenticator app at password sign-in. [WO "two-factor authentication required for Manager, Chief of Staff and CEO roles"; D-21]

**Roles.** Holders of `manager`, `cos` or `ceo`, on the password path only.

**User actions (UI).** No UI yet. D-21 adds an enrolment screen: a QR code, a manual key, and a code field.

**System behaviour.**
1. In `mfa_enroll`, `start` generates a 20-byte random secret with `crypto.randomBytes`. It is held in the session, not yet saved. The response returns an `otpauth://` URI (issuer "TaskWatch", account = email) and the base32 key.
2. `confirm` verifies a 6-digit code (RFC 6238, 30 s step, SHA-1, ±1 step tolerance [A]), stores the encrypted secret, sets `totp_enrolled_at`, moves the session to `authenticated`, and audits `auth.totp_enrolled`.
3. Recovery codes are out of scope [A]. Recovery is AUTH-05.

**Data.** `users.totp_secret` (encrypted with a key from the secrets store, SEC-2 [A]), `users.totp_enrolled_at`.

**API (PROPOSED, new).**

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/auth/2fa/enroll/start` | – | 200 `{otpauthUrl, secret}` |
| POST | `/api/auth/2fa/enroll/confirm` | `{code: string}` | 200 `{ok:true}` |

**Validation.**
- `code` must be 6 digits → otherwise 422 `fields.code = "Enter the 6-digit code from your app."` [A]
- Wrong code → 422 `fields.code = "That code is not valid. Try the current one."` [A]
- `confirm` before `start` → 409 [A]

**Authorization.** Session in `mfa_enroll` only; otherwise 401 (anonymous) or 409 (already enrolled) [A]. Rate-limited like AUTH-01.

**Scenarios.**

| Scenario | Status |
|---|---|
| Correct code | 200, session authenticated |
| Wrong code | 422 |
| Too many tries | 429 |
| Called while authenticated | 409 |

**Dependencies.** AUTH-01b, AUTH-05 (recovery), SEC-2.

**Acceptance criteria.**
- AUTH-07-AC-1: A Manager with no enrolment who signs in with a password cannot call any non-auth endpoint until enrolment completes (401 `MFA_REQUIRED`).
- AUTH-07-AC-2: A code generated by a standard authenticator from the returned URI is accepted.
- AUTH-07-AC-3: The stored secret is not readable in plain text from the database row. [A]
- AUTH-07-AC-4: Enrolment writes an audit record.

**Test scenarios.**
- Full enrolment with an RFC 6238 test vector.
- Wrong code.
- Clock skew of ±30 s.
- Access attempt before enrolment.
- Repeat enrolment blocked.

---

## AUTH-08 TOTP sign-in challenge (new, from WO)

**Description.** The second step at password sign-in for enrolled Manager, CoS and CEO holders. [WO; D-21]

**Roles.** As AUTH-07.

**User actions (UI).** No UI yet. D-21 adds a code step after the password form.

**System behaviour.**
- Verifies the code as in AUTH-07.
- Rejects reuse of a code within its validity window (replay) [A].
- On success the session moves to `authenticated` and the server audits `auth.login` with `mfa: true`.
- Five consecutive failures end the pending session [A].

**Data.** `users.totp_secret`, `users.totp_last_step` (replay guard) [A].

**API (PROPOSED, new).** `POST /api/auth/2fa/verify` with `{code}` → 200 `{ok:true}`.

**Validation.** As AUTH-07.

**Authorization.** Session in `mfa_pending` only.

**Scenarios.**

| Scenario | Status |
|---|---|
| Correct code | 200 |
| Wrong code | 422 |
| Replayed code | 422 |
| Fifth failure | 401, session ended |
| Not pending | 401 |

**Dependencies.** AUTH-01b, AUTH-07.

**Acceptance criteria.**
- AUTH-08-AC-1: A CEO with a correct password but no code gets 401 `MFA_REQUIRED` from `/api/me`.
- AUTH-08-AC-2: A correct code completes the sign-in; the same code submitted again in a new sign-in within 30 s is rejected.
- AUTH-08-AC-3: Staff and Lead holders (without manager, cos or ceo) are never asked for a code.
- AUTH-08-AC-4: Google sign-in never asks for a TOTP code.

**Test scenarios.**
- Correct code.
- Wrong code.
- Replay.
- Lockout after five failures.
- Role-based skip.
- Google path skip.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

- **D-2, D-21** (decided). The rate-limit numbers, TOTP parameters, secret encryption and the recovery-through-AUTH-05 design are marked **[A]** above and need confirmation.
- **D-17**: removing the demo login helpers and the demo bar "act as" (`AuthPages.tsx:91-117`).
- **D-18**: adding `password_hash` and `totp_*` columns is a schema change to the dev database and needs explicit OK before any migration.
- S-6, S-7 and S-10 (EXISTING_SYSTEM_ANALYSIS §3.8) are fixed by AUTH-02, AUTH-03 and AUTH-01's audit.
- **Gap:** a user who gains the Manager role while signed in keeps a non-2FA session until it ends. **[A]** Force a re-check on role change (M-6 in [USER_ROLES_AND_PERMISSIONS](../USER_ROLES_AND_PERMISSIONS.md#4-multiple-roles-union-semantics-d-8)).
