# Demo Tools FRD (DEMO)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). Demo sign-in helpers on the login, forgot- and reset-password pages are AUTH features ([AUTH-FRD.md](AUTH-FRD.md)); their production gating is listed here (G-7) so all demo surfaces are in one place.
> Demo tools are **not** a WO feature. The WO only requires that production is safe (server-side access control, server time only, secrets out of code). Whether any demo tool survives is [D-17, decided]. Nothing here has been executed. No test has been run.

## DEMO-01 Demo bar and simulated controls

**Description.** A bar at the top of every signed-in page with: (a) act-as user switcher, (b) simulated clock +1 / +4 / +12 / +24 h and "Now", (c) scripted scenarios, (d) expire session, (e) reset demo data. [V-C `features/demo/DemoBar.tsx:13-151`; `services/api/demo.ts`]

**Roles.** Today: **every signed-in user, with no permission check.** [V-C `app/Shell.tsx:126`] Target: development only, CoS only. [PRD DEMO-01; D-17 recommendation]

**User actions (UI) and current behaviour.**

| Control | UI | Client behaviour | Server equivalent |
|---|---|---|---|
| (a) Act as | select listing every active user grouped by role [V-C `DemoBar.tsx:33-55`] | `switchUser(id)` replaces the session; inactive → 403 "That demo user is not active." [V-C `services/api/misc.ts:27-31`] | Dev login `POST /auth/dev-login` (non-production; lists users without authentication, S-2) [V-S `routes/auth.ts:79-98` per EXISTING_SYSTEM_ANALYSIS §3.8] |
| (b) Clock | +1 h, +4 h, +12 h, +24 h → toast "Clock advanced N h; escalation engine ran."; "Now" resets [V-C `DemoBar.tsx:62, :66`] | `advanceClock(h)` adds to `clockOffsetMs`, runs all ticks, audits `demo.clock_advanced` (source `demo`); `resetClock()` sets 0 [V-C `demo.ts:8-21`] | `POST /dev/clock {advanceHours 0–720 \| reset}`, role `cos`, **404 when demo tools are off**; persists `app_state.clock_offset_ms`; admin log `demo_clock` before/after; runs engine and dispatcher [V-S `routes/admin.ts:56-76`] |
| (c) Scenarios | drawer of 12 scenarios; the active scenario's steps card is kept in localStorage [V-C `DemoBar.tsx:71, :103-117`] | `runScenario(id)` creates "[Demo] …" tasks with back-dated timestamps, audits `demo.scenario_loaded`, switches user, navigates [V-C `demo.ts:88-212`] | none |
| (d) Expire session | button "Simulate an expired session" [V-C `DemoBar.tsx:74`] | sets `lastActive = 0` [V-C `misc.ts:37-40`] | none |
| (e) Reset data | confirm → `resetDemoData()` [V-C `DemoBar.tsx:77, :132-148`] | rebuilds the whole localStorage DB [V-C `demo.ts:23-25`] | none (would rewrite the DB; D-18) |

**Expected behaviour — production gating requirements.**

