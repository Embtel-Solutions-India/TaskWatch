# Bug Report Template

> Copy below the line. Do not paste secrets, real client ID numbers (A-numbers, passports, receipts), real phone numbers or raw outbox addresses ([WO "Client data"], [AI_AGENT_GUARDRAILS G-4](../04-engineering-standards/AI_AGENT_GUARDRAILS.md)). Severity scale: [QA_STRATEGY.md §5](QA_STRATEGY.md).

---

**Title:** <feature ID> — <what is wrong, in one line>

| Field | Value |
|---|---|
| Feature ID(s) | e.g. `WF-11` ([PRD](../02-product-requirements/PRODUCT_REQUIREMENTS.md)) |
| Related WO AC / test case | e.g. AC-3 / `TC-WF-11-02` |
| Severity | 1 / 2 / 3 |
| Environment | dev / test / staging / pilot / production |
| Build or date deployed | |
| Signed in as | persona or user id, **and role(s)** (e.g. "Jordan Lee — lead") |
| Entity / team | e.g. BAIS / case team 2 |
| Viewer's time zone | e.g. Asia/Kolkata |
| Server time when it happened (UTC) | from `GET /api/me` `serverTime`, or the log row time |
| Demo clock offset | none / +N h (dev only) |
| Task / escalation / notification id | e.g. task #123, escalation #45 |

**Steps to reproduce**
1.
2.
3.

**Expected** (quote the PRD/WO rule with its tag)

**Actual** (status code and `error` text if an API call failed; screenshot)

**Evidence**
- Activity log rows (kind, seq, at) for the task:
- Delivery log row(s) (channel, status, attempts):
- Server log line(s) without personal data:

**Regression?** Last version where it worked:
