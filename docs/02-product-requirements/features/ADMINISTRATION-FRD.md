# Administration FRD (ROLE / POL / SET / AUD)

> **Evidence tags:** [WO] Work Order FO-2026-OPS-01 · [V-C] client file:line (relative to `client/src/`) · [V-S] server file:line (relative to `server/src/`) · [A] assumption · [OPEN] [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> Common rules C-1..C-7 live in [PRODUCT_REQUIREMENTS.md §2](../PRODUCT_REQUIREMENTS.md). The ladder maths and routing (ESC-01..05) are specified there and are only configured here. The delivery log (DLV) is in [NOTIFICATIONS-FRD.md](NOTIFICATIONS-FRD.md); staff and role assignment per person in [STAFF-AND-ORG-FRD.md](STAFF-AND-ORG-FRD.md).
> Nothing here has been executed. No test has been run.

---

## ROLE-01 Permission matrix (view)

**Description.** Role × permission matrix with active-user counts per role. [V-C `services/api/admin.ts:200-205`; `features/admin/AdminPages.tsx:23-135`]

**Roles.** `manage_roles`. [V-C `admin.ts:202`]

**User actions (UI).** `/admin/roles`: 15 permissions in 7 groups (Tasks, Assignments, Reviews, Staff, Reports, Administration, Audit) with help text; "Org-wide" tag on the six org-wide permissions. [V-C `AdminPages.tsx:13-21, :70`; `constants/index.ts:50-75`] The CoS column shows "Granted (locked)". [V-C `AdminPages.tsx:79-80`]

**Expected behaviour.**
- 15 permissions [V-C `types/index.ts:4-20`]; org-wide set: `view_org_reports`, `manage_staff`, `manage_roles`, `manage_escalation_policies`, `view_audit_logs`, `manage_system_settings`. [V-C `constants/index.ts:68-75`]
- Default matrix (seed) [V-C `services/mock/seed.ts:47-73`]:

  | Role | Default permissions |
  |---|---|
  | CEO | view_tasks, view_team_reports, view_org_reports, view_audit_logs ("read-only by default", WO) |
  | CoS | all (always; not stored, not editable) [V-C `services/authz/permissions.ts:17`] |
  | Manager | view_tasks, create_tasks, assign_tasks, reassign_tasks, update_assigned_tasks, review_tasks, approve_extensions, manage_team, view_team_reports |
  | Team lead | the Manager set minus manage_team |
  | Staff | update_assigned_tasks |

- A permission grants a capability; the reporting line still limits which tasks and people it applies to. [V-C `AdminPages.tsx` page description; PROJECT_OVERVIEW §1.4]
- Counts = active users holding each role (a multi-role user counts under each, D-8). [V-C `admin.ts:203`; A]

**Data required.** New table `role_permissions(role, permission)`; the server has hard-coded role checks only. [V-S `services/access.ts:37-79`]

**Backend processing.** Read matrix + counts.

**API (built 2026-11-04, T-3.1).** `GET /api/roles` → `{matrix, counts}`, per the approved API_CONTRACTS. `matrix.cos` lists all 15 permissions (same shape as the client mock); groups and the org-wide tag stay client constants. Scoped to the caller's organization.

**Validation.** None.

**Authorization.** No `manage_roles` → 403 "You don't have permission to manage roles." [V-C `admin.ts:202`]

**Success / failure.** 200; 401; 403.

**Dependencies.** AUTH-06 (effective permissions), STAFF-05 (multi-role), D-8.

**Acceptance criteria.**
1. ROLE-01-AC-1: A user without `manage_roles` gets 403.
2. ROLE-01-AC-2: A fresh install returns exactly the default matrix above.
3. ROLE-01-AC-3: CoS is reported as all permissions and is not editable.

**Test scenarios.** 403 · default matrix · counts with multi-role users and inactive users.

---

## ROLE-02 Edit role permissions

**Description.** Change one role's permission set. [V-C `admin.ts:207-218`]

**Roles.** `manage_roles`. [V-C `admin.ts:209`]

**User actions (UI).** Toggle cells; per-role Save / Reset enabled only when that column changed; Save opens a confirm listing granted and removed permissions, with a danger banner when granting any org-wide permission; toast "Role permissions updated". [V-C `AdminPages.tsx:27, :33-36, :117-132`] Editable roles are hard-coded `['ceo','manager','lead','staff']`. [V-C `AdminPages.tsx:33`]

**Expected behaviour.**
- Unknown permission names are dropped silently; the stored set is ordered as the canonical list. [V-C `admin.ts:211`]
- Audit `role.permissions_changed`: prev "Removed: <labels>", next "Added: <labels>", context role label. [V-C `admin.ts:213-216`]
- **Takes effect on the next request of every affected user**, on every server instance. [PRD ROLE-02; S-9]
- No lock-out is possible because any CoS holds every permission. [V-C `permissions.ts:17`]
- Permission changes alter what users can see and do but do not change escalation routing (routing is by role and chain). [V-C `services/core.ts:60-73`]

**Data required.** `role_permissions`; cache invalidation signal.

**Backend processing.** Transaction: replace the role's rows + audit; bump a permissions version used by the session middleware. [A]

**API (built 2026-11-04, T-3.1).** `PUT /api/roles/:role {permissions:[Permission]}` → `200` the whole matrix. This follows the approved [API_CONTRACTS](../../03-architecture/API_CONTRACTS.md) row, not the earlier `/permissions` proposal. The audit row stores permission ids (`before: {removed}`, `after: {added}`); the audit page shows their labels. Saving a role marks the organization's matrix as saved (migration 008), so emptying every role never brings the defaults back.

**Validation.** `role` ∈ {ceo, manager, lead, staff} → otherwise 404 "Role not found." [A]; `permissions` array of strings (unknown ones dropped, per mock).

**Authorization.** No `manage_roles` → 403 "You don't have permission to manage roles."; `role = cos` → 403 "Chief of Staff always has full platform authority and cannot be edited." [V-C `admin.ts:209-210`]

**Success / failure.** 200; 401; 403; 404; 422 (non-array body).

**Dependencies.** ROLE-01, AUTH-06, AUD-01.

**Acceptance criteria.**
1. ROLE-02-AC-1: Removing `view_team_reports` from Team lead makes a lead's very next `/api/reports` call return 403.
2. ROLE-02-AC-2: `PUT /api/roles/cos` returns 403 with the message above.
3. ROLE-02-AC-3: An unknown permission in the body is ignored and not stored.
4. ROLE-02-AC-4: The audit record lists exactly the added and removed permission labels.

**Test scenarios.** Grant / revoke / no-op · unknown permission · cos · live session effect on two instances · org-wide grant audit · multi-role user effect.

---

## POL-01 Escalation policy (global)

**Built 2026-11-05 (T-5.7, T-5.8, T-5.9).** Writes need `manage_escalation_policies`; validation answers under the keys above (`w_<p>`, `multiples`, `offsets`, `ackSnoozeHours`, `dueSoonHours`, plus `repeatAfterWindows` 0–10); unknown fields 422; the note has the sensitive-ID guard. Saving re-evaluates on the request: the whole organization for the default, that entity for an override. An override stores and applies only windows and multiples (D-48). `DELETE /api/rules/default` 409, unknown entity 422, delete answers 204. Policies page: entity selector, "Create override", "Reset to default". Not built: the history list on the page (the Audit page shows `rules_change`).

**Changed 2026-11-12 ([ADR-0014](../../03-architecture/decisions/ADR-0014.md), built, uncommitted).**
- New fields: `deadlineDelaysMinutes` (L2/L3 minutes after due, per priority; replaces the past-due offsets row, D-140), `reviewSlaMinutes` (per priority, D-145) and `extraRecipients` (`l1`/`l2`/`l3`, D-142). Shipped values in [ESC-02](ESCALATION-FRD.md#esc-02-past-due-floor-deadline-milestones) and [ESC-11](ESCALATION-FRD.md#esc-11-reviewer-deadline-and-review-accountability-new-adr-0014).
- New 422 keys: `d_<p>` (L2 ≥ 5 min after due, L3 > L2, ≤ 30 days, whole minutes), `sla_<p>` (5 min–7 days, whole minutes), `rcpt_<level>` (≤ 10 people; active people of the vertical or the Founder's Office).
- Saving no longer moves open tasks' L1/L2/L3 times (D-146); update windows still apply at once. "Apply to open tasks" is POL-04.
- `sla_rules.version` +1 on every save; the `admin_log` `after` carries the version.
- Policies page: deadline table (L1 "At due time", L2, L3, reviewer deadline per priority); the "Past-due floors" card and the past-due ladder row are removed; the 10-minute warning is shown as system-controlled.
- POL-01-AC-2 still holds for windows; the deadline milestones follow D-146.

**Description.** Edit update windows, level multiples, past-due offsets, acknowledgement snooze, due-soon notice, quiet hours and the D7 switch. Saving re-evaluates every open task. [V-C `admin.ts:222-248`; `AdminPages.tsx:137-273`; WO "The Chief of Staff can change windows and multiples … without code changes; every change is logged."]

**Roles.** Read: any signed-in user ("Everyone can read the rules that govern their work"). [V-S `routes/rules.ts:12-21`; V-C `admin.ts:222-224` has no check] Write: `manage_escalation_policies`. [V-C `admin.ts:228`]

**User actions (UI).**
- "Resulting ladder" table: window per priority (spinner 1–720) and computed `window × multiple` per level; past-due row "at due time" / "due +N h". [V-C `AdminPages.tsx:160-200`]
- Multiples L0–L3 (step 0.5, min 0.5) [V-C `:212`]; past-due offsets L1–L3 (min 0) [V-C `:222`]; ack snooze (1–72) [V-C `:231`]; due-soon (1–168) [V-C `:234`]; quiet hours enable/start/end [V-C `:239-245`]; "L3 also goes to the CEO (decision D7)" [V-C `:265`].
- Static "Work-order routing" table. [V-C `:250-264`]
- Discard / Save (enabled when changed); confirm "Apply new escalation policy?"; toast "Escalation policy saved; all open tasks re-evaluated." [V-C `:141, :268`]

**Expected behaviour.**
- Defaults: windows Critical 4 h / High 24 h / Normal 48 h / Low 72 h; multiples 1 / 1.5 / 2 / 3; past-due offsets 0 / 24 / 72 h; ack snooze 12 h; due-soon 24 h; quiet hours on 21:00–08:00; `l3NotifyCeo` true. [V-C `constants/index.ts:93-101`; WO ladder table] Defaults are subject to Founder's Office confirmation WO-D2, WO-D3, WO-D4, WO-D7. [WO]
- Save → audit diff + immediate re-evaluation of all open tasks (C-7). [V-C `admin.ts:237-246`; V-S `routes/rules.ts:35`]
- The audit text must also record a change to `l3NotifyCeo`; the mock's diff omits it. [V-C `admin.ts:237-243`; A] The server stores full before/after JSON. [V-S `services/rules.ts:77-80`]
- Field set differs between client and server: client has `dueSoonHours`; server has `repeatAfterWindows` (0–10) and `blockedAlertsLead`. [V-C `types/index.ts:320-329`; V-S `services/rules.ts:10-20`] [D-48, decided]

**Data required.** `sla_rules(scope='default', config jsonb, updated_at, updated_by)`. [V-S `services/rules.ts:68-83`]

**Backend processing.** Validate → transaction (upsert + admin log before/after) → invalidate rules cache → run the engine. [V-S `services/rules.ts:68-83`; `routes/rules.ts:29-37`]

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/rules` | — | `{defaults:RulesConfig, overrides:{entityId:RulesConfig}, history:[{at,actor,target,before,after,note}]}` | Yes: `GET /rules` [V-S `routes/rules.ts:12-21`]. |
| PUT | `/api/rules/default` | `{config:RulesConfig, note?}` | `200 {ok:true}` | Yes: `PUT /rules/:scope` [V-S `routes/rules.ts:29-37`]; gate by `manage_escalation_policies` instead of role `cos`. |

**Validation.**

| Field | Rule | 422 key: message | Evidence |
|---|---|---|---|
| `windowsHours[p]` | > 0 and ≤ 720 | `w_<p>`: "Between 1 and 720 hours." | [V-C `admin.ts:230`] (server allows ≤ 2160, `rules.ts:7`; D-48) |
| `multiples` | m0 > 0 and m0 < m1 < m2 < m3 | `multiples`: "Multiples must increase from L0 to L3." | [V-C `admin.ts:231-232`; V-S `rules.ts:21-24`] |
| `overdueOffsetsHours` | o1 ≥ 0 and o1 < o2 < o3 | `offsets`: "Past-due offsets must increase from L1 to L3." | [V-C `admin.ts:233-234`; V-S `rules.ts:25-28`] |
| `ackSnoozeHours` | 1–72 | `ackSnoozeHours`: "Between 1 and 72 hours." | [V-C `admin.ts:235`] |
| `dueSoonHours` | 1–168 | `dueSoonHours`: "Between 1 and 168 hours." | [V-C spinner `AdminPages.tsx:234`; message A] |
| `quietHours.start/end` | `HH:MM` 24 h | "Use HH:MM (24-hour)" | [V-S `rules.ts:8`] |
| `quietHours.enabled`, `l3NotifyCeo` | boolean | — | [V-S `rules.ts:15-16`] |
| `note` | ≤ 500 chars, sensitive-ID guard | — | [V-S `routes/rules.ts:32`; C-6] |

**Authorization.** Without `manage_escalation_policies` → 403 "You don't have permission to change escalation policies." [V-C `admin.ts:228`]

**Success / failure.** 200; 401; 403; 422.

**Dependencies.** ESC-01..08, NTF-03, POL-03, AUD-01, D-9.

**Acceptance criteria.**
1. POL-01-AC-1: Each rule above returns 422 with its key and message.
2. POL-01-AC-2: Changing the Critical window from 4 h to 2 h makes an open Critical task silent for 3 h reach L1 on the save request, without waiting for the scheduler.
3. POL-01-AC-3: The save writes an audit/admin-log row with before and after values, including `l3NotifyCeo`.
4. POL-01-AC-4: Any signed-in user can read the rules; only a holder of `manage_escalation_policies` can change them.
5. POL-01-AC-5 (WO AC-1 context): with defaults, the ladder for Critical is 4 / 6 / 8 / 12 h.

**Test scenarios.** Each 422 rule incl. equal multiples · offsets starting at 0 · window 720 / 721 · re-evaluation on save (level up and level down) · D7 off removes CEO from new L3 events · audit content · 403.

---

## POL-02 Policy simulator

**Description.** "What level would a task be at?" computed against the **unsaved** policy. [V-C `AdminPages.tsx:267, :275-306`]

**Roles.** As POL-01 page.

**User actions (UI).** Inputs: priority, hours silent (0–240), hours overdue (−96 to 120). [V-C per FEATURE_INVENTORY "/admin/policies"]

**Expected behaviour.** Result = `computeLevel({priority, clockStartedAt: t0 − silent h, dueAt: t0 − overdue h}, rules, t0)`. [V-C `AdminPages.tsx:280`] Pure function; no server call. The client and server must run **the same** ladder code (D-9).

**Data / API.** None; uses the shared module.

**Validation / Authorization.** None (no data access).

**Dependencies.** D-9, ESC-01/02.

**Acceptance criteria.**
1. POL-02-AC-1: For every combination in a fixed table (4 priorities × silent {0, w, 1.5w, 2w, 3w} × overdue {−1, 0, 24, 72}), the simulator level equals the server engine's level for the same inputs.

**Test scenarios.** Table-driven parity test between client and server modules.

---

## POL-03 Per-entity SLA overrides (new, from WO)

> **2026-11-12: superseded in part by POL-04 ([ADR-0014](../../03-architecture/decisions/ADR-0014.md), D-142).** A vertical row is now sparse: it stores only the fields it changed, from `windowsHours`, `multiples`, `deadlineDelaysMinutes`, `reviewSlaMinutes` and `extraRecipients`; every other leaf is inherited from the global policy. The D-48 field scope below (windows and multiples only) and "Create override" are superseded. Existing windows/multiples rows are valid sparse rows (no data migration).

**Description.** "The Chief of Staff can change windows and multiples **per entity** without code changes; every change is logged." The Policies page gets an entity selector. [WO; D-7 decided; V-S `services/rules.ts:30-39`, `routes/rules.ts:23-46`]

**Roles.** As POL-01.

**User actions (UI).** New entity selector on `/admin/policies`: "Default" plus the 6 entities; an entity without an override shows "Follows default"; "Create override" copies the defaults; "Reset to default" removes the override; history list from `GET /rules`. [D-7; A for UI wording]

**Expected behaviour.**
- A task uses its entity's override when one exists, else the default. [V-S `services/rules.ts:36-38`]
- Task entity = its team's entity, else its assignee's (D-4). [D-4]
- Missing override fields inherit the default. [V-S `services/rules.ts:41-48`]
- Which fields may differ per entity: WO names windows and multiples; the server allows the whole config. Proposed: windows, multiples, past-due offsets and ack snooze per entity; quiet hours, D7 and due-soon global. [A] [D-48, decided]
- Saving or resetting re-evaluates open tasks of that entity (C-7). [V-S `routes/rules.ts:35, :44`]
- Logged as `rules_change` with scope, before and after. [V-S `services/rules.ts:77-80, :92-94`]

**Data required.** `sla_rules` rows with `scope = <entityId>`.

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| PUT | `/api/rules/:entityId` | `{config, note?}` | `200` | Yes: `PUT /rules/:scope` [V-S `routes/rules.ts:29-37`]. |
| DELETE | `/api/rules/:entityId` | — | `204` | Yes: `DELETE /rules/:scope` [V-S `routes/rules.ts:39-46`]. `scope=default` must return 409 "The default rules cannot be removed." (today an uncaught `Error` → 500, `services/rules.ts:87`). |

**Validation.** As POL-01; unknown entity → 422 "Unknown entity" (today 400, `routes/rules.ts:26`).

**Authorization.** As POL-01.

**Success / failure.** 200/204; 401; 403; 409; 422.

**Dependencies.** POL-01, D-4, ESC engine, ORG-01 (entities).

**Acceptance criteria.**
1. POL-03-AC-1: With a BAIS override Critical window = 2 h, a BAIS Critical task silent 2 h is at L0 while a USAIS Critical task silent 2 h is on track.
2. POL-03-AC-2: Resetting the BAIS override makes BAIS tasks follow the default on the same request.
3. POL-03-AC-3: `DELETE /api/rules/default` returns 409.
4. POL-03-AC-4: Each override save and reset is logged with scope, before and after.

**Test scenarios.** Override vs default per entity · partial override inheritance · reset · unknown entity · default delete · task changes entity on reassignment (D-4) and picks up the other entity's rules.

---

## POL-04 Vertical policy: GM editing, inheritance, versions, apply (new, ADR-0014)

**Built 2026-11-12, uncommitted.** [ADR-0014 §6, §7, §15; D-141, D-142, D-146, D-150; US-02, US-03]

**Roles.**
- CoS (any holder of `manage_escalation_policies`): reads and edits the global policy and every vertical.
- GM (the vertical's `entities.head_id`, archived verticals excluded): reads and edits their own vertical only. No new permission key (ADR-0011).
- Everyone else: reads the global policy and their own vertical.

**User actions (UI).** `/admin/policies` ("Escalation Policies"). The nav entry also shows for a GM in server mode (`bootstrap.headOf`).
- CoS: "Policy for" picker (Global plus every vertical; "(customised)" marks verticals with a row). A GM has no picker and opens on their vertical.
- In a vertical, each changed field shows a **Custom** tag; untagged fields show the global value (inherited). "Reset these to global" per section, "Reset to default" for the whole vertical.
- Extra recipients per level (vertical scope only): a checkbox list of the vertical's people.
- After a save: "Open tasks keep the schedule they were given" with **Apply to open tasks** (confirm dialog).
- "Change history" card for a vertical: version, who, when, note.
- Org-wide settings (quiet hours, acknowledgement, due-soon, CEO on L3) show on Global only; a vertical's banner says they are organization-wide.

**Expected behaviour.**
- Effective policy = code defaults ⊕ global row ⊕ vertical row, leaf by leaf (`resolvePolicy`, `shared/policy.ts`). A later global change shows through every leaf a vertical did not set and never overwrites a custom one.
- The page saves `diffPolicy(effective, global)`: a value equal to the global one is not stored, so it stays inherited.
- Org-wide fields in a vertical body → 422 (strict schema).
- Every save bumps `sla_rules.version` and writes `admin_log` `rules_change` (actor, before, after with version, note). A task stores `policy_version` (e.g. `default@3,BAIS@2`).
- **Apply to open tasks** re-stamps the milestones of every open task in the scope (every open task for Global) from the policy as it stands, re-runs the engine, and writes `admin_log` `rules_applied` `{scope, version, updated}`.

**API.**

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/rules` | — | `{defaults, overrides (effective per visible vertical), stored (sparse rows), versions, headOf, history}` |
| GET | `/api/rules/history?scope=` | — | `{items}`: newest first, 50 rows, filtered to readable scopes |
| PUT | `/api/rules/:scope` | `{config, note?}`; vertical `config` is the sparse override | `200 {ok:true}` |
| DELETE | `/api/rules/:scope` | — | `204`; the vertical follows the global policy again |
| POST | `/api/rules/:scope/apply` | — | `200 {updated}` |

**Validation.** As POL-01 (checked on the effective policy, so keys are the same in both scopes); extra recipients per POL-01.

**Authorization.** GM on another vertical → 404 "Vertical not found." (same answer whether it exists or not, D-150); GM on Global → 403; no right at all → 403 for Global, 404 for a vertical. CoS on an unknown entity → 422 "Unknown entity". A non-admin asking for history of a vertical they cannot read → 404.

**Acceptance criteria.**
1. POL-04-AC-1: A vertical row holds only what it changed; a later global change shows through the rest.
2. POL-04-AC-2: The GM edits their own vertical (200, versioned, audited under their name); another vertical 404; Global 403; an org-wide field 422.
3. POL-04-AC-3: The CoS overrides the GM's value; the history shows both; the GM sees only their vertical's and the global history.
4. POL-04-AC-4: A policy change leaves open tasks' milestones unchanged; apply re-stamps them and is audited.
5. POL-04-AC-5: An extra L2 recipient is copied on L2; one outside the vertical and the Founder's Office → 422 `rcpt_l2`.

**Tests.** `api.test.ts` "ADR-0014 vertical policies: …" and "ADR-0014 apply to open tasks and extra recipients"; `rules.test.ts` "ADR-0014 policy …", "ADR-0014 diffPolicy …"; `e2e/escalation-v2.spec.ts` (GM sets Critical L2 and applies).

**Not done / differences from ADR-0014 §15** (see [KNOWN_ISSUES](../../07-project-memory/KNOWN_ISSUES.md)): no before-save diff dialog and no note field on the page (the API accepts `note`); the recipients picker lists the vertical's people only, not the Founder's Office (the API accepts both); the page as a GM was not checked by hand in server mode (the e2e spec covers the GM save and apply).

---

## SET-01 System settings

**Description.** Platform settings: organisation name, default time zone, workday, session timeout, overload threshold, simulation toggles, digest day/hour, task categories; retention shown read-only. [V-C `admin.ts:250-266`; `AdminPages.tsx:308-414`]

**Roles.** Read (subset): every signed-in user (categories, org name, overload threshold and time zone are used across the UI). [V-C `admin.ts:250-252` has no check; A for the subset] Write: `manage_system_settings`. [V-C `admin.ts:256`]

**User actions (UI).** Fields: Organization name [V-C `AdminPages.tsx:333`], Default time zone (6 IANA zones) [`:335-337`], Workday start/end [`:343, :346`], Session timeout 5–480 min [`:353`], Overload threshold 1–50 [`:356`], Email / WhatsApp simulation [`:361-362`], Digest day Sun–Sat [`:369`], Digest hour 0–23 [`:376`], Categories add/remove (trimmed, duplicates ignored, client-side) [`:380-404`], retention "N years (policy requirement; not editable)" [`:408`]. Save enabled when changed; toast "Settings saved". [V-C `:312`]

**Expected behaviour.**
- `retentionYears` is always 7 regardless of input. [V-C `admin.ts:263`; WO Retention]
- Session timeout drives AUTH-03 ([AUTH-FRD.md](AUTH-FRD.md)).
- Overload threshold drives DASH workload and ORG load badges.
- Categories: trimmed and de-duplicated on the server; removing a category does not change existing tasks. [V-C `AdminPages.tsx:395`; A]
- Simulation toggles: [D-41, decided]. Digest day/hour: [D-44, decided] (D-14 fixes Monday 09:00 IST).
- Audit `settings.updated` listing changed keys. [V-C `admin.ts:262-264`]
- No server settings exist today (hard-coded constants). [V-S per FEATURE_GAP_ANALYSIS §5.2]

**Data required.** New single-row `settings` table.

**API (proposed).**

| Method | Path | Request | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/settings` | — | full `Settings` for `manage_system_settings`; otherwise `{orgName, timezone, categories, overloadThreshold, workdayStart, workdayEnd}` | New. |
| PUT | `/api/settings` | `Settings` (without `retentionYears`) | `200` | New. |

**Built 2026-11-05 (T-3.7).** `GET /api/settings` (full for `manage_system_settings`, else the public subset) and `PUT /api/settings` → the full settings. `orgName` is the organization's own name (`organizations.name`, KI-23); the other values are stored per organization, only where they differ from the shared defaults. `retentionYears` and the simulation flags may be sent and are ignored: retention is 7, simulation shows whether credentials are set (D-41). Extra rule: the workday must end after it starts. Audit `settings.updated` with before/after of the changed keys only.

**Validation.**

| Field | Rule | 422 message | Evidence |
|---|---|---|---|
| `orgName` | non-empty after trim | "Organization name is required." | [V-C `admin.ts:258`] |
| `sessionTimeoutMinutes` | 5–480 | "Between 5 and 480 minutes." | [V-C `admin.ts:259`] |
| `categories` | ≥ 1 after trim/dedupe; each ≤ 40 chars [A] | "Keep at least one category." | [V-C `admin.ts:260`] |
| `overloadThreshold` | integer 1–50 | "Between 1 and 50." | [V-C spinner `:356`; message A] |
| `timezone` | valid IANA zone | "Unknown time zone" | [V-S `routes/people.ts:67` pattern; A] |
| `workdayStart`, `workdayEnd` | `HH:MM`, start < end | "Use HH:MM (24-hour)" | [V-S `services/rules.ts:8` pattern; A] |
| `digestDay` / `digestHour` | 0–6 / 0–23 (if kept, D-44) | "Between 0 and 6." / "Between 0 and 23." | [V-C spinners `:369, :376`; A] |
| `retentionYears` | ignored; always 7 | — | [V-C `admin.ts:263`] |

The mock validates only the first three rows. [V-C `admin.ts:257-261`; FEATURE_GAP_ANALYSIS §5.5]

**Authorization.** Without `manage_system_settings` → 403 "You don't have permission to change system settings." [V-C `admin.ts:256`]

**Success / failure.** 200; 401; 403; 422.

**Dependencies.** AUTH-03, DASH-01, ORG-01, TASK-01 (categories), NTF-05/06, D-41, D-44.

**Acceptance criteria.**
1. SET-01-AC-1: Each validation rule returns 422 with its field key.
2. SET-01-AC-2: Sending `retentionYears: 3` stores 7.
3. SET-01-AC-3: After lowering the session timeout to 5 min, an idle session's next request after 5 min returns 401 `SESSION_EXPIRED`.
4. SET-01-AC-4: A non-admin reading settings gets only the public subset.
5. SET-01-AC-5: The audit record lists the changed keys.

**Test scenarios.** Each 422 · category trim/dedupe · removing a category used by a recurring schedule (REC-04 skip) · retention immutability · public subset · 403.

---

## AUD-01 Audit log

**Description.** Read-only, filterable view of every change made through TaskWatch, with CSV export; append-only with 7-year retention. [WO "Data, security and audit trail"; V-C `admin.ts:270-275`; `features/admin/AuditPage.tsx:11-123`]

**Roles.** `view_audit_logs`. [V-C `admin.ts:272`] (Server today: role `cos` or `ceo`, `routes/admin.ts:17`.)

**User actions (UI).** Filters From/To, Actor (any user or "System"), Action type (prefix before the first "."), Team, Source (User action / System / Demo mode), Task ID — client-side today [V-C `AuditPage.tsx:24-41, :100-106`]; page size 50, newest first; hidden "Context" column; "Export CSV" [V-C `AuditPage.tsx:49`]; retention banner [V-C `AuditPage.tsx:55-56`].

**Expected behaviour.**
- Records: `at` (server UTC), `actorId` (null = system), `action`, `targetType` (task, user, role, policy, settings, team, recurrence, demo), `targetId`, `taskId`, `prev`, `next`, `source` (ui, system, demo), `context`. [V-C `types/index.ts:283-295`]
- Covers both stores: admin events (`admin_log`) and task events (per-task `activity_log`). [V-S per EXISTING_SYSTEM_ANALYSIS §3.2] The WO requires every assignment, update, comment, state change, due-date change, reassignment, escalation and acknowledgement to be a new row with server time, actor and before/after values. [WO]
- **No endpoint updates or deletes a log row**; DB triggers reject UPDATE, DELETE and TRUNCATE on both tables. [WO; V-S `db/migrations/001_init.sql:109-112, :195-198`] Comment edit/delete keep the original in the log (D-12).
- Date filters use the viewer's zone (today the UTC date string, `AuditPage.tsx:27-28`). [V-C; D-5]
- The team filter is computed on the server (today it joins the raw store, `AuditPage.tsx:33-37`). [V-C]
- `source=demo` rows exist only outside production (DEMO-01).
- Retention: 7 years; no purge job before then. [WO]

**Data required.** `admin_log`, `activity_log` (+ actor names, task team).

**Backend processing.** Union view over both logs, server-side filters, keyset paging (D-10).

**API (proposed).**

| Method | Path | Request (query) | Response | Adapt existing? |
|---|---|---|---|---|
| GET | `/api/audit` | `from, to, actorId \| "system", action (prefix), teamId, source, taskId, before, limit≤200` | `{items:[{id,at,actor:{id,name}\|null,action,targetType,targetId,taskId,prev,next,source,context}], actions:[prefix], next}` | Partly: `GET /admin/audit` (last 100 `admin_log` + 20 chain checks + integrations) [V-S `routes/admin.ts:17-35`]. |
| GET | `/api/audit/export.csv` | same | CSV (RPT-03 guard) | New. |

**Validation.** Dates `YYYY-MM-DD`, from ≤ to; `source` enum; `limit` 1–200 [A].

**Authorization.** Without `view_audit_logs` → 403 "You don't have permission to view audit logs." [V-C `admin.ts:272`]

**Success / failure.** 200; 401; 403; 422.

**Dependencies.** Every module that writes audit rows; AUD-02; D-12.

**Acceptance criteria.**
1. AUD-01-AC-1 (WO AC-7): no API route accepts PUT, PATCH or DELETE on any log row; a direct `UPDATE activity_log …` by the app's DB role fails.
2. AUD-01-AC-2: Filters and paging are applied on the server.
3. AUD-01-AC-3: Every row has server time, actor (or system) and before/after where applicable.
4. AUD-01-AC-4: A user without `view_audit_logs` gets 403.
5. AUD-01-AC-5: CSV export applies the formula guard.

**Test scenarios.** Each filter · system actor · demo source hidden in production · update/delete attempts (API and SQL) · CSV · 403 · IST/PT date boundaries.

---

## AUD-02 Integrity check (new, from WO)

**Description.** "Each log row stores a hash of the previous row for that task; a nightly job verifies the chain and alerts the Chief of Staff on any break." Plus an on-demand run. [WO; V-S `jobs/scheduler.ts:16-48`, `services/activity.ts:105`]

**Roles.** System nightly. Manual run and result list: `view_audit_logs` [A]; server today allows `cos`, `ceo` (`routes/admin.ts:37`). UI button: [D-16, decided].

**User actions (UI).** None today ("no 'run integrity check' button"). Proposed: Audit page panel "Integrity checks" with the last 20 results and "Run check now". [D-16 recommendation; A]

**Expected behaviour.**
- Nightly once per local date after 02:00 in `NIGHTLY_TZ` (default America/Los_Angeles), de-duplicated via `job_runs('chain_check', <date>)`. [V-S `scheduler.ts:40-48`; config per EXISTING_SYSTEM_ANALYSIS §3.1]
- Row hash = `sha256(prevHash + "\n" + canonicalJSON(row))`. [V-S `services/activity.ts:42-61`]
- Each run is stored in `chain_checks` (ran_at, trigger nightly|manual, ok, tasks_checked, rows_checked, breaks). [V-S `scheduler.ts:18-21`]
- On any break: system alert to every active CoS (NTF-08). [V-S `scheduler.ts:22-35`]
- Verification must not run on every task-detail read (today it does; PRD NFR Performance). [V-S per EXISTING_SYSTEM_ANALYSIS §3.6]
- Manual runs are throttled (at most one in progress; one per 5 minutes) because the check scans every row. [A]
- `admin_log` is not chained (S-11); chaining it is not required by the WO. [V-S; A]

**API (proposed).**

| Method | Path | Response | Adapt existing? |
|---|---|---|---|
| GET | `/api/audit/integrity` | `{checks:[{ranAt,trigger,ok,tasksChecked,rowsChecked,breaks:[{taskId,seq,reason}]}]}` | Yes: `checks` part of `GET /admin/audit` [V-S `routes/admin.ts:18-19`]. |
| POST | `/api/audit/integrity/run` | `ChainResult` | Yes: `POST /admin/chain-check` [V-S `routes/admin.ts:37-39`]. |

**Validation.** None.

**Authorization.** Without the permission → 403; a run while one is in progress or within 5 min → 429 "An integrity check ran recently. Try again in a few minutes." [A]

**Success / failure.** 200; 401; 403; 429.

**Dependencies.** C-5, AUD-01, NTF-08, D-16.

**Acceptance criteria.**
1. AUD-02-AC-1 (WO AC-7): altering one `activity_log` row directly in the DB (with triggers disabled) makes the next check report `ok=false` with that task id.
2. AUD-02-AC-2: The nightly job runs once per night even with several server instances.
3. AUD-02-AC-3: A break sends the NTF-08 alert; a clean run sends nothing.
4. AUD-02-AC-4: A manual run is recorded with trigger `manual`.

**Test scenarios.** Clean chain · altered row · deleted row · reordered seq · nightly dedupe across instances · manual throttle · alert recipients.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

| Ref | Point |
|---|---|
| [D-7](../../01-discovery/OPEN_QUESTIONS.md) | Decided: per-entity overrides with an entity selector (POL-03). |
| [D-8](../../01-discovery/OPEN_QUESTIONS.md) | Decided: permission union over roles. |
| [D-9](../../01-discovery/OPEN_QUESTIONS.md) | Shared ladder module for simulator and engine (POL-02). |
| [D-12](../../01-discovery/OPEN_QUESTIONS.md) | Decided: originals kept in the append-only log. |
| [D-14](../../01-discovery/OPEN_QUESTIONS.md) | Decided: digest Monday 09:00 IST. Settings fields → D-44 (decided). |
| [D-16](../../01-discovery/OPEN_QUESTIONS.md) | Manual chain-check button (AUD-02). |
| WO-D2 / WO-D3 / WO-D4 / WO-D7 | Founder's Office confirmation of default windows, multiples/offsets, quiet hours and CEO L3. |
| D-41 (decided) | Simulation toggles in production. |
| D-48 (decided) | Policy field set, limits and per-entity field scope. Per-entity field scope superseded by D-142 (POL-04). |
| D-140…D-142, D-146, D-150, D-152 (decided 2026-11-12) | ADR-0014: deadline delays, GM edits own vertical, sparse vertical fields, snapshot + apply, GM sees own vertical only, D-152 default values (POL-01, POL-04). |

## Changed 2026-11-13 (ADR-0015)
- **Working time per vertical.** Each vertical's time zone, quiet hours and working days and hours are set on Verticals by its GM or the CoS (STAFF-AND-ORG-FRD ORG-03). Policy quiet hours remain the organization default.
- **GMs run their own vertical:** its staff, departments and attendance (STAFF-AND-ORG-FRD STAFF-06, ATT-01).
