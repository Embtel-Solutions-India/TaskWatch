// Comments and attachments (T-4.10, T-4.11; COLLABORATION-FRD, D-12, D-74, D-31). Comments never touch the clock
// (WO FR-4). Edits and deletions keep the original text in the append-only activity log; removed files stay stored.
import { isCoS } from '@taskwatch/shared/permissions';
import type pg from 'pg';
import * as clock from '../clock.js';
import { tx } from '../db/pool.js';
import { isOpenStatus } from '../domain.js';
import { forbidden, invalid, notFound } from '../http/errors.js';
import { can, canView, isOverseerOf } from './access.js';
import { appendLog } from './activity.js';
import { getDirectory, type DirUser } from './directory.js';
import { act, guardText, insertComment, lockTask, notifyUser, ref, storeAttachment, withCleanup, type PendingFile } from './tasks.js';

const LIMIT = 4000; // D-34

/** CMT-01: a comment or a one-level reply, with files; @Full Name notifies that person if they can see the task. */
export async function addComment(actor: DirUser, taskId: number, input: { body: string; parentId?: number | null; files?: PendingFile[] }): Promise<number> {
  const body = input.body.trim();
  if (!body) throw invalid({ body: 'Write a comment first.' });
  if (body.length > LIMIT) throw invalid({ body: 'Comments are limited to 4000 characters.' });
  guardText(body, ...(input.files ?? []).map((f) => f.name));
  let id = 0;
  await withCleanup((written) =>
    act(actor, taskId, 'comment', 'comment', async ({ c, t, dir, now, rules }) => {
      if (input.parentId) {
        const { rows } = await c.query('select parent_id from comments where id = $1 and task_id = $2 and deleted_at is null', [input.parentId, taskId]);
        if (!rows[0] || rows[0].parent_id !== null) throw invalid({ parentId: 'Reply to a comment on this task.' });
      }
      const made = await insertComment(c, { taskId, actorId: actor.id, body, now, parentId: input.parentId });
      const logId = made.logId;
      id = made.id;
      for (const file of input.files ?? []) await storeAttachment(c, { taskId, logId, actor, file, now, context: 'comment', commentId: id, written });
      // Mentions: only people who can see the task; never the author (CMT-01-AC-3).
      const mentioned = dir.all().filter((u) => u.active && u.id !== actor.id && body.includes(`@${u.name}`) && canView(u, t, dir));
      for (const u of mentioned) await notifyUser(c, dir, rules, u.id, 'mention', taskId, `${actor.name} mentioned you on “${t.title}”`, body);
      if (t.assignee_id !== actor.id && !mentioned.some((u) => u.id === t.assignee_id)) {
        await notifyUser(c, dir, rules, t.assignee_id, 'comment', taskId, `${actor.name} commented on “${t.title}”`, body);
      }
    }),
  );
  return id;
}

/** Load a live comment the actor can see, locking its task; anything else is "not found". */
async function liveComment(c: pg.PoolClient, actor: DirUser, commentId: number) {
  const { rows } = await c.query('select * from comments where id = $1 and deleted_at is null', [commentId]);
  if (!rows[0]) throw notFound('Comment not found.');
  const dir = await getDirectory(actor.organizationId);
  const t = await lockTask(c, rows[0].task_id, actor, dir, 'Comment not found.');
  return { comment: rows[0], t };
}

/** CMT-02: the author corrects their text; the log keeps the previous and the new text. */
export async function editComment(actor: DirUser, commentId: number, input: { body: string }): Promise<number> {
  const body = input.body.trim();
  if (!body) throw invalid({ body: 'A comment cannot be empty.' });
  if (body.length > LIMIT) throw invalid({ body: 'Comments are limited to 4000 characters.' });
  guardText(body);
  return tx(async (c) => {
    const { comment, t } = await liveComment(c, actor, commentId);
    if (comment.author_id !== actor.id) throw forbidden('You can only edit your own comments.');
    await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'comment_edited', body, before: { commentId, body: comment.body }, after: { commentId, body } });
    await c.query('update comments set body = $2, edited_at = $3 where id = $1', [commentId, body, clock.now()]);
    return t.id;
  });
}

/** CMT-03: hidden for everyone; the original stays in the log. The author or a Chief of Staff. */
export async function deleteComment(actor: DirUser, commentId: number): Promise<void> {
  await tx(async (c) => {
    const { comment, t } = await liveComment(c, actor, commentId);
    if (comment.author_id !== actor.id && !isCoS(actor)) throw forbidden('You can only delete your own comments.');
    await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'comment_deleted', before: { commentId, body: comment.body }, after: { commentId, deleted: true } });
    await c.query('update comments set deleted_at = $2, deleted_by = $3 where id = $1', [commentId, clock.now(), actor.id]);
  });
}

/** ATT-01: files on the task itself; each gets an `attachment_added` log row with its name and hash. */
export async function addAttachments(actor: DirUser, taskId: number, files: PendingFile[]): Promise<number[]> {
  if (!files.length) throw invalid({ files: 'Choose at least one file.' });
  guardText(...files.map((f) => f.name)); // S-12: file names pass the sensitive-ID guard too
  const ids: number[] = [];
  await withCleanup((written) =>
    act(actor, taskId, 'attach', 'attach files', async ({ c, now }) => {
      for (const file of files) {
        const logId = await appendLog(c, { taskId, actorId: actor.id, kind: 'attachment_added', after: { name: file.name, size: file.size, sha256: file.sha256, mime: file.mime } });
        ids.push(await storeAttachment(c, { taskId, logId, actor, file, now, context: 'task', written }));
      }
    }),
  );
  return ids;
}

/** ATT-03: hidden from the task, never deleted (D-31); the uploader or someone overseeing the task, while it is open. */
export async function removeAttachment(actor: DirUser, attachmentId: number): Promise<number> {
  const dir = await getDirectory(actor.organizationId);
  return tx(async (c) => {
    const { rows } = await c.query('select * from attachments where id = $1 and removed_at is null', [attachmentId]);
    if (!rows[0]) throw notFound('Attachment not found.');
    const t = await lockTask(c, rows[0].task_id, actor, dir, 'Attachment not found.');
    if (!isOpenStatus(t.status)) throw forbidden(`You can't remove files on ${ref(t.id)} in its current state.`);
    // D-33 (KI-40): like attaching, a supervisor must also hold create_tasks, so a read-only senior cannot remove files.
    if (rows[0].uploaded_by !== actor.id && !(isOverseerOf(actor, t, dir) && can(actor, dir, 'create_tasks'))) throw forbidden('Only the uploader or a task supervisor can remove this file.');
    await appendLog(c, { taskId: t.id, actorId: actor.id, kind: 'attachment_removed', before: { attachmentId, name: rows[0].file_name, sha256: rows[0].sha256 } });
    await c.query('update attachments set removed_at = $2, removed_by = $3 where id = $1', [attachmentId, clock.now(), actor.id]);
    return t.id;
  });
}
