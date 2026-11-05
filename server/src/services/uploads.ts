// Upload checks (T-4.11; ATT-01, D-13, D-69, S-4, SEC-8). The type comes from the file's own bytes, never from the
// request (ATT-01-AC-4); only the allow-listed kinds pass. No dependency: the signatures below cover the allow-list.
import crypto from 'node:crypto';
import { invalid } from '../http/errors.js';
import type { PendingFile } from './tasks.js';

const ext = (name: string) => name.toLowerCase().split('.').pop() ?? '';
const starts = (b: Buffer, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

const OOXML: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const OLE: Record<string, string> = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };

/** The detected MIME type of an allow-listed file, or null. Office files are ZIP/OLE containers, so the extension names which one. */
export function detectType(b: Buffer, name: string): string | null {
  const e = ext(name);
  if (starts(b, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'; // %PDF
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts(b, [0x50, 0x4b, 0x03, 0x04]) && OOXML[e]) return OOXML[e]!;
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0]) && OLE[e]) return OLE[e]!;
  // Text and CSV have no signature: accept valid UTF-8 without NUL bytes under those extensions.
  if ((e === 'txt' || e === 'csv') && !b.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b);
      return e === 'csv' ? 'text/csv' : 'text/plain';
    } catch {
      return null;
    }
  }
  return null;
}

/** Safe to show inline (ATT-02): images, PDF, plain text. Everything else is always a download. */
export const INLINE_SAFE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);

/** Multer memory files → checked PendingFiles. Size is capped by multer (15 MiB, 413). */
export function checkUploads(files: Express.Multer.File[] | undefined): PendingFile[] {
  return (files ?? []).map((f) => {
    const name = f.originalname.slice(0, 200);
    const mime = detectType(f.buffer, name);
    if (!mime) throw invalid({ files: `${name} is not an allowed file type (Office documents, PDF, images, text or CSV).` });
    return { name, mime, size: f.size, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), buffer: f.buffer };
  });
}
