# Milestones

> Last updated: 2026-11-03. Aligned to the Work Order's six work packages and its "proposed 10 weeks from kickoff" [WO p.6].
> **All dates are relative to a kickoff date K that is not yet set [OPEN].** "Week n" means the n-th week after K. No milestone has been reached. Phases and tasks: [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md) · [TASK_BREAKDOWN](TASK_BREAKDOWN.md). Gates: [RELEASE_READINESS](../05-testing-and-qa/RELEASE_READINESS.md).
> The WO also asks Embtel for an effort and cost estimate per work package within 5 working days of receiving the order [WO p.6]. That estimate is not part of these docs [OPEN].

| Milestone | WO WP | Weeks (WO) | Target | Roadmap phases | Status |
|---|---|---|---|---|---|
| M0 Kickoff readiness | before WP-1 | — | K − 1 week to K | Foundation, step 1 (T-1.1) | not reached |
| M1 Foundations | WP-1 | 1–2 | end of week 2 | Foundation, Auth, Org/permissions | not reached |
| M2 Task core | WP-2 | 2–4 | end of week 4 | Task core (+ Recurring, see note) | not reached |
| M3 Escalation engine | WP-3 | 4–5 | end of week 5 | Escalation, Recurring | not reached |
| M4 Notifications | WP-4 | 5–6 | end of week 6 | Notifications | not reached |
| M5 Dashboards and reports | WP-5 | 6–8 | end of week 8 | Dashboards, Reports, Demo | not reached |
| M6a Pilot start | WP-6 | 8 | start of week 9 | Release (T-11.1…T-11.4) | not reached |
| M6b Pilot sign-off and rollout | WP-6 | 8–10 | end of week 10 | Release (T-11.5, T-11.6) | not reached |

## M0 Kickoff readiness
- **Deliverables:**
  - Decisions recorded in [OPEN_QUESTIONS §7.1](../01-discovery/OPEN_QUESTIONS.md).
  - ADR-0007 and ADR-0009 status set.
  - DATABASE_DESIGN §3–5 and API_CONTRACTS §2 approved.
  - Kickoff date set.
- **Exit gate:**
  - D-18 OK given in writing.
  - The WO decisions confirmed "before Embtel starts WP-1" [WO p.7].
- **Decisions needed:**
  - D-18, D-9, D-10
  - D-35, D-80, D-82, D-67
  - WO-D2, WO-D3, WO-D4, WO-D5, WO-D7
  - WO-D6: start Meta template approval now, because of its external lead time
  - The kickoff date

## M1 Foundations (WP-1, weeks 1–2)
- **WO deliverables:** "Schema, seeded directory for all entities, role tests" [WO].
- **Plan deliverables:**
  - Migrations `002`…`006`
  - Shared rules module
  - Error envelope, rate limiting, `/api/me`, fetch adapter, leader lock
  - Google and password sign-in with TOTP
  - Permission matrix, multiple roles, teams, placement
- **Exit gate:**
  - DoD for AUTH-*, STAFF-*, ORG-*, ROLE-*, SET-01.
  - The adapted existing tests run once with approval, results recorded.
  - TC-AUTH-*, TC-STAFF-*, TC-ROLE-* run.
- **Decisions needed:** D-65, D-68, D-29, D-33, D-75, D-41, D-44.

## M2 Task core (WP-2, weeks 2–4)
- **WO deliverables:** "Task screens, log, API" for FR-1…FR-7 [WO].
- **Plan deliverables:**
  - TASK-01…08, WF-01…11, EXT-01…04, CMT-*, ATT-*, AUD-01/02
  - Their pages integrated (T-4.14)
- **Exit gate:**
  - AC-4, AC-6 and AC-7 cases run (TC-CMT-01-01, TC-WF-03-01, TC-TASK-04-01/02, TC-TASK-05-01, TC-SEC1-01, TC-AUD-01-01…04).
  - TC-TASK-01-06 run (AC-9, automated part).
