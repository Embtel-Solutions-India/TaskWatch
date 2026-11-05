# Active Work

_Last updated: 2026-11-06_

| Item | Owner | Status | Next action |
|---|---|---|---|
| Documentation system (docs/01–08, AGENTS.md) | AI agent | Approved (defaults accepted 2026-11-04) | Keep updated per AGENTS.md |
| T-1.11 error envelope | AI agent | CODE_COMPLETE | Done and verified (43/43). |
| T-1.12 404 for not-visible | AI agent | CODE_COMPLETE | Done and verified (43/43). |
| T-1.13 rate limiting | AI agent | CODE_COMPLETE | Helper and live surfaces done (46/46). The `login_attempts` part moves to T-2.1. |
| T-1.14 Vite proxy / T-1.17 scheduler lock | AI agent | CODE_COMPLETE | Done (48/48; proxy verified live). |
| Stray API process (pid 15752, started by the agent for the proxy check) | User | Waiting | Stop it; the agent's kill was blocked by permissions |
| Readiness review | AI agent | Approved (owner said "start T-1.2") | — |
| T-1.2 shared ladder module | AI agent | CODE_COMPLETE | 53/53, live smoke ok. |
| T-1.3 shared workflow | AI agent | CODE_COMPLETE | 59/59. |
| T-1.4 shared permissions | AI agent | CODE_COMPLETE | 66/66 ×6. |
| T-1.5 migration 002 (additive) | AI agent | DONE | Applied to dev; 66/66 ×3 |
| T-1.6 migration 003 (teams) | AI agent | DONE | Dev: 6 teams, 20 people placed |
| T-1.8 migration 004 (auth tables) | AI agent | DONE | Applied to dev |
| T-1.9 audit-log chain (migration 005 + `services/audit.ts`) | AI agent | DONE | 67/67 ×3 |
| T-1.15 `/api/me` bootstrap | AI agent | CODE_COMPLETE | 71/71 |
| T-1.16 client HTTP transport | AI agent | CODE_COMPLETE | Foundation complete |
| Auth phase (T-2.1…T-2.7) | AI agent | Security review done, fixes in; 7 features in REVIEW, AUTH-01a TESTING, AUTH-07/08 REMOVED (D-94) | Owner runs `npm test`; then DONE |
| Task core phase (T-4.x) | AI agent | DONE 2026-11-05 | — |
| Escalation phase (T-5.x) | AI agent | DONE 2026-11-05 | — |
| Notifications phase (T-6.x) | AI agent | Code-complete 2026-11-05 (Batch A green; Batch B written) | Owner runs `npm test` + `npm run e2e` |
| Recurring phase (T-7.x) | AI agent | Code-complete 2026-11-06 (Batch A server, Batch B client) | Owner runs `npm test` + `npm run e2e` |
| Org/permissions phase (T-3.x) | AI agent | T-3.0…T-3.8 CODE_COMPLETE (dev at 008); phase code-complete | Owner runs e2e + npm test; then Phase 4; T-3.9 gated on KI-22 |

Waiting on the user:
- Run `npm test` after setting `ALLOW_DEV_LOGIN=true` in `.env` (KI-21).
- D-98, D-99 (auth review).
- WO-D2…D7 confirmation from the Founder's Office.
