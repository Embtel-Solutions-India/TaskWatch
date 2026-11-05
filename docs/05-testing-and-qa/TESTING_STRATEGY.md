# Testing Strategy

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> **Test status as of 2026-11-03: not run.** No server test and no client self-check has been executed in this project's documented history ([EXISTING_SYSTEM_ANALYSIS §3.7](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)). Running `npm test` needs approval because it drops the `taskwatch_test` schema ([D-18, decided]).
> The case list is [TEST_CASE_INVENTORY.md](TEST_CASE_INVENTORY.md). Security: [SECURITY_TEST_PLAN.md](SECURITY_TEST_PLAN.md). Performance: [PERFORMANCE_TEST_PLAN.md](PERFORMANCE_TEST_PLAN.md).

## 1. What exists

| Suite | Count | Needs DB | Runs with | Evidence |
|---|---|---|---|---|
| `server/test/rules.test.ts` | 21 | no | `npm test` (`tsx --test test/*.test.ts`) | [V-S] `server/package.json:12` |
| `server/test/api.test.ts` | 17 | yes (drops `public` on `TEST_DATABASE_URL`) | `npm test` | [V-S] `api.test.ts:54` |
| `client/src/selfcheck.ts` | 1 script, ~10 assertion groups | no | `npx tsx client/src/selfcheck.ts` | [V-C] `selfcheck.ts:2` |

38 server tests total, which matches README.md:156. The api tests were written for the **current server model** (statuses `open/in_progress/blocked/done`, entities, multi-role). When the model changes under D-4/D-20, fixtures and requests are adapted, but every assertion's intent stays ([AI_AGENT_GUARDRAILS §2.5](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)).

The self-check tests the **client prototype's** copy of the rules (`client/src/services/engine/*`). It overlaps `rules.test.ts` because the ladder is duplicated ([D-9, decided]). Once the shared module exists, its unit tests replace both overlaps.

## 2. Levels

| Level | Tests what | How | Pattern to copy |
|---|---|---|---|
| **Unit** | Pure functions: ladder (`computeLevel`, `silenceThresholds`, `levelApplies`), quiet hours, routing, state machine (`TRANSITIONS`, `allowedActions`), permission rules, recurrence math, sensitive-ID patterns, `csvCell`, `parseLocalDue` | `node:test` + `node:assert/strict`, no DB, fixed instants, an in-memory `Directory` | `server/test/rules.test.ts` [V-S] |
| **Integration** | Every endpoint through **real HTTP** against an **isolated Postgres DB**: authz, validation, transactions, log rows, notifications rows, engine effects | Start `createApp().listen(0)`; sign in via `POST /api/auth/dev-login` (available when `NODE_ENV=test`, `config.ts:60`); send `x-taskwatch: 1`; assert status, body and DB rows | `server/test/api.test.ts` [V-S] |
| **E2E** | Workflows W1–W9 from [PRD §3](../02-product-requirements/PRODUCT_REQUIREMENTS.md) through the browser, per role; IST/PT display (AC-9); 422 inline vs toast | Tool *Proposed — needs approval* (§3) | — |
| **Manual / pilot** | AC-5 real delivery on WhatsApp and email, AC-8 manual count, AC-10 adoption | [QA_STRATEGY.md](QA_STRATEGY.md), [QA_CHECKLIST.md](QA_CHECKLIST.md) | — |

### Rules for integration tests
- One DB per run: `TEST_DATABASE_URL`, default `taskwatch_test` (`api.test.ts:9`). Never the dev DB. [V-S]
- Delete credential env vars before importing the app so no real WhatsApp, email or Google call is made (`api.test.ts:10`). [V-S]
- Disable the dispatcher (`setDispatcherEnabled(false)`, `api.test.ts:57`) and drive jobs by calling them directly (`runEngine`, `runChainCheck`, `runRecurring`). [V-S] Dispatcher tests enable it explicitly and stub the channel at the module boundary. [A]
- Every authz test asserts **both** the refusal (403/404) and that the object is absent from the list (pattern: `api.test.ts:163-175`). [V-S]
- Assertions may read the DB directly (levels, notifications, log rows), as the existing tests do.

## 3. Tools

| Tool | Status | Notes |
|---|---|---|
| `node:test` via `tsx --test` | **In use** | No Jest or Vitest; do not add one. [V-S] |
| `node:assert/strict` | In use | [V-S] |
| `fetch` (Node built-in) | In use for HTTP | [V-S] `api.test.ts:94-102` |
| Coverage: `node --test --experimental-test-coverage` | *Proposed — needs approval* (built into Node, no new dependency) | [A] |
| E2E: Playwright | ***Proposed — needs approval*** (new dev dependency; browsers download) | Chosen because it can set the browser time zone per context (`timezoneId`), which AC-9 needs. Alternative: a manual checklist only. [A] |
| `npm audit` | *Planned* (read-only report) | [SECURITY_TEST_PLAN.md](SECURITY_TEST_PLAN.md) |

