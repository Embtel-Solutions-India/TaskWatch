# Implementation Tracker

> Last updated: 2026-11-07 (Phase 8 and PERF DONE). This file replaces the first draft [../IMPLEMENTATION_TRACKER.md](../IMPLEMENTATION_TRACKER.md), which is kept unedited for reference.
> **Status per row is current** (DONE, CODE_COMPLETE, IN_PROGRESS, ANALYSIS, READY, BLOCKED, REMOVED). The note "No backend work has started", written 2026-11-03, no longer applies. "Existing, not run" means a test in `server/test` asserts part of the feature and has never been executed in this effort ([EXISTING_SYSTEM_ANALYSIS §3.7](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)).
> Feature IDs come from [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md), including the IDs added later at its end. Phases and tasks: [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [TASK_BREAKDOWN.md](TASK_BREAKDOWN.md). Done means [DEFINITION_OF_DONE.md](../04-engineering-standards/DEFINITION_OF_DONE.md).

## Status definitions

| Status | Meaning |
|---|---|
| NOT_STARTED | No FRD section yet. No feature is in this state: all 93 have an FRD section. |
| ANALYSIS | The FRD exists, but the design still depends on something unsettled: a §8 question with a default not yet accepted, a Proposed ADR or design item, or a doc conflict. |
| READY | The FRD exists, the governing decisions are accepted, and nothing feature-specific is open. Work can start once the phase entry gate opens. |
| IN_PROGRESS | A task for it has started (code being written). |
| BLOCKED | A decision with no usable default stops the design: D-5, D-9, D-13 or D-17 from [OPEN_QUESTIONS §7.1](../01-discovery/OPEN_QUESTIONS.md) "Still open", or a WO-D decision. |
| CODE_COMPLETE | Backend and frontend integration written, typecheck exits 0, tests not yet run. |
| TESTING | Approved test runs in progress. |
| REVIEW | Code and security review against the DoD. |
| DONE | All 15 DoD points evidenced. |

**Phase gates are not repeated on each row.** Every feature that needs migration `002`+ inherits the **D-18** gate and the ADR approvals through T-1.1…T-1.9 (the Foundation phase). The Blockers column lists only decisions specific to the feature.

## Legend for stage columns

| Mark | Meaning |
|---|---|
| ✅ | done |
| 🟡 | partial. **FRD:** never partial. **Arch:** governed only by Proposed items (ADR-0007, ADR-0009, DATABASE_DESIGN, API_CONTRACTS, the SECURITY/SCALABILITY proposals). **DB:** designed in [DATABASE_DESIGN](../03-architecture/DATABASE_DESIGN.md) (Proposed), not written. **API:** contract in [API_CONTRACTS §2](../03-architecture/API_CONTRACTS.md) (Proposed). **Backend:** existing server code partly covers it, built for the old model (cited in Key files). **Tests:** an existing server test covers part of it, **existing, not run**. |
| ⬜ | not started |
| ⛔ | blocked by the decision in Blockers |
| — | not applicable (no schema change, or no server endpoint) |

Stage columns: FRD · Arch · DB · API · BE (backend) · FE (frontend integration) · Tst (tests) · Sec (security review) · QA · Doc (docs) · Done. Arch ✅ means an Accepted ADR or a decided D-number in OPEN_QUESTIONS §7.1 governs the design.

## Summary

| Status | Count |
|---|---|
| ANALYSIS | 25 |
| READY | 3 |
| BLOCKED | 0 |
| TESTING | 1 (AUTH-01a: mocked OAuth test) |
| DONE | 61 (Auth, Org/permissions, Task core, Escalation) |
| REMOVED | 2 (D-94) |
| **Total** | **92** (counted from the table, 2026-11-05) |

Priorities: **P0**: needed for a WO FR, AC or security rule. **P1**: prototype behaviour the approved UI relies on. **P2**: convenience. **P3**: dev only.

## Foundation progress (cross-cutting, 2026-11-04): **complete**. Moved out: T-1.7 and T-1.10 to the T-4.0 cutover; the identity switch to T-2.7.

| Task | What | Status | Evidence |
|---|---|---|---|
| T-1.11 | Error envelope: 422 + `fields`, pg errors → 409/422 (C-3) | CODE_COMPLETE | `server/test/errors.test.ts` 5/5 |
| T-1.12 | Not visible → 404, identical to missing (C-2, SEC-1) | CODE_COMPLETE | `api.test.ts` Security suite |
| T-1.13 | Rate-limit helper; uploads + Google callback (SEC-3) | CODE_COMPLETE | `server/test/rateLimit.test.ts` 3/3 |
| T-1.14 | Vite `/api` proxy | CODE_COMPLETE | live check `:5173/api/auth/config` → 200 |
| T-1.17 | Scheduler leader + migration lock (ESC-08) | CODE_COMPLETE | `api.test.ts` Scheduler leadership 2/2 |
| T-1.1 | Approve DATABASE_DESIGN and API_CONTRACTS | **Approved 2026-11-04** | gates T-1.5…T-1.10, T-1.15, T-1.16 |
| T-1.16 | Client HTTP transport (identity switch moved to T-2.7) | CODE_COMPLETE | self-check + live check against dev API |
| T-1.15 | `/api/me` bootstrap (AUTH-06) | CODE_COMPLETE | TC-AUTH-06-01/02 |
| T-1.2 | Shared ladder module (ADR-0007) | CODE_COMPLETE | `npm test` 53/53 incl. DST guard; live smoke ok |
| T-1.3 | Shared workflow: states incl. Blocked, R-1, R-2 | CODE_COMPLETE | `server/test/workflow.test.ts` 6/6 |
| T-1.4 | Shared permissions over `roles[]` (D-8, D-29, D-32, D-33) | CODE_COMPLETE | `server/test/permissions.test.ts` 7/7 |

Full suite: `npm test` 71/71, typecheck exit 0, client build ok (2026-11-04).

## Features

| ID | Name | Pri | Phase | Depends on | Status | FRD | Arch | DB | API | BE | FE | Tst | Sec | QA | Doc | Done | Blockers | Next action | Key files | Last updated |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AUTH-01 | Sign in (common rules for 01a/01b) | P0 | Auth | T-1.8, T-1.13 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `server/src/services/auth.ts`; `server/src/routes/auth.ts`; `client/src/features/auth/AuthPages.tsx`; `e2e/auth.spec.ts` | 2026-11-04 |
| AUTH-01a | Sign in with Google Workspace | P0 | Auth | AUTH-01 | TESTING | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ✅ | ⬜ | — | Automated test of the Google failure paths (mocked OAuth client); real Google configuration at release (D-89) | `server/src/routes/auth.ts` (Google callback, now recorded and audited) | 2026-11-04 |
| AUTH-01b | Sign in with email + password | P0 | Auth | AUTH-01, T-1.8 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `server/src/services/auth.ts`; `POST /api/auth/login`; tests AUTH-01-AC-1..6 + e2e | 2026-11-04 |
| AUTH-02 | Sign out | P1 | Auth | AUTH-01 | DONE | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `POST /api/auth/logout` (cookie cleared, audited); Shell sign-out in server mode | 2026-11-04 |
| AUTH-03 | Session timeout | P1 | Auth | AUTH-01, SET-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `server/src/http/middleware.ts` `requireUser` (idle from Settings, 12 h cap, per-request user check) | 2026-11-04 |
| AUTH-04 | Forgot / reset password | P1 | Auth | AUTH-01b, NTF-02 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `server/src/services/passwordReset.ts`; forgot/reset pages; e2e reset flow | 2026-11-04 |
| AUTH-05 | Admin "reset access" | P1 | Auth | AUTH-04, STAFF-02 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `POST /api/people/:id/reset-access` (manage_staff); `services/passwordReset.ts` | 2026-11-04 |
| AUTH-06 | Current user / capabilities (`/api/me`) | P0 | Foundation | T-1.4, T-1.6, ROLE-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | ✅ | — | — (done 2026-11-04: `npm test` all Auth cases pass, `npm run e2e` 3/3, selfcheck ok) | `server/src/services/me.ts`; `client/src/app/App.tsx` (server-mode bootstrap) | 2026-11-04 |
| AUTH-07 | TOTP enrolment (Manager, CoS, CEO) | P0 | Auth | AUTH-01b, STAFF-05 | REMOVED (D-94) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | ✅ | ⬜ | — | Removed by D-94 (no 2FA); WO deviation needs Founder's Office sign-off | `server/src/services/totp.ts`; migration 006; enrolment screen; e2e | 2026-11-04 |
| AUTH-08 | TOTP sign-in challenge | P0 | Auth | AUTH-07 | REMOVED (D-94) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ | ⬜ | ✅ | ⬜ | — | Removed by D-94 (no 2FA); WO deviation needs Founder's Office sign-off | `POST /api/auth/2fa/verify`; code step screen; e2e | 2026-11-04 |
| TASK-01 | Create task | P0 | Task core | ORG-02, STAFF-05, WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| TASK-02 | Save as draft / publish | P1 | Task core | TASK-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks (draft) + /publish` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| TASK-03 | Edit task | P1 | Task core | TASK-01, EXT-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `PUT /api/tasks/:id` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| TASK-04 | List tasks by scope | P0 | Task core | T-3.2, WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/tasks?scope=&view=` → `{items, truncated}` (`services/queries.ts` `listTasks`) | 2026-11-05 |
| TASK-05 | Task detail | P0 | Task core | TASK-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/tasks/:id` contract shape (`services/queries.ts` `taskDetail`) | 2026-11-05 |
| TASK-06 | Calendar | P2 | Task core | TASK-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/tasks?dueFrom&dueTo` | 2026-11-05 |
| TASK-07 | Bulk cancel / bulk acknowledge | P2 | Task core | WF-01, WF-08, ESC-06 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks/bulk/cancel, /bulk/acknowledge` | 2026-11-05 |
| TASK-08 | Picker data (assignees, parents) | P0 | Task core | T-3.2 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/tasks/options/assignees`, `/options/parents` | 2026-11-05 |
| TASK-09 | FR-10 quick views | P0 | Dashboards | TASK-04, ESC-06 | DONE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-49, D-26 | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `server/src/routes/tasks.ts:36` (`view=open\|mine\|escalated\|red\|blocked\|closed`) | 2026-11-06 |
| TASK-10 | Stage stripe and summary tiles | P0 | Dashboards | TASK-04, ESC-01 | DONE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-49; TC-TASK-10-02 (passed 2026-11-07) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `server/src/routes/tasks.ts:31` (`/tasks/summary`) | 2026-11-06 |
| WF-01 | Acknowledge task | P1 | Task core | TASK-05, WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/acknowledge` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-02 | Start work | P0 | Task core | TASK-05, WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/start` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-03 | Post progress update | P0 | Task core | WF-02, ATT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/progress` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-04 | Submit for review | P1 | Task core | WF-03 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` green; AC-3 built in T-5.1) | `/submit` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-05 | Mark complete (Done) | P0 | Task core | WF-02 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/complete` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-06 | Review decision | P1 | Task core | WF-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/review, GET /api/reviews` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-07 | Reassign | P0 | Task core | WF-10, T-3.2 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/reassign` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-08 | Cancel | P1 | Task core | WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/cancel` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-09 | Reopen | P1 | Task core | WF-05 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/reopen` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| WF-10 | Allowed actions | P0 | Task core | T-1.3 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `actions[]` on every TaskView (`services/access.ts` `taskActions` over shared `allowedActions`) | 2026-11-05 |
| WF-11 | Mark Blocked | P0 | Task core | WF-02, T-1.3 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `/block` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| EXT-01 | Request extension | P1 | Task core | WF-10 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks/:id/extensions` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| EXT-02 | Decide extension | P1 | Task core | EXT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/extensions/:id/decision` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| EXT-03 | Extensions queue | P1 | Task core | EXT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/extensions` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| EXT-04 | FR-5 direct due-date change | P0 | Task core | TASK-05 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks/:id/due` (`server/src/services/tasks.ts`, `routes/tasks.ts`) | 2026-11-05 |
| CMT-01 | Add comment / reply | P0 | Task core | TASK-05 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks/:id/comments (multipart)` | 2026-11-05 |
| CMT-02 | Edit comment | P2 | Task core | CMT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `PUT /api/comments/:id` | 2026-11-05 |
| CMT-03 | Delete comment (soft) | P2 | Task core | CMT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `DELETE /api/comments/:id (soft)` | 2026-11-05 |
| ATT-01 | Upload attachment | P0 | Task core | TASK-05, T-1.13 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST /api/tasks/:id/attachments (memory upload, type from bytes)` | 2026-11-05 |
| ATT-02 | Download / preview | P0 | Task core | ATT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/tasks/:id/attachments/:aid[?inline=1]` | 2026-11-05 |
| ATT-03 | Remove attachment | P2 | Task core | ATT-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `DELETE /api/attachments/:id (soft)` | 2026-11-05 |
| ESC-01 | Silence ladder | P0 | Escalation | T-1.2, WF-03 | DONE | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `engine/engine.ts`, `engine/levels.ts` `taskLevel`, `shared/levels.ts` | 2026-11-05 |
| ESC-02 | Past-due floor | P0 | Escalation | ESC-01, EXT-04 | DONE | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `shared/levels.ts` (`silencePaused`: floor runs while In review, D-25) | 2026-11-05 |
| ESC-03 | Highest rule wins; once per cycle | P0 | Escalation | ESC-01 | DONE | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `engine/engine.ts` `applyLevel` (reached_at, cycle_started_at, reason incl. `blocked`; migration 011) | 2026-11-05 |
| ESC-04 | Routing | P0 | Escalation | ESC-03, STAFF-05, ORG-02 | DONE | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `engine/routing.ts` (D-28 fall-through routed like L3) | 2026-11-05 |
| ESC-05 | Repeat alerts | P1 | Escalation | ESC-03 | DONE | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `engine/engine.ts` `repeatDue`/`repeatStamp` (window-boundary stamps) | 2026-11-05 |
| ESC-06 | Acknowledge escalation | P0 | Escalation | ESC-03 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `POST /api/escalations/:id/ack` → `{event, task}` (`services/tasks.ts` `acknowledge`, `queries.ts` `escalationView`) | 2026-11-05 |
| ESC-06a | Acknowledgement note | P0 | Escalation | ESC-06 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `POST /api/escalations/:id/ack` `{note}` (422 `fields.note`, 1000 max, sensitive-ID guard) | 2026-11-05 |
| ESC-07 | Due-soon / overdue notices | P1 | Escalation | ESC-02 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `engine/engine.ts` `sendDueNotices` (job_runs keys task@due) | 2026-11-05 |
| ESC-08 | Scheduler (≤ 5 min, on the server) | P0 | Escalation | T-1.17 | DONE | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `config.ts` `engineIntervalMs` (≤ 5 min), `POST /api/admin/engine/run` | 2026-11-05 |
| ESC-09 | Escalations workspace | P1 | Escalation | ESC-06 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `GET /api/escalations` (`queries.ts` `escalationList`); `EscalationsPage.tsx` | 2026-11-05 |
| NTF-01 | In-app inbox | P0 | Notifications | NTF-04 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` + `npm run e2e` | `routes/notifications.ts`; client `notificationsServer.ts`, `NotificationsPage`, `Shell` bell (60 s refresh) | 2026-11-05 |
| NTF-02 | Email + WhatsApp dispatch | P0 | Notifications | NTF-04 | CODE_COMPLETE | ✅ | ✅ | ✅ | — | ✅ | — | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-106 (WhatsApp off) | owner `npm test` | `notify/notify.ts`, `notify/dispatcher.ts` (`claimed_at` lease, email only) | 2026-11-05 |
| NTF-03 | Quiet hours | P0 | Notifications | NTF-02 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | WO-D4; D-108 | owner `npm test` + `npm run e2e` | `notify/notify.ts` `quietHold`; staff dialog "Own quiet hours" (D-105) | 2026-11-05 |
| NTF-04 | Notification preferences | P1 | Notifications | T-1.6 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-107 | owner `npm test` + `npm run e2e` | `shared/notifications.ts`, `services/prefs.ts`; client Account settings | 2026-11-05 |
| NTF-05 | Weekly digest (FR-12) | P0 | Notifications | NTF-02, RPT-05 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` | `services/digest.ts` (per organization, D-44 day/hour in IST); `POST /api/admin/digest` | 2026-11-05 |
| NTF-06 | Simulation mode | P1 | Notifications | NTF-02 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` | status derived from credentials (`services/settings.ts`, `/api/deliveries` `integrations`); Settings shows it read-only | 2026-11-05 |
| NTF-07 | Blocked alert to the lead | P0 | Notifications | WF-11, NTF-03 | ANALYSIS | ✅ | ✅ | — | — | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-23, D-42 | T-4.6, T-6.4 | `server/src/services/tasks.ts:152-156` | 2026-11-03 |
| NTF-08 | Chain-break system alert to the CoS | P0 | Notifications | AUD-02 | CODE_COMPLETE | ✅ | ✅ | — | — | ✅ | — | ✅ | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` (existing tests cover it) | `jobs/scheduler.ts` `runChainCheck` (built in T-1.9/T-4.13; mandatory type `system_alert`) | 2026-11-05 |
| DLV-01 | Delivery log | P0 | Notifications | NTF-02 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` + `npm run e2e` | `GET /api/deliveries` (D-52, 30 days, cap 2000); client `DeliveryLogPage` | 2026-11-05 |
| DLV-02 | My deliveries | P2 | Notifications | DLV-01 | CODE_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | — | owner `npm test` | `GET /api/me/deliveries`; Account "Messages sent to you" | 2026-11-05 |
| REC-01 | List schedules | P1 | Recurring | REC-02 | CODE_COMPLETE | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-33 | owner `npm test` + `npm run e2e` | `services/recurring.ts` `listRecurring`; client `adminServer.ts`, `RecurringPage` | 2026-11-06 |
| REC-02 | Create / edit schedule | P0 | Recurring | TASK-01, T-1.2 | CODE_COMPLETE | ✅ | 🟡 | ⛔ | ⛔ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | decided 2026-11-04 (was: **D-5**; D-9 ) | owner `npm test` + `npm run e2e` | `services/recurring.ts` `saveRecurring`, `shared/recurrence.ts`; client `adminServer.ts`, `RecurringPage` | 2026-11-06 |
| REC-03 | Pause / resume / delete | P1 | Recurring | REC-02 | CODE_COMPLETE | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-31 (not in OQ) | owner `npm test` + `npm run e2e` | `services/recurring.ts` `setRecurringActive`, `deleteRecurring`; client `adminServer.ts`, `RecurringPage` | 2026-11-06 |
| REC-04 | Generation | P0 | Recurring | REC-02, T-1.17 | CODE_COMPLETE | ✅ | 🟡 | ⛔ | — | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | decided 2026-11-04 (was: **D-5**; D-45, D-46 ) | owner `npm test` + `npm run e2e` | `services/recurring.ts` `runRecurring`, migration 013; client `adminServer.ts`, `RecurringPage` | 2026-11-06 |
| PERF-01 | Measured tasks (target, unit, estimate, purpose) | P1 | Performance | REC-02, TASK-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `routes/tasks.ts` `measuredFields`, `services/tasks.ts` `measuredErrors`, migration 014; client form, recurring dialog | 2026-11-06 |
| PERF-02 | Assignee report: achieved, result, shortfall reason | P1 | Performance | PERF-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `services/tasks.ts` `finishValues`, progress/complete/submit; client finish dialogs | 2026-11-06 |
| PERF-03 | Giver ratings: review scores, Rate step | P1 | Performance | PERF-02, WF-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `shared/workflow.ts` `rate`, `shared/performance.ts` `isRatable`, `rateTask`; client Review/Rate dialogs | 2026-11-06 |
| PERF-04 | Formulas: progress, outcome, timeliness, quality, score, efficiency | P1 | Performance | PERF-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `shared/performance.ts` | 2026-11-06 |
| PERF-05 | Team leaderboard and person breakdown | P1 | Performance | PERF-04 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `services/performance.ts`, `routes/performance.ts`; client `PerformancePages.tsx` | 2026-11-06 |
| PERF-06 | Workload (estimated hours vs working hours) | P1 | Performance | PERF-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ⬜ | ✅ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `shared/performance.ts` `workload`, `/api/workload`, assignee picker load | 2026-11-06 |
| PERF-07 | Employee dashboard tiles (own score, progress, load) | P2 | Performance | PERF-05, DASH-01 | DONE | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-110…D-121 (2026-11-06) | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | Phase 8 | 2026-11-06 |
| DASH-01 | Role dashboard | P0 | Dashboards | DASH-03, ESC-01 | DONE | ✅ | 🟡 | — | 🟡 | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-49, D-51; ADR-0007 | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `server/src/routes/dashboard.ts:13`; `client/src/features/dashboard/insights.ts` | 2026-11-06 |
| DASH-02 | Team overview | P1 | Dashboards | DASH-03 | DONE | ✅ | 🟡 | — | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-51 | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `client/src/features/staff/TeamPage.tsx:17` | 2026-11-06 |
| DASH-03 | Server-side scoping of every aggregate | P0 | Dashboards | T-3.2 | DONE | ✅ | 🟡 | — | 🟡 | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-51 | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `server/src/services/reports.ts`; unscoped reads `client/src/features/dashboard/DashboardPage.tsx:107-119` | 2026-11-06 |
| RPT-01 | Report scope | P0 | Reports | T-3.2 | CODE_COMPLETE | ✅ | 🟡 | — | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-51 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `client/src/services/api/misc.ts:135` | 2026-11-07 |
| RPT-02 | Nine reports | P1 | Reports | RPT-01 | CODE_COMPLETE | ✅ | 🟡 | — | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-50, D-5 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `client/src/services/api/misc.ts:152,240-276` | 2026-11-07 |
| RPT-03 | CSV export | P0 | Reports | RPT-02 | CODE_COMPLETE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-53 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `server/src/services/exports.ts:9-10` (guard misses tab/CR, S-13) | 2026-11-07 |
| RPT-04 | Scoped filter option lists | P1 | Reports | RPT-01 | CODE_COMPLETE | ✅ | 🟡 | — | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | — | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | unscoped `client/src/features/reports/ReportsPages.tsx:85-111` | 2026-11-07 |
| RPT-05 | FR-11 accountability by entity | P0 | Reports | RPT-01, ESC-01 | CODE_COMPLETE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-49 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `server/src/services/reports.ts` | 2026-11-07 |
| RPT-06 | FR-11 accountability by person | P0 | Reports | RPT-01 | CODE_COMPLETE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-50 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `server/src/services/reports.ts` | 2026-11-07 |
| RPT-07 | FR-11 PDF export | P0 | Reports | RPT-05, RPT-06 | CODE_COMPLETE | ✅ | ✅ | — | 🟡 | 🟡 | ⬜ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-53 | owner `npm test` + `npm run e2e`; dev smoke when Postgres is up | `server/src/services/exports.ts`; `server/src/routes/dashboard.ts:21-37` | 2026-11-07 |
| STAFF-01 | Staff directory | P0 | Org/permissions | T-3.2 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/people` (`server/src/routes/people.ts`, `services/staff.ts` `listPeople`) | 2026-11-05 |
| STAFF-02 | Create / edit person | P0 | Org/permissions | STAFF-05, T-1.11 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `POST/PUT /api/people` (`services/staff.ts` `createPerson`, `updatePerson`) | 2026-11-05 |
| STAFF-03 | Activate / deactivate (archive) | P0 | Org/permissions | AUTH-03 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green; browser-checked in T-3.8) | `POST /api/people/:id/status` (`services/staff.ts` `setPersonStatus`) | 2026-11-05 |
| STAFF-04 | Staff profile | P1 | Org/permissions | STAFF-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/people/:id` (`services/staff.ts` `personProfile`) | 2026-11-05 |
| STAFF-05 | Multiple roles per person | P0 | Org/permissions | T-1.4, ROLE-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `roles[]` in `services/staff.ts` `personSchema` | 2026-11-05 |
| ORG-01 | Org tree and teams | P1 | Org/permissions | STAFF-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/org` (`services/staff.ts` `orgView`) | 2026-11-05 |
| ORG-02 | Move person (one transaction) | P0 | Org/permissions | ORG-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `PUT /api/people/:id/placement` (`services/staff.ts` `setPlacement`) | 2026-11-05 |
| ROLE-01 | Permission matrix (view) | P1 | Org/permissions | T-1.6 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green; browser-checked in T-3.8) | `GET /api/roles` (`server/src/routes/admin.ts`); `services/permissions.ts` `getRoleMatrix`, `roleCounts` | 2026-11-05 |
| ROLE-02 | Edit role permissions | P1 | Org/permissions | ROLE-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green; browser-checked in T-3.8) | `PUT /api/roles/:role`; `services/permissions.ts` `saveRolePermissions`; migration 008 | 2026-11-05 |
| POL-01 | Escalation policy (global) | P0 | Escalation | ESC-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `PUT /api/rules/default` (`services/rules.ts` `checkRules`; re-evaluates on the request) | 2026-11-05 |
| POL-02 | Policy simulator | P2 | Escalation | T-1.2 | DONE | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `AdminPages.tsx` simulator on `shared/levels.ts`; parity test in `rules.test.ts` | 2026-11-05 |
| POL-03 | Per-entity SLA overrides | P0 | Escalation | POL-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` green; browser-checked) | `PUT/DELETE /api/rules/:entityId` (D-48: windows and multiples) | 2026-11-05 |
| SET-01 | System settings | P1 | Org/permissions | T-1.6 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET/PUT /api/settings` (`services/settings.ts`) | 2026-11-05 |
| AUD-01 | Audit log | P0 | Task core | T-1.9 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/audit, /api/audit/export.csv (`services/auditView.ts`)` | 2026-11-05 |
| AUD-02 | Integrity check, nightly and manual | P0 | Task core | AUD-01 | DONE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — (done 2026-11-05: owner `npm test` and `npm run e2e` all green) | `GET /api/audit/integrity, POST /api/audit/chain-check`; manual "Check integrity now" button added 2026-11-06 (KI-43) | 2026-11-05 |
| SRCH-01 | Global search | P2 | Dashboards | T-3.2, T-1.13 | DONE | ✅ | 🟡 | — | 🟡 | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | D-33, D-82 | DONE 2026-11-07 (owner: `npm test` + `npm run e2e` all green) | `server/src/routes/tasks.ts:36` (`q` only) | 2026-11-06 |
| DEMO-01 | Demo bar and dev clock | P3 | Demo | AUTH-06 | CODE_COMPLETE | ✅ | ✅ | — | ✅ | ✅ | ✅ | 🟡 | ⬜ | ⬜ | ⬜ | ⬜ | D-17, D-47 | owner `npm test` (TC-DEMO-01-01/02); browser check in server mode with `DEMO_TOOLS=true` | `server/src/config.ts` `demoToolsAllowed`; `server/src/routes/admin.ts` `/dev/clock`; `client/src/features/demo/ServerClockBar.tsx` | 2026-11-07 |

## Notes on the honest marks
- **Backend 🟡** means the old-model server has code for the behaviour. It still has to be reshaped to the new model ([FEATURE_GAP_ANALYSIS §5.3](../01-discovery/FEATURE_GAP_ANALYSIS.md)). It is not "half done".
- **Tests 🟡** never means passing. All 38 existing tests are *existing, not run*. AUTH-07 has no test case (removed by D-94); TASK-10 gained TC-TASK-10-02 in Phase 8 ([RTM §3](REQUIREMENT_TRACEABILITY_MATRIX.md)).
- **FE ⬜ everywhere:** every screen exists on the localStorage mock, but none calls the server yet.
