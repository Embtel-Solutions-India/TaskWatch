# Architecture Decision Records

> Evidence tags: **[WO]** Work Order FO-2026-OPS-01 · **[V-C]** client code · **[V-S]** server code · **[A]** assumption · **[OPEN]** a D-number in [OPEN_QUESTIONS.md](../../01-discovery/OPEN_QUESTIONS.md).
> New ADRs use [ADR-TEMPLATE.md](ADR-TEMPLATE.md).

## What is (and is not) here
- ADRs record only the decisions taken by the product owner on 2026-11-03 ([OPEN_QUESTIONS.md §7.1](../../01-discovery/OPEN_QUESTIONS.md)) and decisions still **Proposed — needs approval**.
- The existing server stack (Express 5, `pg` with raw SQL, zod, `express-session` + `connect-pg-simple`, helmet, luxon, multer, nodemailer, pdfkit, google-auth-library, tsx) was **never recorded as a decision**. It is existing, observed in code ([EXISTING_SYSTEM_ANALYSIS.md §3.1](../../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)). ADR-0001 decides only to keep evolving it; it does not reconstruct why it was chosen.

## Index
| ADR | Title | Status | Date | D-numbers |
|---|---|---|---|---|
| [ADR-0001](ADR-0001.md) | Evolve the existing Express/pg server | Accepted | 2026-11-03 | D-1, D-18 |
| [ADR-0002](ADR-0002.md) | Authentication: Google OAuth + password + TOTP for senior roles | Accepted | 2026-11-03 | D-2, D-21 |
| [ADR-0003](ADR-0003.md) | Task state model: WO core plus prototype extras | Accepted | 2026-11-03 | D-3, D-20 |
| [ADR-0004](ADR-0004.md) | Organization and authorization model | Accepted | 2026-11-03 | D-4, D-8 |
| [ADR-0005](ADR-0005.md) | Due-date changes: extension requests and FR-5 direct change | Accepted | 2026-11-03 | D-6 |
| [ADR-0006](ADR-0006.md) | Keep per-entity SLA overrides | Accepted | 2026-11-03 | D-7 |
| [ADR-0007](ADR-0007.md) | Single shared rules module for client and server | **Accepted** | 2026-11-04 | D-9 |
| [ADR-0008](ADR-0008.md) | Standalone delivery, not a StatCommand module | Accepted | 2026-11-03 | D-22, WO-D1 |
| [ADR-0009](ADR-0009.md) | v1 list pagination stays client-side over capped, scoped results | **Accepted** | 2026-11-04 | D-10 |
| [ADR-0010](ADR-0010.md) | Multiple organizations in one database | **Accepted** | 2026-11-04 | D-95…D-97, D-100…D-104 |

## Proposals that live outside the ADR list
These are written in the architecture docs and are marked **Proposed — needs approval** where they appear. None is accepted yet.

| Proposal | Where |
|---|---|
| Target schema for migration 002+ (new tables and columns) | [DATABASE_DESIGN.md §3](../DATABASE_DESIGN.md) |
| Hash-chain `admin_log` + daily external anchor of chain heads (S-11) | [SECURITY_ARCHITECTURE.md §9](../SECURITY_ARCHITECTURE.md) |
| Scheduler leader lock with `pg_try_advisory_lock`, and lease-based recovery of stuck `sending` rows | [SCALABILITY_AND_RELIABILITY.md §2–3](../SCALABILITY_AND_RELIABILITY.md) |
| Per-request user check replacing the 30 s directory cache for authN (S-7) | [SECURITY_ARCHITECTURE.md §3](../SECURITY_ARCHITECTURE.md) |
| Proposed endpoint set and `TW-<n>` task IDs | [API_CONTRACTS.md](../API_CONTRACTS.md) |
