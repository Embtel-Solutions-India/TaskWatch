# Feature Inventory (frontend)

> Source: full read of `client/src` on 2026-11-03 (every file under app/, features/, components/). Verified facts carry file:line references; anything inferred is marked *(inferred)*. Feature IDs used across the docs are defined in [../02-product-requirements/PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md). Contract layer (`services/api/*`, `authz`, `engine`) is analysed in [EXISTING_SYSTEM_ANALYSIS.md](EXISTING_SYSTEM_ANALYSIS.md).

Base path: `client/src/`. All paths below are relative to it.

## How the app works overall

- **Reads.** Every page reads data through `useApi(key, fn)` (`hooks/index.ts`). This is react-query with `staleTime: Infinity`, no retry and no refetch on window focus (`app/App.tsx:13`). The query key is always prefixed `['db', ...]`. Any change to the mock store invalidates every query (`App.tsx:16`). Each read and write gets a fake delay of 120–340 ms.
- **Writes.** Writes go through `useAction(fn, {success, onSuccess})`.
  - On success it shows a toast (3.5 s; errors stay 6 s, `components/ui.tsx:573`).
  - An `ApiError` with status 422 shows no toast. Instead its `fields` map appears inline under the form fields.
  - Any other error shows an error toast.
- **Validation.** Almost all field validation happens in the API layer and comes back as 422 `fields`. Nearly every form sets `noValidate`, so the browser's own `min`/`max`/`type=email` checks are not enforced on submit. Where I list a min/max below, it only limits the spinner or slider. Exceptions:
  - The `maxLength` on the task title does limit typing.
  - Settings and Policies have no `<form>` at all, so nothing checks their inputs on the client.
- **Error, 403 and 404 screens.** `ErrorState` (`ui.tsx:218`) turns a 403 into `AccessDenied`, a 404 into a "Not found" empty state, and anything else into "Something went wrong" with an optional "Try again".
- **Direct store reads.** Many components call `getDb()` and read the localStorage store directly, skipping the API layer. Each case is noted per page and collected in the final list.
- **Route guards.** `Guarded` (`App.tsx:36-41`) runs `route.allow(getDb(), user)` and shows `AccessDenied` if it fails. The allow rules are in `app/routes.tsx:36-39`:
  - `supervises` = `view_tasks` AND (role is `cos` OR the user has at least one person in their reporting line)
  - `creates` = `create_tasks`
  - `reports` = `view_team_reports` OR `view_org_reports`
  - `perm(p)` = `hasPerm(p)`
- **Unknown paths.** Any unmatched path shows AccessDenied ("That page does not exist or is not available to you", `App.tsx:98`).

---

## App shell (`app/App.tsx`, `app/Shell.tsx`)

### App.tsx
- **Session check, `resolveAuth` (`App.tsx:20-34`).** Runs entirely on the client. It reads the session, then:
  - If the user is missing or not `active`, it clears the session.
  - If `Date.now() - lastActive > settings.sessionTimeoutMinutes`, it clears the session and redirects to `/session-expired` (`:58-60`).
- **Re-checking auth.** Auth is re-resolved on every store change (`:50`) and whenever any query fails with a 401 (`:51-57`).
- **Background timer, `:62-72`.** A `setInterval` runs every 30 s. Each run calls `tick()` (the client-side escalation/recurrence engine) and re-resolves auth. It also runs once on mount. **This is the only timer in the app**: there is no react-query `refetchInterval` anywhere.
- **Signed-out routes:** `/login`, `/forgot-password`, `/reset-password`, `/session-expired`. Anything else redirects to `/login` with `from` saved in state (`:77-85`).
- **Signed-in routes** do not include `/forgot-password`. So the "Reset password" link on Account settings (`AccountPages.tsx:92`) lands a signed-in user on AccessDenied (inferred from the route table).

### Shell nav (`Shell.tsx:60-118`)
- **Which items show.** Nav items are `ROUTES` that have a `nav` entry and either no `allow` rule or an `allow` that passes (`:61`). The three sections are General, Management and Administration.
- **"New task" button** in the sidebar shows only with `create_tasks` (`:79`).
- **Collapsed sidebar** state is saved in localStorage as `sidebar.collapsed`. Below 900 px the sidebar becomes a mobile drawer.
- **Breadcrumbs** come from `crumbs()` (`routes.tsx:91-102`).
- **Search** opens with Ctrl/Cmd+K or `/` (`:45-58`).
- **Theme.** There is a top-bar light/dark button and a Light/Dark/System toggle in the user menu. Both are local only (`utils/theme`).
- **User menu.** My profile, Account settings, theme, and Sign out. Sign out calls `logout()` from api/misc, then `refresh()`, then navigates to `/login` (`:173-185`).

### Nav badges, `useBadges` (`Shell.tsx:19-31`)
These are computed entirely on the client from raw `getDb()`. They re-render on every store revision via `useSyncExternalStore`.
- **notifications:** this user's unread notifications.
- **escalations:** the number of distinct tasks with an `active` escalation event at L1 or higher. The task must be visible to the user, and its assignee must be someone else (CoS sees all).
- **reviews:** visible tasks in `submitted` where `allowedActions` includes `review` (only counted with the `review_tasks` permission).
- **extensions:** pending extensions on visible tasks where `allowedActions` includes `decide_extension`.
- **mine:** my active tasks that I haven't acknowledged.

Visibility here uses `canViewTask` and `allowedActions` imported straight from authz/engine.

### Notification bell (`Shell.tsx:240-304`)
- Shows this user's 8 most recent notifications, read directly from `getDb()`.
- "Mark all read" calls `markAllRead()` directly, not through `useAction`. So there is no toast and no loading state.
- Clicking a row calls `markRead(n.id)` if it is unread, closes the popover, and goes to `/tasks/:taskId`.
- Empty state: "You're all caught up." Footer link: "View all notifications" (`/notifications`).
- There is no polling. The bell updates on store changes and on the 30 s engine tick.

---

## SearchPalette (`app/SearchPalette.tsx`)
- **Purpose:** a global search across tasks, people and teams.
- **API:** `search(q)` from api/misc, called synchronously on every keystroke inside a `useMemo`, with no debounce (`:39`). The code comment says "permission-aware in the service".
- **Empty query.** Shows up to 6 recent searches, saved per user in localStorage as `recent-search.${userId}` (`:26, :43`). A recent search is saved when you pick a result.
- **Where results go:**
  - **Task:** `/tasks/:id`.
  - **Person:** `/admin/staff/:id`. The one exception is a user without `manage_staff` picking themselves, who goes to `/profile` (`:66`). The `hasPerm` check here is client-side.
  - **Team:** `/tasks/team?team=:id`.
