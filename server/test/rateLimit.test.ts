// Pure tests for the fixed-window rate limiter (T-1.13, D-82). No database, fake clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/http/errors.js';
import { errorHandler } from '../src/http/middleware.js';
import { rateLimit } from '../src/http/rateLimit.js';

let t = 1_000_000;
const limit = rateLimit({ max: 3, windowMs: 60_000, key: (req: any) => req.k, now: () => t });

/** One request through the limiter: 'ok', or the 429 status + Retry-After + body it would send. */
function hit(k: string | undefined): 'ok' | { status: number; retryAfter: string; body: unknown } {
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (n: string, v: string) => (headers[n] = v) };
  try {
    let passed = false;
    limit({ k } as any, res, () => (passed = true));
    assert.ok(passed);
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof HttpError);
    const out: any = {};
    const res2: any = { setHeader: (n: string, v: string) => (headers[n] = v), status: (s: number) => ((out.status = s), { json: (b: unknown) => (out.body = b) }) };
    errorHandler(err, {} as any, res2, () => {});
    out.retryAfter = headers['Retry-After'];
    return out;
  }
}

describe('rate limit', () => {
  it('allows max requests per window, then 429 with Retry-After and the usual envelope', () => {
    assert.deepEqual([hit('a'), hit('a'), hit('a')], ['ok', 'ok', 'ok']);
    t += 15_000;
    assert.deepEqual(hit('a'), { status: 429, retryAfter: '45', body: { error: 'Too many requests. Please wait and try again.' } });
  });

  it('keys are independent; an undefined key is never counted', () => {
    assert.equal(hit('b'), 'ok');
    for (let i = 0; i < 10; i++) assert.equal(hit(undefined), 'ok');
  });

  it('a new window starts once the old one has passed', () => {
    t += 45_000;
    assert.equal(hit('a'), 'ok');
  });
});
