# Runbook

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Signals and queries: [MONITORING.md](MONITORING.md). Environment variables: [ENVIRONMENT_CONFIGURATION.md](ENVIRONMENT_CONFIGURATION.md).
> **Rules that apply to every procedure:** never delete data, log rows or people (archive instead) [WO "Retention"]; never bypass the append-only triggers; take a backup before any write you are not sure of; any command that writes to a DB needs the owner's OK ([AI_AGENT_GUARDRAILS §2.6](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)). Procedures that depend on a host are [A] until a host is chosen ([DEPLOYMENT.md](DEPLOYMENT.md)).

## 1. Escalation engine stalled

**Symptom.** No new escalations although tasks are overdue; the engine-lag alert fires; the dashboard levels look stale. WO FR-8 requires a run at least every 5 minutes.

1. Is the process running? Check the host's service status and the start log for `TaskWatch API listening` (`index.ts:21`). [V-S]
2. Look for `[engine]` errors in the log (`scheduler.ts:58`). The engine catches per tick, so a bad task can repeat the error every minute without stopping the process. [V-S]
3. Check `ENGINE_INTERVAL_MS` is unset or ≤ 300000 (`config.ts:67`).
4. A tick that takes longer than the interval is skipped by the busy flag (`scheduler.ts:51-54`). [V-S] Look for lock waits on `tasks` (`select * from pg_stat_activity where wait_event_type = 'Lock'`).
5. Force one run as the CoS: **Audit & admin → run engine** (`POST /api/admin/engine`, cos only, runs the engine and the dispatcher once; `admin.ts:41-45`). [V-S]
6. If more than one instance is running, stop all but one (S-15).
7. Once recovered, the next tick catches up: levels are computed from stored times, so no alert is lost; late levels fire on the first good tick. [V-S] `engine/engine.ts:37-64`. Record how late they were (AC-1 evidence).

## 2. Deliveries failing

**Symptom.** `failed` rows, or `pending`/`held` rows past `send_after` ([MONITORING §2](MONITORING.md)).

1. Count by channel and status (MONITORING query). One channel or both?
2. **WhatsApp only**: token expired or revoked, phone number id changed, or a template not approved or renamed (`docs/whatsapp-templates.md`). Check the `error` column of a few rows **without copying addresses out** (S-16).
3. **Email only**: SMTP app password revoked, Workspace sending limits, or a changed `SMTP_HOST`/`SMTP_PORT`.
4. Rows in `sending` for > 15 min are stuck (S-14): the dispatcher never retries them. Until a fix ships, moving them back to `pending` is a **data change**: take a backup and get the owner's OK first. [V-S] `dispatcher.ts:41-46`
5. After fixing credentials, rotate them via §6 and restart. `failed` rows are not retried automatically after 3 attempts (`dispatcher.ts:6,68-72`); re-queuing them is a data change needing approval. In-app alerts were already delivered (`inapp` rows are `sent` at once). [V-S]
6. If L2/L3 alerts failed, tell the Chief of Staff directly. Those are the alerts the WO says always go out.

## 3. Hash-chain break alert

**Symptom.** The CoS receives "TaskWatch audit-log integrity alert" (`chain_break`); `chain_checks.ok = false`; the task page shows the chain as broken. [V-S] `scheduler.ts:16-38`

1. **Do not modify anything.** The broken rows are the evidence. Do not "repair" the chain, re-hash rows, or disable triggers.
2. Record `chain_checks.breaks` (task ids, seq, problem) and the time of the last `ok` run. That window is when the change happened.
3. Take a backup now (§5) and keep it outside the 90-day rotation as incident evidence.
4. Compare the affected rows with the last backup taken before the window (restore it to a **separate** database, never over production) to see what changed.
5. Review who had direct DB write access in the window (DB logs, host access). The app itself cannot edit log rows: the triggers reject it (`001_init.sql:104-112`), so a break means someone bypassed them (for example `session_replication_role = replica`, as the test simulates at `api.test.ts:208-213`).
6. Inform the Chief of Staff and the Founder's Office with the findings. Note the known limit: someone with DB write access can rebuild a consistent chain (S-11), so "no break" is not absolute proof.
7. If it is a false alarm (for example a code change altered the canonical row format), that is a severity 1 defect: stop deploys and fix the verifier, never the rows.

## 4. A user locked out of 2FA

