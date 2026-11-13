# Staff Directory & Organisation FRD (STAFF / ORG)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). "Send password reset" from the staff row menu is AUTH-05 and session revocation mechanics are AUTH-02/03/06 in [AUTH-FRD.md](AUTH-FRD.md). Role permissions are ROLE-01/02 in [ADMINISTRATION-FRD.md](ADMINISTRATION-FRD.md).
> Nothing here has been executed. No test has been run.

## 0. Model decisions in force

| Topic | Rule | Evidence |
|---|---|---|
| Org units | "Department" is relabelled **Entity**; the 6 WO entities are BAIS, USAIS, International Evaluations, Embtel, Bay Area Accounting Solutions, Founder's Office; teams sit under entities. | [WO; D-4] |
| Roles | A user can hold **several** roles (`ceo`, `cos`, `manager`, `lead`, `staff`); effective permissions are the union of the roles' rows in the permission matrix. | [WO "second role"; D-8; V-S `routes/people.ts:65` already stores `roles[]`] |
| Reporting line | `managerId` (one manager per person) drives visibility and escalation routing. | [WO; V-C `services/authz/permissions.ts:26-62`] |
| Retention | People are archived, never deleted. | [WO; D-12] |
| Directory | TaskWatch keeps its own directory (standalone). | [D-22] |

---

## STAFF-01 Staff directory

**Description.** `/admin/staff`: list of people with manager, team, status and open/overdue counts; filters, stats and CSV. [V-C `features/staff/StaffPages.tsx:15-150`]

**Roles.** Route gate `manage_staff`. [V-C per FEATURE_INVENTORY "/admin/staff"] The API returns the people the caller may view (`canViewUser`): CoS or `manage_staff` → everyone; anyone else → themselves, their transitive reports and their chain of managers. [V-C `services/api/admin.ts:22-24`; `permissions.ts:102-107`]

**User actions (UI).**
- Search (name, email, title), Role, Team (incl. "No team"), Status: Active (default) / Inactive / "Without manager" (no manager and not CoS) — client-side today. [V-C `StaffPages.tsx:31-38`]
- Stats: total, active, inactive, without manager. [V-C per FEATURE_INVENTORY]
- "Export CSV". [V-C `StaffPages.tsx:48`]
- Row menu: View profile (STAFF-04), Edit (STAFF-02), Send password reset (AUTH-05), Deactivate / Reactivate (STAFF-03). [V-C `StaffPages.tsx:116-121`]

**Expected behaviour.**
- Each row: person fields, `managerName`, `teamName`, `openTasks` (active statuses), `overdueTasks` (active and `dueAt < now`). [V-C `admin.ts:25-33`]
- Filtering, sorting and paging move to the server once the directory exceeds the client cap (D-10).
- Contact fields (email, phone, WhatsApp) are returned only to callers with `manage_staff`. [A; SEC-9]
- CSV export uses the RPT-03 formula guard. [A]

**Data required.** users (+ `roles[]`, `entityId`, `teamId`, `status`, `archivedAt`), teams, entities, task counts.

**Backend processing.** One query with correlated counts (server already counts `open_tasks`, `routes/people.ts:29-32`).

**API (proposed).**

