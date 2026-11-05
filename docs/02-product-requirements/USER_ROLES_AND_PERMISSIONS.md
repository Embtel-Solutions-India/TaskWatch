# User Roles and Permissions

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 (wins) · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN D-n]** [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md). Client paths are relative to `client/src/`, server paths to `server/src/`. Terms: [GLOSSARY.md](GLOSSARY.md). Items marked "D-2 (decided)x" are contradictions raised for the product owner and listed in §7.
>
> Binding decisions: **D-8** multiple roles per user, with permissions as the union · **D-21** TOTP 2FA for Manager, CoS and CEO on the password path · **D-22** standalone directory.

## 1. Roles (work order)

From the WO table "Users, roles and visibility" (page 1–2). "Receives" is the level the role is the **to** recipient of; the copy rules are in [BUSINESS_RULES BR-35](BUSINESS_RULES.md#4-routing).

| Role (code) | Example | Sees | Can do | Receives | 2FA |
|---|---|---|---|---|---|
| Founder & CEO (`ceo`) | Dr. Alka Madan | All entities, all tasks | Everything; **read-only by default** | L3 (when WO-D7 is on) | Required [WO; D-21] |
| Chief of Staff (`cos`) | Rahul Kashyap | All entities, all tasks | Assign, reassign, extend due dates, edit rules and SLA windows | L3 | Required |
| Manager (`manager`) | Operations Manager | Tasks of their team leads and the leads' staff | Assign, reassign, extend due dates, acknowledge escalations | L2 | Required |
| Team lead (`lead`) | BAIS case team lead | Tasks of their direct staff and their own | Assign to their staff, comment, acknowledge, extend **once** | L1 | Not required |
| Staff (`staff`) | Case associate, evaluator, developer | Own tasks and tasks they assigned | Post updates, mark Blocked, mark Done | L0 | Not required |

- Reporting lines (staff → lead → manager → Founder's Office) live in the user directory and drive both visibility and alert routing. [WO]
- "Anyone can be given a second role, for example a team lead who also does case work." [WO] → §4.
- Role rank for seniority checks (for example, who may be someone's manager): staff 0, lead 1, manager 2, cos 3, ceo 4. [V-C `constants/index.ts:14`]

## 2. The 15 permissions and default grants

Source of the default matrix: `DEFAULT_ROLE_PERMISSIONS` [V-C `services/mock/seed.ts:47-73`]. The matrix is editable on the Roles page (PRD ROLE-01/02), except for the CoS column. ✓ = granted by default.

| # | Permission | What it allows [V-C `constants/index.ts:50-66`] | CEO | CoS | Manager | Lead | Staff |
|---|---|---|---|---|---|---|---|
| 1 | `view_tasks` | See the tasks of people in their reporting line (own tasks are always visible) | ✓ | ✓ | ✓ | ✓ | – |
| 2 | `create_tasks` | Create tasks and drafts | – | ✓ | ✓ | ✓ | – |
| 3 | `assign_tasks` | Assign to people below them; also gates cancel, reopen and publish | – | ✓ | ✓ | ✓ | – |
| 4 | `reassign_tasks` | Move a task in scope to another eligible person | – | ✓ | ✓ | ✓ | – |
| 5 | `update_assigned_tasks` | Acknowledge, post progress and submit their own tasks | – | ✓ | ✓ | ✓ | ✓ |
| 6 | `review_tasks` | Approve or send back submissions | – | ✓ | ✓ | ✓ | – |
| 7 | `approve_extensions` | Decide extension requests in scope | – | ✓ | ✓ | ✓ | – |
| 8 | `manage_team` | Move people between teams within their scope | – | ✓ | ✓ | – | – |
| 9 | `view_team_reports` | Reports over their reporting line | ✓ | ✓ | ✓ | ✓ | – |
| 10 | `view_org_reports` | Organisation-wide reports | ✓ | ✓ | – | – | – |
| 11 | `manage_staff` | Create, edit, deactivate people | – | ✓ | – | – | – |
| 12 | `manage_roles` | Edit the matrix and people's roles | – | ✓ | – | – | – |
| 13 | `manage_escalation_policies` | Edit windows, multiples, offsets, quiet hours, D7 (global and per entity, D-7) | – | ✓ | – | – | – |
| 14 | `view_audit_logs` | Audit log and delivery log | ✓ | ✓ | – | – | – |
| 15 | `manage_system_settings` | Platform settings; "send digest now" | – | ✓ | – | – | – |

Rules on the matrix:
- **The CoS is locked to all 15.** `hasPerm` returns true for a CoS whatever the matrix says [V-C `services/authz/permissions.ts:17`]. Editing the CoS column returns 403 [V-C `services/api/admin.ts:210`]. The purpose is to stop the platform locking itself out. [V-C `client/ASSUMPTIONS.md:7`]
- **The CEO is read-only by default.** The CEO gets only view and report permissions [V-C `seed.ts:48-49`]; on the server, `relation()` returns null for a CEO, so the CEO has no task powers [V-S `services/access.ts:37-44`]. Note that the CEO is not granted `update_assigned_tasks`, so a task assigned to a CEO cannot be acknowledged or updated by them [V-C `services/engine/workflow.ts:49`]. [A] Keep the CEO out of the CoS's assignable set, or grant the permission.
- Six permissions give organisation-wide reach (`view_org_reports`, `manage_staff`, `manage_roles`, `manage_escalation_policies`, `view_audit_logs`, `manage_system_settings`), and the Roles page warns before granting them. [V-C `constants/index.ts:68-75`]
- Unknown permission names are dropped on save. A change is audited (added/removed) and takes effect on the next request. [PRD ROLE-02]
- The server has no permission table today: its rules are hard-coded by role [V-S `services/access.ts`]. Under D-1 it adopts this matrix. [A]

## 3. Scope rules

A permission is a **capability**; the **reporting line** limits which people and tasks it applies to. [V-C `client/ASSUMPTIONS.md:8`]

| Rule | Definition | Evidence |
|---|---|---|
| S-1 Founder's Office sees everything | A CoS sees every task (`visibleUserIds` → `all`). The WO also gives the **CEO** all tasks; the client only reaches that through the reporting line (the CEO is the root), while the server treats CEO and CoS alike (`isFounderOffice`). **Target:** any holder of `ceo` or `cos` sees all tasks. | [WO]; [V-C `permissions.ts:65`]; [V-S `services/access.ts:21, 29`, `services/directory.ts:90`] |
| S-2 Reporting-line visibility | With `view_tasks`, a user sees tasks whose assignee is in their transitive reports. | [V-C `permissions.ts:64-69, 76`]; [V-S `services/access.ts:12-14, 31`] |
| S-3 Own and given tasks | Anyone sees tasks assigned to them, created by them, assigned by them, or for which they are the reviewer. This is how Staff see "tasks they assigned". | [WO Staff row]; [V-C `permissions.ts:75, 81`] |
| S-4 Assignable set | Anyone with `assign_tasks` may assign to themselves and to their active transitive reports; a CoS may assign to any active user (D-32, decided: transitive, self-assignment allowed, as the server does today). The prototype excludes self; the client picker must follow the server. |
| S-5 People visibility | CoS or `manage_staff` see everyone; everyone else sees themselves, their reports and their chain of managers. | [V-C `permissions.ts:102-107`] |
| S-6 Team scope list | The `team` list is tasks whose assignee is in my reports (the CoS sees everyone except themselves), excluding drafts. | [V-C `services/api/tasks.ts:26-30`] |
| S-7 Escalations workspace | Requires `view_tasks`. Shows visible tasks not assigned to me (the CoS sees all). | [V-C `services/api/admin.ts:281-282`] |
| S-8 Aggregates are scoped | Every dashboard and report figure is computed only over data the viewer may see. | PRD DASH-03, RPT-04 |
| S-9 Enforced on the server | The UI guards are hints only; every endpoint checks scope, and AC-6 is tested through the API. | [WO]; C-2 |

## 4. Multiple roles: union semantics (D-8)

| # | Rule | Tag |
|---|---|---|
| M-1 | A user holds a non-empty set of roles. The server already stores `roles text[]` with at least one role. | [V-S `routes/people.ts:65`] |
| M-2 | Effective permissions = ⋃ `rolePermissions[r]` over the user's roles. Holding `cos` means all 15. | D-8; [V-C `permissions.ts:15-19`] (single role today) |
| M-3 | Every identity check in the reference code written as `user.role === 'cos'` becomes "holds `cos`". That covers scope `all` and assigning to anyone [V-C `permissions.ts:65, 74, 92, 103`], the CoS as giver [`workflow.ts:51`], comment deletion [`services/api/tasks.ts:458`], schedule ownership [`admin.ts:370, 386, 397`], and the Founder's Office [`services/core.ts:52`]. The server's `hasRole(u, ...roles)` is already any-of. | [A]; [V-S `services/directory.ts:85`] |
| M-4 | Routing: an ancestor counts as the lead or manager if they hold that role among others. | [V-S `engine/routing.ts:6-27`]; BR-37 |
| M-5 | Rank for manager-candidate lists is the highest rank among the user's roles. | [A] |
| M-6 | 2FA is required if **any** held role is `manager`, `cos` or `ceo`. Gaining such a role forces enrolment at the next password sign-in. | D-21; [A] for timing → [AUTH-FRD](features/AUTH-FRD.md) |
| M-7 | The last-CoS check counts active users who hold `cos` (BR-92). | [A] |
| M-8 | CEO plus another role: the CEO's read-only default does not cancel the other role's grants. A CEO who is also a manager has manager permissions. | [A], follows from M-2 |
| M-9 | Changing a person's roles needs `manage_roles`; you cannot change your own; a role change takes effect on that person's next request, including live sessions (S-9 in EXISTING_SYSTEM_ANALYSIS). | [V-C `admin.ts:129`]; PRD STAFF-02 |

## 5. Per-task action matrix

The **source** is `allowedActions` [V-C `services/engine/workflow.ts:45-73`]. The relationships it uses:
- **A (assignee):** `assigneeId = me` and I hold `update_assigned_tasks`.
- **O (overseer):** `isOverseer` and not the assignee. That means the CoS, the creator, the assigner, the reviewer, or someone with `view_tasks` who has the assignee in their reports.
- **G (giver):** I hold `cos`, or I am `createdBy` or `assignedBy`.

The cells show the result **with the default matrix** when the actor is in that relationship to the task (Lead, Manager and CEO as overseer through the reporting line). New actions marked *(new)* do not exist in `allowedActions` yet.

| Action (API) | Condition in `allowedActions` | Staff as A | Lead as O | Manager as O | CoS | CEO as O | WO "Can do" | Delta |
|---|---|---|---|---|---|---|---|---|
| publish | draft ∧ G ∧ `assign_tasks` | – | ✓ (if G) | ✓ (if G) | ✓ | – | not in WO (draft is an extra, D-20) | — |
| acknowledge (task) | A ∧ active ∧ not acknowledged | ✓ | – | – | – | – | not in WO | Prototype extra; keep |
| start | A ∧ status ∈ {assigned, changes_requested, reopened} | ✓ | – | – | – | – | implied by "In progress" (FR-2) | — |
| progress | A ∧ active | ✓ | – | – | – | – | Staff: post updates | — |
| mark blocked *(new, WF-11)* | A ∧ active [A] | ✓ | – | – | – | – | Staff: mark Blocked | **Missing in client** (D-3) |
| submit | A ∧ in_progress ∧ review required | ✓ | – | – | – | – | not in WO | Extra (D-20) |
| complete | A ∧ status ∈ {assigned, in_progress, blocked} ∧ no review required (R-2) | ✓ | – | – | – | – | Staff: mark Done | **Decided (R-2, 2026-11-04):** Done from Open, In progress or Blocked when no review is required; the prototype previously required In progress. The server allows Done from any open state (`routes/tasks.ts:80`) |
| review | submitted ∧ O ∧ `review_tasks` | – | ✓ | ✓ | ✓ | – | not in WO | Extra (D-20) |
| request_extension | A ∧ active ∧ none pending | ✓ | – | – | – | – | not in WO (the WO has only FR-5) | Kept by D-6 |
| decide_extension | pending ∧ O ∧ `approve_extensions` | – | ✓ | ✓ | ✓ | – | Lead: "extend once"; Manager/CoS: extend | Lead is unlimited in the client. **D-27 (decided)** |
| change due *(new, EXT-04)* | O ∧ (CoS ∨ manager ∨ lead not yet used) | – | ✓ once | ✓ | ✓ | – | Lead once, Manager, CoS | **Missing in client** (D-6). Server: `services/access.ts:74` |
| reassign | ¬closed ∧ ¬draft ∧ O ∧ `reassign_tasks` | – | – | ✓ | ✓ | – | Manager, CoS only | **Target (D-29, decided): leads do not get `reassign_tasks` by default**; the prototype seed grants it and must change. Matches the server (`services/access.ts:75`). |
| cancel | ¬closed ∧ (G ∨ O) ∧ `assign_tasks` | – | ✓ | ✓ | ✓ | – | not in WO | Server: close is CoS and manager only (`access.ts:76`). Extra (D-20) |
| reopen | completed ∧ (G ∨ O) ∧ `assign_tasks` | – | ✓ | ✓ | ✓ | – | not in WO | Server: CoS, manager or assigner (`access.ts:77`) |
| edit | ¬closed ∧ (G ∨ O) ∧ `create_tasks` | – | ✓ | ✓ | ✓ | – | not in WO | A due change made through Edit must obey FR-5 (BR-56) |
| comment | always (if visible) | ✓ | ✓ | ✓ | ✓ | ✓ | Lead: comment; FR-4: leads, managers, FO | Assignee may comment: broader than the WO, kept (PROJECT_OVERVIEW §1.6). The server forbids it (`access.ts:73`) |
| attach | ¬closed ∧ (A ∨ O ∨ G) | ✓ | ✓ | ✓ | ✓ | ✓ | Staff: update "optionally with a file" (FR-3) | No permission is checked. **CEO can attach.** D-33 (decided) |
| ack_escalation | active event at a level where I am a "to" recipient, or I am a CoS | ✓ (L0 only) | ✓ | ✓ | ✓ | ✓ (L3, D7) | Manager, Lead: acknowledge; FR-9: "the person an escalation reached" | **Decided (R-1, 2026-11-04)**: "to" recipients of that level plus CoS; the prototype also lets non-reached overseers acknowledge, and that must change. Scope: that level only (D-26). |

**Summary of deltas against the WO "Can do" column**
1. Blocked and the FR-5 direct due change are missing from the client: WF-11 (D-3) and EXT-04 (D-6).
2. The lead's default grants exceed the WO: reassign (D-29 (decided)) and unlimited extension approval (D-27 (decided)).
3. The CEO is not strictly read-only in the client: comment, attach and acknowledge escalation (D-33 (decided)).
4. Escalation acknowledgement is broader than "the person it reached" (D-26 (decided)).
5. Review, cancel, reopen, edit, draft and task acknowledgement are prototype extras that D-20 keeps.
6. A lead's assignable set is transitive reports, not "their staff" (D-32 (decided)).

## 6. Where these rules are specified in the features

| Area | FRD |
|---|---|
| Sign-in, 2FA, session, `/me` permissions | [features/AUTH-FRD.md](features/AUTH-FRD.md) |
| Task visibility, lists, quick views | [features/TASKS-FRD.md](features/TASKS-FRD.md) |
| Action authorization per workflow step | [features/TASK-WORKFLOW-FRD.md](features/TASK-WORKFLOW-FRD.md) |
| Comment and attachment authorization | [features/COLLABORATION-FRD.md](features/COLLABORATION-FRD.md) |
| Escalation acknowledgement and workspace | [features/ESCALATION-FRD.md](features/ESCALATION-FRD.md) |
| Staff, roles matrix editing (STAFF/ROLE) | [PRODUCT_REQUIREMENTS §2.11](PRODUCT_REQUIREMENTS.md#211-staff-org-roles-staff--org--role) |

## 7. Open points

- **D-8** (decided): multi-role UI picker on the Staff form. The union is computed on the server.
- **D-21** (decided): which roles require 2FA; enrolment design in AUTH-07.
- **D-20**: exact transitions for Done and Blocked.
- **D-26 (decided), D-27, D-29, D-32, D-33**: see the report to the product owner; they are not yet in OPEN_QUESTIONS.md.