Applies to password sign-in with TOTP for manager, cos and ceo (D-21; **not built yet**). Google sign-in 2FA is Workspace 2-Step Verification, so lockouts there go to the Workspace admin.

1. Verify the person's identity out of band (a call to a known number, or in person). Never by email alone.
2. A Chief of Staff (not the user themselves) resets their TOTP enrolment through the admin UI (planned with AUTH-05). The action must be audited in `admin_log`.
3. The user signs in with their password and enrols a new authenticator immediately; they cannot finish sign-in without it.
4. If the locked-out user is the **only** CoS: a second CoS should always exist (see the last-CoS rule, S-9). If none exists, the recovery is a reviewed DB change by the system owner with a backup first, recorded afterwards in `admin_log`. [A]
5. Never switch TOTP off for a role to get someone in. That breaks the WO login rule.

## 5. Backup and restore

The WO requires daily backups, 90-day retention and one restore test per quarter. [WO "Backups"] **Nothing is scheduled today** (DP-3 in [DEPLOYMENT.md](DEPLOYMENT.md)).

**Back up** (daily, and before every deploy that carries a migration):
```
pg_dump -Fc --no-owner -f taskwatch_<UTC-date>.dump "<DATABASE_URL from the secrets store>"
```
Also copy the `UPLOAD_DIR` volume; attachments are evidence too. Store both off the host, encrypted, for 90 days. `backups/` is git-ignored locally (`.gitignore`). [V-S] Never write the connection string into a script file; pass it from the environment.

**Restore** (needs the owner's approval; it replaces data):
1. Stop the app, so the scheduler does not write during the restore.
2. Restore into a **new** database first: `createdb taskwatch_restore` → `pg_restore --no-owner -d taskwatch_restore <file>`.
3. Verify it: row counts for `tasks`, `activity_log` and `users`; run the chain check against it (point a non-production instance at it and call `POST /api/admin/chain-check`, or run `verifyChains`). Expect `ok = true`.
4. Switch `DATABASE_URL` to the restored DB (or rename databases) and start **one** instance. Pending migrations apply at start-up (`index.ts:9`).
5. Restore the matching uploads snapshot.
6. Tell users which window of activity was lost (from the backup time to the incident).

**Quarterly restore test:** steps 2–3 on a scratch server; record the date, backup file, duration and chain result in the release notes. [WO]

## 6. Rotating secrets

Secrets: `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `WHATSAPP_TOKEN`, `SMTP_PASS`, and the DB password in `DATABASE_URL`. [V-S] `config.ts`

1. Create the new value at the provider (Google Cloud Console, Meta Business, Workspace app passwords, Postgres `alter role … password`).
2. Put it in the managed secrets store. Never in a file, ticket or chat. [WO "Secrets"]
3. Restart the single instance so `config.ts` reads it.
4. Check: sign-in works; the start log shows `WhatsApp: live · Email: live`; a test alert reaches `sent`.
5. Revoke the old value at the provider.

Side effect: rotating `SESSION_SECRET` signs everyone out (sessions are signed with it). [V-S] `app.ts:36`. Do it outside working hours in IST and PT, or announce it.

If a secret leaked: rotate at once, then review the delivery log and admin log for misuse in the exposure window.

## 7. Offboarding a person (archive, never delete)

[WO "Retention": closed tasks and logs kept 7 years; archived, never deleted, when a person leaves.]

1. A Chief of Staff opens **People** and **archives** the person (`POST /api/people/:id/active` with `active=false` sets `archived_at`, `people.ts:150-162`). The action is written to `admin_log`. [V-S] There is no delete.
2. Their next request is refused; with the current 30 s directory cache it can take up to 30 s (S-7).
3. **Reassign their open tasks** (WO FR-6). The clock restarts for each new assignee. Routing already skips archived people, so their alerts go to the next level up ([V-S] `rules.test.ts` "archived people are skipped").
4. Move their direct reports to a new manager (ORG-02) so reporting lines and visibility stay correct.
5. Pause or reassign recurring schedules they own (REC-03).
6. If they held cos, check that another active CoS remains (S-9).
7. Remove their access at Google Workspace too, if they sign in with Google.
8. Their tasks, updates, comments and log rows stay, with their name, for 7 years.

Re-hiring: restore the same user (`active=true`). Never create a second account for the same email.
