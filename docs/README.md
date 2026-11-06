# TaskWatch documentation

These docs are the engineering system for TaskWatch, specified by Work Order FO-2026-OPS-01. Start at [../AGENTS.md](../AGENTS.md), then read [07-project-memory/CURRENT_STATE.md](07-project-memory/CURRENT_STATE.md).

| Folder | What it answers | Start with |
|---|---|---|
| [01-discovery](01-discovery/PROJECT_OVERVIEW.md) | What exists today, what is missing, what is undecided | [OPEN_QUESTIONS](01-discovery/OPEN_QUESTIONS.md) (all D-numbers) |
| [02-product-requirements](02-product-requirements/PRODUCT_REQUIREMENTS.md) | What the system must do: feature IDs, roles, business rules, one FRD per module in [features/](02-product-requirements/features/) | [PRODUCT_REQUIREMENTS](02-product-requirements/PRODUCT_REQUIREMENTS.md) |
| [03-architecture](03-architecture/SYSTEM_ARCHITECTURE.md) | How it is and will be built: DB, API contracts, security, reliability, integrations, ADRs | [decisions/README](03-architecture/decisions/README.md) |
| [04-engineering-standards](04-engineering-standards/AI_AGENT_GUARDRAILS.md) | Rules for writing code: guardrails, DoD, errors, migrations, review | [AI_AGENT_GUARDRAILS](04-engineering-standards/AI_AGENT_GUARDRAILS.md) |
| [05-testing-and-qa](05-testing-and-qa/TESTING_STRATEGY.md) | How it is verified: test cases `TC-*`, security and performance plans, release gates | [TEST_CASE_INVENTORY](05-testing-and-qa/TEST_CASE_INVENTORY.md) |
| [06-planning-and-tracking](06-planning-and-tracking/IMPLEMENTATION_ROADMAP.md) | In what order, and how far along: roadmap, tracker, tasks, traceability | [IMPLEMENTATION_TRACKER](06-planning-and-tracking/IMPLEMENTATION_TRACKER.md) |
| [07-project-memory](07-project-memory/PROJECT_MEMORY.md) | Where things stand right now, and what the last session handed over | [CURRENT_STATE](07-project-memory/CURRENT_STATE.md) |
| [08-operations](08-operations/DEVELOPMENT_SETUP.md) | Running, configuring, deploying, monitoring | [DEVELOPMENT_SETUP](08-operations/DEVELOPMENT_SETUP.md) |
| [whatsapp-templates.md](whatsapp-templates.md) | The five Meta WhatsApp templates (existing) | — |

## ID conventions
| Prefix | Meaning | Defined in |
|---|---|---|
| `AUTH-`, `TASK-`, `WF-`, `EXT-`, `CMT-`, `ATT-`, `ESC-`, `NTF-`, `REC-`, `DASH-`, `RPT-`, `STAFF-`, `ORG-`, `ROLE-`, `POL-`, `SET-`, `AUD-`, `DLV-`, `SRCH-`, `DEMO-` | Feature IDs | PRODUCT_REQUIREMENTS |
| `<ID>-AC-n` | Feature acceptance criterion | the module FRD |
| `AC-1…AC-10` | Work-order sign-off criteria | [PROJECT_OVERVIEW §1.7](01-discovery/PROJECT_OVERVIEW.md) |
| `C-1…C-7` | Cross-cutting rules | PRODUCT_REQUIREMENTS |
| `BR-nn` | Business rule | [BUSINESS_RULES](02-product-requirements/BUSINESS_RULES.md) |
| `D-n` | Our decision or question. `WO-D1…D7` are the work order's own decisions. | [OPEN_QUESTIONS](01-discovery/OPEN_QUESTIONS.md) |
| `ADR-nnnn` | Architecture decision | [decisions/](03-architecture/decisions/README.md) |
| `TC-<ID>-NN` | Test case | [TEST_CASE_INVENTORY](05-testing-and-qa/TEST_CASE_INVENTORY.md) |
| `T-<phase>.<n>` | Implementation task | [TASK_BREAKDOWN](06-planning-and-tracking/TASK_BREAKDOWN.md) |
| `S-n`, `KI-n` | Security finding, known issue | EXISTING_SYSTEM_ANALYSIS §3.8, KNOWN_ISSUES |

Evidence tags used everywhere:
- **[WO]**: from the work order
- **[V-C] / [V-S]**: verified in client / server code, with file:line
- **[A]**: assumption
- **[OPEN]**: undecided

## Superseded drafts
The first drafts (`FRD.md`, `IMPLEMENTATION_TRACKER.md`) are gone; their content lives in 01-discovery and 02-product-requirements.

## Proposed scope expansion
[PERFORMANCE_SCOPE_GAP_ANALYSIS](01-discovery/PERFORMANCE_SCOPE_GAP_ANALYSIS.md) compares the current system with the 2026-11-06 brief (outcomes, time, performance, leaderboards) and the BAIS spreadsheet. Open decisions D-110…D-121.
