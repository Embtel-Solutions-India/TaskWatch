export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Per-field messages; the UI shows these inline next to the inputs (422 only). */
    readonly fields?: Record<string, string>,
    /** For 429: sent as the Retry-After header. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** 422 with field messages; the first message doubles as the summary. */
export const invalid = (fields: Record<string, string>) =>
  new HttpError(422, Object.values(fields)[0] ?? 'Please fix the highlighted fields', fields);
export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