- **Keyboard:** Up/Down arrows move the selection; Enter opens it.
- **Empty states:** "No results you have access to for …" and "Try a task ID like TW-1012…".
- There is no loading or error state (the call is synchronous).

---

## DataTable (`components/DataTable.tsx`)
- **Sorting, paging and selection all happen on the client** over the full `rows` array it is given (`:56-66, :81`).
  - Sort cycles asc → desc → off (`:85-88`).
  - Page sizes are 10/25/50/100 (`ui.tsx:543`). The chosen size is saved in localStorage as `pagesize.${storageKey}`.
- **Columns.** Hidden columns are saved as `cols.${storageKey}`. Columns marked `fixed` can't be hidden.
- **Selection.** "Select all" covers the current page only. Selections that drop out of the filtered rows are removed automatically (`:73-79`).
- **Bulk actions.** A bulk bar appears when at least one row is selected.
- **Loading / empty.** A skeleton shows while `loading && rows.length === 0`. Otherwise an empty slot (default "Nothing to show").
- **Row click.** Clicks on links, buttons, inputs and labels inside a row are ignored (`:164`).

---

## Pages

### `/` Overview (dashboard)
- **Component:** `DashboardPage`, `features/dashboard/DashboardPage.tsx:26`.
- **Gate:** none (every signed-in user). The layout is chosen by **role**, not permission (`:71-74`):
  - `staff` → StaffDash
  - `lead` → LeadDash
  - `manager` → ManagerDash
  - `cos` and `ceo` → CosDash
- **Purpose:** a role-specific command center.
- **API:** `getDashboard` via `useApi(['dashboard', user.id])` (`:28`). The fields used are `d.mine.*`, `d.scope.*`, `d.workload`, `d.teams`, `d.staffStats.noManager` and `d.recentAdmin`.
- **Controls:**
  - Department select, CoS/CEO only (`:53-62`). Filtering happens on the client with `departmentOf` (`:355`).
  - Date-range segmented control: 7/30/90 days, saved in localStorage as `dash.range` (`:29, :63`).
  - "New task" link, shown when role is not staff (`:64`). This is role-based, not `create_tasks`.
  - KPI tiles, health-bar segments, funnel steps, workload rows and team links all navigate to filtered list URLs (`/tasks/team?status=…|due=overdue|level=…|assignee=…|team=…` and `/escalations?level=N`).
  - TrendCard has a Line/Bars toggle (`widgets.tsx:134`).
  - WorkloadCard has a member select (`widgets.tsx:150`).
  - AttentionPanel has "Show all N" / "Show less" (`widgets.tsx:90`).
- **Feedback:**
  - Error: `ErrorState` with retry (`:31`).
  - Loading: skeleton (`:32`).
  - Empty states: AttentionPanel "Nothing needs intervention", WorkloadCard "No workload in scope", ActivityCard "No recent activity", the TaskMiniList empty strings, and "No team has overdue or escalated work."
- **FoundersOfficeBanner (`:482-512`).** Shown when `foundersOffice(db)` includes the user. It counts L3 escalation events that are not resolved and name this user as a recipient. Read from raw db.

**What each role's dashboard computes on the client, from raw `getDb()` and `insights.ts`:**

- **StaffDash (`:97-216`):**
  - `kpis` (minus `critical`) and `attention`.
  - Week start (Monday) and tasks due / done this week, read from raw `db.tasks` (`:106-108`).
  - "Update next", sorted by `levelInfo.next.at`.
  - Recent feedback from raw `db.reviews`.
  - Comments from raw `db.comments` on my tasks.
  - A 7-day strip.
  - "My task timeline" from raw `db.activities`.
  - Trend.
- **LeadDash (`:220-265`):**
  - kpis, attention, health, workload (threshold `settings.overloadThreshold`).
  - Review queue and escalation watchlist from `d.scope`.
  - Stale tasks.
  - Due-within-48 h risk.
  - "Assignments" by status from `d.scope.assignedByMe`.
  - Trend.
  - Activity heatmap and activity feed from raw `db.activities` filtered to scope ids.
- **ManagerDash (`:269-315`):**
  - kpis, health, attention, trend.
  - Overdue by team.
  - Escalations by priority × level (ColumnChart).
  - Per-team update compliance: share of active tasks with `silenceLevel < 0`. Bar colors switch at 0.8 and 0.6.
  - Delayed reviews: submitted more than 24 h ago.
  - Workload with an average.
  - TeamComparison table built from `d.teams`.
- **CosDash (`:351-450`):**
  - kpis plus an extra "Active staff" KPI built from raw `db.users`.
  - Attention (critical/high, or medium at L1 or higher).
  - Health.
  - Escalation funnel/pyramid.
  - Department workload stacked chart and drill-down chips.
  - Trend.
  - Escalation response time: average hours from an L1+ event to its acknowledgement, per bucket.
  - At-risk teams: (overdue + escalated) ÷ open, top 5.
  - Staff by role donut (raw `db.users`).
  - OrgMini from raw departments/teams/users.
  - Staff workload.
  - Recent admin activity (`d.recentAdmin`).
  - Operational activity feed (raw `db.activities`).
- **`useReviewerSet` (`:79-93`).** Calls `allowedActions(db, user, rawTask)` for every task in scope to decide whether the user can review a task or decide its extension. This is a client-side permission evaluation.

**`insights.ts`: pure analytics, all client-side (`features/dashboard/insights.ts`):**
- **`kpis` (`:38-62`).** Six KPIs: open, overdue, critical (L2 or higher), awaiting review (oldest age in hours), completion rate, update compliance.
  - Each has a previous-period comparison and a 10-point sparkline.
  - Past values are rebuilt from the created/completed/updated timestamps (`isOpenAt`, `:9-14`). Past overdue uses the *current* due date.
- **`health` (`:72-81`).** Puts each open task into exactly one bucket, checked in order:
  1. Overdue
  2. Escalated (L1 or higher)
  3. At risk (L0, or due within 24 h)
  4. On track
- **`attention` (`:93-111`).** Severity rules:
  - **Critical:** overdue AND (priority critical OR level ≥ 2).
  - **High:** overdue; the next level fires in under 2 h; or a review has waited more than 24 h.
  - **Medium:** due within 24 h; not acknowledged more than 2 h after creation; or a pending extension that the user can decide.
  - Sorted by severity, then by level.
