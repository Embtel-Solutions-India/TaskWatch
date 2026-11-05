# Error Handling

> Evidence tags: **[WO]** · **[V-C]** · **[V-S]** · **[A]** · **[OPEN]** — see [OPEN_QUESTIONS.md](../01-discovery/OPEN_QUESTIONS.md).
> The product-level rule is [PRD C-3 and NFR "Error handling"](../02-product-requirements/PRODUCT_REQUIREMENTS.md). This file is how the code implements it.

## 1. Envelope

Every non-2xx API response is JSON:

```ts
{ error: string; fields?: Record<string, string> }
```

- `error` is a sentence a user can read. It never contains a stack trace, SQL, a constraint name, a file path or another person's personal data.
- `fields` appears only on **422**. It maps the request field name (camelCase, as sent) to a message.

**Current state [V-S].** The server sends `{ error }` only. It never sends `fields` (`middleware.ts:68-84`). The client's `ApiError(status, message, fields?)` already expects both (`client/src/services/authz/permissions.ts:5-13`). [V-C] Adding `fields` is required for the UI contract in §3.

## 2. Status codes

| Code | Meaning | Thrown by (today) | Target |
|---|---|---|---|
| 400 | Malformed request: bad id, bad JSON, unparsable value, bad OAuth state | `idParam` (`middleware.ts:64`) [V-S]; `badRequest()` in services, which today is also used for business-rule validation (for example `services/tasks.ts:69,113,182`) [V-S] | Keep 400 for malformed input only. Business-rule validation moves to 422. |
| 401 | No session, or the user is inactive or archived | `requireUser` (`middleware.ts:28,33`) [V-S] | Plus `SESSION_EXPIRED` for idle timeout (AUTH-03). Wrong password → generic 401 (no enumeration, AUTH-01). |
| 403 | Signed in but not allowed; also a missing CSRF header | `forbidden()`, `requireRole`, `csrfGuard` (`middleware.ts:42,51`) [V-S] | Unchanged. |
| 404 | Unknown route, or object not found | `app.ts:59-61`, `notFound()` [V-S] | See D-81 on "not visible". |
| 409 | State conflict: already decided, already pending, stale transition, duplicate unique value, reporting loop | pg `23505` → 409 since T-1.11; business-rule 409s arrive with their features [V-S] | Required by PRD C-3, WF-06, EXT-02, ORG-02. |
| 413 | Upload too large | `LIMIT_FILE_SIZE` (`middleware.ts:78-81`) [V-S] | Message derived from `config.maxUploadBytes` (D-13). |
| 422 | Validation failed; field messages in `fields` | Zod errors (all issues, keyed by path), `invalid(fields)`, pg `23503`/`23514`, the sensitive-ID guard. Implemented 2026-11-04 (T-1.11, D-80) [V-S] | **All** zod and business-rule validation. Service-level `badRequest` calls move to `invalid()` feature by feature. |
| 500 | Unexpected | `errorHandler` fallback (`middleware.ts:82-83`) [V-S] | Fixed message "Something went wrong on the server". Nothing else leaks. |
| 429 | Rate limit hit | Implemented 2026-11-04 (T-1.13, D-82): `{error}` plus a `Retry-After` header in seconds, from `server/src/http/rateLimit.ts`. The UI shows it as a toast. |

**D-81 → D-35 (decided, implemented T-1.12):** a resource outside the caller's scope returns the same 404 and body as a missing one, on every `:id` route.

**D-80 (decided, implemented T-1.11):** validation returns 422 with `fields`. The `api.test.ts` assertion of 400 for "Blocked requires a reason" is unchanged, because that 400 comes from a service `badRequest`, which is outside zod.

## 3. UI contract

