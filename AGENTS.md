# AGENTS.md: TaskWatch engineering instructions

TaskWatch is an escalation system. Every task assigned across the six entities gets a server timestamp, a required update rhythm, and automatic L0→L3 escalation when work stalls. It is specified by **Work Order FO-2026-OPS-01**. The repo has an Express/Postgres API (`server/`) and a React prototype (`client/`).

## Sources of truth, in order
1. **Work Order FO-2026-OPS-01**. Location: [docs/07-project-memory/PROJECT_MEMORY.md](docs/07-project-memory/PROJECT_MEMORY.md). The work order wins whenever it disagrees with the prototype.
2. **The frontend in `client/`**. It is the reference for intended behaviour and UX. Its mock API (`client/src/services/api`, `authz`, `engine`) is the executable spec of the rules.
3. **The existing `server/`**. Build on it rather than replacing it ([ADR-0001](docs/03-architecture/decisions/ADR-0001.md)).

## Read before any development
1. [docs/07-project-memory/CURRENT_STATE.md](docs/07-project-memory/CURRENT_STATE.md) and [HANDOFF.md](docs/07-project-memory/HANDOFF.md): where things stand.
2. [docs/01-discovery/OPEN_QUESTIONS.md](docs/01-discovery/OPEN_QUESTIONS.md): decisions D-n, both decided and open.
3. The FRD for the module you are touching: [docs/02-product-requirements/features/](docs/02-product-requirements/features/).
4. [docs/03-architecture/](docs/03-architecture/SYSTEM_ARCHITECTURE.md) and the ADRs.
5. [docs/04-engineering-standards/AI_AGENT_GUARDRAILS.md](docs/04-engineering-standards/AI_AGENT_GUARDRAILS.md).

Full map: [docs/README.md](docs/README.md).

## Non-negotiable rules (from the project owner)
- **Never commit or push.**
- **Never delete anything** (files, code, tests, data, DB rows or schemas) without asking first. `npm test` drops the `taskwatch_test` schema, and `db:seed -- --reset` wipes the dev database. Both need approval.
- **Never change an architecture decision without approval.** Propose an ADR and wait.
- **Never hardcode sensitive data.** Secrets come from env or a secrets manager only.
- **Never repeat code.** Reuse existing helpers and the shared rules module.
- Never fake success, never use mock data in production paths, never weaken tests, and never claim a test passed unless you ran it.

## How to implement a feature
Every feature goes through these steps: **Understand → Plan → Implement → Validate → Integrate → Verify → Document → Complete**.
- **Understand.** Read the feature's FRD section and its UI code, and confirm its dependencies are DONE.
- **Plan.** Work out the migration, the endpoint (per [API_CONTRACTS](docs/03-architecture/API_CONTRACTS.md)), validation and authorization (object-level), and tests (per [TEST_CASE_INVENTORY](docs/05-testing-and-qa/TEST_CASE_INVENTORY.md)).
- **Implement.** Follow the existing conventions ([CODING_STANDARDS](docs/04-engineering-standards/CODING_STANDARDS.md)). Errors go through [ERROR_HANDLING](docs/04-engineering-standards/ERROR_HANDLING.md).
- **Integrate.** Replace the mock call in `client/src/services/api/*` and any direct `getDb()` reads. Keep the UI design. Any UI change must be minimal and explained.
- **Verify.** Run the feature through the real UI, as each relevant role.
- **Complete.** Only when [DEFINITION_OF_DONE](docs/04-engineering-standards/DEFINITION_OF_DONE.md) is fully met. Then update the [tracker](docs/06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) and the [traceability matrix](docs/06-planning-and-tracking/REQUIREMENT_TRACEABILITY_MATRIX.md).

Implement in dependency order, following [IMPLEMENTATION_ROADMAP.md](docs/06-planning-and-tracking/IMPLEMENTATION_ROADMAP.md).

## Security guardrails (detail: [SECURITY_ARCHITECTURE](docs/03-architecture/SECURITY_ARCHITECTURE.md))
- **Authorization:** enforce it on the server for every request and every `:id` (IDOR). Scope comes from the reporting line. UI guards don't count.
- **Validation:** validate with zod and reject unknown fields. The sensitive-ID guard applies to free text.
- **SQL:** parameterized only.
- **Output:** no PII in logs or in unneeded response fields.
- **Production:** dev login and demo tools must be impossible there.

## Testing and QA
- **Levels:** unit for the pure rules, integration through real HTTP against an isolated DB, and e2e through the UI. See [TESTING_STRATEGY](docs/05-testing-and-qa/TESTING_STRATEGY.md).
- **Release gate:** the work order's acceptance criteria AC-1…AC-10 ([RELEASE_READINESS](docs/05-testing-and-qa/RELEASE_READINESS.md)).

## Keep the docs true
After any meaningful change, and at the end of every session, update:
- [docs/07-project-memory/](docs/07-project-memory/): CURRENT_STATE, ACTIVE_WORK, HANDOFF, KNOWN_ISSUES, CHANGELOG
- the tracker
- the affected FRD or ADR

Record new questions as D-numbers in OPEN_QUESTIONS.md. Never record secrets.
