// Work order, "Client data": task titles may name clients, but no passport numbers,
// A-numbers or other ID numbers in task text. Link the case in ImmigrationCRM instead.

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bA[-\s]?\d{3}[-\s]?\d{3}[-\s]?\d{3}\b/i, label: 'an A-number' },
  { re: /\bA\d{8}\b/i, label: 'an A-number' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, label: 'a Social Security number' },
  { re: /\b(EAC|WAC|LIN|SRC|NBC|MSC|IOE|YSC)\d{10}\b/i, label: 'a USCIS receipt number' },
  { re: /\bpassport\b[^.\n]{0,24}?\b[A-Z]{0,2}\d{6,9}\b/i, label: 'a passport number' },
  { re: /\bI-?94\b[^.\n]{0,24}?\b\d{9,11}[A-Z]?\d?\b/i, label: 'an I-94 number' },
];

/** Returns a description of the first ID number found, or null if the text is clean. */
export function findSensitiveId(text: string): string | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.label;
  return null;
}
