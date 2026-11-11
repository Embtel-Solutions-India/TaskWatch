# Session Handoff

Each session appends its entry at the top. Write facts only, and link to documents instead of restating them.

## 2026-11-07 (commit + whole-codebase review; highs fixed)
- Owner: "commit and review the whole code base", then "fix highs". Committed `7ad7d98` on new branch `phases-8-10` (not pushed; `server/smoke-reports.mts` left out). The H1–H5 fixes are **uncommitted** on top.
- Fixed KI-51…55 (see KNOWN_ISSUES). Open review findings: KI-56; owner said "then we will see". Open question for the owner: one meaning of on-time for D-50 (completion vs submission).
- Postgres: service start type was switched to Manual on 2026-11-06 23:59 and it was stopped at 00:52, so it does not start with Windows. Start it as admin (`net start postgresql-x64-18`, or `sc.exe config postgresql-x64-18 start= auto` to restore autostart).
- **2026-11-10:** Postgres running (auto-start). Two stale tests fixed (CHANGELOG); owner `npm test`, `npm run e2e` and the reports smoke all green; H4 browser check **passed**; tracker swept (93 DONE).
- **2026-11-10 later:** every board refreshes every 60 s while visible and on tab focus (`App.tsx`), browser-verified.
- **2026-11-10 later:** e2e green; org page redesigned as a top-down chart (CHANGELOG). Owner to approve deleting the unused `.org-tree`/`.org-card` CSS, and to decide whether the CEO should count as "No manager" (shared rule in OrgPage, StaffPages, misc.ts).
- **2026-11-10 latest:** KI-57 shell offset fixed for all users; dashboards are masonry (no row gaps). Not re-run after these: `npm run e2e`.
- **2026-11-11:** D-124 leaderboard = weighted Outcome Score (Settings priority weights); owner to run `npm test` (2 new API tests) and answer D-125 (over-average-time reason).
- **2026-11-11 later:** D-125 built (standard task times, recommended estimate, working-time over-run reason, reviewer view). Owner to run `npm test`; some older API tests may need a reason where a 1 h-estimate task now runs over. Offered: welcome / set-password email on person creation (not built).
- **2026-11-11 last:** D-126/127/128 done (no welcome email; CEO not flagged; leaderboard visuals + analytics endpoint); old org CSS and smoke file deleted. Owner: `npm test`. Charts are unproven with real data: dev has no scored tasks.
- **2026-11-11:** sign-in page redesigned from the owner mockup (illustration panel, icon inputs, password toggle). Unused `.ladder` CSS awaits a delete decision.
- **2026-11-11 tests:** `npm test` 254/254 green after the test-setup fixes. Next: owner `npm run e2e`, then PERF-04/05 → DONE.
- **2026-11-11 final:** `npm test` 254/254 + e2e 3/3 green; PERF-04/05 DONE (93/98). Nothing committed. Left: DEMO-01 browser check, optional sample scored data for the charts.
- **2026-11-11 (ADR-0011):** verticals and departments plus automatic reporting lines are built; `npm test` 260/260 and e2e 3/3 green. Owner: browser check of /admin/verticals, then the CoS sets each vertical's general manager and renames the lead-named teams on /admin/verticals (D-132). Until a GM is set, a vertical's lines change only when someone in it is edited, and then they fall back to the CoS.
- **2026-11-11 (D-133):** the task giver can reassign their task and delete drafts (hidden, never deleted); Edit / Reassign / Delete are buttons and row-menu items. Owner: `npm test`.
- **2026-11-11 release:** pushed to `main` (fast-forward) for production at the owner's request. Earlier: `npm test` 264/264 green; committed and pushed on `phases-8-10` at the owner's request. `npm run e2e` was last green before sign-in v2 and D-133 (re-run recommended). Go-live: DEPLOYMENT.md "First production start" (hand-run SQL; the bootstrap command was removed after the push, uncommitted).
- **Resume here:** delete `server/smoke-reports.mts` (owner approval) → DEMO-01 browser check (`DEMO_TOOLS=true`, CoS + non-CoS) → commit the H1–H5 fixes if the owner asks → owner picks from KI-56.
- Verified 2026-11-10: `npm run typecheck` 0; owner `npm test`, `npm run e2e` and the reports smoke all green (incl. the `Review fixes 2026-11-07` tests); H4 browser check passed.