- **`trend` (`:120-136`).** 7, 10 or 13 buckets counting created, completed and "became overdue".
- **`workload` (`:149-169`).** Counts assigned and completed within the range, plus active and overdue now. A person is "overloaded" when active > threshold.
- **`funnel` (`:171-182`).** Open tasks per level, plus events triggered in this period versus the previous one.
- **`activityHeatmap` (`:185-195`).** Progress updates over the last 28 days, by weekday × 3-hour block, in local time.
- **`escalationResponse` (`:197-211`).** As described under CosDash.
- **`departmentOf` (`:213`).**

**`widgets.tsx`** is presentational only. It computes KPI deltas and good/bad polarity (`:16-18`), the health percentage (`:54`), and workload bar scaling.

---

### `/tasks/mine` (My Tasks), `/tasks/assigned-by-me` (Assigned by Me), `/tasks/team` (Team Tasks)
- **Component:** `TaskListPage`, `features/tasks/TaskListPage.tsx:19`, with `scope` set to `mine`, `assigned_by_me` or `team`.
- **Gates (`routes.tsx:43-45`):**
  - mine: none (badge `mine`).
  - assigned-by-me: `creates`.
  - team: `supervises`.
- **Purpose:** filterable task lists for each scope. (`META` also defines an `all` scope, but no route uses it.)
- **API:** `listTasks(scope)` via `useApi(['tasks', scope, userId])` (`:24`).
- **Filters (all client-side, `applyFilter` in `features/tasks/shared.tsx:110-141`):**
  - Free-text search over ID, title, assignee name and giver name.
  - Status: open/closed group or an exact status. "Open" includes draft and submitted.
  - Priority, assignee, giver, team. The dropdown options come from the loaded rows (`shared.tsx:149-150`), and the team select only appears when there is more than one team.
  - Due: overdue / today / within 7 days / later.
  - Level: any / none / 0–3.
  - Created: 7 / 30 / 90 days.
  - Updated: 24 h / 7 days / "stale" (`silenceLevel ≥ 0`).
  - "Clear" button.
  - The default filter is `status: 'open'` (`shared.tsx:108`).
- **Filter persistence and URL parameters.** The filter is saved per user and scope in localStorage as `filter.${userId}.${scope}`. On first load the URL parameters `team`, `due`, `assignee`, `level` and `status` override it (`:25-34`).
- **Quick filter segment (`:39-55, :99-108`), client-side:**
  - All.
  - "Needs attention": overdue OR level ≥ 0 OR an unacknowledged active task.
  - "In review": submitted or changes_requested.
  - Each option shows a count.
- **Saved views (`shared.tsx:247-269`).**
  - Saved in localStorage as `views.${userId}.${scope}`.
  - The name comes from `window.prompt("Name this view")` and is trimmed; saving with an existing name replaces that view.
  - "Delete all saved views" asks for `window.confirm`.
- **Export CSV (`:58-64`).** Generated on the client from the filtered rows, or from the selected IDs only. Columns: Task ID, Title, Priority, Status, Assignee, Task giver, Team, Due, Last update, Escalation level, Progress %.
- **Bulk actions (`:112-128`):**
  - "Acknowledge" (mine scope only) → `bulkAcknowledge(ids)`. Toast: "Acknowledged N task(s); M skipped".
  - "Export" → CSV of the selected rows.
  - "Cancel tasks" (only when scope is not mine AND `canCreate`) opens a dialog → `bulkCancel(ids, reason)`. The Reason field is marked required and validated by the API (`fields.reason`). Toast: "Cancelled N task(s); M skipped (not permitted or already closed)".
- **Row menu (`shared.tsx:58-73`):** Open; Acknowledge → `acknowledgeTask(id)`; Edit → `/tasks/:id/edit`. Which items appear is decided on the client by `allowedActions(getDb(), user, t)`.
- **"New task" link:** shown when `canCreate` (`useCan('create_tasks')`) and scope is not mine.
- **Table:** `taskColumns` (`shared.tsx:75-91`), default sort due ascending. Sorting and paging are client-side (DataTable). Clicking a row opens the detail page.
- **Feedback:**
  - Error: `ErrorState` with retry.
  - Loading: table skeleton.
  - Empty, with two variants: no rows at all ("No tasks assigned to you", or "No tasks yet" with a "Create a task" CTA), or no matches ("No tasks match these filters" with "Clear filters").
  - Toasts for the bulk actions.

### `/tasks/new` (New task) and `/tasks/:id/edit` (Edit task)
- **Components:** `NewTaskPage` (`features/tasks/TaskFormPage.tsx:15`) and `EditTaskPage` (`:24`), both rendering the shared `TaskForm` (`:40`).
- **Gates:**
  - New: `creates`.
  - Edit: no route rule. The page itself checks `q.data.actions.includes('edit')`; if that fails it shows a 403 ErrorState "You can't edit {id} in its current state." (`:30`).
- **Purpose:** create, draft or edit a task, or create a recurring schedule.
- **API:**
  - `getTask(id)` for edit.
  - `assigneeOptions()` (the dropdown list) and `parentOptions()`, called synchronously inside `useMemo`.
  - `createTask(input)`, `updateTask(id, input)` and `saveRecurrence(null, …)` via `useAction` (`:50-52`).
  - Category options come from raw `db.settings.categories`. Team options and the "assignee's team" label come from raw `db.teams`/`db.users`.
- **Fields.** "Required" below means the label has an asterisk. The actual checks happen in the API (field errors come back as `fields.*`).

| Field | Required | Client-side constraint / notes |
|---|---|---|
| Title | yes | `maxLength={140}`, placeholder "e.g. Reconcile October carrier invoices" (`:78`) |
| Description | no | hint "What does done look like?" |
| Assignment instructions | no | |
| Category | yes | select from `settings.categories` |
| Parent task | no | `parentOptions()` minus the task itself; error key `parentId` |
| Attachments | no | new tasks only; FilePicker accepts multiple files with no size or type limit; files are not uploaded ("Files stay in this browser tab only") |
| Assignee | yes | `assigneeOptions()`; on edit, an assignee outside your scope is shown as "(current)" (`:68, :119`) |
| Team / reporting scope | no | defaults to the assignee's team |
| Priority | yes | hint shows the silence thresholds from `silenceThresholds(priority, db.rules)`: "Update required every X h · L1 at … h · L2 … · L3 …" (`:137`) |
| Due date | yes | `type=date`, defaults to now + 2 days; error key `dueDate` |
| Due time | no | defaults to `17:00` |
| Start date | no | error key `startDate` |
| Review required | checkbox | |
| Repeat this task (new tasks only) | checkbox | Frequency daily/weekly/monthly/interval; Interval `min=1 max=365` (spinner only); weekdays checkboxes (weekly); End date optional; error keys `interval`, `weekdays`, `endDate` |

