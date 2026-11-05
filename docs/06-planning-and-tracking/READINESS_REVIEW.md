# Development Readiness Review

**Date:** 2026-11-04. **Reviewer:** AI agent. **Approval:** awaiting the product owner. Implementation does not start until it is approved.

## 1. Scope and method

**Read:**
- every doc in `docs/01`–`08`
- `AGENTS.md`
- the Work Order PDF
- the code that the docs make claims about

**Checked by script (repeatable, results below):**
- markers in the docs that still say a decision is open
- `client/src/services/api/*` exports against `API_CONTRACTS`
- `client/src/types/index.ts` fields against `DATABASE_DESIGN`
- tracker statuses against the Decision Register

**Checked by hand:**
- every decided value that changes stated behaviour
- consistency of the action matrix, business rules and FRDs for the affected rules
- security findings against the code as it is now
- whether the shared module (ADR-0007) can actually be built with the current tooling

**Run (2026-11-04):** `npm test` 48/48 · `npm run typecheck` exit 0 · `npm run build` ok (chunk-size warning only) · `npx tsx client/src/selfcheck.ts` ok (122 tasks, 141 escalation events, 31 people).

**Not done:**
- A line-by-line re-derivation of each of the 13 FRDs. They were spot-checked only.
- Any UI run-through.
- Any load or performance measurement.

## 2. Verdict

| Area | Ready? | Condition |
|---|---|---|
| Foundation: shared rules module (T-1.2…T-1.4) | **Yes** | ADR-0007 is accepted. No schema or endpoint dependency. |
| Foundation: migrations, `/api/me`, client fetch adapter (T-1.5…T-1.10, T-1.15, T-1.16) | **No** | Needs **T-1.1**: the owner's approval of `DATABASE_DESIGN` and `API_CONTRACTS` (§6). |
| Escalation and task-core phases | **No** | Needs T-1.1 plus **R-1** and **R-2** (§5). |
| Any feature reaching DONE | **No** | The DoD requires e2e tests and the e2e tool is not approved (**R-3**). |
| BAIS pilot (WP-6) | **No** | WO-D2…D7 not confirmed by the Founder's Office. WhatsApp sender not decided (WO-D6). |

## 3. Current implementation state (verified)

| Task | State | Evidence |
|---|---|---|
| T-1.11 error envelope | CODE_COMPLETE | `server/test/errors.test.ts` 5/5 |
| T-1.12 not visible → 404 | CODE_COMPLETE | `api.test.ts` Security suite |
| T-1.13 rate limiting | CODE_COMPLETE (uploads, Google callback) | `server/test/rateLimit.test.ts` 3/3 |
| T-1.14 Vite proxy | CODE_COMPLETE | live check `:5173/api/auth/config` → 200 |
| T-1.17 scheduler and migration locks | CODE_COMPLETE | `api.test.ts` Scheduler leadership 2/2 |
| Every feature in the tracker | ANALYSIS (76) or READY (16); none IN_PROGRESS | [IMPLEMENTATION_TRACKER](IMPLEMENTATION_TRACKER.md) |

**Note:** these Foundation tasks were implemented before this review, on the owner's instructions of 2026-11-04. This review covers what remains.

## 4. Findings

