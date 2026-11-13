# Attendance and vertical working time: design

Status: draft for owner approval, 2026-11-13. Nothing is built. It needs an ADR (proposed with this design) because it adds a table and moves per-person settings to the vertical (AGENTS.md: architecture changes need approval).

## 1. Why

A person on leave keeps getting escalated: nobody posts updates, so the silence ladder climbs to L3, and tasks due during the leave escalate as if nothing were known. The silence clock also counts nights and weekends, so a task left on Friday evening escalates over the weekend. Each person also has their own time zone and quiet hours, which a CoS has to set one by one.

The owner wants:
- the GM to record attendance;
- the escalation to know who is away;
- the working time (time zone, quiet hours, working days and hours) set once per vertical.

## 2. Goals

1. **Attendance.** A vertical's GM marks each member, per day: **present**, **absent**, **half day** (with a from–to time range, the part they are away), or **leave**. The GM is the only person who can set or correct it.
2. **Founder's Office.** The CoS acts as the GM of the Founder's Office: they mark its members and set its working time, as a GM does for a vertical.
3. **Who has no attendance.** GMs, the CoS and the CEO have no attendance of their own, and nobody marks it.
4. **Calendar view.** Every person with attendance sees their own on a calendar (read-only).
5. **GM attendance page.** The GM gets an **Attendance** item in the sidebar: mark days, correct them, and see them with filters.
6. **Default.** A day nobody marked **shows as absent** on calendars. For escalation it counts as **not marked**, not as away.
7. **Escalation while away** (only days the GM actually marked absent, leave, or the away part of a half day):
   - Tasks stay with the person and escalate on their normal schedule (L1 at due, then L2, L3), until a senior reassigns or cancels them.
   - "No update" (silence) escalation continues for **Critical** tasks and pauses for **High, Normal and Low** while the person is away.
   - When a person is marked away and has open tasks due inside that time, **the assignee, their GM and each task's giver** get a notice listing those tasks, so a senior can reassign or cancel.
8. **Vertical working time.** Each vertical has a **time zone**, **quiet hours**, and **working days and hours**. Its members follow them automatically; nobody sets them per person any more.
9. **Escalation in working time:**
   - **Critical** tasks: the silence clock and the deadline steps run on plain clock time, as today.
   - **High, Normal, Low** tasks: the silence clock counts only the vertical's working time, and the L2 and L3 deadline steps ("N minutes after due") are counted in working time.

## 3. Non-goals

- No payroll, hours or overtime tracking. Attendance is only what the GM marks.
- No self-service leave requests or approval flow. People do not mark themselves.
- No public-holiday calendar. A holiday is marked by the GM as leave, or the vertical's working days exclude it.
- No change to how L1 works: it stays at the due time.

## 4. Anti-goals (a failure even if it works)

- **A GM forgetting to mark attendance must not change escalation.** Unmarked days never pause anything.
- **No unexpected bulk notices.** Example: the "away with tasks due" notice firing for a whole vertical because a day was not marked.
- **No moved work.** A task never silently moves to someone else, and never stops being due, because its owner is away.
- **No misleading Critical work.** Critical work never goes quiet because of attendance or working hours.

## 5. Rules in detail

### 5.1 Who may mark whom

| Marker | May mark |
|---|---|
| A vertical's GM (`entities.head_id`) | Every active member of that vertical, except GMs, the CoS and the CEO |
| The CoS | Every active member of the Founder's Office except the CEO and CoS. The CoS acts as the Founder's Office GM (see §5.7) |
| Anyone else | Nobody. This includes a CoS for other verticals; marking stays with each vertical's GM |

The server enforces this on every write and for every person id (object-level, IDOR).

### 5.2 Days and statuses