- **Submit logic (`:56-64`):**
  - Edit → `updateTask`.
  - Repeat on (and not a draft) → `saveRecurrence`. If no assignee is chosen, it calls `createTask` instead, purely so the field errors show up (`:61`). In the schedule payload:
    - category is `f.category || 'Operations'`, so the required-category check is bypassed.
    - teamId falls back to the assignee's team, looked up on the client.
    - startDate is `startDate || dueDate`.
    - `dueHour` is the hour of `dueTime`; minutes are dropped.
  - Otherwise → `createTask`. "Save as draft" passes `draft: true` and is hidden when repeat is on.
  - Submit is disabled on new tasks when `assigneeOptions()` is empty. A warning banner then explains that you have no one in your reporting line (`:73`).
- **Feedback:**
  - Success toasts: "Draft X saved", "X assigned", "X updated", or "Recurring schedule created…". After success it navigates to the task page or to `/recurring`.
  - Inline 422 field errors.
  - Loading: skeleton (edit). Error: ErrorState (edit).

### `/tasks/:id` (Task detail)
- **Component:** `TaskDetailPage`, `features/tasks/TaskDetailPage.tsx:18`; the body is `TaskWorkspace` (`:26`).
- **Gate:** none on the route. Access is enforced by `getTask`; a 403 or 404 renders through ErrorState.
- **Purpose:** the full workspace for one task.
- **API:** `getTask(id)` returns `TaskDetail`: `task`, `actions`, `users`, `updates`, `comments`, `reviews`, `attachments`, `assignments`, `extensions`, `escalations`, `activities`, `children`, `parent`, `recurrence`. **Which buttons show is driven by the server-provided `d.actions`** (`:32`).
- **Primary buttons (`:46-55`):**
  - Assign now → `publishTask`
  - Acknowledge → `acknowledgeTask`
  - Start work → `startTask`
  - Post update → ProgressDialog
  - Submit for review → SubmitDialog
  - Mark complete → CompleteDialog
  - Review submission → ReviewDialog
  - Decide extension → DecideExtensionDialog
  - Acknowledge escalation → `ackEscalation(taskId)`
- **More menu (`:76-85`):** Request extension, Edit (navigates to the edit page), Reassign, Reopen, Cancel task.
- **Banners (`:89-115`):**
  - Active escalation: level, reason, overdue or silent hours, recipients, CC list, ack info, next level. It has an Acknowledge button if allowed.
  - Assignee hasn't acknowledged → Acknowledge.
  - Changes requested / rejected, with the reviewer's comment.
  - Waiting for review (round N).
  - Pending extension → Decide.
  - Cancelled, with the reason.
  - Draft.
- **Tabs:**
  - **Activity** timeline, with a client-side filter: Everything / Progress updates / System & escalations (`:370-402`).
  - **Progress:** list of updates, with a Post update button.
  - **Comments** (`:525-604`):
    - Threaded, one level of replies.
    - Add → `addComment(taskId, {body, parentId, files})`.
    - Edit → `editComment(id, body)`.
    - Delete (confirm) → `deleteComment(id)`.
    - **The Edit button shows only for the author, and Delete only for the author or role `cos`; both checks are client-side (`:563-564`).**
    - The comment form shows only if `actions` includes `comment`. The body error comes from the API.
    - The banner says "Mention someone with @Full Name". Mention parsing is not done in the UI.
  - **Reviews:** read-only history.
  - **Files** (`:457-523`):
    - Upload → `addAttachments(taskId, files)`, only if `actions` includes `attach`.
    - Preview for image, PDF and text files when `attachmentUrl(id)` exists.
    - Download: if no URL exists, a placeholder `.txt` blob is generated (demo).
    - Remove (confirm) → `removeAttachment(id)`. **The button shows for the uploader, or for anyone with `reassign` or `edit` in actions; client-side (`:466, :503`).**
  - **Assignment & extensions:** history.
  - **Escalations:** timeline grouped by cycle.
- **Side panel:**
  - Overview key/value list.
  - **"Escalation clock" card (`:284-317`).** Shows the ladder from `silenceThresholds(t.priority, getDb().rules)` (client engine, `:44`). Each step is marked hit when `silentHours >= threshold`. It also shows the past-due floor, the snooze state (`snoozeUntil > now()`), and the next level.
- **Dialogs** (`features/tasks/TaskDialogs.tsx`). Errors appear as 422 field errors; "Required" means an asterisk on the label.

| Dialog | API call | Fields / client constraints |
|---|---|---|
| ProgressDialog `:31` | `postProgress(id,{message,percent,files})` | "What changed?" required; Progress range `min 0 max 100 step 5`, default `min(100, progress+10)`; files |
| SubmitDialog `:53` | `submitForReview(id,{note,files})` | "Submission summary" required; Deliverables files. Reviewer name read from raw db |
| CompleteDialog `:72` | `completeTask(id,note)` | Closing note optional (this form does *not* set noValidate) |
| ReviewDialog `:87` | `reviewTask(id,{decision,comment})` | Decision approved / changes_requested / rejected; comment marked required when decision is not approved (`:117`) |
| ExtensionDialog `:125` | `requestExtension(id,{requestedDate,requestedTime,reason,info})` | Requested date required, default `max(due, now)+2d`; time defaults to the current due time; Reason required; Supporting info optional |
| DecideExtensionDialog `:158` | `decideExtension(extId,{approve,note})` | Note marked required when rejecting. Requester read from raw db |
| ReassignDialog `:213` | `reassignTask(id,{toId,reason})` | New assignee required, list is `assigneeOptions()` minus the current assignee; the "(N open)" count is computed from raw `db.tasks` with a hard-coded status list (`:230`); Reason required |
| CancelDialog `:243` | `cancelTask(id,reason)` | Reason required |
| ReopenDialog `:258` | `reopenTask(id,{reason,dueDate})` | Reason required; New due date required, default `max(due, now+2d)` |

- **Feedback:**
  - Loading: skeleton, also shown while the cached data belongs to a different task id (`:22`).
  - ErrorState with retry.
  - A success toast for every action. Examples: ack "Acknowledged. Repeat notifications are paused for 12 h…", and escalation ack "Escalation acknowledged. The level is unchanged; repeat alerts are paused 12 h."
  - Empty states on each tab.

### `/calendar` (Task Calendar)
- **Component:** `CalendarPage`, `features/tasks/CalendarPage.tsx:13`.
- **Gate:** none.
- **Purpose:** a month grid of tasks by due date.
- **API:** `listTasks('mine' | 'all')` (`:22`).
- **Controls:**
  - Scope: My tasks / Everything I can see. Shown only with `useCan('view_tasks')`.
  - "Show closed" checkbox.
  - Previous / next month and Today.
