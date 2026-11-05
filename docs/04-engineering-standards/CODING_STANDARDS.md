# Coding Standards

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Scope: all code under `server/` and `client/`. Agents must also follow [AI_AGENT_GUARDRAILS.md](AI_AGENT_GUARDRAILS.md). Error rules live in [ERROR_HANDLING.md](ERROR_HANDLING.md) and schema rules in [DATABASE_MIGRATION_POLICY.md](DATABASE_MIGRATION_POLICY.md). This file does not repeat them.

These are the conventions the existing code already follows. New code matches them. To change one, write an ADR in [../03-architecture/decisions/](../03-architecture/decisions/) and get it approved first (see the guardrails).

## 1. Language and build

| Rule | Evidence |
|---|---|
| TypeScript `strict: true` and `noUncheckedIndexedAccess: true` in both workspaces. Do not relax either flag. Do not add `// @ts-ignore` or `as any` to silence an error you could fix with a type. The tests use `as any` on parsed JSON bodies; production code should not. | [V-S] `server/tsconfig.json:7-8` · [V-C] `client/tsconfig.json:8-9` |
| ESM only. Both packages are `"type": "module"`. Server imports carry the `.js` suffix (`nodenext` resolution). | [V-S] `server/package.json:5`, `server/tsconfig.json:5-6` · [V-C] `client/package.json:5` |
| The server runs TypeScript directly with `tsx`. It has no compile step. `npm run typecheck` (`tsc --noEmit`) is the type gate for both workspaces. | [V-S] `server/package.json:7-13` · root `package.json:19` |
| Node ≥ 22. The test runner is built in (`node:test` via `tsx --test`). | [V-S] `server/package.json:12` · README.md:23 |

## 2. Server layering (observed)

| Layer | Owns | Must not | Evidence |
|---|---|---|---|
| `routes/*.ts` | HTTP. It parses `req.query` and `req.body` with an inline **zod** schema, calls `me(req)` and `idParam(req)`, calls a service, and sets the status code. | Contain business rules or authorization decisions beyond `requireRole`. | [V-S] `routes/tasks.ts:36-62` |
| `services/*.ts` | Business rules, authorization (`access.ts`), and **SQL**. Multi-row writes run inside `tx()`. | Know about `req` or `res`. | [V-S] `services/tasks.ts:1-40`, `db/pool.ts:12-25` |
| `engine/*.ts` | Pure ladder math (`levels.ts`) and routing (`routing.ts`); `engine.ts` applies them under a row lock. | Read the wall clock directly. | [V-S] `engine/engine.ts:61,74` |
| `notify/*.ts` | Message text, channels, the dispatcher. | Be called outside a transaction when it writes `notifications` rows. | [V-S] `jobs/scheduler.ts:27-35` |
| `http/*.ts` | `HttpError`, middleware and the error handler. | — | [V-S] `http/errors.ts`, `http/middleware.ts` |

**Known deviation.** 25 SQL calls still live in route files (`admin.ts`, `auth.ts`, `notifications.ts`, `people.ts`, `recurring.ts`, `rules.ts`, `tasks.ts:129`). [V-S] New SQL goes in a service. When you touch one of those routes, move its SQL into a service in the same change. Do not move SQL in unrelated changes.

## 3. Rules that are not negotiable

1. **Parameterized SQL only.** Use `$1…$n` placeholders. Never build SQL by string concatenation with user input. The only interpolation allowed is generated placeholder numbers or whitelisted identifiers (for example `visibilityFilter` builds `$${firstParam}`). [V-S] `services/access.ts:20-26`. No ORM. Do not add one. [V-S] [EXISTING_SYSTEM_ANALYSIS §3.1](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)
2. **Time comes from `clock.now()`.** Never call `new Date()` or `Date.now()` for business time on the server. The clock is the only seam that tests and the demo clock control. [V-S] `clock.ts:10-13`. Clients never supply timestamps. [WO "Server time only"]
3. **luxon for zones.** Convert local wall-clock input with `DateTime.fromISO(local, { zone })` on the server (`parseLocalDue`). Store `timestamptz` (UTC). Format with `formatInZone`. [V-S] `services/tasks.ts:20-24`, `notify/format.ts` · [WO "Time zones"]
4. **Authorization runs on the server for every request.** Use the `services/access.ts` helpers (`visibilityFilter`, `canView`, `taskPermissions`) for every list and every `:id`. A UI guard is never the control. [WO] · [PRODUCT_REQUIREMENTS C-2](../02-product-requirements/PRODUCT_REQUIREMENTS.md)
5. **Validate at the boundary.** Every route parses its input with zod. Free text goes through the sensitive-ID guard (`findSensitiveId`). [V-S] `services/tasks.ts:26-34`, `services/sensitive.ts` · [PRD C-6]
6. **Log every state change through `appendLog`.** Never `UPDATE` or `DELETE` `activity_log` or `admin_log`. [V-S] `services/activity.ts:63` · [WO "Append-only log"]
7. **No secrets in code or config files.** Read them through `config.ts`, which reads env vars. [WO "Secrets"] · [V-S] `config.ts`
8. **Never copy `.env` values into docs, logs, fixtures or test files.** Tests that need a credential-free run delete the credential vars, as `api.test.ts:10` does. [V-S]