| # | Sev. | Area | Finding | Action |
|---|---|---|---|---|
| F-1 | High | All requirement docs | **175 markers in 37 docs** still called decided questions "open" or "proposed" after "accept defaults" (§9). Acceptance criteria worded "follows the answer to D-n" could not be tested. | **Fixed:** markers relabelled `[D-n, decided]`. Every value that changes behaviour is now written inline: D-23, 24, 25, 27, 28, 29, 30, 31, 32, 33/40, 34, 35, 51, 75, 80. The 13 FRDs' "Open points" sections are now "Decision points (all decided)". OPEN_QUESTIONS is retitled **Decision Register**. |
| F-2 | **High** | ESC-06 | **The accepted default for D-26 is unsafe.** "to + cc may acknowledge" lets the **cc'd assignee acknowledge their own L1 escalation** and silence repeats to their lead. It contradicts WO FR-9 ("the person an escalation reached") and the passing test "copied assignee cannot acknowledge". The default was the reviewer's own earlier proposal. | **Needs the owner: R-1.** The docs use the recommended value meanwhile, marked pending. |
| F-3 | Medium | WF-05 | D-20 did not settle whether a task can be marked **Done directly from Open or Blocked**. The WO says "Staff … mark Done", and the server allows it; the prototype requires In progress first. The relabel in F-1 had made this look decided. | **Needs the owner: R-2.** Marked in USER_ROLES_AND_PERMISSIONS and TASK-WORKFLOW-FRD. |
| F-4 | Medium | DoD / testing | DoD point 11 requires e2e tests. The tool (Playwright) is *Proposed — needs approval*, and it is a new dev dependency. The test-coverage flag and a load tool are also unapproved. | **Needs the owner: R-3.** |
| F-5 | Medium | Tracker | 7 features were BLOCKED on D-5, D-9, D-13 and D-17, all now decided. The summary said 93 features; the table has 92. Foundation progress was not shown. | **Fixed:** the 7 moved to ANALYSIS, the counts corrected, and a Foundation progress table added. |
| F-6 | Medium | Docs vs code | The snapshot docs still said: no rate limiting (S-1), duplicates → 500 (S-8), the scheduler runs in every instance (S-15), zod → 400, not visible → 403. | **Fixed** in EXISTING_SYSTEM_ANALYSIS §3.8, SECURITY_ARCHITECTURE §10, API_CONTRACTS, SYSTEM_ARCHITECTURE, ERROR_HANDLING, TASKS-FRD and COLLABORATION-FRD. |
| F-7 | Low | Docs vs code | 295 line references point into files changed on 2026-11-04 and may be off by a few lines. | Recorded as KNOWN_ISSUES KI-11, with a snapshot note. The function or route named next to each reference is authoritative. |
| F-8 | Medium | WF-11 / ESC | D-24: Blocked puts the task at L1 or higher. If built naively, the lead would get two alerts for one event: the Blocked alert and an L1 escalation. | Rule written as BR-06/BR-04: the Blocked alert **is** the L1 notification [A]. Confirm at implementation. |
| F-9 | Medium | NTF / pilot | D-75 sets WhatsApp opt-in **off** by default, as Meta policy requires. AC-5 expects alerts "on WhatsApp and email". | Pilot risk: collect opt-ins from BAIS staff before the pilot. Added to §8. |
| F-10 | Low | TASK-01 | D-63 derives the entity rather than having the assigner pick it. WO FR-1 lists entity as an assignment field. | Acceptable: the entity is recorded on every task. Revisit if a person works across entities. |
| F-11 | Info | API design | All **86/86** client mock-API functions have an endpoint in API_CONTRACTS. | None. |
| F-12 | Info | DB design | All 18 persisted client entities (194 fields) are mapped. 26 fields are stored under renamed existing columns or as whole JSON documents (`sla_rules.config`, `app_state.settings`). Verified, including `teams.entity_id` for Department = Entity. | None. |
| F-13 | Medium | ADR-0007 | The shared module has to work under `nodenext` (server) and `bundler` (client). The server ladder uses `Date` and luxon; the client's uses epoch ms and `Intl`. The client also has its own `quietEndsAt` in `channels.ts`. | Folded into the first task's acceptance criteria (§7). The 21 rule tests are the regression guard. |
| F-14 | Low | Planning | T-1.2 listed T-1.1 (schema approval) as a dependency. It touches no schema or endpoint. | Corrected in §7. TASK_BREAKDOWN is updated when T-1.2 starts. |
| F-15 | Low | Roadmap, ADR-0007 | The roadmap still named T-1.11 (done) as the first task. ADR-0007 said the rule tests were "not executed". | **Fixed.** |
| F-16 | Low | Repo | **Closed 2026-11-06** (drafts gone, README refreshed). Was: the superseded drafts `docs/FRD.md` and `docs/IMPLEMENTATION_TRACKER.md` still exist. README Layout is stale (D-19: refresh when integration starts). An API process started by the agent (pid 15752) may still be running (KI-12). | Owner: allow removing the drafts; stop pid 15752. |