- **Client-side work:** drafts are excluded and closed tasks optionally included. Tasks are grouped by local date. The grid is 6×7 starting Monday. Each cell shows up to 3 tasks plus "+N more". A "Due this month" list is shown below.
- **Feedback:** ErrorState (no retry). No loading skeleton: the grid just renders empty. Empty: "Nothing due this month."

### `/notifications` (Notifications)
- **Component:** `NotificationsPage`, `features/notifications/NotificationsPage.tsx:12`.
- **Gate:** none (badge `notifications`).
- **API:** `listNotifications`, `markAllRead()` (toast "Marked N as read" or "Nothing unread"), `markRead(id, bool)`.
- **Filters (client-side):** All / Unread (with count), and a notification type select.
- **Actions:**
  - Clicking a row marks it read and opens the task.
  - A per-row button toggles read/unread.
  - "Preferences" goes to `/settings/account#notifications`.
- **Delivery tags.** Each row shows its email/WhatsApp delivery status (sent / held / skipped). These are **read from raw `getDb().deliveries`** (`:73-82`).
- **Feedback:** skeleton, ErrorState, empty "No (unread) notifications / You're all caught up."

### `/team` (Team Overview)
- **Component:** `TeamPage`, `features/staff/TeamPage.tsx:11`.
- **Gate:** `supervises`.
- **Purpose:** reporting-line summary.
- **API:** `getDashboard` (same key as the dashboard).
- **Content:**
  - Stats: open, overdue, escalated, awaiting update, on-time rate. These come from `d.scope`.
  - Workload BarList from `d.workload`.
  - Teams table from `d.teams`.
  - People table. **The list of people is computed on the client** from raw `db.users` with `reportsOf(db, user.id)`, or all users for `cos` (`:18`). "Reports to" is also read from raw db.
  - Names link to `/admin/staff/:id`.
- **Feedback:** skeleton and ErrorState. There is no empty state.

### `/escalations` (Escalations)
- **Component:** `EscalationsPage`, `features/work/EscalationsPage.tsx:16`.
- **Gate:** `supervises` (badge `escalations`).
- **API:** `listEscalations` (from api/admin). Rows include `task`, `level`, `status`, `since`, `nextLevel`, `recipients` and `canAck`. Acknowledge → `ackEscalation(taskId)`.
- **Filters (client-side):**
  - Status segment: Open / Active / Acknowledged / Resolved / All, with counts.
  - Level: kept in the URL `?level=`.
  - Priority.
  - Team: options from raw `db.teams` that appear in the rows.
  - Assignee.
- **Stats:** per-level count of open escalations and how many are unacknowledged (client-side).
- **CSV export:** client-side (`:55-58`).
- **Table:** default sort level descending, client-side. The Acknowledge button shows when `r.canAck && status === 'active'`.
- **Feedback:** table skeleton, ErrorState (no retry), empty "No escalations match", and a toast on acknowledge.

### `/reviews` (Reviews)
- **Component:** `ReviewsPage`, `features/work/QueuePages.tsx:10`.
- **Gate:** `perm('review_tasks')` (badge `reviews`).
- **API:** `listReviewQueue`. "Review" opens the shared ReviewDialog → `reviewTask`.
- **"Your recent decisions"** shows the last 8, read **from raw `db.reviews`** (`:18`).
- **Feedback:** skeleton, ErrorState, empty "Nothing waiting for review".

### `/extensions` (Extensions)
- **Component:** `ExtensionsPage`, `QueuePages.tsx:77`.
- **Gate:** `supervises` (badge `extensions`).
- **API:** `listExtensions` returns `{ext, task, canDecide}`. "Decide" opens DecideExtensionDialog → `decideExtension`.
- **Filter (client-side):** Pending (with count) / Decided / All.
- **Names** are read from raw `db.users`.
- **Undecidable pending requests** show "Your request" or "Awaiting an authorized senior".
- **Feedback:** skeleton, ErrorState, empty "No pending requests" or "No requests".

### `/recurring` (Recurring Tasks)
- **Component:** `RecurringPage`, `features/work/RecurringPage.tsx:16`.
- **Gate:** `creates` AND `assign_tasks`.
- **API:**
  - `listRecurrences`. Rows include `summary`, `next[]`, `instances`, `ownerName` and `assigneeName`.
  - `saveRecurrence(id | null, input)`, `toggleRecurrence(id, active)` and `deleteRecurrence(id)` (with a confirm).
  - `assigneeOptions()`.
- **Row menu** (Edit / Pause or Resume / Delete) shows only when **`r.createdBy === user.id || user.role === 'cos'` (client-side, `:81`)**.
- **"N tasks" link** goes to `/tasks/assigned-by-me`, unfiltered.
- **RecurrenceDialog fields (`:107-206`):**
  - Title (required).
  - Template description.
  - Assignee (required).
  - Priority.
  - Category.
  - Due at (hour), `min 0 max 23`.
  - Frequency.
  - Interval, `min 1 max 365`.
  - Start date (required), defaults to tomorrow.
  - End date (optional).
  - Weekdays (weekly only).
  - Review required.
  - Error keys: `title`, `assigneeId`, `dueHour`, `interval`, `startDate`, `endDate`, `weekdays`.
  - teamId falls back to the assignee's team on the client.
  - Note text: "Times are interpreted in UTC in this prototype."
- **The table is plain HTML** (not DataTable): no sorting or paging.
- **Feedback:** skeleton, ErrorState, empty state with "Create one", and toasts.

### `/reports` (Accountability Reports index) and `/reports/:reportId`
- **Components:** `ReportsIndexPage` (`features/reports/ReportsPages.tsx:41`) and `ReportPage` (`:74`).
- **Gate:** `reports` (`view_team_reports` or `view_org_reports`).
- **Index:** `reportScope()` decides between "Organization-wide" and "scoped to your reporting line" text. It shows 9 report tiles (completion, overdue, escalations, accountability, teams, assignments, compliance, reviews, extensions) and a metric-definitions glossary (`:31-39`).
- **Report page:**
  - Calls `getReport(filters)`, keyed by the JSON of the filters, so it refetches whenever a filter changes.
  - Filters: From/To dates (default the last 30 days; no check that from ≤ to), Team, Staff member, Task giver, Priority, Status (drafts excluded), Escalation level.
  - **The filter dropdowns list all teams and all active users from raw db, regardless of scope** (`:85, :99, :105, :111`). An info banner says out-of-scope people are excluded (`:138`).
  - Six summary stats, then a different body per report (`:172-258`).
  - Unknown report id → 404 ErrorState.
  - Export CSV is built on the client per report (`:260-274`).
  - Chart-ready numbers come from the API. The client only sorts and filters rows, e.g. by escalations or compliance (`:199, :228`).
