# API Contracts

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> The endpoint table in §2 is **Proposed — needs approval**. Behaviour and validation of each operation are specified in [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md) by feature ID and are not repeated here. Existing endpoints: [EXISTING_SYSTEM_ANALYSIS.md §3.3](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md).

Related: [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) · [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) · [DATABASE_DESIGN.md](DATABASE_DESIGN.md)

## 1. Conventions

| Topic | Rule | Evidence |
|---|---|---|
| Prefix | Everything under `/api`; unknown paths → `404 {error:"Not found"}` | [V-S `server/src/app.ts:59-62`] |
| Format | JSON request and response bodies; JSON limit 200 kb; uploads are `multipart/form-data` | [V-S `app.ts:29`] |
| CSRF | Every non-GET/HEAD/OPTIONS request must send header `x-taskwatch: 1`, else `403` | [V-S `server/src/http/middleware.ts:48-55`] |
| Auth | Session cookie `tw.sid`; every endpoint except the signed-out auth ones requires an active user → else `401` (C-1) | [V-S `app.ts:33-46`, `middleware.ts:26-38`] |
| Error envelope | `{ "error": string, "fields"?: { [field]: string } }`; no stack traces | PRD C-3; [V-S `middleware.ts:68-84`] |
| Status codes (C-3) | `200` ok · `201` created · `400` bad token/request · `401` not signed in / `SESSION_EXPIRED` · `403` not allowed · `404` not found **or not visible** · `409` state conflict · `413` file too large · `422` validation with `fields` · `429` rate-limited (new) · `500` | PRD C-3. **Implemented 2026-11-04:** zod → `422` with `fields` (T-1.11); not visible → `404` (T-1.12); `429` + `Retry-After` (T-1.13). |
| Not visible | A task/person/comment the caller may not see returns **404**, never 403, so IDs cannot be probed. The prototype returns 403 [V-C `client/src/services/authz/permissions.ts:85`] — D-60 (decided). | [V-S `server/src/routes/tasks.ts:135`] |
| Unknown fields | zod schemas are `.strict()`: unknown keys → 422 (SEC-7) | PRD NFR |
| Time | All instants are ISO-8601 UTC strings (`2026-11-03T09:00:00.000Z`), server-generated (C-4). Date-only inputs are `YYYY-MM-DD`; due date + time inputs are interpreted in a zone still to be confirmed [D-5, decided]. | [WO p.5] |
| IDs | Strings in JSON. Tasks: `TW-<n>` (n = `tasks.id`); the server accepts `TW-<n>` or `<n>` in paths. Others: decimal strings of integer keys. **Proposed.** | [V-C `client/src/services/core.ts:21`; V-S `001_init.sql`] |
| Lists | `{ items: [...], truncated: boolean }`, scoped in SQL, server-capped (ADR-0009, proposed) | [V-S `services/queries.ts:106`] |
| Task rows | `TaskView` = task + `level`, `levelInfo`, `overdue`, `lastUpdateAt`, `escalationAcked`, `actions[]` (WF-10) and **minimal** `assignee`/`giver` `{id,name}` and `team` `{id,name}` — never full user records | [V-C `client/src/services/api/base.ts:57-83`] |
| People in payloads | Only `{id, name, title?}` of people the response references; email/phone/WhatsApp only where the feature needs them (STAFF-*, own profile) | SEC-9; TASK-05 |
| Mutation responses | Return the updated resource (or `{done, skipped}` for bulk) so react-query can update without a refetch [A] | — |
| Rate limits | `429 {error}` with `Retry-After` on sign-in, reset, TOTP, search, upload ([SECURITY_ARCHITECTURE.md §6](SECURITY_ARCHITECTURE.md)) | SEC-3 |

"Adapts" column: the existing endpoint reused or reshaped [V-S `server/src/routes/*.ts`], or **new**. "Authz" lists the permission / allowed action; object-level visibility (`canViewTask`, `canViewUser`) applies to every `:id` route in addition.

## 2. Endpoint table — every client mock API function

### 2.1 `client/src/services/api/misc.ts` — auth, notifications, search, reports, dashboard