| Situation | UI behaviour | Evidence |
|---|---|---|
| Mutation returns **422** | No toast. `useAction` exposes `fields`; the form shows each message next to its input. | [V-C] `hooks/index.ts:37,43` |
| Mutation returns any other error | Error toast with `error` text. | [V-C] `hooks/index.ts:38` |
| Query (page load) returns 403 | `ErrorState` renders `AccessDenied` with the server message. | [V-C] `components/ui.tsx:220` |
| Query returns 404 | `ErrorState` renders "Not found" plus a link back to the overview. | [V-C] `ui.tsx:221-226` |
| Query returns anything else | "Something went wrong" with the message and an optional **Try again**. | [V-C] `ui.tsx:227-236` |
| 401 on any call | Route to sign-in (or `/session-expired` for `SESSION_EXPIRED`). | [PRD AUTH-03]; not implemented against a server yet [V-C] |

Consequences for the server:
- A 422 **must** include `fields` whenever the problem belongs to an input. Without it the user sees nothing, because the toast is suppressed for 422 (`hooks/index.ts:37`).
- A 422 for a whole-record problem (for example the sensitive-ID guard on multiple fields) uses `fields` with the offending field name, plus `error` for the summary. [A]
- `ApiError.status` is typed `400 | 401 | 403 | 404 | 409 | 422` [V-C] `permissions.ts:7`. 413, 500 and (if D-82 is accepted) 429 must be added to that union when the client moves to `fetch`.

## 4. Database errors (fixes S-8)

Today a duplicate email or an unknown entity id surfaces as a 500 (`people.ts:97,123`, `recurring.ts:66`). [V-S] [S-8](../01-discovery/EXISTING_SYSTEM_ANALYSIS.md)

The `errorHandler` maps Postgres error codes before the 500 fallback:

| `pg` code | Meaning | Response |
|---|---|---|
| `23505` unique_violation | duplicate email, duplicate active escalation | 409 `{error:"… already exists"}`; for a form field, 422 with `fields` [A] |
| `23503` foreign_key_violation | unknown entity, manager or assignee | 422 with `fields` naming the input |
| `23514` check_violation | invalid enum or range that slipped past zod | 422 |
| `P0001` raised by `taskwatch_forbid_change` | attempt to modify an append-only table | 500 to the user; logged at error level as a security event (it means a code path tried to modify the log). [V-S] `001_init.sql:104-112` |

The mapping must not echo the constraint name or the offending value. Services should still validate first (for example "Unknown entity" in `services/tasks.ts:74`); the mapping is the safety net.

## 5. Logging

- Today the fallback does `console.error(err)` with the whole error (`middleware.ts:82`). [V-S] Jobs log `console.error('[name]', err)` (`scheduler.ts:58`, `dispatcher.ts:21`). [V-S]
- **Rules:** log the method, route template, status, user id (numeric), request id and error class/message. **Never** log request bodies, emails, phone numbers, task text, OAuth tokens, session ids, SMTP/WhatsApp provider payloads, or `.env` values. [PRD NFR Observability]
- Stack traces go to the server log only, never to the response.
- A structured logger is *Proposed* (NFR Observability); until then keep `console.*` with a `[area]` prefix, and do not log PII. See [../08-operations/MONITORING.md](../08-operations/MONITORING.md).

## 6. Rules for new code
1. Throw `HttpError` (or a helper from `http/errors.ts`). Do not call `res.status(4xx)` in routes. The only exception today is `csrfGuard`.
2. Do not catch an error just to re-throw a vaguer one. Do catch to clean up (the upload route removes the temp file, `routes/tasks.ts:91-94`). [V-S]
3. Background jobs never crash the process: `every()` already catches per tick (`scheduler.ts:50-65`). [V-S] Record failures where an operator will see them (`job_runs`, notifications status `failed`).
4. Express 5 forwards rejected promises from async handlers to `errorHandler`. Do not wrap handlers in try/catch only to call `next(err)`. [V-S] `express@^5.3.0`

## 7. Field messages are user-facing (added 2026-11-04)
Since T-1.11, every zod issue reaches the UI inline as `fields[path]`. Zod's built-in texts ("Invalid input: expected string, received undefined") are developer text. **Every request schema must carry the exact user-facing message from its FRD**, for example `z.string({ error: 'Choose an entity.' })`. The prototype's mock API already lists them (`client/src/services/api/*`). Live check 2026-11-04: `POST /api/tasks` with an incomplete body returns raw zod text for four fields (KNOWN_ISSUES KI-18). Each feature fixes its own schemas.
