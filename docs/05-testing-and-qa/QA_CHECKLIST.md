# QA Checklist (per release)

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> Run in staging (production config, demo tools off) unless a line says "dev". Record the release, date, tester and persona at the top of the copy you fill in. Personas are in [QA_STRATEGY.md §2](QA_STRATEGY.md). A line that cannot be checked is marked "not checked" with the reason; it never counts as passed.

Release: ______ Date: ______ Tester: ______ Environment: ______

## 0. Pre-flight
- [ ] Backup taken before deploy; file name and size recorded ([../08-operations/RUNBOOK.md](../08-operations/RUNBOOK.md)).
- [ ] Migrations applied at start-up are listed in the start log (`[db] applied migrations: …`, `index.ts:10`). [V-S]
- [ ] Start log shows `Google sign-in: on`, no "directory sign-in (dev) on", and channels `live` (`index.ts:21-23`). [V-S]
- [ ] `npm run typecheck` and `npx tsx client/src/selfcheck.ts` results attached.
- [ ] `npm test` result attached (or "not run: approval pending").

## 1. Sign-in and session (AUTH)
- [ ] Google sign-in works for an allowed-domain user; an outside-domain account is refused.
- [ ] Password sign-in (D-2): wrong password and unknown email show the same message.
- [ ] Manager, CoS and CEO cannot finish a password sign-in without a TOTP code (D-21).
- [ ] Repeated wrong passwords are throttled.
- [ ] Sign out returns to the login page; Back does not show data.
- [ ] Idle past the session timeout → "session expired" page on the next action.
- [ ] An archived user is refused on the next click.
- [ ] No demo bar and no dev sign-in list for anyone.

## 2. Tasks (TASK, WF, EXT, CMT, ATT)
- [ ] Lead (Jordan) assigns a Critical task to Sofia; she gets in-app, email and WhatsApp.
- [ ] Assigner and assigned time shown come from the server; time shown in the viewer's zone.
- [ ] Task text with an A-number is refused with the ImmigrationCRM message, shown inline.
- [ ] Sofia posts an update with a PDF; the stage stripe returns to on-track.
- [ ] Sofia marks Blocked without a reason → refused; with a reason → Jordan alerted (AC-3).
- [ ] Jordan comments; the silence clock does not reset (AC-4).
- [ ] Jordan extends the due date once; a second extension is refused; Maria can extend; old date, new date and reason are in the activity log.
- [ ] Maria reassigns to another of her staff; the clock restarts; both are notified.
- [ ] Mark Done; task moves to Closed; escalations clear.
- [ ] Extension request / approve flow (D-6): request, approve, reject with note.
- [ ] Attachment download prompts a download (no inline HTML); a disallowed file type is refused.
- [ ] Task list filters All open, Escalated to me, Red, Blocked, Closed each match the tiles (FR-10).

## 3. Escalation (ESC)
- [ ] Escalation rules page shows the WO defaults: 4/24/48/72 h windows; 1/1.5/2/3 multiples; due, +24 h, +72 h.
- [ ] (dev, demo clock) Critical silent task climbs L0→L3 at 4/6/8/12 h; routing matches the WO table.
- [ ] (staging) The engine's last run is < 5 min ago ([MONITORING.md](../08-operations/MONITORING.md)).
- [ ] Acknowledging needs a note and pauses repeats; the level does not drop.
- [ ] Daniel Brooks' staff task: L2 goes to the Founder's Office.
- [ ] L3 banner appears at the top of the CoS/CEO dashboard.

## 4. Notifications (NTF, DLV)
- [ ] Delivery log shows one row per channel per alert, with status.
- [ ] A user with no WhatsApp number shows WhatsApp `skipped`, email `sent`.
- [ ] L0/L1 between 21:00 and 08:00 in the recipient's zone show `held`; L2/L3 go out.
- [ ] No row stays in `sending` for more than 15 min.
- [ ] Every WhatsApp message uses an approved template and links to the task.
- [ ] Email sender name is "TaskWatch".
- [ ] Notification inbox: mark read / all read; unread badge updates.
- [ ] Mandatory alert types cannot be switched off in preferences.

## 5. Recurring (REC)
- [ ] Create a weekly schedule; next 3 occurrences shown in the assignee's zone.
- [ ] Pause and resume are logged.
- [ ] The generated task appears once at the run time.

## 6. Dashboards and reports (DASH, RPT)
- [ ] Sofia's dashboard covers only herself; Maria's only her line.
- [ ] Entity table: open, on track, amber, red, longest silence; person table: open, average first response, escalations, on-time %.
- [ ] Spot-check one entity against a hand count (AC-8 sample during the pilot).
- [ ] CSV and PDF exports download; CSV opened in a spreadsheet shows no formulas executed for a title starting with `=`.
- [ ] Report filter lists show only people in scope.

## 7. People and administration (STAFF, ORG, ROLE, POL, SET)
- [ ] Add a person with a duplicate email (different case) → clear field error, not a server error.
- [ ] A reporting loop is refused.
- [ ] The last CoS cannot lose the role or be archived.
- [ ] Archive a person: they disappear from pickers; their tasks and history remain.
- [ ] Org move (manager + team) applies atomically.
- [ ] Permission matrix: CoS column read-only; a change takes effect on the next request.
- [ ] Per-entity SLA override for BAIS applies to BAIS only; reset works; both logged.
- [ ] Settings: invalid time zone or timeout refused; retention fixed at 7 years.

## 8. Audit (AUD)
- [ ] Every action in §2 appears in the task's activity log with server time and actor.
- [ ] No edit or delete control exists for log rows.
- [ ] Last nightly chain check is from today or last night and `ok` ([MONITORING.md](../08-operations/MONITORING.md)).
- [ ] Manual chain check (if D-16 adds the button) records a `manual` row.

## 9. Search (SRCH)
- [ ] Search as Sofia never returns another team's task or a person outside her view.

## 10. Time zones (AC-9)
- [ ] An IST user and a PT user open the same task; due and log times are correct in each zone.
- [ ] A due date entered by a PT user shows the matching IST time to an IST user.

## 11. Security quick pass
- [ ] Response headers include CSP and `X-Content-Type-Options` (helmet).
- [ ] Session cookie is `Secure`, `HttpOnly`, `SameSite=Lax` over HTTPS.
- [ ] Error pages show no stack traces.
- [ ] Secrets scan and `npm audit` results attached ([SECURITY_TEST_PLAN.md §14-15](SECURITY_TEST_PLAN.md)).
