# Global Search FRD (SRCH)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). Visibility rules `canViewTask` / `canViewUser` are specified with TASK-05 and STAFF-01 and are only applied here.
> Nothing here has been executed. No test has been run.

## SRCH-01 Global search

**Description.** One search box across tasks, people and teams that returns only what the user may see. [V-C `services/api/misc.ts:107-120`; `app/SearchPalette.tsx:21-125`; WO "Access control enforced on the server for every request"]

**Roles.** Every signed-in active user. Results are filtered per user; search never returns 403. [V-C `misc.ts:111-117`]

**User actions (UI).**
- Open with Ctrl/Cmd+K, `/`, or the top-bar search button. [V-C `app/Shell.tsx:45-58, :142`]
- Type a query; results are grouped Tasks / People / Teams; Up/Down to move, Enter to open. [V-C `SearchPalette.tsx:35-70`]
- Empty query shows up to 6 recent searches stored per user in the browser (`recent-search.<userId>`); a search is saved when a result is picked. [V-C `SearchPalette.tsx:26, :43-46`]
- Destinations: task → `/tasks/:id`; person → `/admin/staff/:id`, except a user without `manage_staff` picking themselves → `/profile`; team → `/tasks/team?team=:id`. [V-C `SearchPalette.tsx:51-67`]
- Empty states: "No results you have access to for …" and "Try a task ID like TW-1012…". [V-C per FEATURE_INVENTORY "SearchPalette"]

**Expected behaviour.**
- Query is trimmed and matched case-insensitively as a substring; an empty query returns empty groups. [V-C `misc.ts:109-110`]
- **Tasks**: tasks the user can view (`canViewTask`), matched on task ID, title, assignee name, giver name or team name; first **8**. Each result shows ID, title, assignee, giver, team, status and level badge. [V-C `misc.ts:111-114`; `SearchPalette.tsx:48-58`]
- **People**: people the user can view (`canViewUser`: CoS or `manage_staff` → all; else self, reports, managers), matched on name, email or title; first **6**; shows title and role. [V-C `misc.ts:115`; `permissions.ts:102-107`]
- **Teams**: teams that contain at least one person the user can view, matched on name. [V-C `misc.ts:116-117`] Return teams only when the user can open the team task list (`supervises`), otherwise the link leads to Access Denied. [V-C `app/routes.tsx:36-39` per FEATURE_INVENTORY; A]
- Results carry only display fields: no email or phone in the response unless the viewer has `manage_staff` (the UI never shows them). [A; SEC-9]
- The UI debounces input (≈250 ms) and cancels stale requests; today `search()` runs synchronously on every keystroke. [V-C `SearchPalette.tsx:39`; A for the interval]
- LIKE wildcards (`%`, `_`, `\`) in the query are escaped. The server's task `q` filter does not escape them today. [V-S `services/queries.ts:94`; A]
- Inactive people are included and marked inactive, so their past tasks can still be found. [V-C `misc.ts:115` has no status filter; A for the marker]

**Data required.** Task id, title, status, level, assignee/giver/team names; user name, email (match only), title, roles, status; team name.

**Backend processing.** One request; three queries each joined to the caller's visibility set (same resolver as DASH-03 / RPT-01). Task ID prefix (`TW-`) short-circuits to an exact lookup. [A] Ranking: exact ID match first, then title prefix, then other matches. [A]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/search?q=<text>` | `q` | `{tasks:[{id,title,status,level,assignee:{id,name},giver:{id,name},team:{id,name}\|null}], people:[{id,name,title,roles,status}], teams:[{id,name}]}` | Partly: `GET /tasks?q=` matches title or assignee name only, capped at 500 [V-S `routes/tasks.ts:36`, `services/queries.ts:94`]. People and team search are new. |

**Validation.** `q` trimmed, 1–100 characters; longer → 422 `{fields:{q:"Search text is too long."}}`. [A] Empty → `200` with empty groups. [V-C `misc.ts:110`]

**Authorization.** C-1. Filtering by `canViewTask` and `canViewUser` on the server. Rate-limited per user (SEC-3, search is listed). [PRD NFR SEC-3] Over the limit → 429. [A]

**Success / failure.** 200; 401; 422; 429.

**Dependencies.** TASK-05 (`canViewTask`), STAFF-01 (`canViewUser`), DASH-02 / TASK-04 (team list route), D-10.

**Acceptance criteria.**
1. SRCH-01-AC-1 (WO AC-6, through the API): a staff member searching the exact ID of another team's task gets no task result.
2. SRCH-01-AC-2: At most 8 tasks and 6 people are returned.
3. SRCH-01-AC-3: A lead searching a peer lead's name (not in their chain) gets no person result; searching their own manager's name does.
4. SRCH-01-AC-4: A query of `%` returns only records whose fields contain a literal `%`.
5. SRCH-01-AC-5: The response contains no email or phone for a caller without `manage_staff`.
6. SRCH-01-AC-6: The UI sends at most one request per pause in typing, not one per keystroke.

**Test scenarios.** Match on each task field · match on person email / title · case-insensitivity · empty and whitespace query · 101-character query · wildcard characters · out-of-scope task ID · inactive person · team result for staff vs lead · rate limit · recent searches stay per browser (no server storage).

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-10](../../01-discovery/OPEN_QUESTIONS.md) | Server-side search replaces client-side filtering over full lists. |
| D-40 (decided) | CEO visibility (search results follow the same rule). |