- **Feedback:** skeleton, ErrorState, and an empty "No data for these filters." per table.

### `/admin/staff` (Staff Management)
- **Component:** `StaffDirectoryPage`, `features/staff/StaffPages.tsx:15`.
- **Gate:** `perm('manage_staff')`.
- **API:** `listStaff`, `createStaff`, `updateStaff(id, f)`, `setStaffStatus(id, 'active' | 'inactive')`, `resetAccess(id)`.
- **Filters (client-side, `:31-38`):**
  - Search over name, email and title.
  - Role.
  - Team (including "No team").
  - Status: active (the default) / inactive / "Without manager" (no `managerId` and role not `cos`).
- **Stats:** totals, active, inactive, without manager (client-side).
- **CSV export:** client-side.
- **Row menu:**
  - View profile.
  - Edit → StaffDialog.
  - "Send password reset (simulated)" → `resetAccess`. Toast: "Simulated: a password reset link was issued. No email was sent."
  - Deactivate / Reactivate (with confirm). If the person still has open tasks, a warning banner shows; the result toast includes `r.openTasks`.
- **StaffDialog fields (`:152-260`):**
  - Full name (required).
  - Work email (required, `type=email`).
  - Job title (required).
  - Role (required). **Disabled on the client when the user lacks `manage_roles` or is editing themselves (`:198`).**
  - Manager. **The option list is filtered on the client: active, not the person themselves, `ROLE_RANK` higher than the selected role, and `!wouldCreateLoop` (`:163`).**
  - Team.
  - Location.
  - Phone.
  - WhatsApp number, hint "International format, e.g. +14155550123…" (format is checked by the API, `fields.whatsapp`).
  - Time zone, a fixed list of 6 IANA zones (`:237`).
  - "Agreed to receive work alerts on WhatsApp" opt-in.
  - Changing the role opens a confirm listing the new permissions from raw `db.rolePermissions` (`:248-257`).
  - Banners: a warning when assigning CoS, and info when there is no manager.
- **Feedback:** table skeleton, ErrorState, toasts, inline field errors.

### `/admin/staff/:id` (Staff profile)
- **Component:** `StaffProfilePage`, `StaffPages.tsx:264`.
- **Gate:** **none on the route** (it only has a parent breadcrumb). Access relies on `getStaffProfile(id)` returning 403/404 (inferred). The page is reachable from SearchPalette, TeamPage and OrgPage links for users without `manage_staff`.
- **API:** `getStaffProfile(id)` returns stats, assigned, created, escalations, activity, manager, chain, reports, permissions and team.
- **Edit button** (StaffDialog) shows only with `manage_staff`.
- **Tabs:** assigned and created task lists (first 25 only), escalation history, recent activity.
- **Feedback:** skeleton, ErrorState, empty strings ("None you can see.").

### `/admin/org` (Organization Structure)
- **Component:** `OrgPage`, `features/org/OrgPage.tsx:20`.
- **Gate:** `perm('manage_staff')`.
- **API:** `getOrg` returns `users`. MoveDialog calls `setManager(userId, managerId | null)` and then `setTeam(userId, teamId | null)` in sequence (`:185-193`): **two separate calls, not one transaction**.
- **Views:** Reporting tree / Teams, via a segmented control.
- **Search** highlights matching people and their reporting chain. The chain is computed with `ancestorsOf` (authz, client-side).
- **Expand all / Collapse.**
- **Per-person load badge.** **`load()` counts open and overdue tasks from raw `db.tasks` (`:14-18`)** and compares against `settings.overloadThreshold`.
- **Stats and orphan banner:** computed on the client.
- **MoveDialog:**
  - The manager list is filtered on the client to active users with a higher `ROLE_RANK`. Options that would create a loop are labelled "(would create a loop)".
  - **Save is disabled when `wouldCreateLoop` (client-side, `:184, :204`).**
  - No success toast (`useAction` without a message). Errors still toast.
- **Feedback:** skeleton, ErrorState.

### `/admin/roles` (Roles & Permissions)
- **Component:** `RolesPage`, `features/admin/AdminPages.tsx:23`.
- **Gate:** `perm('manage_roles')`.
- **API:** `getRoles` returns `{matrix, counts}`. Saving calls `setRolePermissions(role, perms)`.
- **Matrix.** Permissions are grouped in 7 groups (`:13-21`).
  - **The CoS column is locked as "Granted" on the client.**
  - Editable roles are hard-coded as `['ceo', 'manager', 'lead', 'staff']` (`:33`).
  - Save and Reset are per role, enabled only when that role's column has changed.
  - Save opens a confirm showing granted and removed permissions, with a danger banner when granting any `ORG_WIDE_PERMISSIONS`.
- **Feedback:** skeleton, ErrorState, toast.

### `/admin/policies` (Escalation Policies)
- **Component:** `PoliciesPage`, `AdminPages.tsx:137`.
- **Gate:** `perm('manage_escalation_policies')`.
- **API:** `getRules`, and `setRules(r)` after a confirm. Toast: "Escalation policy saved; all open tasks re-evaluated."
- **Fields (spinner limits only; there is no `<form>`):**
  - Update window per priority: `min 1 max 720` (error key `w_${p}`).
  - L0–L3 multiples: `step 0.5 min 0.5` (error key `multiples`).
  - Past-due offsets L1–L3: `min 0` (error key `offsets`).
  - Acknowledgement snooze: `min 1 max 72` (`ackSnoozeHours`).
  - "Due soon" notice: `min 1 max 168`.
  - Quiet hours: enabled, start and end times.
  - `l3NotifyCeo` checkbox ("L3 also goes to the CEO (decision D7)").
- **"Resulting ladder" table:** computes `window × multiple` on the client (`:188`).
- **"Work-order routing" table:** static, hard-coded text (`:250-264`).
- **PolicySimulator (`:275-306`):** runs `computeLevel(...)` from the engine on the client against the *unsaved* rules. Inputs: priority, hours silent 0–240, overdue −96 to 120.
- **Discard / Save** are enabled only when something has changed.
- **Feedback:** skeleton, ErrorState, toast, inline errors.

### `/admin/audit` (Audit Logs)
- **Component:** `AuditPage`, `features/admin/AuditPage.tsx:11`.
- **Gate:** `perm('view_audit_logs')`.
- **API:** `listAudit`. **Everything after that is client-side (`:24-41`):**
  - From/To filters compare `r.at.slice(0,10)` (the UTC date string).
  - Actor: any user or "System". The options are all users from raw db.
  - Action type: the prefix before the first `.`, derived from the rows.
  - Team: derived by looking up `db.tasks` / `db.users` in the raw store.
  - Source: ui / system / demo.
  - Task ID: substring match.
