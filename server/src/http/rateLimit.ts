import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors.js';

interface Options {
  max: number;
  windowMs: number;
  /** Bucket key for this request, or undefined to let it through uncounted. */
  key: (req: Request) => string | undefined;
  /** Real time, not the demo clock: limits are about actual request rates. Injectable for tests. */
  now?: () => number;
}

/**
 * Fixed-window rate limit (SECURITY_ARCHITECTURE §6). Over the limit → 429 with Retry-After.
 * ponytail: per-process memory; correct for the single-instance deployment. Move the counts to a
 * Postgres table if TaskWatch ever runs more than one instance (SCALABILITY_AND_RELIABILITY §1).
 */
export function rateLimit({ max, windowMs, key, now = Date.now }: Options) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const k = key(req);
    if (k === undefined) return next();
    const t = now();
    let h = hits.get(k);
    if (!h || h.resetAt <= t) {
      if (hits.size >= 10_000) for (const [old, v] of hits) if (v.resetAt <= t) hits.delete(old);
      h = { count: 0, resetAt: t + windowMs };
      hits.set(k, h);
    }
    if (++h.count > max) {
      throw new HttpError(429, 'Too many requests. Please wait and try again.', undefined, Math.ceil((h.resetAt - t) / 1000));
    }
    next();
  };
}
