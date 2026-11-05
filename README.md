# TaskWatch

TaskWatch implements **Work Order FO-2026-OPS-01**. Every task assigned across BAIS, USAIS,
International Evaluations, Embtel, Bay Area Accounting Solutions and the Founder's Office gets a
server timestamp, a required update rhythm, and automatic escalation when work stalls.

It has three parts: an Express API with PostgreSQL (`server/`), a React web app (`client/`), and the
rules both of them run (`shared/`: escalation ladder, workflow, permissions, notifications,
recurrence).

Engineering instructions for anyone (person or AI agent) working on the code: [AGENTS.md](AGENTS.md).
Requirements, decisions, architecture and the current state of the work: [docs/](docs/README.md).

## Run it locally

You need Node 22 or later and PostgreSQL 15 or later (this machine runs PostgreSQL 18 as the Windows
service `postgresql-x64-18`).

```bash
npm install
cp .env.example .env        # then set DATABASE_URL; keep ALLOW_DEV_LOGIN=true for local sign-in
npm run db:setup            # creates the database, applies the migrations and loads sample data
npm run dev:server          # API on :4000 (watch mode; applies new migrations on restart)
npm run dev                 # web app on :5173, in a second terminal
```

The web app has two backends:

- **Mock** (default): the original prototype's in-browser sample data. No API or database needed.
  Use the amber **Demo mode** bar to switch users, advance the simulated clock, load the scripted
  scenarios or reset the data. Assumptions and limits: `client/ASSUMPTIONS.md`.
- **Server**: start Vite with `VITE_BACKEND=server` (on the command line or in `client/.env`; Vite does
  not read the root `.env`). Every screen runs on the API except dashboards and reports, which show
  "not connected to the server yet" until their phase is built.

Open <http://localhost:5173>. With `ALLOW_DEV_LOGIN=true` the sign-in page lists everyone in the
sample directory, so you can try every role:

| Try as | To see |
|---|---|
| **Rahul Kashyap** (Chief of Staff) | Everything: L3 alerts, escalation policies, staff and organization, roles, settings, audit and delivery logs |
| **Dr. Alka Madan** (CEO) | Everything, read-only except commenting and acknowledging (D-33); receives L3 alerts |
| **Maria Gonzales** (BAIS Operations Manager) | Their team leads and those leads' staff; can reassign, extend and acknowledge |
| **Jordan Lee** (BAIS team lead) | Their staff; can assign to them, review, extend and acknowledge L1 alerts |
| **Sofia Ramirez** (BAIS staff) | Only their own tasks; posts updates, marks Blocked or submits for review |
| **Daniel Brooks** (USAIS lead with no manager) | Shows L2 skipping straight to the Founder's Office |

Start over with fresh sample data (this **wipes the dev database**):

```bash
npm run db:seed -- --reset
```

## How escalation works

Every open task needs an **assignee update** within its priority's window. Comments from leads,
managers or the Founder's Office are logged but never reset the clock.

| Priority | Update at least every | L0 Reminder | L1 Team lead | L2 Manager | L3 Founder's Office |
|---|---|---|---|---|---|
| Critical | 4 h | 4 h silent | 6 h | 8 h | 12 h |
| High | 24 h | 24 h | 36 h | 48 h | 72 h |
| Normal | 48 h | 48 h | 72 h | 96 h | 144 h |
| Low | 72 h | 72 h | 108 h | 144 h | 216 h |
| Any, past due | — | — | at due time | +24 h | +72 h |

- **Highest rule wins.** A task sits at the highest level any rule gives it. Past-due levels hold even
  while updates continue, until the task closes or its due date is extended.
- **Each level fires once.** An assignee update drops the task back down, and it can climb again later.
- **Routing.** L0 goes to the assignee, L1 to their team lead, L2 to their manager, and L3 to the
  Chief of Staff and CEO, copying the level below. If a role is missing in someone's reporting
  line, the alert goes straight to the next existing level.
- **Acknowledging** (with a note) pauses repeat alerts at that level. It never resets the clock.
- **Quiet hours** hold L0 and L1 email between 21:00 and 08:00 in the recipient's time zone; a person
  can have their own window, e.g. a night team (D-105). L2 and L3 always go out, and in-app alerts
  are never held.
- **Marking a task Blocked** (a reason is required) alerts the team lead immediately.
- The engine runs every minute; the work order requires at least every 5 minutes.

The Chief of Staff changes the windows, multiples and past-due offsets under **Escalation Policies**,
either as the default or per entity. Every change is logged.

## Recurring tasks

Schedules (daily, weekly on chosen days, monthly, or every N days) create one task per occurrence,
due at the chosen hour in the **assignee's** time zone. Missed days are not backfilled, days 29–31
fall on the last day of shorter months, and an occurrence the owner may no longer assign is
skipped and logged. Deleting a schedule archives it and keeps the tasks it made.

## Going live

All secrets are read from environment variables (see `.env.example`). In production, inject them
from a managed secrets store instead of a `.env` file.