## 5. Open decisions (everything else is in the Decision Register)

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| **R-1** | Re-decide D-26: who may acknowledge an escalation? | "To" recipients of that level, plus any CoS. Scope: that level only. Matches WO FR-9, the server and its existing test. | Escalation phase (ESC-06) |
| **R-2** | May a task be marked Done directly from Open or Blocked (no review required)? | **Yes.** WO "Staff … mark Done"; the server allows it; fewer clicks for staff. The review loop still applies when review is required. | Task-core phase (WF-05) |
| **R-3** | Approve the e2e tool (Playwright, new dev dependency), `node --test --experimental-test-coverage` (built in), and a load tool? | Playwright: yes (per-context time zones for AC-9). Coverage flag: yes. Load tool: defer; a `fetch` script is enough at pilot volume. | Any feature reaching DONE |
| **T-1.1** | Approve the proposals in DATABASE_DESIGN (incl. `admin_log` chaining), API_CONTRACTS §2, SECURITY_ARCHITECTURE (TOTP key env var, session lifetime, upload pipeline), INTEGRATION_DESIGN and SCALABILITY §3–4 | Approve as written. F-11 and F-12 found no coverage gap. | Migrations onward |
| WO-D2…D7 | The Founder's Office confirms SLA windows, ladder, quiet hours, pilot entity, WhatsApp sender, CEO alerts | The WO defaults are built in as settings | Pilot only |

## 6. Implementation order

Order rule: dependencies first, then WO acceptance criteria (P0), then risk, front-loaded.

1. **Foundation (WP-1).** Done: T-1.11–14, T-1.17. Remaining, in this order:
   1. **T-1.2–T-1.4**, the shared module. It is the lowest-risk enabler and removes duplicated code before more code is built on it.
   2. **T-1.1** approval.
   3. **T-1.5–T-1.9**, migrations: additive first, then backfill, then constraints, then auth, then audit chain.
   4. **T-1.10**, adapt the server tests.
   5. **T-1.15** `/api/me`.
   6. **T-1.16**, the client fetch adapter.

   *Risk:* the migrations reshape `taskwatch` on the next server start (auto-migrate; D-18 approved). Back up before T-1.6.
2. **Auth (WP-1).** Password sign-in, with `login_attempts` limits, sessions and TOTP for manager, CoS and CEO. *Why here:* every later screen needs a real session; this is WO security.
3. **Org/permissions (WP-1).** Entities, teams, multiple roles, the permission matrix, staff and org admin. *Why:* visibility and routing depend on the reporting line (WO).
4. **Task core (WP-2).** Covers FR-1–FR-6: create, the states including Blocked, updates, comments, due changes, reassign, attachments. *Gates:* R-2.
5. **Escalation (WP-3).** Covers FR-8, FR-9, AC-1–AC-3. *Gates:* R-1. *Risk:* highest business value; the existing engine and tests carry it.
6. **Notifications (WP-4).** Covers AC-5, quiet hours, preferences, the digest (FR-12), the delivery log.
7. **Recurring (WP-2/FR-7).** Runs in parallel with Escalation. Agree the one-week slip with the CoS (MILESTONES).
8. **Dashboards → Reports (WP-5).** Covers FR-10, FR-11, AC-8, CSV and PDF.
9. **Demo gating, then Release (WP-6).** Covers AC-6–AC-10 and the pilot.

The detail is in [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md) and [TASK_BREAKDOWN](TASK_BREAKDOWN.md). The order above matches them, with one correction: T-1.2 no longer waits for T-1.1.

## 7. First backend implementation task

**T-1.2: Shared escalation-ladder module (`shared/levels.ts`)**