- **One record per person per day,** in the vertical's time zone.
- **Statuses:**
  - `present`;
  - `absent`;
  - `leave`;
  - `half_day` with `away_from` and `away_to` (HH:MM, inside the vertical's working hours; from < to).
- **Today and past days only (D-163).** No future marking, so there is no planned leave in advance; the GM marks leave on the day.
- A range of past days up to today can be marked in one action (e.g. leave 10–13 Nov). It is stored as one row per working day.
- **A mark affects escalation only from the moment it is saved (D-164).** Marking a past day changes the calendar, not escalations already counted or sent, so marking leave after the fact cannot erase L2s and L3s.
- **Correction** replaces the row. Every write and correction is audited (`admin_log`, actor, before/after).
- **Clearing** a day returns it to "not marked". Rows are never hard-deleted. The row is kept with status `unmarked` so the audit trail stays readable. *(Builder may store this differently; it must not lose history.)*

### 5.3 What "away" means for escalation

A person is **away** at instant *t* when their marked day covers *t*:
- **Absent or leave:** the whole working day, in the vertical's time zone.
- **Half day:** between `away_from` and `away_to` on that day.
- **Present, or not marked:** not away.

### 5.4 Escalation effects

- **Silence clock, non-Critical tasks.** It counts only time that is both:
  - inside the vertical's working time, and
  - not away for the assignee.
- **Silence clock, Critical tasks.** It counts all clock time, as today.
- **Deadline steps, non-Critical.** L1 is at the due time. L2 and L3 are *N* working minutes after the due time, in the vertical's working time. Away time is **not** removed from deadlines: late is late.
- **Deadline steps, Critical.** Plain clock time, as today.
- **Stored milestones.** ADR-0014 milestones (`deadline_l2_at`, `deadline_l3_at`) are computed with the working-time rule when stamped. They are restamped when the vertical's working time changes and someone presses "Apply to open tasks", as with policy changes (D-146).
- **Away notice.** When the GM marks a person away **today**, the server finds that person's open tasks due during today's away time (and, for leave or absent, until the end of their next working day). If there are any, it sends **one** in-app and email notice each to the assignee, their GM and every distinct giver of those tasks. Repeat marks for the same tasks and days do not resend (idempotent via `job_runs`).
- **Quiet hours.** These now come from the person's vertical, not the person.

### 5.5 Vertical working time

- **New per-vertical settings:**
  - `time_zone`;
  - `quiet_start`, `quiet_end` (and enabled);
  - `work_days`, a set of Mon–Sun;
  - `work_start`, `work_end`.
- **Defaults** for a vertical that has not set them: the organization's current values (Settings: time zone, workday start/end; policy quiet hours), with Mon–Fri as working days.
- **Existing hour values are read as working time, unchanged (owner, 2026-11-13).** Examples: "update every 48 h" and "L2 = 1440 min after due". No conversion is done; each vertical edits its own values in the UI. Consequence the owner accepted: with the shipped defaults, non-Critical escalation is slower than today until a vertical tunes its numbers. For example, a Normal task's first reminder comes after 48 working hours, about 5 working days on 9 h days.
- **Changing a vertical's working days or hours (D-165).** Open tasks keep their stored deadline times until someone presses **Apply to open tasks**. Silence counting uses the new hours from the moment of the change.
- **No per-person or per-department override.** The night-team case (D-105) is handled by the GM managing their own vertical (§5.6).
- **Who edits:** the vertical's GM, and the CoS (all verticals, and the Founder's Office). Edits are audited.
- **Members inherit them.** The time zone, quiet hours and working-day fields are removed from the person form and profile in the UI. Existing per-person values stay in the database untouched (no deletion), but are no longer used.
- **What the vertical's time zone drives:**
  - dates on notices and emails;
  - "local" times on screens for that person;
  - the attendance day boundary;
  - working-time maths.

### 5.6 GM manages their own vertical (D-162)

*Scope as the designer reads the owner's answer; the owner should confirm.*
- **People:** on the Staff page, scoped to their vertical, a GM may add, edit and deactivate its people, move them between its departments, and send password resets.
- **Vertical:** on the Verticals page, scoped to their vertical, they may manage its departments and leads, and its working time (§5.5).
- **Limits:** a GM cannot touch other verticals, the Founder's Office, or roles above Manager. Granting CoS or CEO, and changing who is GM, stay with the CoS.
- **Enforcement:** the server enforces this per request and per id. Today these pages need `manage_staff` / `manage_roles` (CoS); a GM gets the vertical-scoped version of them.