- **Table:** page size 50, sorted by time descending. A hidden "Context" column is available.
- **CSV export:** client-side.
- **Retention banner:** "audit records are retained for N years. In this prototype they are stored in the browser and can be reset with demo data…"
- **Feedback:** skeleton and ErrorState. The empty state is DataTable's default.

### `/admin/deliveries` (Delivery Log)
- **Component:** `DeliveryLogPage`, `features/admin/DeliveryLogPage.tsx:102`.
- **Gate:** `perm('view_audit_logs')`.
- **API:**
  - `listDeliveries`.
  - "Send weekly digest now" → `sendWeeklyDigestNow()`. **The button shows only with `useCan('manage_system_settings')` (client-side, `:110, :134`).** Toast: "Weekly digest sent to N recipients (simulated email)."
- **Filters (client-side):**
  - Channel segment: All / Weekly digest / Email / WhatsApp, with counts.
  - Status: sent / held / skipped.
  - Recipient: all users from raw db.
  - Free text over subject, template, body, task and address.
- **Stats:** computed on the client.
- **Table:** page size 50, sorted by time descending. Clicking a row opens the preview.
- **PreviewDialog (`:53-100`):** renders an email or WhatsApp mock. Template variables come from `TEMPLATES` (`services/channels`).
- **WhatsApp templates table:** a per-template "sent here" count.
- **The "Copied recipient" label** is derived from the raw `db.notifications` title starting with "Copy:" (`:185`).
- **Banners:** a "Simulated delivery" banner that mentions `server/src/notify`, `SMTP_*`, `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
- **Feedback:** skeleton, ErrorState, toast.

### `/admin/settings` (System Settings)
- **Component:** `SettingsPage`, `AdminPages.tsx:308`.
- **Gate:** `perm('manage_system_settings')`.
- **API:** `getSettings`, and `setSettings(s)` (no confirm; toast "Settings saved").
- **Fields (spinner limits only):**
  - Organization name (error key `orgName`).
  - Default time zone: the same fixed list of 6.
  - Workday start and end (time).
  - Session timeout: `min 5 max 480` (`sessionTimeoutMinutes`).
  - Overload threshold: `min 1 max 50`.
  - Email simulation and WhatsApp simulation checkboxes.
  - Digest day: Sunday–Saturday.
  - Digest hour: `min 0 max 23`.
  - Categories: add (trimmed; ignored if empty or a duplicate, client-side) and remove (error key `categories`).
  - `retentionYears`: shown read-only.
- **Feedback:** skeleton, ErrorState, toast. Save is enabled only when something has changed. A warning banner explains that 7-year immutable retention is not implemented.

### `/profile` (My profile)
- **Component:** `ProfilePage`, `features/account/AccountPages.tsx:14`.
- **Gate:** none.
- **API:** `getStaffProfile(user.id)`.
- **Content:** read-only details, accountability stats (open, overdue, completed, on-time) and permission tags.
- **Feedback:** skeleton, ErrorState.

### `/settings/account` (Account settings)
- **Component:** `AccountSettingsPage`, `AccountPages.tsx:69`.
- **Gate:** none.
- **API:** `getPrefs`, `setPrefs(draft)` (toast "Notification preferences saved"), and `myDeliveries` (first 10, rendered as `DeliveryRow`s).
- **Sign-in card:** email; a "Reset password" link to `/forgot-password` (see the routing gap above); session timeout read from raw `db.settings`.
- **Preferences table:**
  - Rows are notification types; columns are In-app / Email / WhatsApp.
  - `MANDATORY_TYPES` (from `services/channels`) are forced on and disabled.
  - WhatsApp applies only to `WA_TYPES = ['assignment', 'reassignment', 'escalation']`, which is **hard-coded in the UI (`:154`)**. It is disabled when the user has no WhatsApp number or hasn't opted in (`:132`).
  - The page scrolls to `#notifications` when that hash is present.
- **Feedback:** skeleton, ErrorState, toast. Save is enabled only when something has changed.

### Signed-out pages (`features/auth/AuthPages.tsx`)
- **LoginPage (`:47`):**
  - Work email and Password fields; `noValidate`.
  - Calls `login(email, password)` synchronously after a fake 250 ms delay.
  - Errors: field errors under each input, or a danger banner for anything other than 422.
  - On success it redirects to `from`.
  - **Demo:** quick-fill buttons for `u-ceo`, `u-cos`, `u-m1`, `u-l1` and `u-s1`, and it displays `DEMO_PASSWORD` (`:91-117`).
- **ForgotPasswordPage (`:122`):**
  - Calls `requestPasswordReset(email)`, which returns a token.
  - Shows "If an account exists for {email}, a reset link has been issued."
  - **Demo:** a direct link to `/reset-password?token=…`.
- **ResetPasswordPage (`:164`):**
  - Calls `resetPassword(token, pw, confirm)`.
  - Password hint: "At least 10 characters, with letters and a number." Error keys `password` and `confirm`.
  - Submit is disabled without a token.
  - **Demo note:** "passwords are not stored. Continue to sign in with DEMO_PASSWORD".
- **SessionExpiredPage (`:214`):** "Sign in again", which carries `from` along.
- There is no loading state apart from the Login button spinner.

---

## Demo-only features
- **DemoBar (`features/demo/DemoBar.tsx`).** Rendered in Shell for **every** signed-in user, with no permission check (`Shell.tsx:126`).
  - "Act as" user switcher → `switchUser(id)`, listing every active user grouped by role (`:33-55`).
  - Simulated clock display with +1h / +4h / +12h / +24h → `advanceClock(h)` ("escalation engine ran"), and "Now" → `resetClock()`.
  - Scenarios drawer → `runScenario(id)` from `SCENARIOS`. It switches user and navigates; the active scenario's steps card is saved in localStorage.
  - "Expire session" → `expireSession()`.
  - "Reset data" (confirm) → `resetDemoData()`.
- **Login demo accounts and the visible demo password** (AuthPages `:91-117`), plus the reset-token link and the "passwords not stored" note.
- **Attachments are never uploaded.** There is a placeholder download blob (`TaskDetailPage.tsx:441-455`), and FilePicker shows a "browser tab only" hint.
- **Simulated features:** password reset email (`resetAccess`), email/WhatsApp delivery (Delivery Log, notification tags, "Messages sent to you"), and the weekly digest.
- **Audit source `demo`** appears as a filter option (`AuditPage.tsx:102`).
- **`now()` from the mock store** is used across the UI (dashboard, filters, dialogs, calendar) so the simulated clock takes effect.
- **Fake latency** in `useApi`/`useAction`.

