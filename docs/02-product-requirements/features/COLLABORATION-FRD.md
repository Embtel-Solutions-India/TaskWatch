# FRD: Comments and Attachments (CMT, ATT)

> Module index: [PRODUCT_REQUIREMENTS §2.5](../PRODUCT_REQUIREMENTS.md#25-comments--attachments-cmt--att). Retention and immutability: [BUSINESS_RULES §11](../BUSINESS_RULES.md#11-retention-and-immutability). Tags: **[WO]** · **[V-C]** `client/src/…` · **[V-S]** `server/src/…` · **[A]** · **[OPEN D-n]**. All endpoints are **PROPOSED**. C-1..C-7 apply.
>
> **Binding:**
> - [WO FR-4] Comments are logged but never reset the clock (AC-4).
> - [WO] Every comment is an append-only log row.
> - **D-12** Soft delete only; the original text stays in the append-only log.
> - **D-11** Sensitive-ID guard.
> - **D-13** (open) Upload size limit.

Features: CMT-01 · CMT-02 · CMT-03 · ATT-01 · ATT-02 · ATT-03

---

## CMT-01 Add comment or reply

**Description.** Anyone who can view a task posts a comment or a one-level reply, optionally with files and @mentions.

**Roles.** Anyone with `canViewTask`, **including the assignee**. This is broader than FR-4 ("from leads, managers and the Founder's Office") and is kept per PROJECT_OVERVIEW §1.6. The server forbids assignee comments today [V-S `services/access.ts:73`]; that rule is dropped. [A]

**User actions (UI).** The Comments tab `features/tasks/TaskDetailPage.tsx:525-604`. The form shows only when `actions` includes `comment`. Reply is one level deep. The banner hint reads "Mention someone with @Full Name".

**Behaviour.**
- Stores the comment (`parentId` for a reply).
- Attaches files with context `comment`.
- Appends a `comment` log row whose body is the comment text, so the log is the evidence [V-S `services/tasks.ts:172`]. The client logs only "Commented" (`services/api/tasks.ts:435`).
- **Never touches `clockStartedAt`.** [WO FR-4; V-C `tasks.ts:434`]
- Notifies every user named as `@<Full Name>` who can view the task, except the author (`mention`). [V-C `tasks.ts:436-437`]
- **[A]** The assignee is also notified in-app when someone else comments. This is server behaviour [V-S `services/tasks.ts:173-176`]; the client does not do it.

**Data.**
- `comments(id, taskId, authorId, body, at, editedAt, parentId, deleted)`
- `activity_log` (kind `comment`, body)
- `attachments`
- `notifications`

**API.** `POST /api/tasks/:id/comments` (multipart) `{body, parentId?, files[]}` → 201 `{comment}`. Adapt the existing `POST /tasks/:id/comments` `{body ≤ 5000}` (`routes/tasks.ts:99-104`).

**Validation.** [V-C `tasks.ts:430-431`]
- Empty after trim → 422 `fields.body = "Write a comment first."`
- Longer than 4000 → 422 `fields.body = "Comments are limited to 4000 characters."` **Decided (D-34): 4000** (the UI limit); the server's 5000 changes to match.
- `parentId` must be a top-level comment on the same task → otherwise 422 [A]. The mock does not check this.
- Sensitive-ID guard (BR-80).

**Authorization.** `comment` ∈ allowedActions (any viewer). Not visible → 404, identical to a missing task (D-35, decided; implemented 2026-11-04 (T-1.12)).

**Scenarios.**

| Scenario | Status |
|---|---|
| Lead comments | 201; clock unchanged |
| Assignee comments | 201 |
| Outsider | 403 |
| 4001 characters | 422 |
| Reply to a reply | 422 [A] |

**Dependencies.** ATT-01, NTF-01/02.

**Acceptance criteria.**
- CMT-01-AC-1 (AC-4): A comment by the lead, by a manager and by the assignee each leaves `clockStartedAt` and the level unchanged.
- CMT-01-AC-2: The comment text is stored in an append-only log row with server time and the author.
- CMT-01-AC-3: `@Full Name` notifies that user only when they can view the task.
- CMT-01-AC-4: A body containing an A-number returns 422 with the BR-80 message.

**Test scenarios.**
- Comment by each relationship.
- The clock is unchanged across a window boundary.
- Mention of an insider and an outsider.
- Length boundaries 4000/4001.
- Reply depth.
- Sensitive ID.

---

## CMT-02 Edit comment

**Description.** The author corrects their comment.

**Roles.** The author only.

**User actions (UI).** The Edit button on a comment, shown for the author only on the client side (`TaskDetailPage.tsx:563`).

**Behaviour.**
- Replaces the visible body and sets `editedAt`.
- **Appends an `edited` log row holding the previous and new text** (D-12; the mock does not log edits, `tasks.ts:441-451`).
- Does not reset the clock.
- Does not re-notify mentions [A].

**Data.** `comments.body/editedAt`, `activity_log`.

**API.** `PATCH /api/comments/:commentId` `{body}` → 200 `{comment}`. New.

**Validation.** [V-C `tasks.ts:444, 447`]
- Empty → 422 `fields.body = "A comment cannot be empty."`
- Unknown or deleted → 404 `Comment not found.`
- Length ≤ 4000.
- Sensitive-ID guard.

**Authorization.** Must be able to view the task (403 otherwise). Not the author → 403 `You can only edit your own comments.` [V-C `tasks.ts:446`] Editing on a closed task is allowed [A]; the mock does not block it.

**Scenarios.** Author → 200. Another user, including the CoS → 403. Deleted comment → 404.

**Dependencies.** CMT-01.

**Acceptance criteria.**
- CMT-02-AC-1: After an edit, the activity log still contains the original text unchanged.
- CMT-02-AC-2: A non-author, including a CoS, gets 403.

**Test scenarios.**
- Edit then read the log.
- Non-author edit.
- Edit a deleted comment.

---

## CMT-03 Delete comment

**Description.** Hide a comment.

**Roles.** The author, or a CoS.

**User actions (UI).** The Delete button (with confirm), shown for the author or a CoS on the client side (`TaskDetailPage.tsx:564`).

**Behaviour.**
- Soft delete: `deleted = true`, and the visible body is blanked.
- The original remains in the append-only log (D-12).
- Audits `comment.deleted`. [V-C `tasks.ts:453-463`]
- Replies to it stay visible [A].

**Data.** `comments.deleted`, `activity_log`, audit.

**API.** `DELETE /api/comments/:commentId` → 200 `{ok:true}`. This marks the comment; no row is removed. New.

**Validation.** Unknown or already deleted → 404 `Comment not found.`

**Authorization.** Must be able to view the task. Not the author and not holding `cos` → 403 `You can only delete your own comments.` [V-C `tasks.ts:458`] With multiple roles (D-8): "holds `cos`".

**Scenarios.** Author → 200. CoS → 200. Lead (not author) → 403. Twice → 404.

**Dependencies.** CMT-01, AUD-01.

**Acceptance criteria.**
- CMT-03-AC-1: After a delete, `GET /api/tasks/:id` shows the comment as deleted with no body, while the activity log row still holds the original text.
- CMT-03-AC-2: No endpoint removes the comment's log row (AC-7).
- CMT-03-AC-3: A non-author non-CoS gets 403.

**Test scenarios.**
- Author delete.
- CoS delete.
- Third-party delete.
- Log intact.
- Direct DB tamper flagged by the chain check (AC-7).

---

## ATT-01 Upload attachment

**Description.** Add files to a task, a progress update, a comment or a review submission. [WO FR-3 "optionally with a file"]

**Roles.** The assignee, an overseer or the giver, on a task that is not closed. [V-C `services/engine/workflow.ts:69`]

**User actions (UI).**
- Files tab upload: `TaskDetailPage.tsx:457-523`.
- File pickers in ProgressDialog `features/tasks/TaskDialogs.tsx:31`, SubmitDialog `:53`, the comment form, and New task (`features/tasks/TaskFormPage.tsx`).
- The demo hint "Files stay in this browser tab only" must go.

**Behaviour.**
1. **Authorize and validate before writing any bytes.** The server writes first today (S-4).
2. Stream the file to storage under a random key.
3. Compute SHA-256.
4. Store `name`, `size`, `mime` (detected, not client-supplied), `sha256`, `uploadedBy`, `at` and `context`.
5. Append an `attachment_added` log row linked to the file. [V-S `routes/tasks.ts:69-95`, `services/tasks.ts:135-141`; V-C `tasks.ts:98-113`]

Several files per request are allowed (the client supports it; the server allows 1). [A]

**Data.** `attachments(id, taskId, logId, name, size, mime, sha256, storageKey, uploadedBy, at, context, removedAt, removedBy)`.

**API.**
- `POST /api/tasks/:id/attachments` (multipart `files[]`) → 201 `{attachments: Attachment[]}`.
- Uploads inside progress, comment, review or create go through those endpoints.

Adapt the multer config (`routes/tasks.ts:21-27`) and the attachment insert (`services/tasks.ts:136-139`).

**Validation.**
- No files → 422 `fields.files = "Choose at least one file."` [V-C `tasks.ts:469`]
- Over the size limit → 422 `<name> is larger than 25 MB.` (client) or 413 `That file is too large (15 MB maximum)` (server, `http/middleware.ts:79`). **Decided (D-13/D-69): 15 MiB, allow-listed types (Office documents, PDF, images, txt, csv).** The client check and message change from 25 MB to 15 MB.
- Type allow-list (SEC-8): **[A]** images, PDF, plain text, CSV and Office documents; others → 422.
- The filename is checked by the sensitive-ID guard [A] (gap S-12).

**Authorization.** `attach` ∈ allowedActions. Closed task → 403 `You can't attach files on <id> in its current state.` Not visible → 404, identical to a missing task (D-35, decided).

**Scenarios.**

| Scenario | Status |
|---|---|
| Assignee uploads a PDF | 201 |
| Upload to a completed task | 403 |
| Oversize | 413/422 (D-13) |
| `.exe` | 422 [A] |
| Outsider | 403, and nothing written to disk |

**Dependencies.** WF-03, CMT-01, WF-04, TASK-01.

**Acceptance criteria.**
- ATT-01-AC-1: A rejected upload (403, 413 or 422) leaves no file in storage.
- ATT-01-AC-2: The stored SHA-256 matches the bytes later downloaded through ATT-02.
- ATT-01-AC-3: Each upload writes an `attachment_added` log row with the filename and hash.
- ATT-01-AC-4: The stored MIME type is derived on the server, not echoed from the request.

**Test scenarios.**
- Upload per role.
- Closed task.
- Size boundary at the D-13 limit.
- Disallowed type.
- Orphan check after a failure.
- Hash round-trip.

---

## ATT-02 Download and preview

**Description.** Fetch an attachment.

**Roles.** Anyone who can view the task.

**User actions (UI).** Files tab download and preview (`TaskDetailPage.tsx:457-523`). The placeholder download blob (`:441-455`) is demo-only.

**Behaviour.**
- Streams the file with `Content-Disposition: attachment; filename*=UTF-8''<name>` and `X-Content-Type-Options: nosniff`. [V-S `routes/tasks.ts:127-143`]
- Inline preview only for safe types (image, PDF, text/plain) through `?inline=1`, with a restrictive CSP. [A]
- A removed attachment (ATT-03) is not downloadable through the task view [A]; it remains retrievable by the CoS for evidence [A].

**Data.** `attachments`.

**API.** `GET /api/tasks/:id/attachments/:attId[?inline=1]` → 200 stream. Reuse the existing route (`routes/tasks.ts:127-143`).

**Validation.** The attachment must belong to `:id`.

**Authorization.** `canViewTask`. Not visible or not found → 404 `File not found` [V-S `routes/tasks.ts:135`].

**Scenarios.** Viewer → 200. Outsider → 404. Wrong task id pairing → 404.

**Dependencies.** ATT-01.

**Acceptance criteria.**
- ATT-02-AC-1: A user who cannot view the task gets 404 for every attachment id on it.
- ATT-02-AC-2: Non-safe types are always served as attachments, never inline.
- ATT-02-AC-3: Every response carries `nosniff`.

**Test scenarios.**
- Visibility.
- Mismatched task and attachment ids.
- HTML file served as a download.
- Header check.

---

## ATT-03 Remove attachment

**Description.** Hide an attachment from the task.

**Roles.** The uploader, or an overseer of the task. [V-C `tasks.ts:480`] The client shows the button for the uploader or anyone with `reassign` or `edit` (`TaskDetailPage.tsx:466, 503`); the server decides.

**User actions (UI).** The Remove button (with confirm) in the Files tab, `TaskDetailPage.tsx:503`.

**Behaviour.**
- Soft removal: sets `removedAt` and `removedBy`; the stored file and its hash are kept (D-12; PRD ATT-03 [A]).
- Appends an `attachment_removed` log row.
- The mock deletes the record outright (`tasks.ts:481`); the backend must not (BR-79).

**Data.** `attachments.removedAt/removedBy`, `activity_log`.

**API.** `DELETE /api/attachments/:attId` → 200 `{ok:true}`. This marks the attachment; no row or file is removed. New.

**Validation.** Unknown or already removed → 404 `Attachment not found.` [V-C `tasks.ts:477`]

**Authorization.**
- Must be able to view the task.
- Not the uploader and not an overseer → 403 `Only the uploader or a task supervisor can remove this file.` [V-C `tasks.ts:480`]
- On a closed task → 403 [A], to protect evidence after closing.

**Scenarios.** Uploader → 200. Overseer → 200. Assignee removing an overseer's file → 403.

**Dependencies.** ATT-01, AUD-01.

**Acceptance criteria.**
- ATT-03-AC-1: After removal, the file no longer appears in the task's attachment list, the stored bytes and hash still exist, and the log has an `attachment_removed` row.
- ATT-03-AC-2: An attachment that was part of a progress update stays referenced from that update's log row.
- ATT-03-AC-3: A third party gets 403.

**Test scenarios.**
- Remove by the uploader.
- Remove by an overseer.
- Remove by a third party.
- Remove on a closed task.
- Storage still holds the file.

---

## Decision points (all decided 2026-11-04)

> Each D-number below is decided. The value is in the [Decision Register](../../01-discovery/OPEN_QUESTIONS.md); where a value changes behaviour, the sections above already state it. R-1 and R-2 from the [readiness review](../../06-planning-and-tracking/READINESS_REVIEW.md) were decided on 2026-11-04 (Decision Register §10.1).

- **D-12** (decided): soft delete. Edits must log the previous text (CMT-02); the client does not.
- **D-13**: 15 MiB or 25 MB.
- **D-11** (decided): the guard on comments. Extending it to filenames is **[A]** (S-12).
- **D-31 (decided)**: the client hard-deletes attachment records and recurrence schedules; confirm soft removal for both.
- **D-34 (decided)**: comment length 4000 (client) vs 5000 (server).
- **D-35 (decided)**: not visible → 404, identical to a missing task (implemented 2026-11-04 (T-1.12)).
