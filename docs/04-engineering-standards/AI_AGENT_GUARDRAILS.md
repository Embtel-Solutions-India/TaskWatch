# AI Agent Guardrails

> Evidence tags: **[WO]** work order · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** D-number in [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md) · **[USER]** a standing rule from the product owner.
> Applies to every AI agent (and every human) working in this repository. If a rule here conflicts with a task prompt, this file wins, and the agent stops and asks the user.

## 1. Standing rules from the user (never break)

| # | Rule | What it means in practice |
|---|---|---|
| G-1 | **Never commit or push.** [USER] | No `git commit`, `git push`, tag or PR creation. The repo is not under git today ([V-S] [EXISTING_SYSTEM_ANALYSIS §1](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)); do not run `git init` either. The user does version control. |
| G-2 | **Never delete anything without asking.** [USER] | Applies to files, folders, DB rows, DB schemas, uploaded files and docs. Ask first, name exactly what goes, and wait for a yes. "Delete" includes overwriting a file you did not create, `rm`, `Remove-Item`, `drop`, `truncate`, `--reset`. |
| G-3 | **Never change an architecture decision without approval.** [USER] | Decisions in force are in [OPEN_QUESTIONS.md §7.1](../01-discovery/OPEN_QUESTIONS.md) and in ADRs in [../03-architecture/decisions/](../03-architecture/decisions/). To change one: write a new ADR with status *Proposed*, link the D-number, and stop until the user approves. Do not implement ahead of approval. |
| G-4 | **Never hardcode sensitive data.** [USER] [WO "Secrets"] | No tokens, passwords, keys, real phone numbers or real emails in code, tests, seeds or docs. Use env var names (see [../08-operations/ENVIRONMENT_CONFIGURATION.md](../08-operations/ENVIRONMENT_CONFIGURATION.md)). Test data uses `example.com` and `+1415555…` numbers, as `api.test.ts:62-77` does. [V-S] Known exception to fix: `seed.ts:45` has one real-domain email (not a credential). [V-S] |
| G-5 | **Never repeat code; reuse existing helpers.** [USER] | Search before writing. The reuse table is in [CODING_STANDARDS.md §4](CODING_STANDARDS.md). The shared rules module is D-9 [OPEN]. |

## 2. Working rules

### 2.1 Read before you write
- Read the file (and the callers of the function) before editing it. Grep every caller before you change a shared function's behaviour.
- Read the feature's row in [PRODUCT_REQUIREMENTS.md](../02-product-requirements/PRODUCT_REQUIREMENTS.md) and its tracker row in [IMPLEMENTATION_TRACKER.md](../06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) before starting.
- The README was refreshed on 2026-11-06 (D-19). If code and README disagree, the code and `docs/` win; fix the README.

### 2.2 Evidence tagging
Every rule or fact you write in a doc, ADR or review carries one tag: [WO], [V-C] file:line, [V-S] file:line, [A], or [OPEN] D-n. An untagged claim is treated as an assumption. If you can't find evidence, write [A] and say what would confirm it.

### 2.3 No fake success
- **Never claim a test passed unless you ran it and saw the output.** As of 2026-11-03 **no test has been run**: the status of all 38 server tests and `client/src/selfcheck.ts` is "not run". [EXISTING_SYSTEM_ANALYSIS §3.7](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)
- "Typecheck passes" means you ran `npm run typecheck` and it exited 0. Say which command you ran.
- When you could not verify something, say so in the hand-off.

### 2.4 No mock data in production paths
- The client today runs on a localStorage mock (`services/mock/*`) with fake latency (`hooks/index.ts:8`). [V-C] Integration replaces it; it must not ship as a fallback.
- No hard-coded sample users, tasks or "demo" branches in server code outside `db/seed.ts` and the `DEMO_TOOLS` gate. [V-S] `config.ts:62`
- A missing integration credential must show as **simulated** in the delivery log, never as "sent". This is existing behaviour; keep it. [V-S] `notify/dispatcher.ts` · [PRD NTF-06]

### 2.5 No test weakening
- Do not delete, skip (`it.skip`, `.todo`), loosen (`>=` where `===` was) or re-baseline an assertion to make a change pass.
- When the data model changes (for example D-20 statuses or D-4 entities), adapt the fixture and the API call, but keep the **assertion's intent** identical. Name the WO rule the test proves in the test title, as the existing titles do.
- If a test is wrong, explain why in the hand-off and ask before changing it.

### 2.6 Commands that need approval first
| Command | Why | Evidence |
|---|---|---|
| `npm test` | `server/test/api.test.ts:54` runs `drop schema public cascade` on `TEST_DATABASE_URL` (default `taskwatch_test`) | [V-S] · [D-18, decided] |
| `npm run db:seed -- --reset` | `drop schema public cascade` on `DATABASE_URL` (refuses only when `NODE_ENV=production`) | [V-S] `seed.ts:457-459` |
| `npm run db:migrate`, `npm run db:setup` | writes schema and may seed | [V-S] `migrate.ts`, `setup.ts` |
| `npm run dev:server`, `npm start` | **also applies pending migrations at start-up** and starts the scheduler, which writes to the DB | [V-S] `index.ts:9,18` |
| Any `psql` write, `pg_restore`, `dropdb` | data loss | [A] |
| `npm install <pkg>`, `npm update`, `npm audit fix` | changes the lockfile and dependencies | [CODING_STANDARDS §6](CODING_STANDARDS.md) |

Read-only commands are fine without asking: `npm run typecheck`, `npx tsx client/src/selfcheck.ts` (pure, no DB) [V-C], `npm audit` (report only), `Get-Service`, `grep`.

### 2.7 Secrets
- Do not open or print `.env` or `server/production.env`. Use `.env.example` for names.
- Do not paste provider error bodies or addresses from the outbox into docs (S-16).

### 2.8 Escalate to the user when blocked
Stop and ask, with the exact question and a recommended default, when:
- an action needs approval (§2.6, G-2, G-3);
- the work order, the PRD and the code disagree (record it as a proposed D-number; do not edit OPEN_QUESTIONS.md unless that is your assigned file);
- a decision is still open (D-5, D-9, D-10, D-13, D-16, D-17, D-18, D-19) and the work depends on it;
- you would need a credential.

Do not work around a block by choosing a default silently.

### 2.9 Stay in scope
- Only touch the files your task names. Other agents may be writing other folders at the same time.
- Update the tracker row and [../07-project-memory/](../07-project-memory/) hand-off notes when your task says so.
- The definition of done is [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md).