1. **Sign-in.** People sign in with a password, or with Google Workspace once configured: create an
   OAuth client of type *Web application* in Google Cloud Console, set the redirect URI to
   `<APP_URL>/api/auth/google/callback`, then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_ALLOWED_DOMAINS`. Only people in the TaskWatch directory get in. Directory sign-in
   ("pick a person") is impossible in production.
2. **Email.** Set `SMTP_USER` and `SMTP_PASS` to a Workspace mailbox and an app password (or use
   `smtp-relay.gmail.com`). Mail is sent from "TaskWatch".
3. **WhatsApp** is switched off (D-106: email and in-app only). The code and
   [docs/whatsapp-templates.md](docs/whatsapp-templates.md) remain if it is turned back on.
4. **Directory.** Under **Staff**, replace the sample people with real people, emails, reporting
   lines and time zones. People are deactivated, never deleted.
5. **Production run:**
   ```bash
   npm run build
   SESSION_SECRET=… APP_URL=https://taskwatch.example.com npm start   # serves API and web app on PORT
   ```
   Put it behind HTTPS. Schedule daily `pg_dump` backups with 90-day retention and a quarterly
   restore test, as the work order requires. Runbooks: [docs/08-operations/](docs/08-operations/).

Until email has its keys, messages are written to the **Delivery Log** as *simulated* instead of
sent, so you can see exactly what would have gone out.

## Audit trail

- **Append-only logs.** Every assignment, update, comment, state change, due-date change,
  reassignment, escalation and acknowledgement is a new row stamped with server time (UTC), the
  actor, and before/after values. Administrative changes (staff, roles, settings, policies,
  recurring schedules) go to a separate admin log. Database triggers reject edits and deletes, and
  records (tasks, people, schedules, …) are archived, never deleted.
- **Tamper evidence.** Each row stores a SHA-256 hash of the previous one. A nightly job at 02:00
  recomputes every chain and alerts the Chief of Staff if anything was altered directly in the
  database. The check can also be run from **Audit Logs**.
- **Server time only.** Due dates are entered as local wall-clock time and converted on the server
  using the person's home time zone.
- **Access control** is enforced by the server on every request and every record, not just hidden
  in the screens. A record you may not see answers exactly like a missing one.
- **Client data.** Text containing A-numbers, SSNs, USCIS receipt numbers, passport or I-94 numbers
  is rejected, with a prompt to link the case in ImmigrationCRM instead.

## Work order coverage

Each requirement (FR-1…FR-12, AC-1…AC-10) is traced to its feature, code and tests in
[docs/06-planning-and-tracking/REQUIREMENT_TRACEABILITY_MATRIX.md](docs/06-planning-and-tracking/REQUIREMENT_TRACEABILITY_MATRIX.md);
progress per feature is in the [implementation tracker](docs/06-planning-and-tracking/IMPLEMENTATION_TRACKER.md).

**Not in this build:** StatCommand integration (built standalone, with its own directory and
sign-in), the phase-2 GoHighLevel webhook, ImmigrationCRM case link and mobile app. Hourly time
tracking, payroll/HR workflows and client access are out of scope under the work order.

## Tests

```bash
npm test                      # pure rule tests + integration tests through the real HTTP API
npm run e2e                   # browser tests (Playwright)
npm run typecheck             # server, client and e2e
npx tsx client/src/selfcheck.ts   # client rule self-check, no database
```

- `npm test` runs against a separate `taskwatch_test` database and **drops and rebuilds its schema** on
  every run. It never touches the dev database.
- `npm run e2e` starts its own API on :4100 against `taskwatch_e2e` and its own web app on :5180, so it
  never touches the dev servers on :4000 / :5173.

What the tests cover is listed in [docs/05-testing-and-qa/](docs/05-testing-and-qa/TESTING_STRATEGY.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Web app on :5173 (mock backend unless `VITE_BACKEND=server`) |
| `npm run dev:server` | API on :4000 in watch mode |
| `npm run db:setup` | Create the database, migrate, and seed if the directory is empty |
| `npm run db:migrate` | Apply new migrations |
| `npm run db:seed -- --reset` | Wipe the database and reload sample data (refuses in production) |
| `npm test` / `npm run e2e` | Test suites (see above) |
| `npm run typecheck` | Type-check server, client and e2e |
| `npm run build` / `npm start` | Production build, then serve API and web app together |

## Layout

```
server/src/
  engine/        ladder (levels.ts), alert routing, the escalation engine (FR-8)
  services/      tasks, queries, access control, staff, settings, audit, recurring, notifications prefs, reports, digest
  notify/        message text, email/WhatsApp channels, dispatcher with retries
  routes/        HTTP API
  http/          error envelope, auth middleware, rate limits
  jobs/          scheduler (engine, dispatcher, recurring, digest, nightly chain check)
  db/            migrations (001–013), setup, seed
server/test/     rule tests and API integration tests
shared/          rules run by both server and client (ADR-0007)
client/src/
  features/      pages: tasks, work (escalations, reviews, extensions, recurring), staff, org, admin, …
  services/api/  one function per action; *Server.ts adapters call the API, the rest is the mock
  services/mock/ the prototype's in-browser data
e2e/             Playwright tests and their isolated API
docs/            requirements, decisions, architecture, standards, testing, planning, project memory, operations
```
#   T a s k W a t c h  
 #   T a s k W a t c h  
 