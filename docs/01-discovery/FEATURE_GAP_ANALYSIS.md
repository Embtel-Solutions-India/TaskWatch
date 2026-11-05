# Feature Gap Analysis

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 (wins over the prototype) · **[V-C]** verified in client code · **[V-S]** verified in server code · **[A]** assumption · **[OPEN]** see [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md). Feature IDs: [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md). Server facts: [EXISTING_SYSTEM_ANALYSIS.md](EXISTING_SYSTEM_ANALYSIS.md).

## 5. Feature gap analysis

### 5.1 Headline finding
The **existing server was built for the previous frontend**, which was deleted on 2026-11-03. The **new frontend runs entirely on a localStorage mock** (`client/ASSUMPTIONS.md:3`) whose domain model differs substantially. This is not "wire up the endpoints": the server's data model must change, or the client must be adapted, and that choice is an architecture decision (§7).

### 5.2 Model differences: existing server vs new client

| Aspect | Server today [V-S] | New client [V-C] |
|---|---|---|
| Statuses | open, in_progress, **blocked**, done | draft, assigned, in_progress, submitted, changes_requested, reopened, completed, cancelled |
| Review workflow | none | rounds, approve / changes / reject |
| Due-date change | direct; lead once, manager, CoS | extension request → approval |
| Org units | `entities` (BAIS, USAIS…) | departments → teams |
| Roles per user | `roles text[]` (several) | single `role` |
| Authorization | hard-coded by role | configurable 15-permission matrix (DB) |
| Escalation rules | default + per-entity overrides | single global policy + dueSoon |
| Recurrence | daily / weekly (1 day) / monthly (1–28), time zone of the assignee | daily / weekly (many days) / monthly / every-N-days, interval, start/end, UTC |
| Task fields | no description, category, team, parent, progress, start, reviewer, draft | all of those |
| Comments | assignee **cannot** comment; no edit or delete; no threads | everyone; edit, delete, replies, @mentions |
| Notifications | inapp/email/whatsapp rows; no prefs | per-type × channel prefs; 13 types |
| Settings | none (hard-coded constants) | org name, time zone, workday, session timeout, categories, overload, digest schedule, simulation toggles |
| Auth | Google OAuth + dev login | email/password + reset |
| Reports | accountability by entity/person, CSV+PDF | 9 reports, many metrics, CSV only |

### 5.3 Gap matrix

Legend: ✅ exists and matches · 🟡 exists but differs · ❌ missing.

| Feature | Frontend UI | Server API | Gap |
|---|---|---|---|
| AUTH-01/02 sign in/out | ✅ (password) | 🟡 (Google/dev) | D-2 |
| AUTH-03 timeout from settings | ✅ client-only | 🟡 fixed 12 h | ❌ setting-driven |
| AUTH-04/05 reset | ✅ simulated | ❌ | depends on D-2 |
| AUTH-06 me/capabilities | 🟡 reads mock | 🟡 `/me` (different shape) | ❌ permission list |
| TASK-01..03 create/draft/edit | ✅ | 🟡 create only, fewer fields | ❌ draft, edit, publish, fields |
| TASK-04 lists | ✅ | 🟡 different views | ❌ scopes, TaskView shape |
| TASK-05 detail | ✅ | 🟡 | ❌ reviews, extensions, children, actions set |
| TASK-07 bulk | ✅ | ❌ | ❌ |
| WF-01..10 | ✅ | 🟡 update/status/reassign | ❌ acknowledge, start, submit, review, cancel, reopen |
| EXT-01..03 | ✅ | ❌ (direct change instead) | D-6 |
| CMT-01..03 | ✅ | 🟡 add only | ❌ edit, delete, reply, mentions |
| ATT-01..03 | ✅ (no real upload) | 🟡 single file per update | ❌ multi-file, contexts, remove |
| ESC-01..05,07 | ✅ client-side | ✅ server engine | 🟡 dueSoon, overdue notices, event model |
| ESC-06 ack | ✅ (no note) | ✅ (with note) | 🟡 note |
| ESC-09 workspace | ✅ | ❌ | ❌ |
| NTF-01 inbox | ✅ | 🟡 latest 40, mark read | ❌ unread toggle, types |
| NTF-02/03 dispatch, quiet | ✅ simulated | ✅ real + simulated | 🟡 type mapping, prefs |
| NTF-04 prefs | ✅ | ❌ | ❌ |
| NTF-05 digest | ✅ | ✅ | 🟡 schedule source (D-14) |
| REC-01..04 | ✅ | 🟡 no edit/delete, different fields | ❌ |
| DASH-01..03 | ✅ client-computed | 🟡 accountability only | ❌ dashboard payload |
| RPT-01..04 | ✅ client-computed | 🟡 one report + CSV/PDF | ❌ report payload, filters |
| STAFF-01..04 | ✅ | 🟡 CoS-only people CRUD | ❌ profile, scoped directory, reset |
| ORG-01/02 | ✅ | ❌ (manager set via person PUT) | ❌ teams/departments, atomic move |
| ROLE-01/02 | ✅ | ❌ | ❌ |
| POL-01 | ✅ | ✅ (+per-entity) | 🟡 dueSoon, field names |
| SET-01 | ✅ | ❌ | ❌ |
| AUD-01 | ✅ | 🟡 admin_log + chain checks | 🟡 shape/filters |
| DLV-01/02 | ✅ | 🟡 `/outbox` | 🟡 shape |
| SRCH-01 | ✅ | 🟡 `q` on task list only | ❌ people/teams |
| DEMO-01 | ✅ | 🟡 clock only | D-17 |

