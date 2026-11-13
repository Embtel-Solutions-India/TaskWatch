# Release Readiness

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> A release (pilot go-live or production rollout) goes ahead only when **every** gate below shows status `met` with linked evidence, or the user has waived it in writing. As of 2026-11-06 **no gate is met**: several are `built` (code done and passing in local runs: owner's `npm test` + `npm run e2e` green 2026-11-06), but staging, pilot and production environments do not exist, so no pilot or production evidence exists yet.

| Status values | `met` (evidence linked) · `built` (code done and tested locally; pilot/production evidence still required) · `not met` · `waived by <name>, <date>` |
|---|---|

## 1. Work-order acceptance (blocking) [WO "Acceptance criteria"]

Each must pass **in the pilot environment**.

| Gate | Criterion | Evidence required | Test cases | Status |
|---|---|---|---|---|
| R-AC1 | Critical silent: L0/L1/L2/L3 at 4/6/8/12 h, each within 5 min | Automated run + live pilot timing | TC-ESC-01-05/06, TC-ESC-08-02 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC2 | Past due: L1 at due, L2 and L3 **per approved policy, in the vertical's working time for non-Critical tasks (D-160, ADR-0015; Critical: clock time)** (D-140, [ADR-0014](../03-architecture/decisions/ADR-0014.md); was +24 h/+72 h) regardless of updates | Automated run | TC-ESC-02-01/02/04/05/06 | built — automated part passing locally (2026-11-06; ADR-0014 runs 2026-11-12: api 178/178, pure 154/154). The D-152 values (Critical 30 min/2 h, High 4 h/24 h, Normal/Low 24 h/72 h) are entered on the dev database (2026-11-12); production needs the same entry. full `npm test` 336/336, `npm run e2e` 4/4, typecheck 0 (2026-11-12). Pilot evidence pending |
| R-AC3 | Blocked alerts the lead within 5 min | Automated run + live timing (D-85 on quiet hours) | TC-WF-11-01…04 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC4 | Lead/manager comment does not reset; assignee update does | Automated run | TC-CMT-01-01, TC-WF-03-01 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC5 | Each alert reaches the right person by **email and in-app** (WhatsApp dropped, D-106); logged | Pilot confirmations against the delivery log | TC-NTF-02-02/06, TC-DLV-01-02 | not met (email delivery needs SMTP keys; pilot confirmations) |
| R-AC6 | Staff cannot see another team's tasks, through the API | Automated run of the scope and IDOR suite | TC-TASK-04-01/02, TC-SEC1-01 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC7 | No log edit/delete via any endpoint; nightly check flags a direct DB edit | Automated run + one nightly `chain_checks` row in pilot | TC-AUD-01-01…04 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC8 | Entity dashboard matches a hand count of 20 tasks | Signed hand-count sheet | TC-DASH-01-01/02 | not met (dashboards: Phase 8) |
| R-AC9 | IST and PT display correct for the same task | Automated run + two screenshots | TC-TASK-01-06, TC-TASK-05-04 | built — automated part passing locally (2026-11-06); pilot evidence pending |
| R-AC10 | BAIS pilot: ≥ 90 % of staff post updates | Query result at end of week 2 | TC-WF-03-06 | not met |

## 2. Definition of Done

| Gate | Criterion | Status |
|---|---|---|
| R-DOD1 | Every P0 feature in [IMPLEMENTATION_TRACKER.md](../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) is DONE per [DEFINITION_OF_DONE.md](../04-engineering-standards/DEFINITION_OF_DONE.md) | not met |
| R-DOD2 | Full automated suite run on the release build: 0 failures; run date, command and counts recorded | not met (not run) |
| R-DOD3 | [QA_CHECKLIST.md](QA_CHECKLIST.md) completed in staging, signed | not met |
| R-DOD4 | No open severity 1 or 2 defect [A] | not met |

## 3. Security

| Gate | Criterion | Status |
|---|---|---|
| R-S1 | All [SECURITY_TEST_PLAN.md](SECURITY_TEST_PLAN.md) automated items pass; manual items signed | not met |
| R-S2 | Findings S-1…S-17 each fixed or risk-accepted in writing (S-11 may stay as an accepted risk) | not met |
| R-S3 | `npm audit`: no high/critical advisory in runtime dependencies, or written acceptance | not met (planned) |
| R-S4 | **2FA: removed by D-94 (owner, 2026-11-04).** Gate is now: the Founder's Office accepts this deviation from WO "Login" in writing; optionally enforce Workspace 2-Step Verification for manager/cos/ceo Google accounts (admin console) | met — 2FA removal (D-94) accepted under R-X1, 2026-11-06; Workspace 2-Step Verification stays optional |
| R-S5 | Dev login and demo tools unavailable: production start log shows no dev sign-in; `/api/dev/clock` and `/api/auth/dev-login` return 404 (TC-AUTH-01-08, TC-DEMO-01-01) [V-S] `config.ts:60-62` | built — dev login opt-in (`ALLOW_DEV_LOGIN=true`, never in production), demo tools opt-in (`DEMO_TOOLS=true`, never in production, D-47/KI-41); verify on the production build |
| R-S6 | Served over HTTPS; session cookie `Secure` (S-6) | not met |
| R-S7 | Rate limiting live on sign-in, reset, search, uploads (S-1) | built — `http/rateLimit.ts` on sign-in, forgot/reset, uploads, Google callback (T-1.13, auth review); search pending Phase 8 |

## 4. Secrets [WO "Secrets", FO-2026-CRM-01 WP-1]

| Gate | Criterion | Status |
|---|---|---|
| R-K1 | Secrets scan of the repo finds names only ([SECURITY_TEST_PLAN §14](SECURITY_TEST_PLAN.md)) | not met |
| R-K2 | Production secrets (`SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `WHATSAPP_TOKEN`, `SMTP_PASS`, `DATABASE_URL` credentials) come from a managed secrets store; **no `.env` file on the host**, and the start command does not load one (D-87) | not met |
| R-K3 | Rotation procedure tested once ([../08-operations/RUNBOOK.md](../08-operations/RUNBOOK.md)) | not met |

## 5. Data protection: backups and retention [WO "Backups", "Retention"]

| Gate | Criterion | Status |
|---|---|---|
| R-B1 | Daily automated backup running; 90-day retention configured | not met |
| R-B2 | One restore test done before go-live and recorded; next one scheduled within the quarter | not met |
| R-B3 | No delete path for tasks, people or log rows; people are archived (TC-STAFF-03-02) | built — delete/truncate triggers on every record table (migration 009), no delete routes, people deactivated (STAFF-03); legacy status route removed (KI-38) |
| R-B4 | Backup taken immediately before the release's migrations | not met |

## 6. Integrations

| Gate | Criterion | Status |
|---|---|---|
| R-I1 | ~~WhatsApp templates approved by Meta~~ **Not needed: WhatsApp dropped (D-106, 2026-11-05).** Code kept, switched off (`WHATSAPP_ENABLED`) | met (not needed) — WhatsApp dropped (D-106), accepted under R-X1, 2026-11-06 |
| R-I2 | Email from the Workspace domain, sender name "TaskWatch" [WO] [V-S] `config.ts:56` | not met |
| R-I3 | Delivery log shows `sent` (not `simulated`) for both channels in the pilot | not met |
| R-I4 | Founder's Office decisions WO-D1…D7 recorded (D1 standalone: D-22; D7 setting matches the decision) | not met — WO-D1 recorded (D-22), WO-D6 not needed (D-106); WO-D2…D5, D7 await the Founder's Office |

## 7. Operations

| Gate | Criterion | Status |
|---|---|---|
| R-O1 | **Single scheduler leader** in production (one instance, or leader election; S-15) | built — Postgres advisory-lock scheduler leader (T-1.17), safe with several instances; verify in production |
| R-O2 | Monitoring in place for the items in [../08-operations/MONITORING.md](../08-operations/MONITORING.md); engine-lag alert at < 5 min | not met |
| R-O3 | [../08-operations/RUNBOOK.md](../08-operations/RUNBOOK.md) reviewed by whoever is on call | not met |
| R-O4 | Directory loaded and reviewed for the release's entities (reporting lines, time zones, phones, opt-in) | not met |
| R-O5 | Performance exit criteria met ([PERFORMANCE_TEST_PLAN §5](PERFORMANCE_TEST_PLAN.md)) | not met |
| R-O6 | Training video and pilot report delivered (WO WP-6) | not met |

## 8. Beyond the work order (owner decisions to confirm with the Founder's Office)

| Gate | Criterion | Status |
|---|---|---|
| R-X1 | Founder's Office accepts the owner's deviations from the WO in writing: WhatsApp dropped (D-106), 2FA removed (D-94), performance scores and leaderboards built without hours tracking or HR appraisal (D-110) | met — approved by the owner, 2026-11-06 (chat): D-106, D-94 and D-110 accepted |
| R-X2 | Performance (PERF-01…06) verified in the pilot: a hand-checked leaderboard for one team matches the formula (PERFORMANCE-FRD §5) | built — deferred by the owner: checked in the pilot, after the remaining phases are complete |

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Founder's Office (pilot sign-off) | | | |
| Chief of Staff | | | |
| Embtel delivery lead | | | |