| Client function [V-C] | Method + path | Request | Response | Authz | Adapts |
|---|---|---|---|---|---|
| `DEMO_PASSWORD` (:12) | — | — | — | **Removed**; no shared password exists on the server | — |
| `login` (:14) | `POST /api/auth/login` | `{email, password}` | `200 {next: "done" | "totp" | "enroll"}` (AUTH-FRD; corrected 2026-11-04); session regenerated |\| "required" \| "enrol"}`; session regenerated | public; rate-limited; 401 generic, 403 inactive | **new** (ADR-0002) |
| — (TOTP step) | `POST /api/auth/2fa/verify` (AUTH-FRD path; corrected 2026-11-04) | `{code}` (6 digits or a recovery code) | `200 {ok}` | password-authenticated session pending MFA | **new** (D-21) |
| — (TOTP enrolment) | `POST /api/auth/2fa/enroll/start` → `POST /api/auth/2fa/enroll/confirm` | `{}` → `{code}` | `{otpauthUrl, secret}` → `{ok, recoveryCodes[10]}` (D-65) | pending-MFA session or signed-in user | **new** (D-21) |
| — (Google) | `GET /api/auth/google`, `GET /api/auth/google/callback` | redirect | redirect to SPA | public | existing [V-S `routes/auth.ts:33-76`] |
| `switchUser` (:27) | `POST /api/auth/dev-login` | `{userId}` | `{ok}` | non-production only (SEC-10) | existing [V-S `auth.ts:90-98`] |
| `logout` (:33) | `POST /api/auth/logout` | — | `{ok}`; session destroyed, cookie cleared | signed in | existing, fixed (S-6) [V-S `auth.ts:100-102`] |
| `expireSession` (:37) | — | — | — | **Removed** (demo); dev can call logout | — |
| `currentUser` (:42) | `GET /api/me` | — | `{user (roles[], team, entity, timezone), permissions[], settings: {orgName, timezone, categories, sessionTimeoutMinutes, workdayStart, workdayEnd}, rules (user's entity), badges: {unread, escalations, reviews, extensions}, integrations, serverTime, demo?}` | signed in | existing, reshaped [V-S `auth.ts:104-125`] |
| — (signed-out config) | `GET /api/auth/config` | — | `{google, password: true, devLogin}` | public | existing [V-S `auth.ts:28-30`] |
| `requestPasswordReset` (:50) | `POST /api/auth/reset-request` | `{email}` | `200 {ok:true}` always (no enumeration); token emailed | public; rate-limited | **new** (AUTH-04) |
| `resetPassword` (:60) | `POST /api/auth/reset` | `{token, password, confirm}` | `{ok}`; all sessions of the user revoked | public; rate-limited; 400 bad/expired token; 422 fields | **new** (AUTH-04) |
| `listNotifications` (:74) | `GET /api/notifications?unread=&type=&limit=&before=` | — | `{unread, items: [{id,type,title,body,taskId,at,read,deliveries[]}], next}` (own only) | signed in | **built 2026-11-05 (T-6.2)**; limit 1–100, keyset paging |
| `markRead` (:78) | `PATCH /api/notifications/:id` | `{read: boolean}` | `204` | owner only (404 otherwise) | **built 2026-11-05 (T-6.2)**; replaces `POST /notifications/read` |
| `markAllRead` (:86) | `POST /api/notifications/read-all` | `{}` | `{count}` | signed in | **built 2026-11-05 (T-6.2)** |
| `getPrefs` (:94) | `GET /api/me/notification-prefs` | — | `{prefs, mandatory, whatsappTypes, whatsappAvailable}` | own | **built 2026-11-05 (T-6.1)**; path per NOTIFICATIONS-FRD |
| `setPrefs` (:98) | `PUT /api/me/notification-prefs` | `{inApp, email, whatsapp}` (partial records) | `204` (mandatory types stored on) | own; audited `preferences.updated` | **built 2026-11-05 (T-6.1)** |
| `search` (:107) | `GET /api/search?q=` | — | `{tasks ≤8, people ≤6, teams}` | scoped by `canViewTask`/`canViewUser`; rate-limited | adapts `q` of `GET /tasks` [V-S `routes/tasks.ts:36`]; **built 2026-11-06 (T-8.4):** `q` ≤ 100 (422 "Search text is too long."), 120/min per person; tasks `{id,title,status,level,stage,assignee,giver,team}` ranked exact id (`123` or `TW-123`), title prefix, newest; people `{id,name,title,roles,active}` (email matched, never returned); teams only for supervisors; `%`/`_` literal |
| `reportScope` (**built 2026-11-07, T-9.1**) | `GET /api/reports/scope` | — | `{scope: "org" \| "team"}` | `view_org_reports` → org, else `view_team_reports` → team, else 403 "You do not have access to reports." (every `/api/reports*`, D-123) | **new** |
| `getReport` (**built 2026-11-07, T-9.1**) | `GET /api/reports?from&to&teamId&userId&giverId&priority&status&level` | query (strict; dates `YYYY-MM-DD` in the viewer's zone) | `{scope, summary, weeks, byStatus, byPriority, overdueByTeam, escalationsByLevel, staffRows, teamRows, giverRows, reviewers, turnaround, extensions, overdue: TaskBrief[]}` (`shared/reports.ts buildReport`; names only) | RPT-01 scope (team = visibility filter, D-51); 422 `fields.from` "The start date must be on or before the end date."; bad date / unknown team or person / unknown field → 422 | **new** |
| — (filter options, **built 2026-11-07**) | `GET /api/reports/options` | — | `{scope, teams:[{id,name,entityId}], people:[{id,name}], givers:[{id,name}]}` | RPT-04: org = all active; team = the viewer's line (+ the viewer as giver), givers hold a non-staff role | **new** |
| — (exports, **built 2026-11-07, T-9.3**) | `GET /api/reports/:reportId/export.csv?<filters>`; `GET /api/reports/accountability?days=7\|30\|90`; `GET /api/reports/accountability/export.csv\|pdf?days=` | query | CSV `taskwatch-report-<id>-<date>.csv` (columns `shared/reports.ts reportCsv`, formula guard incl. TAB/CR, BOM); FR-11 JSON / CSV / A4-landscape PDF | as above; unknown report id → 404 "Unknown report."; bad `days` → 422 | moved from `/api/dashboard/export.*` (removed) |
| `getDashboard` (:278) | `GET /api/dashboard?range=7\|30\|90&entity=` | — | the dashboard payload [V-C `misc.ts:308-350`], all aggregates over the viewer's scope (DASH-03); `recentAdmin` only with `view_audit_logs` | signed in | adapts `GET /dashboard` |
| — (DASH-01, **built 2026-11-06, T-8.1**) | `GET /api/dashboard?range=7\|30\|90&entity=` | — | `{layout: staff\|lead\|manager\|executive, kpis, attention, trend, …per layout (shared/insights.ts buildDashboard), activity, range, entity, scopeLabel, canCreate, overloadThreshold, entityOptions, l3Banner, me}`; staff adds `myDay, week, feedback, comments`; lead `health, workload, reviewQueue, escalated, stale, dueSoon, assignments, heatmap`; manager `health, workload, overdueByTeam, escalationsByPriority, complianceByTeam, delayedReviews, teams`; executive `health, workload, funnel, entities, escalationResponse, atRiskTeams, staff, staffByRole, orgMini, recentAdmin`. Task lists are capped briefs `{id,title,priority,status,assignee,dueAt,overdue,level,next}`; `me` = PERF-07 (own month score, open measured progress, load) | signed in; `entity` only for CoS/CEO (403 "You don't have permission to filter by entity."); bad range → 422 `{fields:{range:"Choose 7, 30 or 90 days."}}`; unknown entity → 422 | **new**; the FR-11 payload moved to `GET /api/reports/accountability?days=` (exports moved to `/api/reports/accountability/export.*` in T-9.3) |
| `/api/me` (2026-11-06) | `GET /api/me` | — | `user.reportCount` added: people below the caller (the client's "supervises" route gate in server mode) | signed in | — |
| `TeamPage` (DASH-02, **built 2026-11-06, T-8.2**) | `GET /api/team/overview` | — | `{reportCount, directCount, stats:{open,overdue,escalated,awaitingUpdate,onTimeRate}, workload ≤14, teams, people}` (names only) | `view_tasks` and (CoS/CEO or has reports), else 403 "You don't have permission to view your team." | **new** |

### 2.2 `client/src/services/api/tasks.ts` — tasks, workflow, comments, attachments

All `:id` routes: task not visible → 404; action not in `allowedActions` → 403; illegal transition → 409; free text passes the sensitive-ID guard → 422 (C-6). Every mutation re-evaluates escalation (C-7).

| Client function [V-C] | Method + path | Request | Response | Authz (`allowedActions` / permission) | Adapts |
|---|---|---|---|---|---|
| `attachmentUrl` (:12) | `GET /api/tasks/:id/attachments/:aid` (`?inline=1` for safe types) | — | file stream, `nosniff`, `attachment` unless inline-safe | `canViewTask` (ATT-02) | existing [V-S `routes/tasks.ts:127-143`] |
| `listTasks` (:18) | `GET /api/tasks?scope=mine\|assigned_by_me\|team\|all` | — | `{items: TaskView[], truncated}` | `assigned_by_me` needs `create_tasks`; `team` needs `view_tasks` | adapts `GET /tasks?view=` [V-S `tasks.ts:36`] |
| — (WO FR-10 summary tiles) | `GET /api/tasks/summary` | — | counts | scoped | existing [V-S `tasks.ts:31`] |
| `getTask` (:35) | `GET /api/tasks/:id` | — | `{task, activities, comments, updates, attachments, reviews, extensions, assignments, escalations, actions, parent, children, recurrence, people: {id→{id,name,title}}, rules, chain: {ok}}` — **no `users` directory** (fixes `tasks.ts:54`) | `canViewTask` | existing, reshaped [V-S `tasks.ts:64`] |
| `createTask` (:115) | `POST /api/tasks` (multipart if files) | `TaskInput` [V-C `tasks.ts:61-76`] | `201 TaskView` | `create_tasks`; + `assign_tasks` unless draft | existing, extended [V-S `tasks.ts:48`] |
| `updateTask` (:147) | `PUT /api/tasks/:id` | `TaskInput` | `TaskView` | action `edit`; due-date change follows FR-5 (ADR-0005) | **new** |
| `publishTask` (:195) | `POST /api/tasks/:id/publish` | — | `TaskView` | action `publish` | **new** |
| `acknowledgeTask` (:207) | `POST /api/tasks/:id/acknowledge` | — | `TaskView` | action `acknowledge` | **new** |
| `startTask` (:219) | `POST /api/tasks/:id/start` | — | `TaskView` | action `start` (also unblocks, ADR-0003) | **new** |
| `postProgress` (:228) | `POST /api/tasks/:id/progress` (multipart) | `{message, percent, files[]}` | `TaskView` | action `progress` (assignee) | adapts `POST /tasks/:id/updates` [V-S `tasks.ts:75-97`] |
| — (WF-11 Blocked) | `POST /api/tasks/:id/block` | `{reason}` | `TaskView` | assignee; active status | adapts `updates` with `status: 'blocked'` [V-S `services/tasks.ts:111-160`] |
| `submitForReview` (:249) | `POST /api/tasks/:id/submit` (multipart) | `{note, files[]}` | `TaskView` | action `submit` | **new** |
| `completeTask` (:266) | `POST /api/tasks/:id/complete` | `{note}` | `TaskView` | action `complete` | adapts `POST /tasks/:id/status` (done) [V-S `tasks.ts:120`] |
| `reviewTask` (:280) | `POST /api/tasks/:id/review` | `{decision, comment}` | `TaskView` | action `review`; not own work (403); no pending round (409) | **new** |
| `requestExtension` (:306) | `POST /api/tasks/:id/extensions` | `{requestedDate, requestedTime, reason, info}` | `201 Extension` | action `request_extension` | **new** (ADR-0005) |
| `decideExtension` (:325) | `POST /api/extensions/:extId/decision` | `{approve, note}` | `Extension` | action `decide_extension`; not requester (403); not pending (409) | **new** |
| — (FR-5 direct change) | `POST /api/tasks/:id/due` | `{dueDate, dueTime, reason}` | `TaskView` | cos; manager overseeing; lead overseeing once (ADR-0005) | existing [V-S `tasks.ts:106-111`] |
| `reassignTask` (:347) | `POST /api/tasks/:id/reassign` | `{toId, reason}` | `TaskView` | action `reassign`; target in scope | existing [V-S `tasks.ts:113-118`] |
| `cancelTask` (:372) | `POST /api/tasks/:id/cancel` | `{reason}` | `TaskView` | action `cancel` | **new** |
| `reopenTask` (:385) | `POST /api/tasks/:id/reopen` | `{reason, dueDate}` | `TaskView` | action `reopen` | adapts `POST /tasks/:id/status` (open) |
| `ackEscalation` (:407) | `POST /api/tasks/:id/escalations/ack` | `{note}` (**required**, WO FR-9) | `TaskView` | action `ack_escalation` | adapts `POST /escalations/:id/ack` [V-S `tasks.ts:145-150`] |
| `addComment` (:426) | `POST /api/tasks/:id/comments` (multipart if files) | `{body, parentId?, files[]}` | `201 Comment` | action `comment` (assignee included — D-74 (decided)) | existing, extended [V-S `tasks.ts:99-104`] |
| `editComment` (:441) | `PUT /api/comments/:commentId` | `{body}` | `Comment` | author only | **new** |
| `deleteComment` (:453) | `DELETE /api/comments/:commentId` | — | `{ok}` (soft delete; original stays in the log, D-12) | author or `cos` | **new** |
| `addAttachments` (:465) | `POST /api/tasks/:id/attachments` (multipart) | `files[]`, `context` | `201 Attachment[]` | action `attach`; type allow-list, size limit [D-13, decided] | **new** (replaces single-file update upload) |
| `removeAttachment` (:474) | `DELETE /api/attachments/:attId` | — | `{ok}` (hidden; file kept) | uploader or overseer | **new** |
| `bulkCancel` (:489) | `POST /api/tasks/bulk/cancel` | `{ids[], reason}` | `{done[], skipped[]}` | per task: action `cancel` | **new** |
| `bulkAcknowledge` (:510) | `POST /api/tasks/bulk/acknowledge` | `{ids[]}` | `{done[], skipped[]}` | per task: action `acknowledge` | **new** |
| `assigneeOptions` (:530) | `GET /api/tasks/options/assignees` | — | `{id,name,title,teamId}[]` | `assign_tasks` (else `[]`) | adapts `GET /users/assignable` [V-S `routes/people.ts:20`] |
| `parentOptions` (:538) | `GET /api/tasks/options/parents` | — | `{id,title}[]` | visible tasks | **new** |
| — (FR-11 PDF on the task list, D-15) | `GET /api/tasks/export.pdf?scope=` | — | PDF | as `listTasks` | **new**, reuses `services/exports.ts` |

### 2.3 `client/src/services/api/admin.ts` — staff, org, roles, policy, settings, queues, recurring, logs

| Client function [V-C] | Method + path | Request | Response | Authz | Adapts |
|---|---|---|---|---|---|
| `listStaff` (:22) | `GET /api/people` | — | `{items: StaffRow[]}` | `canViewUser` per row (STAFF-01) | adapts `GET /people` (cos/ceo only today) [V-S `routes/people.ts:28`] |
| `getStaffProfile` (:38) | `GET /api/people/:id` | — | profile payload [V-C `admin.ts:47-66`], tasks filtered by `canViewTask` | `canViewUser` → else 404 | **new** |
| `normalizeWhatsApp` (:84) | — (server-side validation inside create/update) | — | — | — | — |
| `createStaff` (:109) | `POST /api/people` | `StaffInput` with `roles[]` | `201 User` | `manage_staff`; granting `cos` needs `manage_roles`; duplicate email → 422 (S-8) | existing [V-S `people.ts:91`] |
| `updateStaff` (:122) | `PUT /api/people/:id` | `StaffInput` | `User` | `manage_staff`; role change needs `manage_roles`; not own role (403); keep ≥1 active cos (409) (S-9) | existing [V-S `people.ts:114`] |
| `setStaffStatus` (:142) | `POST /api/people/:id/status` | `{status}` | `{openTasks}`; on deactivate all sessions of the user are deleted | `manage_staff`; not self; last cos (409) | adapts `POST /people/:id/active` [V-S `people.ts:150`] |
| `resetAccess` (:155) | `POST /api/people/:id/reset-access` | — | `{sent: true}` — **the token is emailed, never returned** (fixes `admin.ts:159-165`) | `manage_staff`; audited `staff.access_reset` | **new** (AUTH-05) |
| — (2FA reset) | `POST /api/people/:id/reset-2fa` | — | `{ok}` | D-65 (decided) | **new** |
| `getOrg` (:168) | `GET /api/org` | — | `{users (scoped, with open/overdue counts), teams, entities}` | `canViewUser` | **new** (adapts `GET /entities` [V-S `people.ts:15`]) |
| `setManager` (:176) + `setTeam` (:188) | `PUT /api/people/:id/placement` | `{managerId?, teamId?}` | `User` | manager: `manage_staff`; team: `manage_staff` or (`manage_team` and person in my reports); loop → 409 | **new**; **one transaction** (ORG-02, fixes `OrgPage.tsx:185-193`) |
| `getRoles` (:200) | `GET /api/roles` | — | `{matrix, counts}` | `manage_roles` | **new** |
| `setRolePermissions` (:207) | `PUT /api/roles/:role` | `{permissions[]}` | matrix | `manage_roles`; `cos` → 403; unknown permissions dropped; audited | **new** |
| `getRules` (:222) | `GET /api/rules` (all scopes) | — | `{defaults, overrides: {entityId: RulesConfig}, history}` | signed in (read) | existing [V-S `routes/rules.ts:13`] |
| `setRules` (:226) | `PUT /api/rules/:scope` (`default` or entity id) | `RulesConfig` | `RulesConfig` | `manage_escalation_policies`; audited diff; re-evaluates open tasks | existing (cos-only today) [V-S `rules.ts:29`] |
| — (reset override, ADR-0006) | `DELETE /api/rules/:scope` | — | `{ok}` | as above | existing [V-S `rules.ts:39`] |
| `getSettings` (:250) | `GET /api/settings` | — | `Settings` | `manage_system_settings` (subset via `/me` for everyone) | **new** |
| `setSettings` (:254) | `PUT /api/settings` | `Settings` | `Settings` | `manage_system_settings`; audited | **new** |
| `listAudit` (:270) | `GET /api/audit?from&to&actorId&action&teamId&source&taskId` | — | `{items: AuditRecord[], truncated}` | `view_audit_logs` | adapts `GET /admin/audit` [V-S `routes/admin.ts:17`] |
| — (audit CSV) | `GET /api/audit/export.csv` | same query | CSV (formula-guarded) | `view_audit_logs` | **new** |
| — (D-16 chain check) | `POST /api/audit/chain-check` | — | `ChainResult` | `view_audit_logs` [D-16, decided] | existing [V-S `admin.ts:37`] |
| `listEscalations` (:279) | `GET /api/escalations` | — | grouped rows [V-C `admin.ts:286-301`] | `view_tasks`; scoped | **new** |
| `listReviewQueue` (:305) | `GET /api/reviews/queue` | — | `{task, submission}[]` | `review_tasks` | **new** |
| — (recent decisions, `QueuePages.tsx:18`) | `GET /api/reviews?decidedBy=me` | — | `Review[]` | signed in | **new** |
| `listExtensions` (:314) | `GET /api/extensions` | — | `{ext, task, canDecide}[]` | scoped to visible tasks | **new** |
| `listRecurrences` (:332) | `GET /api/recurring` | — | rows with `summary`, `next[≤3]`, `instances`, `canEdit`; archived hidden | `create_tasks`; cos all, else own or assignee in reports | existing [V-S `routes/recurring.ts:14`] |
| `saveRecurrence` (:361) | `POST /api/recurring` / `PUT /api/recurring/:id` | `RecurrenceInput` (ids as numbers) | `201 {id, generated}` / `200 {id}` | `create_tasks` + `assign_tasks`; edit: owner or cos | existing create [V-S `recurring.ts:48`]; edit **new** |
| `toggleRecurrence` (:382) | `POST /api/recurring/:id/active` | `{active}` | `{ok, generated}` | owner or cos; **audited** (S-10) | existing [V-S `recurring.ts:68`] |
| `rateTask` (PERF) | `POST /api/tasks/:id/rate` | `{outcomeScore?, shortfallAccepted?}` (one required) | `{task, actions}` | the giver, when `rate` is allowed | **new** |
| `leaderboard` (PERF) | `GET /api/performance/leaderboard?teamId&period=week\|month\|custom&from&to` | — | `{team, from, to, weights, rows[]}` **D-133:** `POST /api/tasks/:id/discard` (empty body) → 204: the giver deletes a never-assigned draft (hidden everywhere, never deleted); 403 otherwise. Allowed actions may now include `discard`; `reassign` is also offered to the giver. **ADR-0011:** `POST /api/entities` `{id, name, headId?}` → 201 `{id}`; `PUT /api/entities/:id` `{name, headId}` → 204; `POST /api/entities/:id/archive` → 204 / 409; `POST /api/teams` `{entityId, name, leadId?}` → 201 `{id}`; `PUT /api/teams/:id` `{name, leadId}` → 204; `POST /api/teams/:id/archive` → 204 / 409 (all manage_staff). `POST/PUT /api/people` and `PUT /api/people/:id/placement` no longer take `managerId`. `GET /api/performance/analytics?teamId&period…` → `{trend[8]: {from, to, average, scored}, teams: {id, name, people, average, scored}[]}` (D-128; same scope as the leaderboard). (Task detail `GET /api/tasks/:id` also returns `time: {worked, standard} | null`, D-125; settings carry `priorityWeights` and `standardTasks`); `weights` = the priority weights `{critical, high, normal, low}` (D-124); `rows[].score` = the Outcome Score | own team; `view_team_reports` (teams below); `view_org_reports` (all) | **new** |
| `perfTeams` (PERF) | `GET /api/performance/teams` | — | `[{id, name}]` visible boards | as above | **new** |
| `personBreakdown` (PERF) | `GET /api/performance/people/:id?period…` | — | `{person, score, tasks[] with excluded}` | self; team reports for people below; org reports | **new** |
| `teamWorkload` (PERF) | `GET /api/workload?teamId` | — | `{team, rows[]}` | as leaderboard | **new** |
| `deleteRecurrence` (:393) | `DELETE /api/recurring/:id` | — | `204` (soft delete) | owner or cos; audited | **new** |
| `isOverseerOf` (:404) | — (use `actions[]` on the task) | — | — | — | **removed** |
| `listDeliveries` | `GET /api/deliveries` | — | `{items: Delivery[], integrations: {email, whatsapp}}` | `view_audit_logs`; CoS all of the organization, others own (D-52) | **built 2026-11-05 (T-6.7)**; replaces `/outbox`; 30 days, cap 2000 |
| `myDeliveries` | `GET /api/me/deliveries` | — | `{items: Delivery[]}` (≤ 30) | own | **built 2026-11-05 (T-6.7)** |
| `sendWeeklyDigestNow` | `POST /api/admin/digest` | `{scope: "all"|"me"}` | `{sent}` | `all`: `manage_system_settings`, audited; `me`: digest recipients | **built 2026-11-05 (T-6.8)** |

### 2.4 `client/src/services/api/demo.ts` — development only

All return `404` when `config.demoTools` is false (always false in production [V-S `config.ts:62`]); otherwise require `cos` [D-17, decided].

| Client function [V-C] | Method + path | Request | Response | Adapts |
|---|---|---|---|---|
| `advanceClock` (:8) | `POST /api/dev/clock` | `{advanceHours}` | `{offsetHours}` | existing [V-S `routes/admin.ts:56`] |
| `resetClock` (:16) | `POST /api/dev/clock` | `{reset: true}` | `{offsetHours: 0}` | existing |
| `clockOffsetHours` (:27) | `GET /api/me` → `demo.offsetHours` | — | — | existing [V-S `auth.ts:122`] |
| `resetDemoData` (:23) | — | — | — | **not provided**: would wipe data; use `npm run db:seed` manually with D-18 consent |
| `runScenario` (:203), `SCENARIOS` (:88) | — | — | — | **not provided** pending [D-17, decided] |
| — | `POST /api/admin/engine` (run engine now) | — | `{checked, changed}` | existing [V-S `admin.ts:41`], dev/ops only |

### 2.5 `client/src/services/api/base.ts` — helpers, not endpoints
`me` (:12) → `GET /api/me`; `nowIso`, `mutate`, `read`, `findTask`, `findUser`, `toView`, `visibleTasks`, `invalid`, `hoursFromNow` (:28-96) are mock-store helpers. They are replaced by `fetch` + react-query in the client and by service code on the server; they have no endpoint.

### 2.6 Operational
| Method + path | Purpose | Authz | Adapts |
|---|---|---|---|
| `GET /api/health` | `{ok, db: true}` for uptime checks (PRD NFR Observability [A]) | public, no data | **new** |

## ADR-0015 endpoints (2026-11-13)
- **Attendance:**
  - `PUT /api/attendance` marks people (the GM of their vertical; the CoS for the Founder's Office).
  - `GET /api/attendance` lists the people the caller marks, with their days.
  - `GET /api/attendance/me` returns the caller's own month.
- **Working time:** `PUT /api/entities/:id/worktime` sets a vertical's working time (its GM or the CoS).
- **GM scope:** `/api/people`, `/api/people/:id` (PUT, status, reset-access) and `/api/teams*` now accept a GM for their own vertical (404 outside it).
- **Data changes:**
  - `/api/me` adds `hasAttendance`;
  - task views add `assigneeAwayUntil` and `assigneeAwayKind`;
  - `/api/org` entities add `worktime`.
