# QA Strategy

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Automated testing is in [TESTING_STRATEGY.md](TESTING_STRATEGY.md). This file covers environments, who to test as, regression, and the pilot.

## 1. Environments

| Env | DB | Config | Purpose | Exists today? |
|---|---|---|---|---|
| **Local dev** | `taskwatch` on the developer's Postgres (this machine: service `postgresql-x64-18`) | `.env` from `.env.example`; dev login and demo clock on (`config.ts:60-62`) | Build and manual checks with the seed data | Yes [V-S] |
| **Automated test** | `taskwatch_test` (`TEST_DATABASE_URL`), schema dropped every run | `NODE_ENV=test`, no credentials | `npm test` | Yes, not run [V-S] |
| **Staging** | Its own DB restored from an anonymised copy or the seed | `NODE_ENV=production`, sandbox WhatsApp number, test mailbox, HTTPS | Release checks with production settings; demo tools **off** | No — gap [A] |
| **Pilot** | Production DB, BAIS only | Production config, real channels, approved templates | WO WP-6 sign-off (AC-1…AC-10 "in the pilot environment") | No — gap [WO] |
| **Production** | Production DB | Secrets from a managed store | All entities after rollout | No — gap |

Deployment details and gaps: [../08-operations/DEPLOYMENT.md](../08-operations/DEPLOYMENT.md).

Because the demo clock is off in production-like environments, time-based checks there use real time (for example a Critical task's 4 h L0) or are proven in the automated suite with a fixed clock.

## 2. Who to test as

Manual QA uses the README's demo personas from `db/seed.ts` (README.md:36-43). [V-S] Each persona covers a role and a routing edge case:

| Persona | Role | Use to check |
|---|---|---|
| **Rahul Kashyap** | Chief of Staff | Everything visible; L3 banner; rules (default and per entity); people; audit and delivery log; demo clock (dev only); last-CoS guard |
| **Dr. Alka Madan** | CEO | Sees everything, **read-only by default**; receives L3 only when WO-D7 is on; 2FA required |
| **Maria Gonzales** | BAIS Operations Manager | Her two leads and their staff only; reassign, extend, acknowledge L2; 2FA required |
| **Jordan Lee** | BAIS team lead | Direct staff only; assign to them; extend once; acknowledge L1; receives Blocked alerts |
| **Sofia Ramirez** | BAIS staff | Own tasks only; post updates, mark Blocked/Done; cannot comment on or see other teams' tasks |
| **Daniel Brooks** | USAIS lead with no manager | L2 goes straight to the Founder's Office |

Add for v1 (not in the seed yet) [A]: a user holding two roles (D-8), an archived user, a PT-based staff member next to an IST lead (AC-9), and a password user with TOTP (D-21).

Every manual case states the persona. A defect report states the persona and role ([BUG_REPORT_TEMPLATE.md](BUG_REPORT_TEMPLATE.md)).

## 3. Regression approach

1. **Every change:** `npm run typecheck` and `npx tsx client/src/selfcheck.ts` (both read-only, no approval needed). Results are recorded in the change notes.
2. **Every change touching the server:** `npm test` once the user approves running it (D-18). The 38 existing tests are the regression baseline, starting with the WO acceptance tests in `api.test.ts`.
3. **Every release:** the full [QA_CHECKLIST.md](QA_CHECKLIST.md) in staging, the [SECURITY_TEST_PLAN.md](SECURITY_TEST_PLAN.md) manual items, and the [RELEASE_READINESS.md](RELEASE_READINESS.md) gates.
4. **Risk-based focus:** a change to the engine, routing, access rules, the activity log or time handling re-runs **all** ESC, AUD and scope (AC-6) cases, not only the ones for the touched feature.
5. **Bug fixes add a test** that fails before the fix, named after the bug's feature ID.
6. **No weakening.** A regression is fixed in the code, never by editing the expected value ([AI_AGENT_GUARDRAILS §2.5](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)).

## 4. BAIS pilot (WO WP-6, AC-10)

The WO: "two-week pilot in BAIS before rollout"; the Founder's Office signs off "when every check below passes in the pilot environment". [WO "Work packages", "Acceptance criteria"] WO-D5 confirms BAIS as the pilot entity (proposed default in the WO).

### Entry criteria
- All automated tests for AC-1…AC-9 have been run and pass (with approval), dated.
- [RELEASE_READINESS.md](RELEASE_READINESS.md) gates met, except AC-10 and the pilot-only checks.
- WhatsApp templates approved by Meta and the sending number decided (WO-D6); email sender configured.
- BAIS directory loaded with real reporting lines, phone numbers, WhatsApp opt-in and time zones; reviewed by the BAIS manager.
- 2FA enforced for BAIS manager(s), CoS and CEO.
- Training video delivered (WO WP-6 deliverable).

### During the pilot
| Check | How | Owner [A] |
|---|---|---|
| AC-1 live | One Critical test task left silent; record each level's time vs threshold | QA |
| AC-3 live | Mark a test task Blocked in working hours; time the lead's WhatsApp/email | QA |
| AC-5 live | For each alert in the delivery log, confirm with the recipient it arrived on WhatsApp and email | QA + BAIS lead |
| AC-8 | Hand count of 20 BAIS tasks vs the dashboard | CoS office |
| AC-9 | One IST and one PT user view the same task; screenshot both | QA |
| AC-10 | Weekly query: distinct BAIS staff with ≥ 1 update in `activity_log` (kind `update`) / active BAIS staff; target ≥ 90 % at the end of week 2 | CoS office |
| Monitoring | Daily look at job runs, chain checks, delivery failures, held queue ([../08-operations/MONITORING.md](../08-operations/MONITORING.md)) | Ops |
| Defects | Logged with the template; triaged daily; severity 1 stops the pilot clock [A] | QA |

### Exit (sign-off)
- AC-1…AC-10 all evidenced, with the evidence linked in [RELEASE_READINESS.md](RELEASE_READINESS.md).
- No open severity 1 or 2 defect [A].
- Pilot report delivered (WO WP-6 deliverable) and signed by the Founder's Office.

Then rollout to USAIS, IE, Embtel, BAAS and the Founder's Office follows the same entry checks per entity (directory, phones, 2FA). [WO WP-6]

## 5. Severity scale [A]

| Sev | Meaning | Example |
|---|---|---|
| 1 | Breaks a WO acceptance criterion, leaks data across scope, or loses or alters audit data | Staff sees another team's task; an alert never fires |
| 2 | Wrong result with a workaround | Dashboard count off by one |
| 3 | Cosmetic or minor | Label wording |