## 4. Fixtures and seeds

| Fixture | Contents | Use |
|---|---|---|
| **F-ORG** (existing) | Entities FO, BAIS, EMB. Users: 1 CEO (PT), 2 CoS (PT), 3 Manager A (BAIS, PT), 4 Lead A (BAIS, IST), 5 Staff A1 (BAIS, IST, WhatsApp), 6 Staff A2 (BAIS, PT), 7 Manager B (EMB, IST), 8 Lead B (EMB), 9 Staff B1 (EMB). Default SLA rules. | All integration tests. Defined at `api.test.ts:42-79`. [V-S] |
| **F-DIR** (existing) | In-memory directory with gaps: lead with no manager (6→2), staff with no lead (8→3). | Routing unit tests, `rules.test.ts:139-151`. [V-S] |
| **F-ORG+** (planned) | F-ORG plus: a lead with no manager (README persona Daniel Brooks), an archived user, a user holding two roles (lead + staff, D-8), a second CoS, a team under each entity (D-4), a password user with TOTP enrolled (D-21). | New authz, routing and 2FA cases. [A] |
| **Seed** `db/seed.ts` | Replays three weeks of history through the real engine (README.md:189). [V-S] | Manual QA and demos only. **Never** used by automated tests; `--reset` drops the schema. |

Test data uses `user<id>@example.com` and `+1415555xxxx`. No real people. ([AI_AGENT_GUARDRAILS G-4](../04-engineering-standards/AI_AGENT_GUARDRAILS.md))

## 5. Clock control

- The server has one clock, `clock.now()`. Tests pin it with `clock.setFixed(date)` and move it with a local `advance(ms)` helper (`api.test.ts:46-51`). [V-S] `clock.ts:23-25`
- Unit tests pass `now` as an argument (`computeLevel(…, now)`). [V-S]
- Thresholds are tested **at T−1 min and T+4 min 59 s** to prove "within 5 minutes" (AC-1, `api.test.ts:232-237`). [V-S] Keep this pattern for AC-2 and AC-3.
- The demo offset (`/api/dev/clock`, `setOffsetMs`) is never used by tests. [V-S]
- E2E cannot set the server clock without demo tools; e2e runs in a dev/test env with `DEMO_TOOLS=true` and the CoS persona. [A]
- Engine cadence (FR-8 "at least every 5 minutes") is a config fact (`ENGINE_INTERVAL_MS`, default 60 000 ms, `config.ts:67`) [V-S]; a startup check that it is ≤ 300 000 is *Proposed*. See [PERFORMANCE_TEST_PLAN.md](PERFORMANCE_TEST_PLAN.md).

## 6. Coverage targets [A] — for approval

| Area | Target | Why |
|---|---|---|
| `engine/*`, shared rules module, `services/access.ts` | 100 % of branches | WO WP-3 requires "automated tests for every rule in this order". [WO] |
| Every WO acceptance criterion AC-1…AC-9 | at least one automated test each; AC-10 is operational | [PROJECT_OVERVIEW §1.7](../01-discovery/PROJECT_OVERVIEW.md) |
| Every route with `:id` | one positive and one out-of-scope negative test | SEC-1 |
| Other services | ≥ 80 % lines | [A] |
| Client | no numeric target; e2e per workflow W1–W9 | [A] |

## 7. Running tests (when approved)

```
npm run typecheck                    # read-only, no approval needed
npx tsx client/src/selfcheck.ts      # pure, no DB, no approval needed
npm test                             # APPROVAL NEEDED: drops schema public on TEST_DATABASE_URL
```

Record each run in the inventory: date, command, pass/fail count, and the name of anything that failed. Until then every status stays "not run" or "planned".

## E2E: set up 2026-11-04 (R-3 approved)
- **Tool:** `@playwright/test` 1.56.1 (root dev dependency) with Chromium. Run `npm run e2e`. Config: `playwright.config.ts`. Specs and launcher: `e2e/`.
- **Isolation:** Playwright starts its own API (`e2e/server.ts`, port 4100) against database `taskwatch_e2e`, rebuilt from the migrations on every run (`drop schema public cascade`, this database only). It also starts its own Vite (port 5180, `VITE_BACKEND=server`), and uses a throwaway `TOTP_ENCRYPTION_KEY`. The dev DB and the dev servers (4000/5173) are never touched.
- **Typechecked:** `e2e/tsconfig.json`, included in `npm run typecheck`.
- **Rules learned:**
  - 2FA codes in tests are tied to the server-recorded step, never "now − 1". At the window's edge, a 30 s boundary makes the code invalid.
  - Locate the user menu by `aria-haspopup="menu"`, never by name alone: dev-login tiles share the name.