## 2026-11-07 (Phase 9 check; Phase 10 Demo: T-10.1, code-complete)
- Owner: "check phase 9 and then 10". **Phase 9 still code-complete, not DONE:** PostgreSQL service `postgresql-x64-18` is stopped and `net start` needs admin (access denied), so `npm test`, e2e and `server/smoke-reports.mts` remain unrun.
- Phase 10 built: see the DEMO-TOOLS-FRD built note. Server: `demoToolsAllowed` (config), `/dev/clock` 404 before the role check, `.strict()` body. Client: `ServerClockBar` (clock only; CoS controls; offset bar for all).
- Verified: `npm run typecheck` 0; `config.test.ts` 5/5; server-mode production build scanned clean of demo strings and the demo password. **Not run:** `npm test` (new TC-DEMO-01-01/02 in `api.test.ts`), e2e, browser check (needs Postgres).
- Owner: start Postgres (admin), then `! npm test`, `! npm run e2e`, the reports smoke, and a server-mode browser check with `DEMO_TOOLS=true` as CoS and a non-CoS. Next: Phase 11 Release.

## 2026-11-07 (Phase 9 Reports: T-9.1…T-9.4, code-complete)
- Owner: "phase 9 start". D-123 decided (FR-11 also 403 for staff). Built: see the REPORTS-FRD built note and API_CONTRACTS §2.1.
- **Report rules only in `shared/reports.ts`.** Shared `ROLE_LABEL` moved to `shared/permissions.ts` (client constants re-export it). `dashboardTasks` takes `orgWide` for the org report scope. Route `server` may list permissions (any-of).
- Verified: typecheck server + client 0; `reports.test.ts` + `insights.test.ts` 24/24. **Not run:** `npm test` (drops `taskwatch_test`, owner's call), e2e, and the dev smoke: PostgreSQL service `postgresql-x64-18` was stopped. Smoke script `server/smoke-reports.mts` (read-only; delete after use).
- Owner: start Postgres, then `! npm test` and `! npm run e2e`. Next: Phase 10 Demo.

## 2026-11-07 (Phase 8 DONE)
- Owner: `npm test` and `npm run e2e` all green. Phase 8 (DASH-01…03, TASK-09, TASK-10, SRCH-01, PERF-07) and PERF-01…06 are DONE.
- Next: Phase 9 Reports (T-9.1…T-9.4). FR-11 is already at `GET /api/reports/accountability`; the exports still sit at `/api/dashboard/export.*` and move in T-9.3. Reports are the last pages on the mock.

## 2026-11-07 (Phase 8 status)
- Owner asked whether Phase 8 is completed; it is **code-complete only**. A mistaken DONE was recorded and reverted the same day. Pending: `npm test` (new Dashboards tests, PERF) and a re-run of `npm run e2e` (the pasted failure predates the spec fix).
- Next: Phase 9 Reports (T-9.1…T-9.4). Entry: Dashboards and Notifications exits; D-49, D-50, D-53 decided. FR-11 is already at `GET /api/reports/accountability`; exports still at `/api/dashboard/export.*` (move in T-9.3).

## 2026-11-06 (Phase 8 Batch B: T-8.5, client)
- Owner: "next". **Phase 8 code-complete.** See the Batch B built notes in DASHBOARD-FRD, SEARCH-FRD, TASKS-FRD (TASK-10) and PERFORMANCE-FRD.
- Pages render payloads only: `getDashboard`, `getTeamOverview`, `search` in `services/api/misc.ts` return one shape in both modes (the mock calls `shared/insights.ts`). Client `features/dashboard/insights.ts` is now a re-export.
- `http()` already prefixes `/api`: pass `/dashboard`, not `/api/dashboard` (caught in the browser check).
- Fixed on the way: in server mode the sidebar hid Team Tasks / Team Overview / Escalations / Extensions from leads and managers (the "supervises" gate read the mock store). `/api/me` now returns `user.reportCount`; `Shell.tsx` uses `supervisesOnServer`. Manager no longer sees the L3 banner (Founder's Office only, AC-6; test assertion added). Task list crashed with no `?view=` (fixed before it shipped).
- Verified: typecheck server + client 0; client build ok; `insights.test.ts` 16/16; browser (server mode) CoS, manager, lead, staff dashboards, lead team overview, team task list with stripe/tiles/views, search (one request per pause); mock mode CoS dashboard + team overview. No data changed except dev-login sign-in audit rows.
- Owner: run `! npm test` and `! npm run e2e`. Next: Phase 9 Reports.

## 2026-11-06 (Phase 8 Batch A: T-8.1–T-8.4, server)
- Owner: "keep recommended and move to phase 8". D-122 decided (counts against, as built).
- Built: see DASHBOARD-FRD, SEARCH-FRD, TASKS-FRD TASK-10 and PERFORMANCE-FRD built notes; contracts in API_CONTRACTS §2.1.
- **Dashboard rules only in `shared/insights.ts`.** The mock must call the same `buildDashboard` in Batch B (map its TaskView to `DashTask`), so both modes return one shape.
- `GET /api/dashboard` is now the role dashboard; FR-11 moved to `GET /api/reports/accountability` (exports unchanged until T-9.3). Existing tests updated to the new path, assertions unchanged.
- Verified: typecheck (server, client) 0; `insights.test.ts` 16/16 + performance 22/22; read-only smoke on the dev DB as staff/lead/manager/CoS/CEO, all 200 (45–112 ms), summary tiles add up. The smoke caught and fixed a lost `$` in a SQL placeholder.
- Owner: run `! npm test` (new Dashboards tests; also still pending for PERF) and `! npm run e2e`. Next: Batch B (T-8.5): dashboard page, team page, list stripe + tiles + FR-10 views, search palette with debounce, PERF-07 tiles; remove `getDb()` from those pages.

## 2026-11-06 (PERF Batch B: plan Tasks 6–8, client + docs)
- Done: see CHANGELOG and the PERFORMANCE-FRD built note. Final whole-change review next (fresh reviewer), then the owner's `npm test` + `npm run e2e`.
- Dev has one test task from the browser check (#53).
- Next: Phase 8 Dashboards (include PERF-07 employee tiles).

## 2026-11-06 (PERF Batch A: plan Tasks 1–5, server)
- Built: see CHANGELOG. Ledger of rulings: in the plan's execution notes (ask the agent); key ones: estimate+purpose required at the API (form fields added early), shortfall reason required for scored tasks finishing short or late, `rated` log kind, breakdown access = self / org reports / team reports for people below.
- **Formulas only in `shared/performance.ts`.** Tasks created before 014 have `scored = false` and never count.
- Owner: run `! npm test` and `! npm run e2e`. Next: Batch B (Tasks 6–8: review/rate UI, leaderboard/breakdown/workload pages, docs) and a final whole-change review.

## 2026-11-06 (D-98 built; performance plan)
- D-98 built (non-CoS resets only self and people below; self-reset allowed). Decisions D-33/D-107/D-108/D-109/D-120/D-121 recorded; open: WO-D2…D7 only.
- Plan for PERFORMANCE-FRD: [PERFORMANCE_PLAN](../06-planning-and-tracking/PERFORMANCE_PLAN.md), 8 tasks, migration 014. Waiting for the owner's review and execution choice; build it before Phase 8.

## 2026-11-06 (decisions-vs-code audit and fixes)
- PERFORMANCE-FRD approved (Rate step yes); D-110…D-119 recorded. Not built yet: next is its implementation plan (before Phase 8).
- Audit found KI-38…KI-46; all fixed (see CHANGELOG). Demo tools are now **off unless `DEMO_TOOLS=true`** (the owner's `.env` has it on).
- Still open: D-98 (reset-access limited to own reporting line?), D-107/D-108/D-109 confirmations, D-120, D-121, D-33 (CEO fixed read-only or by default), WO-D2…D7.
- Owner: run `! npm test` and `! npm run e2e` (covers Phase 7, the fixes and the new assertions).

## 2026-11-06 (scope brief: gap analysis)
- Owner pasted a new brief (outcomes, estimated vs actual time, performance scores, leaderboards) and asked for the difference with the current system. Done: [PERFORMANCE_SCOPE_GAP_ANALYSIS](../01-discovery/PERFORMANCE_SCOPE_GAP_ANALYSIS.md). No code changed.
- **The WO excludes "time tracking by the hour, payroll or HR appraisal workflows" (p.1).** Do not build time capture, scoring or leaderboards until D-110 is answered.
- If any measurement fields (M-1/M-2) are approved, settle their data model before Phase 8, so dashboards and reports are built once.

## 2026-11-06 (Phase 7 Batch B: T-7.4, client)
- Owner said "go for it". Done: see RECURRING-FRD Batch B note. **Phase 7 code-complete.** Browser-checked; one schedule was paused and resumed (audit rows `recurrence.paused/resumed` on `recurrence:1`), nothing created.
- A dev server restart drops browser sessions: sign in again before reading a 401 as a bug.
- Owner: run `! npm test` and `! npm run e2e`. Next: Phase 8 Dashboards per the roadmap. KI-37 (recurrence filter on task lists) is open.

## 2026-11-06 (Phase 7 Batch A: T-7.1–T-7.3, server)
- Owner said "start next phase". Done: see RECURRING-FRD "Built" note. Dev at **013** (backup `backups/taskwatch-before-T-7.1-2026-11-06.dump`); live smoke ok (`GET /api/recurring` as CoS).
- **Recurrence rules:** only `shared/recurrence.ts`. A schedule change must go through `saveRecurring` / `setRecurringActive` / `deleteRecurring` (audited) and then `runRecurring(id)`.
- `pg_dump` is not on PATH here: use `C:/Program Files/PostgreSQL/18/bin/pg_dump.exe`.
- Owner: run `! npm test`. Next: Batch B, T-7.4 (RecurringPage on the server, no `getDb()`; New Task "Repeat this task"; task detail recurrence; "N tasks" link).

## 2026-11-05 (Phase 6 Batch B: T-6.5–T-6.9)
- Batch A green (owner). Done: see NOTIFICATIONS-FRD "Batch B" note. **Phase 6 code-complete.** Browser-checked as CoS (inbox read/unread, bell, preferences save round-trip, delivery log, staff dialog fields); a preference and one read flag were changed and put back.
- Client: one adapter `services/api/notificationsServer.ts`; `http()` accepts PATCH. Delivery rows carry `recipientName` and `copied` in server mode; never look names up in the mock store.
- Owner: run `! npm test` and `! npm run e2e`. Next: Phase 7 per the roadmap.

## 2026-11-05 (Phase 6 Batch A: T-6.1–T-6.4, server)
- Owner said "next phase". Done: see NOTIFICATIONS-FRD "Built" note. Dev at **012** (backup `backups/taskwatch-before-T-6.3-2026-11-05.dump`); live smoke ok.
- **Notification type of a row:** `typeOfEvent(row.event)` from `shared/notifications.ts`; never map events by hand. New notices keep calling `notify()` / `notifyUser()`; preferences, quiet hours and D-106 are applied there.
- WhatsApp is off through one constant, `WHATSAPP_ENABLED` (D-106). Test expectations changed accordingly (L3 channels, quiet-hours test).
- Open with defaults: D-107 (event → type for comment/due_change/cancelled/reopened), D-108 (org switch governs personal windows).
- Owner: run `! npm test`. Next: Batch B (T-6.5 simulation status, T-6.6 chain-break alert, T-6.7 delivery log, T-6.8 digest, T-6.9 client: bell, inbox, account prefs, staff dialog quiet hours, delivery log).

## 2026-11-05 (Phase 5 Batch B: T-5.4–T-5.9)
- Done: see ESCALATION-FRD and ADMINISTRATION-FRD (POL-01) "Built" notes.
- `runEngine(scope?)` takes `{organizationId, entityId?}`; anything that changes rules must await it with the narrowest scope.
- Client acknowledgement: `ackEscalation(taskId, note, eventId?)`; server mode needs the event id (`canAck` on detail events, `ackEventId` on workspace rows).
- Owner: run `! npm test` and `! npm run e2e`. Next: Phase 6 notifications (T-6.4 per-person quiet hours, D-105: India night team quiet 08:00–20:00 local).

## 2026-11-05 (Phase 5 Batch A: T-5.1–T-5.3)
- Phase 4 is DONE (owner's runs green). Done now: see ESCALATION-FRD "Built" note.
- **Level of a task row:** always `taskLevel(row, rules.for(entity), now)` from `engine/levels.ts`; it returns null off the ladder. Never call `computeLevel` with a hand-built input on the server.
- Escalation reasons are `silence | overdue | blocked`; the engine does not notify a Blocked L1 (the block action does).
- Owner: run `! npm test`. Next: Batch B (T-5.4 due-soon/overdue notices, T-5.5 scheduler guard, T-5.6 escalations workspace, T-5.7 rules API, T-5.8 simulator, T-5.9 client incl. KI-32 note dialog and KI-34).

## 2026-11-05 (Phase 4 Batch 3: T-4.10–T-4.14)
- Done: comments (`services/collab.ts`, migration 010), attachments (`services/uploads.ts`, `storeAttachment` + `withCleanup` in `tasks.ts`), calendar window and bulk actions, organization-scoped audit view (`services/auditView.ts`, routes `/api/audit*`), client task pages (`client/src/services/api/tasksServer.ts`).
- Uploads: never write a file outside an authorized action; pass `PendingFile[]` into the action and let `storeAttachment` write it.
- The audit page lives at `/admin/audit` in the client; the old `/api/admin/audit` and `/api/admin/chain-check` are gone.
- Owner: run `! npm test` and `! npm run e2e`. Next: Phase 5 Escalation (T-5.1 engine on the new model incl. KI-29; escalation acknowledgement with note, KI-32). Then T-6.4 quiet hours (D-105: India night team 08:00–20:00 local).

## 2026-11-05 (Phase 4 Batch 2: T-4.3–T-4.9)
- Done: task actions (see TASK-WORKFLOW-FRD "Built" note). New action = a function using `act(actor, id, '<TaskAction>', '<label>', fn, precheck?)` in `services/tasks.ts` plus one `action('<path>', schema, run)` line in `routes/tasks.ts`.
- Request bodies follow the contract: `dueDate` (+ `dueTime`, default 17:00, caller's zone) via `dueFrom`; tests use `due(localIn(h, tz))`.
- New log kinds are written under the client's names; legacy kinds (`update`, `status`, `reassign`, `due_change`, `ack`) are still written by the paths that always wrote them.
- Owner: run `! npm test`. Next: Batch 3 (T-4.10 comments, T-4.11 attachments, T-4.12 calendar/bulk, T-4.13 audit, T-4.14 client task pages).

## 2026-11-05 (Phase 4 Batch 1: T-4.0–T-4.2)
- Done: cutover (dev at 009), TaskView with actions, scopes, pickers, detail shape. See CHANGELOG and DATABASE_DESIGN §6.
- **Statuses:** use `isOpenStatus` / `openSql()` (lists, counts) and `ladderSql()` / `ACTIVE_STATUSES` (engine) from `domain.ts`; never write `'open'`/`'done'`. The status endpoint and the update form still accept `done`/`open` as request values until T-4.7/T-4.8 and T-4.14.
- Log rows keep their stored kinds; show them through `presentKind` / `presentValues` (`services/activity.ts`).
- Task rows: one `toTaskView` in `queries.ts`; `actions[]` from `taskActions` (shared rules). Services still enforce the legacy `taskPermissions` until T-4.5…T-4.8 move each action onto `actions`.
- Records are never deleted now (triggers on tasks, users, comments, …): tests reset by dropping the schema only.
- Owner: run `! npm test`. Next: Batch 2 (T-4.3–T-4.9).

## 2026-11-05 (T-3.8 frontend integration)
- Done: the Org/permissions pages run on the server in server mode (see CHANGELOG). Pattern for later phases: add a branch in the `services/api/*` function that calls `xxxServer`, map server shapes to the client types there, mark the route `server: <permission>`, and replace any `getDb()` read on that page with API data.
- To check in the browser: API with `ALLOW_DEV_LOGIN=true` on 4000 and `VITE_BACKEND=server npx vite --port 5190`; if a change does not show, see KI-27.
- Owner: run `! npm run e2e` (client hooks changed) and `! npm test`.
- Next: Phase 4 (Task core). D-5 (home time zone) and D-13 (15 MiB) were decided by "accept defaults" (OPEN_QUESTIONS §9).

## 2026-11-05 (T-3.5, T-3.6, T-3.7)
- Done: status, org view, placement, settings (see the FRD built notes). Every Org/permissions endpoint now exists on the server.
- Settings: `getSettings(org)` returns `orgName` from `organizations.name` and derived simulation flags; store through `saveSettings` only.
- Test helper: after ending a fixture user's sessions, drop their cached client with `sessions.delete(id)`.
- Next: T-3.8, the client pages (staff, org, roles, settings) onto these endpoints; T-3.9 still gated on KI-22 (exports, admin audit view).

## 2026-11-05 (T-3.4 create/edit person)
- Done: see STAFF-AND-ORG-FRD STAFF-02 built note. D-99 decided and built. Open from the auth review: D-98 only.
- Account emails that must go out now (not through alert preferences or quiet hours) use `sendAccountEmail` in `services/passwordReset.ts`.
- KI-25: remove both `whatsapp ?? phone` fallbacks in T-4.0.
- Next: T-3.5 activate/deactivate (sessions deleted, no delete route, last-CoS rule).

## 2026-11-04 (T-3.3 directory and profile)
- Done: `GET /api/people`, `GET /api/people/:id` (see STAFF-AND-ORG-FRD built notes). `services/staff.ts` holds the queries.
- Profile task rows use `shapeTask` (today's server shape); T-4.1 changes it. T-3.8 must map them or wait for T-4.1.
- Next: T-3.4 create/edit person (`roles[]`, last-CoS lock, role changes need `manage_roles`; consider D-99 email-change handling there).

## 2026-11-04 (T-3.2 fixes after the owner's run)
- **The shared rules are single-organization.** Any server check that says "the Founder's Office (or a CoS) sees everything" must also match `organization_id` (KI-24). Task rows passed to `access.ts` must include `organization_id`; without it access is refused.
- Direct SQL changes to role permissions in tests must call `invalidateDirectory()` (the directory carries the matrix).
- Auth is DONE. Owner: re-run `! npm test` for the T-3.2 fixes.

## 2026-11-04 (T-3.2 authorization)
- Done: see ADR-0004 implementation note. Authorization on tasks now follows the role matrix; `can(viewer, dir, perm)` in `access.ts` for new checks.
- `visibilityFilter` returns 1 parameter for the Founder's Office and 3 otherwise; callers must keep counting `params.length`.
- Owner: run `! npm test` and `! npm run e2e`. Auth moves to DONE after e2e.
- Next: T-3.3 (scoped directory and profile).

## 2026-11-04 (T-3.1 role matrix)
- Done: `GET /api/roles`, `PUT /api/roles/:role` (see ADMINISTRATION-FRD ROLE-01/02 API notes). Dev at 008.
- Use `requirePermission(perm, 'do x')` from `http/middleware.ts` for permission checks, not inline matrix reads.
- Tests change the matrix through the API and undo it with `resetRoleMatrix()` in `api.test.ts`.
- Task actions still use the hard-coded role checks in `access.ts`, so a matrix change does not affect them yet. That is T-3.2, next.

## 2026-11-04 (T-3.0 organizations)
- ADR-0010 accepted; T-3.0 done (see its implementation note). Dev at 007.
- **Every new helper call needs an organization:** `getDirectory(org)`, `getSettings(org)`, `getRoleMatrix(org)`, `getRuleSet(org)`. Requests use `user.organizationId`; jobs loop `organizationIds()`. Inserts into root tables name `organization_id`. `appendAdmin` takes the actor's organization unless `organizationId` is given (required when there is no actor; `null` is the platform chain).
- **Do not build T-3.9 (create organizations) before KI-22 is cleared.**
- **Owner:** run `! npm test` (still not run since the auth review; the classifier blocks the agent). Set `ALLOW_DEV_LOGIN=true` in `.env` first.
- Next: T-3.1 (role matrix endpoints, per organization).

## 2026-11-04 (ADR-0010 proposed)
- Owner chose "draft ADR-0010 first". Phase 3 (Org/permissions) is **on hold until ADR-0010 is approved**, along with D-100…D-104. Once approved, start at T-3.0 (migration 007 plus organization context), then T-3.1…T-3.8 built organization-aware.

## 2026-11-04 (auth security review)
- Done: review and fixes, see [SECURITY_TEST_PLAN §2a](../05-testing-and-qa/SECURITY_TEST_PLAN.md). 2FA is gone (D-94): **ignore the `TOTP_ENCRYPTION_KEY` note below.**
- **Owner:** set `ALLOW_DEV_LOGIN=true` in `.env` (dev login is now opt-in, KI-21), then run `npm test` (the agent was not allowed to: it drops `taskwatch_test`). If it passes, move AUTH-01, 01b, 02–06 to DONE.
- Open for the owner: D-98, D-99. Next: Org/permissions phase (D-98 belongs there).

## 2026-11-04 (Auth phase built)
- Done: T-2.1–T-2.7 (see TASK_BREAKDOWN). Tracker: 9 Auth features in REVIEW, AUTH-01a in TESTING.
- **The owner should add `TOTP_ENCRYPTION_KEY` to `.env`** or 2FA sign-in returns 503 in dev.
- `npm run e2e` is isolated (DB `taskwatch_e2e`, ports 4100/5180). Keep 2FA test codes tied to the recorded step.
- Next: security review of the auth items (SECURITY_TEST_PLAN), then the Org/permissions phase.

## 2026-11-04 (T-1.16, Foundation complete)
- Done: `client/src/services/http.ts`. Screens still run on the mock (`VITE_BACKEND` default `mock`). Each feature moves its `services/api` functions to `http()`; T-2.7 moves the signed-in identity to `/api/me`.
- Every new server zod schema must carry the FRD's user-facing messages (ERROR_HANDLING §7, KI-18).
- Next: Auth phase, T-2.1 password sign-in (tables already exist, migration 004).

## 2026-11-04 (T-1.15)
- Done: `/api/me` bootstrap (see TASK_BREAKDOWN T-1.15). Role matrix, settings and the `dueSoonHours` rule all fall back to the shared defaults when nothing is stored.
- Next: T-1.16, the client fetch adapter (last Foundation task).

## 2026-11-04 (T-1.9)
- Done: audit chain. **Every `admin_log` write must use `appendAdmin` (`services/audit.ts`)**; a direct insert fails at the DB trigger. Pass the caller's tx client so the audit row commits with the change.
- Read-only check pattern for dev data: a temporary .ts calling the verify functions, run with `node --env-file=../.env --import tsx`, then deleted.

## 2026-11-04 (T-1.6)
- Done: `003_teams.sql`, dry-run in a rolled-back transaction, then applied. **Plan change:** row mappings and tightening moved to T-4.0 (cutover with the server switch). Read the TASK_BREAKDOWN T-1.6 and T-4.0 rows.
- Dry-run pattern for data migrations: `begin; <sql>; select ...; rollback;` against dev.

## 2026-11-04 (T-1.5)
- Done: migration 002 (see TASK_BREAKDOWN T-1.5, DATABASE_DESIGN §6). Dev DB is at 002.
- **The owner runs `tsx watch` (pid tree from 00:15, port 4000) against dev.** It auto-applies migrations on restart. Draft migrations in the scratchpad and prove them on `taskwatch_test` first (DATABASE_MIGRATION_POLICY, drafting rule).
- Next: T-1.6 (003 backfill): take a new backup first.

## 2026-11-04 (T-1.4)
- Done: shared permissions (see TASK_BREAKDOWN T-1.4, ADR-0004 note). 66/66 on 6 consecutive runs.
- Fixed flaky `api.test.ts`: `as()` must read the dev-login body before reusing the cookie (KI-14).
- KI-13: mock-API scope checks still use `role === 'cos'`; fix each as its feature moves to the server.
- Backup taken: `backups/taskwatch-before-T-1.5-2026-11-04.dump` (custom format; restore with `pg_restore --clean --dbname <url>`). Call `pg_dump` with `--no-password`, normalise the `ppostgres:` typo in memory (KI-16), and redact errors (KI-17).
- Next: T-1.5.

## 2026-11-04 (T-1.3)
- Decided: R-1, R-2, R-3, T-1.1 (Decision Register §10.1). Done: shared workflow (see TASK_BREAKDOWN T-1.3, ADR-0003 note). 59/59.
- The `block` action exists in the rules, but its UI and API come with WF-11 (task core).

## 2026-11-04 (T-1.2)
- Done: shared ladder module (see TASK_BREAKDOWN T-1.2, ADR-0007 implementation note). 53/53, typecheck 0, build ok, selfcheck unchanged, live smoke ok.
- Live-run pattern that leaves no stray process: `timeout 25 node --env-file-if-exists=../.env --import tsx src/index.ts` from `server/` (not `npm run dev:server`, whose child survives on Windows).
- Next: T-1.3 needs R-2; T-1.4 needs R-1. T-1.5+ needs T-1.1.

## 2026-11-04 (readiness review)
- See [READINESS_REVIEW](../06-planning-and-tracking/READINESS_REVIEW.md). **Do not start T-1.2 until the owner approves.** Open: R-1, R-2, R-3, T-1.1, WO-D2…D7.

## 2026-11-04 (T-1.14 + T-1.17)
- Done: see TASK_BREAKDOWN. 48/48, typecheck 0. The user's own Vite (pid 9036, :5173) was already running and picked up the proxy config; it was left alone.
- The agent's API dev server (pid 15752) could not be stopped (permission denied); the user was asked to stop it.
- Still waiting: T-1.1 approval of the DATABASE_DESIGN schema and API_CONTRACTS endpoints.

## 2026-11-04 (T-1.13)
- Done: rate limiting (see TASK_BREAKDOWN T-1.13). 46/46, typecheck 0. Deviation: the Google callback limit is 100 per IP, not 20, because of shared office NAT; recorded in SECURITY_ARCHITECTURE §6.
- Next: T-1.1 needs the user's approval of the proposed schema and endpoints before the migrations. Independent alternatives: T-1.17 (scheduler lock), T-1.14 (Vite proxy).

## 2026-11-04 (T-1.12)
- Done: not-visible → 404 identical to missing (see TASK_BREAKDOWN T-1.12). Verified 43/43 and typecheck 0. Next: T-1.13 rate limiting.

## 2026-11-04 (T-1.11)
- Done: error envelope (see TASK_BREAKDOWN T-1.11). Verified: typecheck exit 0; errors 5/5 and rules 21/21 pass.
- `api.test.ts` now derives its DB from `DATABASE_URL` with the name forced to `taskwatch_test` (it previously defaulted to a credential-less URL). Full suite: 43/43 pass.
- Before integrating forms with the server, check that zod field keys match the UI's `fields.*` names.

## 2026-11-04 (validation)
- Validation passed: 0 broken links; all 92 feature IDs are in an FRD, the tracker, the tests and the RTM. No code changed. Nothing run except read-only checks.
- Next: the user reviews the docs and answers OPEN_QUESTIONS §8 (or accepts the defaults), plus D-18 and WO-D2…D7. Then T-1.11.

## 2026-11-03 (discovery and documentation session)

**Done**
- Ran discovery on both the client and the server.
- Wrote the documentation system: `docs/01`–`08` and `AGENTS.md`.
- Recorded the decisions (see [CURRENT_STATE](CURRENT_STATE.md)).

**Not done**
- No backend code.
- No migrations.
- No tests executed.

**Start the next session by**
1. Reading `AGENTS.md`.
2. Reading [CURRENT_STATE](CURRENT_STATE.md).
3. Checking [OPEN_QUESTIONS](../01-discovery/OPEN_QUESTIONS.md) for answers that are still pending.
4. Doing the first task in [IMPLEMENTATION_ROADMAP](../06-planning-and-tracking/IMPLEMENTATION_ROADMAP.md), but only once the user has approved it.

**Watch out**
- Running `npm test` or `db:seed --reset` destroys data, so get approval first.
- The README's Layout section is stale.