| # | Requirement | Evidence |
|---|---|---|
| G-1 | When `NODE_ENV=production`, every demo capability is off regardless of environment variables. | [V-S `config.ts:60, :62` already forces `devLogin` and `demoTools` off] |
| G-2 | Demo endpoints answer **404** (not 403) when demo tools are off, so their existence is not disclosed. | [V-S `routes/admin.ts:57`] |
| G-3 | The production client bundle contains no DemoBar, no scenario code and no demo login helpers (build-time flag, dead-code eliminated), and the UI also hides them unless `/api/me` reports `demo` enabled. | [V-C `Shell.tsx:126`; `services/api/demo.ts`; A for the mechanism] |
| G-4 | Outside production, demo tools are **off by default** and enabled only with `DEMO_TOOLS=true`. The server default is the opposite today (`DEMO_TOOLS !== 'false'`). | [PRD DEMO-01; V-S `config.ts:62`] [D-47, decided] |
| G-5 | When enabled, only a user holding `cos` may use them; checked on the server for each call. | [V-S `routes/admin.ts:56` `requireRole('cos')`; D-17] |
| G-6 | Every demo action is audited with source `demo` and the acting user; the Audit page's "Demo mode" source filter exists only when demo tools are on. | [V-C `demo.ts:12, :208`; `features/admin/AuditPage.tsx:102`] |
| G-7 | Demo sign-in aids — quick-fill accounts, the displayed shared password `taskwatch`, the reset-token link and the "passwords are not stored" note — never ship to production. | [V-C `features/auth/AuthPages.tsx:91-117`; `misc.ts:12`; AUTH-FRD] |
| G-8 | While a clock offset is non-zero, every page shows a banner with the offset, because the offset changes server time (C-4) for **all** users of that environment. | [V-S `routes/admin.ts:62-66` global offset; `routes/auth.ts:122` exposes it in `/me`; A for the banner] |
| G-9 | Demo tools must never run against the pilot or production database; reset and scenarios would rewrite data. | [D-18; A] |
| G-10 | The production seed contains no fictional WhatsApp numbers, demo password or development-only accounts. | [whatsapp-templates.md note on +1-415-555-01xx; V-S `db/seed.ts:45` real-domain address per EXISTING_SYSTEM_ANALYSIS §3.1] |
| G-11 | (a) act-as, (c) scenarios, (d) expire session and (e) reset data have no production value. Proposed: keep only (b) the clock, in development, for CoS (D-17 recommendation). (d) is reproducible with a short AUTH-03 timeout. | [D-17; A] |

**Data required.** `app_state.clock_offset_ms`; config flags; admin log.

**Backend processing.** Clock: set offset → persist → admin log → run engine and dispatcher → return offset and engine result. [V-S `routes/admin.ts:60-75`]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| POST | `/api/dev/clock` | `{advanceHours?: number 0–720, reset?: boolean}` | `{offsetHours, engine}` | Yes: `POST /dev/clock` [V-S `routes/admin.ts:56-76`]. |
| GET | `/api/me` | — | includes `demo:{offsetHours}\|null` | Yes: `/me` [V-S `routes/auth.ts:122`]; see AUTH-06. |
| POST | `/api/dev/act-as`, `/api/dev/scenarios/:id`, `/api/dev/reset` | — | — | **Not proposed** unless D-17 keeps them. [D-17, decided] |

**Validation.** `advanceHours` number 0–720 (24 × 30) → else 422. [V-S `routes/admin.ts:59`] Negative values are not allowed; "Now" uses `reset`. [V-S]

**Authorization.** Demo off → 404. Demo on and caller not `cos` → 403 "Your role cannot do this". [V-S `http/middleware.ts:40-45`]

**Success / failure.** 200; 401; 403; 404; 422.

**Dependencies.** AUTH-01/06 (dev login, `/me`), ESC-08 (engine run), NTF-02 (dispatcher), AUD-01, D-17, D-18.

**Acceptance criteria.**
1. DEMO-01-AC-1: With `NODE_ENV=production` and `DEMO_TOOLS=true`, `POST /api/dev/clock` returns 404 and `/api/me` reports `demo: null`.
2. DEMO-01-AC-2: The production client bundle contains none of the strings "Demo scenarios", "Act as" or the demo password.
3. DEMO-01-AC-3: In development with demo tools on, a non-CoS user gets 403 from `/api/dev/clock`.
4. DEMO-01-AC-4: Advancing the clock 6 h in development makes a Critical task silent since the start reach L1 in the same response's engine result, and writes an admin-log row with before/after offsets.
5. DEMO-01-AC-5: With demo tools off by default in development (per D-47), the demo bar is not rendered for any user.
6. DEMO-01-AC-6: A non-zero offset is visible to every signed-in user as a banner.

**Test scenarios.** Production flag combinations (`NODE_ENV` × `DEMO_TOOLS`) · 404 vs 403 · CoS vs non-CoS · advance / reset / out-of-range hours · audit rows · bundle scan · banner visibility · dev-login unavailable in production (AUTH).

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-17](../../01-discovery/OPEN_QUESTIONS.md) | Which demo tools survive (recommendation: clock only, dev only, CoS only). |
| [D-18](../../01-discovery/OPEN_QUESTIONS.md) | Any reset/scenario feature writes to a database; needs explicit OK. |
| [D-2](../../01-discovery/OPEN_QUESTIONS.md) | Decided: dev directory login is non-production only. |
| D-47 (decided) | Demo tools default on (server) vs opt-in `DEMO_TOOLS=true` (PRD). |
