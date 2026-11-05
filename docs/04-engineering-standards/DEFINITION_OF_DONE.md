# Definition of Done (per feature)

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> A feature is one canonical ID from [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md) (for example `WF-11`). It moves to **DONE** in [IMPLEMENTATION_TRACKER.md](../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) only when all 15 points below are evidenced. "Evidence" means something a reviewer can open. A claim alone does not count.

| # | Point | How it is evidenced | Where it is checked |
|---|---|---|---|
| 1 | **FRD satisfied** | Every bullet of the feature's PRD row is mapped to code (file:line) in the change description. Every deviation has a D-number. | [PRD](../02-product-requirements/PRODUCT_REQUIREMENTS.md), [FRD.md](../FRD.md) |
| 2 | **Acceptance criteria met** | Each feature AC and each related WO AC-n has at least one test case in [TEST_CASE_INVENTORY.md](../05-testing-and-qa/TEST_CASE_INVENTORY.md) with status `run: pass` and the date of the run. | Test inventory; AC table in [PROJECT_OVERVIEW §1.7](../01-discovery/PROJECT_OVERVIEW.md) |
| 3 | **Backend done** | The endpoint exists under `/api` and is mounted in `app.ts`. Business logic is in a service. `npm run typecheck` exits 0 (command and output pasted). | [CODING_STANDARDS §2](CODING_STANDARDS.md) |
| 4 | **Frontend integrated** | The page calls the endpoint through `useApi` / `useAction`. No `getDb()` or mock import remains in the files the feature touches. [V-C] `hooks/index.ts:11-44` | grep result in the change description |
| 5 | **DB changes via migration** | A new numbered file in `server/src/db/migrations/`. No applied migration edited. Backup taken before applying (outside dev). | [DATABASE_MIGRATION_POLICY.md](DATABASE_MIGRATION_POLICY.md) |
| 6 | **Authn / authz** | The route is behind `requireUser` (C-1). Every `:id` has an object-level check through `services/access.ts`. An integration test proves a user outside scope gets 403/404. | [SECURITY_TEST_PLAN.md](../05-testing-and-qa/SECURITY_TEST_PLAN.md) §IDOR |
| 7 | **Validation** | A zod schema at the route, rejecting unknown fields (NFR SEC-7). Limits match the UI (same min/max). The sensitive-ID guard runs on any free text (C-6). A test covers at least one invalid input. | [CODE_REVIEW_GUIDELINES.md](CODE_REVIEW_GUIDELINES.md) §Validation parity |
| 8 | **Security checks** | The relevant rows of [SECURITY_TEST_PLAN.md](../05-testing-and-qa/SECURITY_TEST_PLAN.md) are run. No secret in the diff. No new S-n finding left unrecorded. | Security plan |
| 9 | **Unit tests** | Pure logic (ladder, state machine, permission rules, formatting) has `node:test` cases that need no DB, like `server/test/rules.test.ts`. [V-S] | `npm test` output (approval needed, see guardrails §2.6) |
| 10 | **Integration tests** | Real HTTP against the isolated test DB, following `server/test/api.test.ts`. [V-S] | Same run |
| 11 | **E2E tests** | A UI-level script for the feature's main workflow (W1–W9 in the PRD). The e2e tool is *Proposed — needs approval* ([TESTING_STRATEGY.md §3](../05-testing-and-qa/TESTING_STRATEGY.md)). Until it is approved, a manual run of the matching [QA_CHECKLIST.md](../05-testing-and-qa/QA_CHECKLIST.md) section, dated and signed, is the evidence. | QA checklist |
| 12 | **Error handling** | Every failure returns the envelope and status from [ERROR_HANDLING.md](ERROR_HANDLING.md). 422 shows inline in the UI; others show as a toast or `ErrorState`. No DB error reaches the user as a 500 (S-8). | Integration test for one 4xx path |
| 13 | **No regression** | The full suite was run (with approval) and every previously passing test still passes. `npx tsx client/src/selfcheck.ts` still passes. No assertion was weakened ([AI_AGENT_GUARDRAILS §2.5](AI_AGENT_GUARDRAILS.md)). | Run output |
| 14 | **Docs updated** | The PRD row, any ADR, the API notes, and [../08-operations/](../08-operations/) docs if env vars, jobs or the runbook changed. Evidence tags on every new fact. | Diff of `docs/` |
| 15 | **Tracker updated** | The [IMPLEMENTATION_TRACKER.md](../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) row shows status, backend, frontend, security and tests columns, and "Remaining" is empty. Hand-off notes in [../07-project-memory/](../07-project-memory/). | Tracker |

## Current state

As of 2026-11-03 no feature meets point 2, 9, 10 or 13. That is because **no test has been run** ([D-18, decided](../01-discovery/OPEN_QUESTIONS.md)), not because tests fail. Points 9 and 10 can be reached for the engine (ESC-01..05) as soon as the run is approved, because the tests already exist. [V-S] `server/test/*.ts`

## What "done" is not
- Not "the screen looks right": C-2 says the UI is never the control.
- Not "the tests pass with the mock": the mock (`client/src/services/mock/*`) is not a production path.
- Not "works in dev": demo tools and dev login must be off in production (SEC-10).