- **Decisions needed:**
  - **D-5** and **D-13** (no default)
  - D-16, D-27, D-30, D-32, D-34, D-69, D-74, D-83
  - D-31 (decided) and D-63 added to OPEN_QUESTIONS and answered
- **Note:** the WO puts FR-7 (Recurring) in WP-2. This plan finishes it by week 5 (M3). Agree the slip with the CoS, or start T-7.1 in week 3 once D-5 is answered.

## M3 Escalation engine (WP-3, weeks 4–5)
- **WO deliverables:** "Engine with automated tests for every rule in this order" (FR-8, FR-9, editable SLA windows) [WO].
- **Plan deliverables:**
  - ESC-*, POL-*, REC-*
  - Browser engine tick removed
- **Exit gate:**
  - AC-1 and AC-2 automated cases run (TC-ESC-01-05/06, TC-ESC-02-01/02/04).
  - TC-ESC-04-*, TC-ESC-06-*, TC-POL-01-* and TC-REC-04-* run.
  - Embtel starts tracking the WO's own tasks in TaskWatch [WO p.6]. That needs a shared environment.
- **Decisions needed:** D-23, D-24, D-25, D-26, D-28, D-48, D-45, D-46.

## M4 Notifications (WP-4, weeks 5–6)
- **WO deliverables:** "Approved templates, delivery log" (WhatsApp, email, in-app, quiet hours, time zones) [WO].
- **Plan deliverables:** NTF-01…08, DLV-01/02, and the weekly digest NTF-05 (FR-12, a WP-5 item built here).
- **Exit gate:**
  - AC-3 and AC-5 automated cases run (TC-WF-11-02…04, TC-NTF-02-01/02, TC-DLV-01-02).
  - TC-NTF-03-* and TC-NTF-05-01 run.
  - Templates approved by Meta (R-I1).
- **Decisions needed:** WO-D6, D-41, D-42, D-43, D-44, D-52, D-93.

## M5 Dashboards and reports (WP-5, weeks 6–8)
- **WO deliverables:** "Role views, accountability dashboard, weekly digest" for FR-10…FR-12, CSV and PDF [WO].
- **Plan deliverables:**
  - DASH-*, TASK-09, TASK-10, SRCH-01, RPT-*
  - DEMO-01 production gate
- **Exit gate:**
  - AC-8 automated case run (TC-DASH-01-01).
  - TC-DASH-03-*, TC-RPT-03-* and TC-DEMO-01-* run.
  - A new TC for TASK-10 written and run.
- **Decisions needed:** D-49, D-50, D-51, D-53, D-17, D-47.

## M6a Pilot start (WP-6, week 8)
- **Deliverables:**
  - Staging run of the [QA_CHECKLIST](../05-testing-and-qa/QA_CHECKLIST.md)
  - Pilot environment with live WhatsApp and email
  - BAIS directory loaded
  - Backups running, one restore test done
  - Secrets store in place
- **Exit gate:**
  - RELEASE_READINESS §2–§7 gates `met` or waived in writing, except the pilot-only items.
  - Full suite run on the release build (R-DOD2).
- **Decisions needed:** WO-D5 (pilot entity), D-73, D-89, D-66.

## M6b Pilot sign-off and rollout (WP-6, weeks 8–10)
- **WO deliverables:** "Pilot report, training video, go-live"; rollout to USAIS, IE, Embtel, BAAS and the Founder's Office [WO].
- **Exit gate:**
  - AC-1…AC-10 `met` in the pilot environment (R-AC1…R-AC10), including AC-10: at least 90 % of BAIS staff posting updates (TC-WF-03-06).
  - Sign-off table in RELEASE_READINESS completed by the Founder's Office, CoS and Embtel delivery lead.
- **Decisions needed:** D-19 (README refresh); rollout order across entities [OPEN].