| | |
|---|---|
| **Feature IDs** | ESC-01 (silence ladder), ESC-02 (past-due floor), ESC-03 (highest level wins), NTF-03 (quiet hours), POL-02 (policy simulator uses it). Rule: "never repeat code" (D-9, ADR-0007). |
| **Objective** | Replace the two copies of the ladder math with one dependency-free module that both the server and the client import, without changing any behaviour. Copy 1: `server/src/engine/levels.ts`, which uses `Date` and luxon. Copy 2: `client/src/services/engine/escalation.ts` plus `quietEndsAt` in `client/src/services/channels.ts`, which use epoch ms and `Intl`. |
| **Dependencies** | ADR-0007 (accepted). Nothing else: no schema, endpoint or R-decision. |
| **Approvals needed** | **Yes:** this approval of the review. **Yes:** running `npm install` to link the new workspace, which changes `package-lock.json` but adds no external package. **No** DB change. |

**Required files**

New:
- `shared/package.json`: `@taskwatch/shared`, private, `exports` pointing at the `.ts` sources
- `shared/levels.ts`

Changed:
- root `package.json`: add `shared` to `workspaces`
- `server/package.json` and `client/package.json`: add the dependency `"@taskwatch/shared": "*"`
- `server/src/engine/levels.ts`: becomes a thin adapter (`Date` ↔ ms) or is removed and its importers updated. Its importers are `engine/engine.ts`, `notify/messages.ts`, `notify/notify.ts`, `services/queries.ts` and `test/rules.test.ts`.
- `client/src/services/engine/escalation.ts`: same treatment. Its importers are `AdminPages.tsx`, `TaskDetailPage.tsx`, `TaskFormPage.tsx`, `selfcheck.ts`, `services/api/base.ts`, `services/channels.ts` and `services/core.ts`.
- `client/src/services/channels.ts`: uses the shared `quietEndsAt`.

No file is deleted without asking.

**Acceptance criteria**
1. Exactly one implementation of `silenceThresholds`, `computeLevel`, `levelApplies`, `isQuietTime` and `quietEndsAt` exists, in `shared/levels.ts`. A grep for those function bodies elsewhere finds only thin adapters.
2. `shared/` has no dependencies and no Node or DOM APIs. Time zones use `Intl`. Relative imports use `.js`.
3. The module takes a minimal structural rules type: windows, multiples, overdue offsets, quiet hours. Both the server and the client `RulesConfig` satisfy it without casts. This is compatible with D-48.
4. `server/test/rules.test.ts`: all 21 tests pass **with unchanged assertions**. Only import paths and `Date`↔ms adapters may change. This includes the IST/PT and quiet-hour boundary tests, which guard the luxon → `Intl` change.
5. `npm test` 48/48. `npm run typecheck` exits 0 for both workspaces. `npm run build` (client) succeeds.
6. `npx tsx client/src/selfcheck.ts` prints `selfcheck ok` with the same counts as the baseline: 122 tasks, 141 escalation events, 31 people.
7. Docs: ADR-0007's verification note is updated, TASK_BREAKDOWN T-1.2 is marked, KI-10 is resolved, and project memory is updated.

**Verification steps**
1. Record the baseline: `npm test` (48/48), typecheck, selfcheck counts. All were recorded in this review.
2. After the change: `npm install`, then `npm test`, `npm run typecheck`, `npm run build`, `npx tsx client/src/selfcheck.ts`.
3. Run `grep -rn "function computeLevel\|function isQuietTime\|function quietEndsAt" server/src client/src shared`. Expect `shared/levels.ts` only.
4. Live smoke test: the server starts and runs an engine tick without errors, and the client dev server loads a task detail page that shows the escalation clock.

**Rollback:** the change touches no data. Reverting the files plus `npm install` restores the previous state.

## 8. Risks to watch

| Risk | Mitigation |
|---|---|
| luxon → `Intl` changes quiet-hour results at DST or zone edges | The 21 rule tests are the gate. Add DST-edge cases if any test needs adjusting (owner approval for any assertion change). |
| Auto-migrate on start reshapes the dev DB once 002 exists | D-18 approved. Back up `taskwatch` before T-1.6 (the backfill). Migration lock now in place. |
| WhatsApp opt-in default off (F-9) | Collect opt-ins before the BAIS pilot. Otherwise AC-5 shows email and in-app only. |
| Pool connection held by the scheduler leader (9 of 10 left) | Monitor; raise the pool `max` if needed. |
| No e2e tool (R-3) | Decide R-3 before the first feature reaches TESTING. |