### 5.4 Missing integration (client side)
- **22 UI files read the mock store directly** via `getDb()` or `now()`, or call engine and authorization functions, bypassing the API layer. Examples: `Shell.tsx`, `DashboardPage.tsx`, `TaskDetailPage.tsx`, `ReportsPages.tsx`, `StaffPages.tsx`, `OrgPage.tsx`. Each of these needs data from an endpoint instead.
- The mock API functions are **synchronous**. `useApi` and `useAction` already wrap them in react-query, so making them `async fetch` calls is a contained change to `services/api/*`. Direct synchronous calls in `useMemo` (`assigneeOptions`, `parentOptions`, `search`) need hooks.
- Nav badges, the bell list and the "allowed actions" on list rows need server data.
- `vite.config.ts` has no `/api` proxy (the comment says none is needed for the prototype).

### 5.5 Missing validation
- Sensitive-ID guard (C-6): the client has nothing.
- Report from ≤ to.
- Server-side category, time zone and HH:MM checks for settings.
- Upload type allowlist.
- Recurring category default `'Operations'` bypasses the required-category check (`TaskFormPage.tsx:60`).

### 5.6 Missing security controls
- **Existing server** (from the server inventory):
  - no rate limiting
  - dev login lists and impersonates any user when not in production
  - upload is written to disk before validation and authorization (orphaned files)
  - no MIME allowlist
  - logout doesn't clear the cookie
  - 30 s per-process directory cache delays revocation
  - a duplicate email produces a 500
  - a CoS can remove the last CoS role
  - the outbox returns raw addresses
- **Client reference spec**:
  - task detail leaks the whole user directory
  - dashboard and report option lists are unscoped
  - the demo bar is available to everyone
  - tokens are generated with `Math.random()`

### 5.7 Missing tests
- Server: 38 tests exist (`README.md:178`).
- Not covered: OAuth, people CRUD, rules endpoints, uploads/downloads, outbox, digest, dispatcher retries, dev clock.
- Client: one self-check script (`client/src/selfcheck.ts`); no component or e2e tests.
- **Note:** `server/test/api.test.ts` runs `drop schema public cascade` on `TEST_DATABASE_URL`, which is `taskwatch_test`. It has not been run in this session (§7, D-18).

---

## 6. Existing assets worth keeping (repository evidence)

These already meet work-order requirements and have existing tests (**not run** in this effort; pass/fail unknown), so rebuilding them would waste effort:
- Escalation ladder math, routing and quiet hours: `server/src/engine/*`, covered by `test/rules.test.ts`.
- Notification dispatcher (WhatsApp Cloud API, SMTP, retries, held messages, simulation): `server/src/notify/*`.
- Append-only activity log with SHA-256 hash chain and DB triggers: `server/src/services/activity.ts` and `001_init.sql:104-112`.
- Sessions in Postgres, helmet, CSRF header, zod validation, migrations runner, seed.
- Sensitive-ID guard: `server/src/services/sensitive.ts`.
- CSV (with injection guard) and PDF exports.

The client already has a **shared pure ladder module** (`client/src/services/engine/escalation.ts`). It duplicates `server/src/engine/levels.ts`. Per the "never repeat code" rule, one implementation should be shared (D-9).

---