## Client-side preferences (localStorage, `taskwatch.ui.*`)
`sidebar.collapsed`, `dash.range`, `filter.{user}.{scope}`, `views.{user}.{scope}`, `cols.{table}`, `pagesize.{table}`, `recent-search.{user}`, `scenario`, `scenario.open`, and the theme preference.

---

## Client-side logic that must move to, or be enforced by, the server

1. **Escalation engine timer.** `tick()` runs in the browser every 30 s and on mount (`App.tsx:62-72`), and DemoBar `advanceClock` also runs it. Escalation level calculation, recurrence generation and notification/delivery creation all depend on an open browser tab.
2. **Session handling.** Inactivity timeout, inactive-user lockout and session invalidation are all evaluated on the client in `resolveAuth` (`App.tsx:20-34`). Login, logout, password reset and the reset token are all browser-side.
3. **Route and nav authorization.** `route.allow` (`routes.tsx:36-39`, `App.tsx:39`, `Shell.tsx:61`) is UI-only. Two routes have no guard at all: `/tasks/:id/edit` (it only checks `actions.includes('edit')`, `TaskFormPage.tsx:30`) and `/admin/staff/:id`. The server must enforce every endpoint behind these routes.
4. **Per-item permission checks done in the UI:**
   - Comment edit (author only) and delete (author or `cos`) (`TaskDetailPage.tsx:563-564`).
   - Attachment removal (uploader, or anyone with `reassign`/`edit`) (`:466, :503`).
   - Recurrence edit/pause/delete (creator or `cos`) (`RecurringPage.tsx:81`).
   - Role field disabled without `manage_roles` or for yourself (`StaffPages.tsx:198`).
   - "Send weekly digest" button needs `manage_system_settings` (`DeliveryLogPage.tsx:110`).
   - Dashboard "New task" button shown by role, not by `create_tasks` (`DashboardPage.tsx:64`).
   - Calendar "all" scope needs `view_tasks` (`CalendarPage.tsx:15`).
   - SearchPalette people routing uses `manage_staff` (`SearchPalette.tsx:41, :66`).
   - Row actions (`shared.tsx:62`) and the reviewer set (`DashboardPage.tsx:79-93`) call `allowedActions(getDb(), …)` directly.
5. **Reporting-line integrity.**
   - Manager candidates (`ROLE_RANK` and `wouldCreateLoop`, `StaffPages.tsx:163`; `OrgPage.tsx:214-221`) and the Save-disabled-on-loop check (`OrgPage.tsx:184, :204`) are client-side.
   - The CoS column being locked/always granted, and the editable-roles list (`AdminPages.tsx:33, :75-80`), are UI constants.
   - The org move is two separate calls, `setManager` then `setTeam` (`OrgPage.tsx:185-193`), and is not atomic.
6. **Badge counts.** Notifications, escalations, reviews, extensions and unacknowledged "mine" are computed from the raw store with `canViewTask`/`allowedActions` (`Shell.tsx:19-31`). The bell list is also read from raw store (`Shell.tsx:245-248`).
7. **Dashboard analytics in `insights.ts`:** KPIs (with history rebuilt from timestamps), health buckets, attention/severity rules and thresholds (2 h, 24 h, critical/L2), trend buckets, workload and overload, the escalation funnel, the activity heatmap, escalation response time, and `departmentOf`. On top of that:
   - Per-role extras in `DashboardPage.tsx`: weekly completion, update-next ordering, team compliance, delayed reviews (>24 h), at-risk team ratio, department workload, staff counts, the Founder's Office L3 banner.
   - These read raw `db.tasks`, `db.activities`, `db.comments`, `db.reviews`, `db.users`, `db.escalations` and `db.extensions` directly, with no scope filtering by the API (e.g. `DashboardPage.tsx:107, 110-111, 119, 262, 358, 447, 486`).
8. **Other aggregates and stats computed in the UI:**
   - Staff directory stats, Org stats and per-person load (`OrgPage.tsx:14-18`).
   - Delivery Log stats and per-template counts.
   - Escalations per-level stats.
   - Reassign dialog "N open" counts (`TaskDialogs.tsx:230`).
   - TeamPage people list via `reportsOf` (`TeamPage.tsx:18`).
   - Reviews "recent decisions" (`QueuePages.tsx:18`).
   - Notification delivery tags (`NotificationsPage.tsx:73`).
9. **Search, filtering, sorting and paging are all client-side** over the full result sets. This covers DataTable, task lists (`applyFilter`), Escalations, Audit (including a team join against raw tasks/users), Delivery Log, Staff, Extensions and Notifications. Any API that paginates on the server must take over these filters and sorts. SearchPalette calls `search()` on every keystroke.
10. **Escalation math in the UI:**
    - `silenceThresholds` for the task clock and the form hint (`TaskDetailPage.tsx:44`, `TaskFormPage.tsx:66`).
    - The snooze-active check (`TaskDetailPage.tsx:305`).
    - The policy ladder preview, and the simulator running `computeLevel` (`AdminPages.tsx:188, :280`).
    - The escalation routing table is hard-coded UI text (`AdminPages.tsx:256-263`), as is `WA_TYPES` (`AccountPages.tsx:154`).
11. **Form defaults and fallbacks that affect stored data:**
    - The recurring schedule created from New Task defaults category to `'Operations'` (bypassing the required check), drops due-time minutes, and falls back on team and start date (`TaskFormPage.tsx:60-62`).
    - Recurrence team fallback (`RecurringPage.tsx:134`).
    - Category dedupe and trim (`AdminPages.tsx:395`).
    - Recurrence times are "interpreted in UTC".
12. **All field validation** must be on the server. The client only marks fields as required, sets `maxLength=140` on the title, and sets min/max attributes that `noValidate` (or the lack of a `<form>`) means are not enforced. Report date ranges (from ≤ to) are not checked anywhere in the UI.
13. **Report filter options** list all teams and active users regardless of scope (`ReportsPages.tsx:85-111`). The server must scope the results (the UI banner already assumes it does).
14. **CSV exports** are generated in the browser from the data already loaded: task lists, escalations, audit, deliveries, staff, and all nine reports. If exports need auditing or volume limits, that has to be done on the server.
15. **Attachments are never uploaded or stored.** Preview and download use object URLs held only in the browser tab.
16. **Demo controls** (switch user, clock offset, scenarios, reset data, expire session) are open to every user and write straight to the store. They must not exist in production; the `demo` audit source comes from them.
17. **Audit retention.** Audit records live in localStorage and can be reset. The 7-year immutable retention is only stated in UI text (`AuditPage.tsx:54-56`, `AdminPages.tsx:406-411`).