### 5.7 Founder's Office

- The CoS is treated as the Founder's Office GM:
  - they mark attendance for its members;
  - they set its working time;
  - they edit its escalation policy as a GM would (they already can, as policy admin).
- The CEO and CoS have no attendance.

## 6. Screens

- **Sidebar.** An **Attendance** item for GMs and the CoS. Everyone with attendance sees **My attendance**: their own month calendar, read-only.
- **GM Attendance page:**
  - **Day view (default):** today's list of members with a status control per person, plus a "Mark all present" action.
  - **Month view:** a grid of people × days with colour per status (unmarked shown as absent, visually distinct from a marked absent so the GM sees gaps).
  - **Mark a range:** a person, a from–to date, and a status (e.g. leave).
  - **Half day:** asks for the from–to time range.
  - **Filters:** date range, department, person, and status (including "not marked").
  - **Export to CSV.**
- **Vertical settings:** the time zone, quiet hours and working days/hours fields on the Verticals page. GMs see only their own vertical.
- **Person form and profile:** remove time zone and quiet hours. Show "Follows <vertical>: <zone>, Mon–Fri 09:00–18:00" read-only.
- **Task page:** when the assignee is away now, a tag "Assignee on leave until <date>" (or "away until 14:00").

## 7. Constraints

- **AGENTS.md:**
  - no commit or push;
  - no deletion without approval;
  - no secrets;
  - one implementation of each rule in `shared/` (ADR-0007), used by server, mock and simulator;
  - zod `.strict()`, parameterized SQL, object-level authorization;
  - UI changes minimal, light and dark, 360 px.
- **Existing tests.** The existing ESC-02 and ADR-0014 tests keep passing for **Critical** tasks unchanged. Non-Critical expectations change only where working time now applies, and each such test change is listed.
- **Existing helper.** `shared/performance.ts` already has `workingHours(from, to, zone, shift)`. Reuse or extend it for working-time maths; no second implementation.

## 8. Decided by the owner (2026-11-13)

All in this conversation:
- **D-156** GM marks attendance: present / absent / half day with time range / leave; only the GM sets or corrects it.
- **D-157** Unmarked days show as absent on calendars; escalation treats a person as away only on days marked absent, leave or the half-day range.
- **D-158** Away: tasks keep escalating normally until a senior reassigns or cancels. "No update" escalation continues for Critical and pauses for other priorities. The assignee, GM and task giver are notified.
- **D-159** Each vertical has a time zone, quiet hours and working days/hours; members inherit them and no longer set them.
- **D-160** Non-Critical: the silence clock and the L2/L3 deadline steps count working time only. Critical: clock time, as today.
- **D-161** The CoS acts as the GM of the Founder's Office. GMs, the CoS and the CEO have no attendance.
- **D-162** A GM manages staff and the vertical (departments, working time) for their own vertical (§5.6; scope to confirm).
- **D-163** Attendance is marked for today and past days only; no future marking.
- **D-164** A mark changes escalation only from when it is saved; past escalations stand.
- **D-165** A vertical's working-time change keeps open tasks' deadline times until "Apply to open tasks".
- **Existing hour values** are read as working time without conversion; each vertical tunes its own (§5.5).

## 9. Left to the builder (marked as the designer's calls)

- **Over-time check (D-125).** It switches to the vertical's working days and hours (one shared implementation), but does **not** subtract away time, so performance scores do not change.

- **Table design.** Proposed: `attendance (organization_id, user_id, day date, status, away_from time, away_to time, marked_by, marked_at)`, unique on (user_id, day), plus an audit row per change.
- **Vertical settings** as new columns on `entities`.
- **Migration number.** The next free one (check the folder; another session may have added 019).
- **Colours and icons** for statuses (reuse `Tag` tones).
- **Working-time function signature** in `shared/`.
