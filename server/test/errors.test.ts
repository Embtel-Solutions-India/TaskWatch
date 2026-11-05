// Pure tests for the API error envelope (T-1.11; docs/04-engineering-standards/ERROR_HANDLING.md). No database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { HttpError, invalid, notFound } from '../src/http/errors.js';
import { errorHandler } from '../src/http/middleware.js';

/** Run the handler on `err` and capture what it sends. */
function handle(err: unknown): { status: number; body: any } {
  const out = { status: 0, body: undefined as any };
  const res: any = {
    status(s: number) {
      out.status = s;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  errorHandler(err, {} as any, res, () => {});
  return out;
}

const pgError = (code: string) => Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code, detail: 'Key (email)=(a@b.c) already exists.' });

describe('error envelope', () => {
  it('zod errors → 422 with one message per field, first one as the summary', () => {
    const schema = z.object({ title: z.string().min(4), priority: z.enum(['high', 'low']), nested: z.object({ n: z.number() }) }).strict();
    const r = schema.safeParse({ title: 'ab', priority: 'x', nested: { n: 'y' }, extra: 1 });
    assert.equal(r.success, false);
    const { status, body } = handle(r.error);
    assert.equal(status, 422);
    assert.deepEqual(Object.keys(body.fields).sort(), ['_', 'nested.n', 'priority', 'title']);
    assert.equal(body.error, body.fields.title);
  });

  it('invalid() → 422 with the given fields; plain HttpError keeps its status and has no fields', () => {
    assert.deepEqual(handle(invalid({ reason: 'Give a reason.' })), { status: 422, body: { error: 'Give a reason.', fields: { reason: 'Give a reason.' } } });
    assert.deepEqual(handle(notFound()), { status: 404, body: { error: 'Not found' } });
    assert.deepEqual(handle(new HttpError(409, 'Already decided')), { status: 409, body: { error: 'Already decided' } });
  });

  it('Postgres constraint errors map to 409/422 without echoing the constraint or value (S-8)', () => {
    for (const [code, status] of [['23505', 409], ['23503', 422], ['23514', 422]] as const) {
      const { status: s, body } = handle(pgError(code));
      assert.equal(s, status, code);
      assert.deepEqual(Object.keys(body), ['error']);
      assert.doesNotMatch(body.error, /users_email_key|a@b\.c|duplicate key/);
    }
  });

  it('malformed JSON → 400; oversize upload → 413', () => {
    assert.equal(handle(Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed' })).status, 400);
    assert.equal(handle({ code: 'LIMIT_FILE_SIZE' }).status, 413);
  });

  it('anything else → 500 with a generic message and no stack trace', () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      for (const err of [new Error('boom at /srv/secret/path.ts:12'), Object.assign(new Error('forbidden'), { code: 'P0001' })]) {
        const { status, body } = handle(err);
        assert.equal(status, 500);
        assert.deepEqual(body, { error: 'Something went wrong on the server' });
      }
    } finally {
      console.error = quiet;
    }
  });
});
