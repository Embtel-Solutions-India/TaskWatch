# Integration Design

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> All three integrations exist in the server today; this document records them and the changes the new model needs. Changes are **Proposed — needs approval** unless an ADR covers them. No integration was exercised while writing this.

Related: [SYSTEM_ARCHITECTURE.md §2](SYSTEM_ARCHITECTURE.md) · [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) · [SCALABILITY_AND_RELIABILITY.md §3](SCALABILITY_AND_RELIABILITY.md) · [../whatsapp-templates.md](../whatsapp-templates.md)

## 1. Channel policy [WO p.4]
"WhatsApp first, email always, in-app always." The notifier writes one row per channel per recipient: in-app immediately `sent`; email and WhatsApp `pending`, or `held` during quiet hours for quietable messages [V-S `server/src/notify/notify.ts:18-75`].

| Rule | Source |
|---|---|
| Quiet hours 21:00–08:00 in the **recipient's** zone hold L0/L1 (and blocked alerts) email + WhatsApp; L2/L3 always go out; in-app never held | [WO p.5; V-S `notify.ts:35-37`; PRD NTF-03] |
| Mandatory types `assignment`, `reassignment`, `escalation` ignore preferences | [V-C `client/src/services/channels.ts:80`; PRD NTF-02] |
| Preferences (type × channel) apply to every other type | PRD NTF-04; new `notification_prefs` ([DATABASE_DESIGN.md §3.7](DATABASE_DESIGN.md)) |
| Every outbound message is a row in the delivery log with its status | [WO acceptance p.7; V-S `001_init.sql:151-174`] |

## 2. Google OAuth (sign-in)
Existing authorization-code flow [V-S `server/src/routes/auth.ts:20-76`], `google-auth-library`:
- Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` (comma list; one domain also sets the `hd` hint) [V-S `config.ts:17, 34-39`; `auth.ts:39-45`].
- Redirect URI `${APP_URL}/api/auth/google/callback` [V-S `auth.ts:24`] — must be registered in the Google Cloud console for each environment.
- Scopes `openid email profile`; only users already in the directory and active may sign in [V-S `auth.ts:41, 67-68`].
- Enabled only when both client ID and secret are set [V-S `config.ts:17`]; otherwise the login page offers password sign-in (ADR-0002) and, outside production, dev login.
- Change: on success also write `login_attempts` / `admin_log` (S-10). 2FA for senior roles relies on Workspace 2SV (D-21; D-64 (decided)).

## 3. Email via Google Workspace SMTP
Existing nodemailer transport [V-S `server/src/notify/channels.ts:56-91`]:
- Env: `SMTP_HOST`, `SMTP_PORT` (default 465 → implicit TLS), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM_ADDRESS` (defaults to `SMTP_USER`) [V-S `config.ts:49-57`]; sender name fixed "TaskWatch" [WO p.4; V-S `config.ts:56`].
- Body is escaped HTML with an "Open in TaskWatch" button plus a plain-text part [V-S `channels.ts:62-71, 82-89`]; the digest is sent as its own HTML [V-S `dispatcher.ts:53, 60`].
- Uses: every alert, reset links (new), the weekly digest (Monday 09:00 IST [WO FR-12; D-14]), chain-break alerts.
- Workspace account: whether to use a user mailbox with an app password or the Workspace SMTP relay is an ops choice [A]; either way the credential is a secret (§6).

## 4. WhatsApp Business Cloud API
Existing direct `fetch` to `https://graph.facebook.com/{WHATSAPP_API_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages` with a bearer token, 15 s timeout [V-S `channels.ts:25-54`]:
- Env: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (default `v23.0`), `WHATSAPP_TEMPLATE_LANG` (default `en`) [V-S `config.ts:41-47`].
- **Templates only.** Five approved templates, names and variable order defined in [../whatsapp-templates.md](../whatsapp-templates.md): `taskwatch_task_assigned`, `taskwatch_update_reminder`, `taskwatch_escalation`, `taskwatch_task_blocked`, `taskwatch_system_alert` (same list as the client type [V-C `client/src/types/index.ts:254`]). Parameters are flattened (no newlines/tabs) and capped at 900 characters [V-S `channels.ts:20-22`].
- Each task template has an "Open task" URL button whose suffix `{{1}}` is the task number [V-S `channels.ts:32-35`]. With the proposed `TW-<n>` IDs ([API_CONTRACTS.md §1](API_CONTRACTS.md)) the SPA route `/tasks/:id` must accept the bare number as well, so the approved template URLs keep working.
- Eligibility: a WhatsApp number in E.164 and explicit opt-in; otherwise the row is `skipped` with a reason [V-S `notify.ts:40-41`; PRD NTF-02]. Target reads `users.whatsapp` instead of `phone` ([DATABASE_DESIGN.md §3.2](DATABASE_DESIGN.md)).
- Only the types that have a template can go to WhatsApp (NTF-04). Other types (e.g. `mention`, `review_decision`) are in-app + email only unless new templates are approved [A].
- Sending number and Meta Business account owner: WO decision D6 (listed as **WO-D6** in project docs) — not recorded as answered in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).

## 5. Simulation mode (NTF-06)
- A channel is live only when its credentials are present (`config.whatsapp.enabled`, `config.smtp.enabled` [V-S `config.ts:42, 50`]); otherwise `sendWhatsApp`/`sendEmail` return `{simulated: true}` and the row becomes `simulated` with the rendered body kept for preview [V-S `channels.ts:26, 75`; `dispatcher.ts:61-66`].
- The client additionally has `Settings.emailSimulation` / `whatsappSimulation` toggles [V-C `types/index.ts:336-338`]. **Proposed:** a toggle may force simulation even when credentials exist; it can never make a channel live without credentials. D-61 (decided).
- `GET /api/me` reports `integrations: {google, whatsapp, email, devLogin}` (existing [V-S `auth.ts:116-121`]) so the UI can label simulated deliveries.

## 6. Retries and errors
- Up to 3 attempts, linear backoff 5 min × attempt, then `failed` with the provider message (truncated to 500 chars) [V-S `dispatcher.ts:6, 67-75`].
- Proposed: lease-based recovery of rows stuck in `sending` (S-14) — [SCALABILITY_AND_RELIABILITY.md §3](SCALABILITY_AND_RELIABILITY.md).
- Provider error text is shown only in the delivery log to `view_audit_logs` holders (S-16).
- Permanent WhatsApp errors (e.g. template not approved, number not on WhatsApp) still use all 3 attempts today [V-S `dispatcher.ts:67-75`]; classifying them as non-retryable is optional [A].
- All credentials are secrets: env names only, values from the managed secrets store [WO p.5; [SECURITY_ARCHITECTURE.md §8](SECURITY_ARCHITECTURE.md)].

## 7. Out of scope (phase 2) [WO p.5–6]
Listed only so nothing is built for them now:
- **GoHighLevel webhook** — a GHL workflow would create a TaskWatch task (e.g. new retainer, RFE received).
- **ImmigrationCRM case link** — link a task to a case ID and show open tasks on the case screen.
- Mobile app.
