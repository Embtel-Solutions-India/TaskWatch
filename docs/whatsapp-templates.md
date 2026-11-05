# WhatsApp message templates

TaskWatch sends WhatsApp alerts through the **WhatsApp Business Cloud API** using pre-approved
message templates (work order: Notifications and integrations). Submit these five templates in
**Meta Business Manager › WhatsApp Manager › Message templates** before turning WhatsApp on.

- **Category:** Utility
- **Language:** English (`en`), or change `WHATSAPP_TEMPLATE_LANG` in `.env`
- **Button:** every template except `taskwatch_system_alert` has one *Visit website* button,
  labelled **Open task**, with a **dynamic** URL `https://<your TaskWatch domain>/tasks/{{1}}`.
  TaskWatch fills `{{1}}` with the task number.

Template names and the order of the `{{n}}` variables must match exactly. The code that fills them
is in `server/src/notify/messages.ts`.

| Template name | Body text | Variables (sample) |
|---|---|---|
| `taskwatch_task_assigned` | New task from {{1}}: {{2}}. Priority: {{3}}. Due: {{4}}. Please post your first update in TaskWatch. | 1 assigner (*Jordan Lee*) · 2 title (*RFE response — Fernandes H-1B*) · 3 priority (*Critical*) · 4 due in the recipient's zone (*Thu 5 Nov, 5:00 PM PT*) |
| `taskwatch_update_reminder` | Reminder: there has been no update on {{1}} for {{2}}. Please post an update in TaskWatch. | 1 title · 2 silence (*4 h*) |
| `taskwatch_escalation` | TaskWatch {{1}}: {{2}} (assigned to {{3}}, {{4}}) — {{5}}. Please review and acknowledge in TaskWatch. | 1 level (*L2 Manager*, *L1 Team lead (copy)*, *L3 Founder's Office (still open)*) · 2 title · 3 assignee · 4 entity · 5 reason (*no assignee update for 8 h* / *past due by 1 d*) |
| `taskwatch_task_blocked` | {{1}} marked {{2}} as Blocked. Reason: {{3}}. Please help unblock it in TaskWatch. | 1 assignee · 2 title · 3 reason |
| `taskwatch_system_alert` | TaskWatch alert: {{1}} Open TaskWatch for details. | 1 alert text (used for audit-log integrity alerts; no button) |

## Turning it on

1. Decide the sending number and Meta Business account owner (decision **D6**).
2. In WhatsApp Manager, add the number and create a permanent System User access token with the
   `whatsapp_business_messaging` permission.
3. Submit the five templates above and wait for approval.
4. Put the token and phone number ID in the server's secrets (`WHATSAPP_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`) and restart. The Delivery log shows **Live** for WhatsApp.
5. Make sure every person in **People** has their real WhatsApp number in international format and
   has agreed to receive work alerts on WhatsApp. Anyone without a number gets email and in-app
   alerts only, and the Delivery log records the WhatsApp alert as *skipped*.

> The sample directory uses fictional +1-415-555-01xx numbers, which WhatsApp will reject. Replace
> them with real numbers before going live.