| Method | Path | Request (query) | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/staff` | `q, role, teamId (or "none"), entityId, status=active\|inactive, withoutManager=true, limit, before` | `{items:[{id,name,email?,title,roles,entityId,teamId,teamName,managerId,managerName,status,joinedAt,location,phone?,whatsapp?,whatsappOptIn,timezone,openTasks,overdueTasks}], counts:{total,active,inactive,withoutManager}, next}` | Yes: `GET /people` [V-S `routes/people.ts:28-52`]; replace `requireRole('cos','ceo')` with `canViewUser` scoping; add team, filters, overdue count. |
| GET | `/api/staff/export.csv` | same filters | CSV | New. |

**Built 2026-11-04 (T-3.3).** `GET /api/people` → `{items}` per the approved [API_CONTRACTS](../../03-architecture/API_CONTRACTS.md) (not `/api/staff`). Rows = shared `canViewUser` inside the caller's organization; `email`, `phone`, `whatsapp` only for `manage_staff` or oneself. Filters, stats and sorting stay client-side over the scoped list (ADR-0009), so the query parameters above are not built. The CSV export is not built yet.

**Validation.** Enum checks on `role`, `status`; `q` ≤ 100 chars [A].

**Authorization.** C-1/C-2; row set = `canViewUser`. The page itself is `manage_staff`; calling the API without it returns only the caller's visible set (no 403), which other pages (Team, Search) rely on. [V-C `admin.ts:24`]

**Success / failure.** 200; 401; 422.

**Dependencies.** ROLE-01 (permissions), ORG-01, D-8, D-10.

**Acceptance criteria.**
1. STAFF-01-AC-1: A user with `manage_staff` receives every person, active and inactive.
2. STAFF-01-AC-2: A lead without `manage_staff` receives only themselves, their transitive reports and their managers, with no email/phone/WhatsApp fields.
3. STAFF-01-AC-3: `openTasks` and `overdueTasks` match a manual count for a sample person.
4. STAFF-01-AC-4: "Without manager" returns active people with no manager who do not hold `cos`.

**Test scenarios.** Scope by role · each filter · CSV injection guard · inactive people listed with status · multi-role person matched by any role filter.

---

## STAFF-02 Create / edit person

**Description.** Add a person or edit their details, role(s), manager, team, contact and time zone. [V-C `services/api/admin.ts:89-140`; `StaffPages.tsx:152-260`]

**Roles.** `manage_staff`. Creating a CoS, or changing anyone's role, also needs `manage_roles`. [V-C `admin.ts:111-112, :124, :128`]

**User actions (UI).** StaffDialog fields: Full name*, Work email*, Job title*, Role* (disabled without `manage_roles` or for yourself, `StaffPages.tsx:198`), Manager (options filtered client-side: active, not self, higher rank than the chosen role, no loop, `:163`), Team, Location, Phone, WhatsApp number (hint "International format, e.g. +14155550123…"), Time zone (6 options incl. `Asia/Kolkata`, `America/Los_Angeles`, `:237`), "Agreed to receive work alerts on WhatsApp". Changing the role opens a confirm listing the new permissions (`:248-257`). Toasts "<name> added" / "Staff details saved". [V-C `StaffPages.tsx:159-160`] New field: **Entity** (D-4) [A].

**Expected behaviour.**
- Email is trimmed and lower-cased; uniqueness is case-insensitive. [V-C `admin.ts:94, :114`]
- WhatsApp is normalised by removing spaces, parentheses and hyphens; opt-in is stored only when a number exists. [V-C `admin.ts:84-87, :114, :137`]
- Defaults on create: `status=active`, `joinedAt=now`, location "Remote" when blank, time zone = `settings.timezone` when blank, default notification preferences. [V-C `admin.ts:114-116`]
- Team must belong to the person's entity. [A; D-4]
- Changing the manager re-evaluates escalation for the person's open tasks (C-7): the mock only does this in `setManager`, not in `updateStaff`. [V-C `admin.ts:133, :184`]
- Audit records: `staff.created` (next "Name (Role)", context email); on edit `staff.role_changed` (prev/next role labels), `staff.manager_changed`, `staff.team_changed`, `staff.whatsapp_changed` (prev/next number and "(opted in)"), and `staff.updated`. [V-C `admin.ts:117, :131-138`]
- A role change takes effect on the person's **next request** (no stale permissions in live sessions). [PRD ROLE-02; S-9]
- The "last active CoS" rule counts active users holding `cos` among their roles. [V-C `admin.ts:130`; D-8]

**Data required.** users: name, email, title, roles[], entityId, managerId, teamId, location, phone, whatsapp, whatsappOptIn, timezone, status, joinedAt, archivedAt.

**Backend processing.** Validate → authorise → transaction (insert/update + audit rows + invalidate directory cache across instances, S-7) → C-7 re-evaluation when manager changes.

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| POST | `/api/staff` | `{name,email,title,roles[],entityId,managerId,teamId,location,phone,whatsapp,whatsappOptIn,timezone}` | `201 {id}` | Yes: `POST /people` [V-S `routes/people.ts:91-112`]; change gate from role `cos` to `manage_staff`; add team, location, title required; map duplicate email to 422 (today 500, S-8). |
| PUT | `/api/staff/:id` | same | `200` | Yes: `PUT /people/:id` [V-S `routes/people.ts:114-148`]. |

**UI (T-3.8, 2026-11-05).** Two changes to the StaffDialog, both required: the single Role select became one checkbox per role (STAFF-05, D-8), and a required **Entity** select was added (D-4); the Team list follows the chosen entity. The role-change confirmation lists the union of the chosen roles' permissions. Everything else is unchanged.

**Built 2026-11-05 (T-3.4).** `POST /api/people` → `201` the directory row; `PUT /api/people/:id` → `200` the row (approved API_CONTRACTS paths). Gate `manage_staff`; the role rules and messages below are enforced in `services/staff.ts`. Unknown fields are refused (422). Audit kinds: `staff.created`, `staff.role_changed`, `staff.manager_changed`, `staff.team_changed`, `staff.whatsapp_changed`, `staff.email_changed` (D-99), `staff.updated` (other fields), each with before/after. **D-99:** an email change ends all the person's sessions and emails the old address (`email_changed` in the delivery log). Until the T-4.0 cutover, `whatsapp` reads as `whatsapp ?? phone` (KI-25).

**Validation (mock messages, `admin.ts:89-107`).**

| Field | Rule | 422 message |
|---|---|---|
| `name` | non-empty after trim; one word is enough (D-136, single-name people) | "Enter the person's name." |
| `name` | ≤ 120 chars | [V-S `people.ts:55`] |
| `email` | `^[^\s@]+@[^\s@]+\.[^\s@]+$` | "Enter a valid email address." |
| `email` | unique, case-insensitive | "Another account already uses this email." |
| `title` | non-empty, ≤ 120 | "Enter a job title." [V-C; V-S `people.ts:63` max] |
| `whatsapp` | after normalising, `^\+[1-9]\d{7,14}$` | "Use international format, e.g. +14155550123." (server regex `^\+\d{8,15}$` is looser, `people.ts:60`; use the client's) |
| `whatsappOptIn` | requires a number; **defaults to off for new people** (D-75, decided; Meta requires opt-in) | "Add a WhatsApp number before opting in." |
| `roles` | ≥ 1, each a known role | "Choose a role." |
| `managerId` | exists | "Manager not found." |
| `managerId` | no reporting loop (edit) | "That would create a reporting loop." |
| `timezone` | valid IANA zone | "Unknown time zone" [V-S `people.ts:67`] (mock does not check) |
| `entityId` | known entity | "Choose an entity." [A] |
| `teamId` | exists and belongs to `entityId` | "Choose a team in this entity." [A] |

**Authorization (exact mock messages).**
- No `manage_staff` → 403 "You don't have permission to manage staff." [V-C `admin.ts:111, :124` via `assertPerm`]
- Creating with `cos` without `manage_roles` → 403 "You don't have permission to grant Chief of Staff." [V-C `admin.ts:112`]
- Changing roles without `manage_roles` → 403 "You don't have permission to change roles." [V-C `admin.ts:128`]
- Changing your own role(s) → 403 "You cannot change your own role." [V-C `admin.ts:129`]
- Removing `cos` from the last active CoS → 409 "The organization must keep at least one active Chief of Staff." [V-C `admin.ts:130`]
- Unknown id → 404 "Person not found." [V-C `base.ts:53`]

**Success / failure.** 201/200; 401; 403; 404; 409; 422.

**Dependencies.** ROLE-01/02, ORG-01 (teams, entities), NTF-04 (default prefs), AUTH-06 (permission refresh), C-7.

**Acceptance criteria.**
1. STAFF-02-AC-1: Each validation rule returns 422 with the field key and message above.
2. STAFF-02-AC-2: Creating `Ana@BAIS.example` when `ana@bais.example` exists returns 422 on `email` (not 500).
3. STAFF-02-AC-3: A user without `manage_roles` who changes someone's roles gets 403 and nothing changes.
4. STAFF-02-AC-4: Removing `cos` from the only active CoS returns 409.
5. STAFF-02-AC-5: After a manager change, the person's open tasks are re-routed on the next escalation (new lead receives L1).
6. STAFF-02-AC-6: A role change is effective on the person's next API call.
7. STAFF-02-AC-7: Each edit writes the audit records listed above with previous and new values.

**Test scenarios.** Each 422 rule · case-insensitive duplicate · WhatsApp normalisation `+1 (415) 555-0123` · opt-in without number · loop via grand-report · own-role change · last CoS · create CoS without `manage_roles` · team/entity mismatch · audit rows · live-session permission change.

---

## STAFF-03 Activate / deactivate (archive)

**Description.** Deactivate (archive) or reactivate a person. People are never deleted. [WO; V-C `admin.ts:142-153`]

**Roles.** `manage_staff`. [V-C `admin.ts:144`]

**User actions (UI).** Row menu Deactivate / Reactivate with a confirm; a warning shows when the person has open tasks; result toast "<name> deactivated. N open task(s) still assigned — reassign them from Team Tasks." [V-C `StaffPages.tsx:25-27, :130-147`]

**Expected behaviour.**
- Returns `{openTasks}` = the person's tasks in active statuses. [V-C `admin.ts:151`]
- Deactivation sets `status=inactive` and `archivedAt=now`; reactivation clears `archivedAt`. [V-S `routes/people.ts:157`]
- **All of the person's sessions stop working immediately** (next request → 401). The server's 30 s per-process directory cache delays this today (S-7). [PRD STAFF-03; V-S `services/directory.ts:111` per EXISTING_SYSTEM_ANALYSIS]
- Open tasks stay assigned; escalation routing skips inactive people and goes to the next active level. [V-C `services/core.ts:61`; V-S routing per EXISTING_SYSTEM_ANALYSIS §3.6]
- Inactive people receive no notifications. [V-C `core.ts:38`]
- Recurring schedules they own stop generating (REC-04, D-46).
- Audited `staff.deactivated` / `staff.activated` with prev/next status. [V-C `admin.ts:150`]

**API (built 2026-11-05, T-3.5).** `POST /api/people/:id/status {status}` → `{openTasks}` (approved API_CONTRACTS path). Deactivation also deletes every session of the person. Setting the current status again changes and audits nothing. Proposed earlier: `POST /api/staff/:id/status {status:"active"|"inactive"}` → `{openTasks}`. Adapt `POST /people/:id/active {active}` [V-S `routes/people.ts:150-168`]; return the open-task count; gate by `manage_staff`.

**Validation.** `status` enum → else 422.

**Authorization.**
- No `manage_staff` → 403 "You don't have permission to manage staff."
- Yourself → 403 "You cannot deactivate your own account." [V-C `admin.ts:146`] (server returns 400 "You cannot archive yourself", `people.ts:154`; use 403.)
- Last active CoS → 409 "The organization must keep at least one active Chief of Staff." [V-C `admin.ts:147`]
- Unknown id → 404 "Person not found."

**Success / failure.** 200; 401; 403; 404; 409; 422.

**Dependencies.** AUTH-02/03 (session revocation), ESC-04, REC-04, AUD-01.

**Acceptance criteria.**
1. STAFF-03-AC-1: After deactivation, the person's existing session gets 401 on its next request, on every server instance.
2. STAFF-03-AC-2: The response reports the number of open tasks still assigned.
3. STAFF-03-AC-3: An L1 escalation for a task whose lead is inactive goes to the manager.
4. STAFF-03-AC-4: No row in `users` is ever deleted by this endpoint.
5. STAFF-03-AC-5: Deactivating yourself returns 403; the last CoS returns 409.

**Test scenarios.** Deactivate with/without open tasks · session revocation across two instances · routing fallback · notifications skipped · reactivate · self · last CoS · audit rows.

---

## STAFF-04 Staff profile

**Description.** Profile of one person: details, manager, reports, chain, team, effective permissions, visible assigned/created tasks, stats, escalations and recent activity. Also used for "My profile". [V-C `admin.ts:38-67`; `StaffPages.tsx:264-390`; `features/account/AccountPages.tsx:14-16`]

**Roles.** Anyone who can view the person (`canViewUser`). The route `/admin/staff/:id` has no UI guard; the API is the control. [V-C per FEATURE_INVENTORY "/admin/staff/:id"]

**User actions (UI).** Tabs: Assigned tasks, Created tasks (first 25 each), Escalation history, Recent activity [V-C `StaffPages.tsx:306-309`]; "Edit" with `manage_staff` (STAFF-02).

**Expected behaviour.**
- `assigned` / `created`: the person's tasks **that the viewer can see**. [V-C `admin.ts:42-44`]
- Stats over visible assigned tasks: open (active), overdue, completed, on-time rate (completed by due ÷ completed). [V-C `admin.ts:57-62`]
- `escalations`: events on visible assigned tasks, newest first, 20. [V-C `admin.ts:63`]
- `activity`: the person's actions on visible tasks, newest first, 15. [V-C `admin.ts:64`]
- `permissions`: the union of the person's roles (D-8); a CoS has all. [V-C `admin.ts:54`]
- `reports` must also be filtered by `canViewUser`; today a staff member viewing their manager sees the manager's other reports. [V-C `admin.ts:51`; A]
- Contact fields only for `manage_staff` or self. [A; SEC-9]

**API (built 2026-11-04, T-3.3).** `GET /api/people/:id` → `{user, manager, reports, chain, team, permissions, assigned, created, stats, escalations, activity}` per API_CONTRACTS; one's own profile is the same route with one's own id. Not viewable → 404 "Person not found." for everyone (same as missing). `manager`, `reports` and `chain` are filtered by `canViewUser`. `assigned`/`created` are today's server task rows (first 25, newest first); the stats count every visible assigned task. `entity` is not returned (the user row has `entityId`).

**Validation.** `id` format.

**Authorization.** Not viewable → **403 "You are not authorized to view this profile."** [V-C `admin.ts:41`]; unknown → 404 "Person not found." [V-C `base.ts:53`]. Because 403 vs 404 reveals existence, return 404 for both when the caller lacks `manage_staff`. [A]

**Success / failure.** 200; 401; 403/404.

**Dependencies.** STAFF-01, TASK-05 (`canViewTask`), ESC, AUD.

**Acceptance criteria.**
1. STAFF-04-AC-1: A staff member can open their own profile and their manager's, and gets 403/404 for a peer in another team.
2. STAFF-04-AC-2: Every task, escalation and activity in the response is on a task the viewer can view.
3. STAFF-04-AC-3: `permissions` equals the union of the person's roles' permissions.
4. STAFF-04-AC-4: A non-`manage_staff` viewer gets no email/phone for anyone but themselves.

**Test scenarios.** Self · manager · report · out-of-scope (WO AC-6 style through the API) · multi-role permission union · reports filtered · stats match.

---

## STAFF-05 Multiple roles per person (new, from WO)

**Description.** "Anyone can be given a second role, for example a team lead who also does case work." [WO; D-8]

**Roles.** `manage_roles` to change; `manage_staff` to open the dialog. [V-C `admin.ts:128`]

**User actions (UI).** Replace the single Role select with a multi-select (at least one role). The confirm dialog lists the **union** of permissions. [D-8; V-C `StaffPages.tsx:196-200, :248-257`]

**Expected behaviour.**
- Effective permissions = union of the matrix rows of every held role; any held `cos` grants everything. [D-8; V-C `permissions.ts:15-19`]
- Rank for the manager picker and dashboard layout = the highest-ranked held role. [A; V-C `constants/index.ts:14`]
- Routing uses the role that matches the level being looked up (a lead+staff person is found as "lead" at L1). [V-S `engine/routing.ts` uses `hasRole`, per EXISTING_SYSTEM_ANALYSIS §3.6]
- The Roles page "active count per role" counts a person under each role they hold. [V-C `admin.ts:203`; A]

**Data required.** `users.roles text[]` (exists on the server). [V-S `001_init.sql` per EXISTING_SYSTEM_ANALYSIS §3.2]

**API.** Part of STAFF-02 (`roles[]`).

**Validation.** `roles` non-empty, unique, known → 422 "Choose a role.".

**Authorization.** As STAFF-02 role rules.

**Dependencies.** ROLE-01/02, AUTH-06, AUTH-07 (2FA required if any held role is Manager, CoS or CEO, D-21).

**Acceptance criteria.**
1. STAFF-05-AC-1: A person holding `lead` and `staff` has exactly the union of both matrix rows.
2. STAFF-05-AC-2: Adding `manager` to a person makes 2FA required at their next password sign-in (D-21).
3. STAFF-05-AC-3: An empty role list is rejected with 422.

**Test scenarios.** Union computation · CoS among roles · rank choice · 2FA trigger · role counts.

---

## ORG-01 Organisation tree and teams

**Description.** `/admin/org`: reporting tree (since 2026-11-10 a top-down chart: the CEO → CoS band on top, one column per entity under a coloured pill, elbow connectors, dotted canvas, zoom 50–150 % opening fitted to width; owner request) and team groupings, search with chain highlight, per-person load badge, orphan banner. [V-C `features/org/OrgPage.tsx:20-175`]

**Roles.** Route gate `manage_staff`. [V-C per FEATURE_INVENTORY "/admin/org"] API returns people per `canViewUser`. [V-C `admin.ts:168-174`]

**User actions (UI).** Segmented "Reporting tree" / "Teams"; search highlights matches and their chain (`ancestorsOf`); Expand all / Collapse; "Move" opens ORG-02. [V-C per FEATURE_INVENTORY; `OrgPage.tsx:25`]

**Expected behaviour.**
- Load badge per person: open = active-status tasks, overdue = open past due; colour danger if overdue > 0, warning if open > `overloadThreshold`, else ok. Today read from the raw store. [V-C `OrgPage.tsx:14-18, :76`]
- Orphans: people with no manager who do not hold `cos`; shown in a banner. [V-C `OrgPage.tsx:41`]
- Teams grouped under entities (D-4).
- Entity and team **creation/rename** is not in the UI or the WO; entities are seeded (WO WP-1 "seeded directory for all entities"). [WO; A]

**Data required.** Visible people with manager, team, entity, roles, status, load counts; teams (entity, lead); entities (head).

**API (built 2026-11-05, T-3.6).** As below, scoped to the caller's organization; `people` are the directory rows (`GET /api/people` items, with `openTasks`/`overdueTasks`). `GET /entities` is now organization-scoped too. Proposed: `GET /api/org` → `{entities:[{id,name,headId}], teams:[{id,name,entityId,leadId}], people:[{id,name,title,roles,managerId,teamId,entityId,status,open,overdue}], overloadThreshold}`. Partly: `GET /entities` [V-S `routes/people.ts:15-18`]; teams table is new.

**Validation.** None.

**Authorization.** C-1; people filtered by `canViewUser`; counts only for visible people.

**Dependencies.** STAFF-01, SET-01 (`overloadThreshold`), D-4.

**Acceptance criteria.**
1. ORG-01-AC-1: The response lists the 6 WO entities with their teams.
2. ORG-01-AC-2: Load counts come from the API; the page imports no `getDb()`.
3. ORG-01-AC-3: Orphans exclude CoS holders.

**Test scenarios.** Tree with orphan subtree · load colours at threshold and threshold + 1 · search chain · non-`manage_staff` caller gets scoped people.

---

## ORG-02 Move person (manager and team)

**Description.** Set a person's manager and team **in one transaction**. Today the dialog makes two calls, `setManager` then `setTeam`, so a failure can leave half a move. [V-C `OrgPage.tsx:178-193`; `admin.ts:176-196`]

**Roles.** Manager change: `manage_staff`. Team-only change: `manage_staff`, or `manage_team` when the person is in the caller's transitive reports. [V-C `admin.ts:178, :190`]

**User actions (UI).** MoveDialog "Reporting for <name>": Reports to (options: active, higher rank, labelled "(would create a loop)"), Team; Save disabled on a loop with the field error "<name> cannot report to someone in their own reporting line." [V-C `OrgPage.tsx:178-225`] No success toast today.

**Expected behaviour.**
- Both changes commit together or not at all. [PRD ORG-02]
- Loop check on the server. [V-C `admin.ts:180`; V-S `routes/people.ts:71-77`]
- Escalation re-evaluated for the person's open tasks and for tasks of everyone below them, because routing follows the chain (C-7). [V-C `admin.ts:184`]
- Existing tasks keep their `teamId` (and so their entity); only new and reassigned tasks follow the new team. [V-C `services/core.ts` task `teamId` set at create/reassign; A]
- Audited `staff.manager_changed` and/or `staff.team_changed` with names. [V-C `admin.ts:183, :194`]
- Manager rank is filtered in the UI only (`OrgPage.tsx:214`, `StaffPages.tsx:163`); the server does not enforce rank. [V-C; V-S] Kept as UI guidance. [A]

**API (built 2026-11-05, T-3.6).** `PUT /api/people/:id/placement {managerId?, teamId?}` → `200` the directory row (approved API_CONTRACTS). Omitted fields are left as they are; unchanged values need no permission. Escalation is not re-run on save: routing reads the directory when the next level fires, so the next alert follows the new line (AC-4).

**Validation.**

| Field | Rule | Response |
|---|---|---|
| `managerId` | exists, active, not self | 422 "Manager not found." [V-C `admin.ts:102`; A for active] |
| `managerId` | no loop | **409** "<name> cannot report to someone in their own reporting line." [V-C `admin.ts:180`] |
| `teamId` | exists, in the person's entity | 422 "Choose a team in this entity." [A] |

**Authorization.** Manager change without `manage_staff` → 403 "You don't have permission to change reporting lines." [V-C `admin.ts:178`]. Team change without either rule → 403 "You cannot move this person between teams." [V-C `admin.ts:190`]. Unknown person → 404 "Person not found."

**Success / failure.** 200; 401; 403; 404; 409; 422.

**Dependencies.** STAFF-02, ESC-04, C-7, AUD-01.

**Acceptance criteria.**
1. ORG-02-AC-1: If the team update fails, the manager change is rolled back.
2. ORG-02-AC-2: Making A report to A's own report returns 409 with the message above.
3. ORG-02-AC-3: A manager with `manage_team` can move a report between teams but gets 403 for someone outside their line and 403 for any manager change.
4. ORG-02-AC-4: After moving a lead under a new manager, the next L2 for that lead's staff goes to the new manager.

**Test scenarios.** Atomic failure injection · loop direct and indirect · team-only by `manage_team` · manager to null (orphan) · re-routing after move · audit rows.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-4](../../01-discovery/OPEN_QUESTIONS.md) | Decided: Department = Entity; teams under entities. Team creation/rename UI not specified (seeded) [A]. |
| [D-8](../../01-discovery/OPEN_QUESTIONS.md) | Decided: multiple roles, union of permissions (STAFF-05). Rank for pickers = highest role [A]. |
| [D-12](../../01-discovery/OPEN_QUESTIONS.md) | Decided: archive, never delete. |
| [D-21](../../01-discovery/OPEN_QUESTIONS.md) | Decided: 2FA for anyone holding Manager, CoS or CEO; role changes trigger enrolment ([AUTH-FRD.md](AUTH-FRD.md) AUTH-07). |
| [D-22](../../01-discovery/OPEN_QUESTIONS.md) | Decided: standalone directory. |
| [D-10](../../01-discovery/OPEN_QUESTIONS.md) | Directory paging. |
| D-40 (decided) | CEO visibility of all people and tasks. |

## ADR-0011: verticals, departments and automatic reporting lines (owner, 2026-11-11; CODE_COMPLETE)

- **Terms:** on screen an entity is a **vertical** and a team is a **department** (Sales, Marketing, …), not a person's team. Code and API keep `entity` / `team`.
- **Who reports to whom (D-130, automatic, no override):** a general manager → the Chief of Staff; a department lead → the vertical's general manager, else the CoS; anyone else → their department lead, else the general manager, else the CoS. The CoS and CEO are not placed. "The CoS" = the first active CoS, else the CEO (`seniorOf`).
- **When lines move:** only for the people a change affects: the edited, created, moved or deactivated person and their direct reports; a department's members when its lead changes; a vertical's people when its general manager changes. Each move is audited as `staff.manager_changed` `{automatic: true}`.
- **Visibility:** unchanged rule (the reporting line). With the automatic lines, a general manager's line covers the whole vertical.
- **Management (D-131):** `/admin/verticals` for manage_staff: add a vertical (code, name, general manager), rename it, change its GM (the GM moves into it), archive it (409 while active people remain; its departments are archived with it); add, rename or archive departments and set their lead (the lead joins the department, unless they already lead one in this vertical: D-137). Nothing is deleted.
- **Several departments per lead (D-137):** a lead may run any number of departments in their own vertical; they keep one home department (one they lead). A lead of a department in another vertical is refused ("A lead can run several departments only within one vertical."). Losing or archiving the home moves them to another department they lead; moving them out of their departments, to another vertical, or removing the Team Lead role leaves them all. The lead picker shows "also leads …" and disables leads of another vertical.
- **Tests:** `permissions.test.ts` "ADR-0011 / D-130"; `api.test.ts` "Verticals and departments (ADR-0011…)" plus the rewritten STAFF-02 / ORG-02 tests.

## ADR-0015: attendance, vertical working time, GM-run verticals (owner, 2026-11-13; built, uncommitted)

Decisions D-156…D-165, [ADR-0015](../../03-architecture/decisions/ADR-0015.md). Design: [2026-11-13-attendance-and-vertical-time-design.md](../../superpowers/specs/2026-11-13-attendance-and-vertical-time-design.md).

### ATT-01 Mark attendance (GM)
- **Statuses:** present, absent, half day (an away from–to time), leave. A cleared day is stored as `unmarked`; rows are never deleted.
- **Who marks:** only the person's vertical GM. The CoS marks the Founder's Office. GMs, the CoS and the CEO have no attendance.
- **When:** today and past days only, in the vertical's zone. A range covers the person's working days; a single day is written as asked.
- **Audit:** every request writes one `attendance.marked` row.
- **API:**
  - `PUT /api/attendance {userIds, from, to, status, half?}` returns `{updated}`. `half`: `first` = away morning, `second` = away afternoon, split at lunch (the middle of the vertical's working hours, D-166). Real dates only (D-168). Away notices are queued in the same transaction (D-167).
    - Another vertical: 404.
    - A GM, the CoS or the CEO: 422 `userIds`.
    - A future day: 422 `day`.
    - A half day without `half`: 422 `half`.
  - `GET /api/attendance?from&to&teamId&userId&status` returns `{today, people, days}`. Unmarked days come back as `unmarked`.
- **AC-1:** unmarked days show as absent (dashed) and never change escalation (D-157).
- **AC-2:** a mark affects escalation only from the moment it is saved (D-164).

### ATT-02 My attendance
- `GET /api/attendance/me?month=YYYY-MM` returns the caller's own month. 404 for people without attendance.
- `/my-attendance` shows a read-only month calendar.
- The sidebar shows it only when `/api/me` says `hasAttendance`.

### ATT-03 Away and escalation
- **While marked away** (absent or leave for the whole day, a half day for its range):
  - non-Critical silence pauses;
  - Critical silence and all deadlines run as usual.
- **Away notice:** when someone is marked away today, each open task due between now and the end of the away window gets one notice (event `away_tasks`, the due-soon preference). It goes to the assignee, their GM and the task giver, once per task (`job_runs`).
- **Task page:** a tag "Assignee on leave", "absent today" or "away until HH:MM".

### ORG-03 Vertical working time
- `PUT /api/entities/:id/worktime {timeZone, quietHours, workDays, workStart, workEnd}`, for the vertical's GM or the CoS. Each field may be `null` (the organization default). Audited as `vertical.worktime_changed`.
- **Members follow the vertical** through the directory: zone, quiet hours and the work schedule. A vertical with no zone set keeps each person's stored zone and quiet hours.
- **Open tasks** keep their deadline times until "Apply to open tasks" (D-165).
- **Screens:** the Verticals page gets a "Working time" dialog. The person form no longer edits zone or quiet hours.

### STAFF-06 GM manages their vertical (D-162)
- **What a GM may do, in their own vertical only:**
  - add, edit, deactivate and reset people;
  - set roles among staff, lead and manager;
  - add, rename and archive departments;
  - see their people's contact details.
- **Refused:**
  - other verticals and the Founder's Office: 404;
  - the CoS or CEO role, renaming a vertical, changing its GM, creating or archiving verticals: 403.
- **Screens:** Staff, Verticals and Attendance appear in the GM's sidebar.

Tests: TC-ATT-*, TC-ORG-03-*, TC-STAFF-06-* (TEST_CASE_INVENTORY), e2e `attendance.spec.ts`. Last run: `npm test` 371/371, `npm run e2e` 5/5, typecheck 0 (2026-11-13).
