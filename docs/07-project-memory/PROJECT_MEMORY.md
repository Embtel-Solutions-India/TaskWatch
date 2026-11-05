# Project Memory: permanent knowledge

> Read this first. It holds facts that are durable and not obvious from the code, and links to the documents that have authority over each one. Keep it short, and change it only when a fact changes. The current state of the work is in [CURRENT_STATE.md](CURRENT_STATE.md).

## What TaskWatch is
- TaskWatch is an escalation system built under **Work Order FO-2026-OPS-01**, issued by the Founder's Office to Embtel on 2026-11-01.
- Every task carries three things:
  - a server timestamp
  - a required update rhythm
  - automatic escalation L0 → L3 when the task goes silent or runs past due
- It serves six entities: BAIS, USAIS, International Evaluations, Embtel, Bay Area Accounting Solutions, and the Founder's Office.
- Overview: [../01-discovery/PROJECT_OVERVIEW.md](../01-discovery/PROJECT_OVERVIEW.md).

## Sources of truth, in precedence order
1. **The work order PDF** (kept outside the repo): the owner's copy, `Work Order FO-2026-OPS-01 TaskWatch Escalation System.pdf`. The work order says: *"Where this work order and the prototype disagree, this work order wins."*
2. **The frontend prototype** in `client/`. This is the functional and UX reference. Its mock API (`client/src/services/api/*`, `services/authz`, `services/engine`) is the executable spec for the rules.
3. **The existing server** in `server/`. It was built for an older frontend that was **deleted on 2026-11-03**, so its model differs from the client's.

## Durable facts
- The new client runs **only on a localStorage mock**. In 22 UI files it bypasses its own API layer (`getDb()`). See [EXISTING_SYSTEM_ANALYSIS §2.2](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md).
- The server already has these pieces, and they are worth keeping (ADR-0001):
  - the escalation engine
  - the dispatcher (WhatsApp, SMTP)
  - the hash-chained append-only log
  - sessions
  - the sensitive-ID guard
  - CSV and PDF export
- The server **runs pending migrations automatically on start** (`server/src/index.ts:9`), so once a migration 002 exists, `npm run dev:server` reshapes the `taskwatch` DB (D-18).
- `npm test` **drops the `taskwatch_test` schema**. `npm run db:seed -- --reset` **wipes the dev database**. Both need the user's approval before they run.
- The machine is Windows 11. PostgreSQL 18 runs as the service `postgresql-x64-18`, on Node 24. The README's setup notes describe a Mac.
- The repository is not a git repository.

## Decisions
All decisions live in [../01-discovery/OPEN_QUESTIONS.md §7.1](../01-discovery/OPEN_QUESTIONS.md) and the ADRs in [../03-architecture/decisions/](../03-architecture/decisions/README.md). The headlines:
- Evolve the existing server.
- Sign-in is Google **and** password. TOTP is required for Manager, Chief of Staff and CEO.
- The core states come from the work order (Open, In progress, **Blocked**, Done), plus the prototype's extras (draft, review loop, reopen, cancel).
- Department = Entity, with teams under each entity.
- Users can hold multiple roles, with a configurable permission matrix.
- Due dates can change by extension request **and** by the direct change in FR-5.
- SLA rules can be overridden per entity.
- The weekly digest goes out Monday 09:00 IST.
- PDF export is required.
- Delivery is standalone.

## User's standing rules (non-negotiable)
Never commit or push · never delete anything without asking · never change an architecture decision without approval · never hard-code sensitive data · never repeat code. Full list: [../04-engineering-standards/AI_AGENT_GUARDRAILS.md](../04-engineering-standards/AI_AGENT_GUARDRAILS.md).
