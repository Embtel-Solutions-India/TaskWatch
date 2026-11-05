# TaskWatch prototype — assumptions and limits

This frontend runs entirely in the browser on mock data (`src/services/mock`). The Express/Postgres
server in `../server` is untouched and is not used by this app.

## Business-rule assumptions

- **Roles:** CEO, Chief of Staff, Manager, Team Lead, Staff. The CEO was added because the work order routes L3 to the Founder's Office (Chief of Staff and CEO); the CEO is read-only by default (views everything, reports, audit and delivery logs) and sits above the Chief of Staff. The Chief of Staff always holds every permission (locked so the platform can't be locked out). Other roles, including the CEO, are edited in Roles & Permissions.
- **Scope:** a role grants a capability; the reporting line limits which tasks it applies to. Seniors see and assign within their transitive reports. Staff see tasks assigned to them or created by them.
- **Statuses:** Draft → Assigned → In progress → In review → Completed, plus Changes requested, Reopened, Cancelled. "Reject" in review returns the task to Changes requested (it must be reworked), like "Request changes", but is recorded as a rejection.
- **Escalation clocks run** for Assigned / In progress / Changes requested / Reopened. While a task is In review, the ball is with the reviewer, so silence escalation pauses; overdue tasks in review still count as overdue on dashboards.
- **A progress update** resets the silence clock and lowers the _silence_ level; escalation events already raised are kept (marked resolved). Past-due floors (L1 at due, L2 +24 h, L3 +72 h) hold until the due date moves or the task closes.
- **Reassignment** gives the new assignee a fresh update window; past-due levels still apply.
- **Acknowledgement** (of a task or an escalation) snoozes repeat notifications for 12 h and never changes the level or clocks.
- **Routing (work order):** New task → assignee. L0 → assignee. L1 → team lead, assignee copied. L2 → manager, lead and assignee copied. L3 → Founder's Office (Chief of Staff, plus the CEO when decision D7 is on), manager copied, and shown at the top of their dashboard. A missing role skips to the next existing level up (e.g. a lead with no manager → L2 goes to the Founder's Office). These events always go to WhatsApp, email and in-app; personal preferences only affect other notification types.
- **Weekly digest:** email only, to every Manager (their reporting line) and the Founder's Office (organization-wide), on the day/hour set in System Settings (default Monday 08:00 local), once per recipient per week.
- **Overloaded** = more than N active tasks, N set in System Settings (default 6).
- **Historical KPIs** (open/overdue N days ago) are reconstructed from task timestamps using the current (approved) due date.

## Prototype limits

- Authentication is simulated (password `taskwatch` for every account); password resets are not stored.
- Attachments live only in the browser tab (object URLs); seeded files are placeholders. Nothing is uploaded.
- Email and WhatsApp are simulated (`src/services/channels.ts`, shown in **Administration › Delivery Log**). Each alert renders exactly what `server/src/notify` would send: email subject/body, and WhatsApp Business messages using the five approved templates from `docs/whatsapp-templates.md` (only assignments, the L0 reminder and L1–L3 escalations have templates). Nothing leaves the browser.
- Quiet hours (default 21:00–08:00 in the recipient's time zone) hold L0/L1 email and WhatsApp; L2/L3 always go; in-app is never held. Held messages are released when quiet hours end.
- WhatsApp needs a number in international format **and** the person's opt-in; otherwise the message is logged as _skipped_ and they still get email and in-app. The seeded 555 numbers are fictional.
- Live sending stays on the server: set `SMTP_*`, `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in its secrets and get the templates approved in Meta WhatsApp Manager.
- Data persists in localStorage; "Reset data" restores the seed. 7-year immutable retention is displayed as policy but requires a backend.
- Recurrence uses UTC days.