## 4. DRY: reuse before you write

The user's standing rule is "never repeat code; reuse existing helpers".

| Need | Reuse | Evidence |
|---|---|---|
| Escalation level, thresholds, quiet hours | `server/src/engine/levels.ts` | [V-S] |
| Who gets an alert | `engine/routing.ts:routeEscalation` | [V-S] |
| Visibility / permissions | `services/access.ts` | [V-S] |
| Directory lookups, roles | `services/directory.ts` (`getDirectory`, `hasRole`, `isFounderOffice`) | [V-S] |
| Transactions | `db/pool.ts:tx` | [V-S] `pool.ts:12-25` |
| Errors | `http/errors.ts` (`badRequest`, `forbidden`, `notFound`, `HttpError`) | [V-S] |
| Sensitive IDs | `services/sensitive.ts:findSensitiveId` | [V-S] |
| CSV / PDF | `services/exports.ts` | [V-S] |
| Formatting a time for a person | `notify/format.ts:formatInZone` | [V-S] |

**Known duplication.** `client/src/services/engine/escalation.ts` duplicates `server/src/engine/levels.ts`. [V-C] [V-S] The fix is one shared rules module (ladder math, the state machine, permission rules) imported by both workspaces. **[D-9, decided]** Until D-9 is decided, do not add a third copy. Any change to ladder math must be made in both files and covered by both `server/test/rules.test.ts` and `client/src/selfcheck.ts`.

**Known duplication.** The 15 MB limit is in `config.ts:65` and again as text in `middleware.ts:79`. Derive the message from `config.maxUploadBytes` when D-13 is settled. **[D-13, decided]**

## 5. Naming and layout

| Item | Convention | Evidence |
|---|---|---|
| Files | lower camel case in server (`sensitive.ts`, `scheduler.ts`); PascalCase for React components (`TaskDetailPage.tsx`) | [V-S] [V-C] |
| Routers | `<area>Router`, one file per area in `server/src/routes/`, mounted in `app.ts` | [V-S] `app.ts:49-58` |
| DB | snake_case tables and columns; enums as `text` + `CHECK`; every instant is `timestamptz` | [V-S] `001_init.sql` |
| JSON | camelCase fields in API payloads (`entityId`, `assigneeId`, `dueLocal`) | [V-S] `routes/tasks.ts:52-57` |
| Local wall-clock input | suffix `Local` (`dueLocal`); UTC instants suffix `At` | [V-S] |
| Migrations | `NNN_description.sql` | [V-S] `db/migrations/001_init.sql` |
| Tests | `server/test/<area>.test.ts` | [V-S] |
| Feature IDs | Reference the canonical IDs (`TASK-01`, `WF-11` …) in commit text, test names and tracker rows | [PRD](../02-product-requirements/PRODUCT_REQUIREMENTS.md) |

New server code goes into the existing folders. Do not create new top-level folders without an ADR. The client folder layout is described in [EXISTING_SYSTEM_ANALYSIS §2.1](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md). Pages call the API only through `useApi` and `useAction` ([V-C] `hooks/index.ts:11-44`). Do not add new direct `getDb()` imports in pages. 22 files already bypass this seam and must be migrated, not copied.

## 6. Dependencies

- **No new dependency without a written justification** in the change description: what it does, why the ladder (stdlib → existing dependency → a few lines of code) does not cover it, its licence, `npm audit` result, and maintenance status. A dependency that changes architecture (ORM, auth framework, queue) needs an ADR.
- Decided examples: TOTP 2FA uses Node `crypto`, with no new package [D-21, decided]. Passwords use `crypto.scrypt` and tokens use `crypto.randomBytes` [D-2, decided].
- Rate limiting (NFR SEC-3) has no implementation yet. Prefer a small in-house limiter backed by Postgres or memory over a new package, unless a reviewer approves the package. [A]
- Keep versions pinned by `package-lock.json`. Do not run `npm update` as part of feature work.

## 7. Comments and docs in code

- Comment the **why** (work-order rule, decision number), as the existing code does: `// Work order, "Client data": …` ([V-S] `sensitive.ts:1-2`).
- Reference the D-number or WO clause when code encodes a decision.
- Deliberate shortcuts carry a comment naming the ceiling and the upgrade path.
