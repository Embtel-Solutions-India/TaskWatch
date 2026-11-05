import { DateTime } from 'luxon';

/** Short zone label used across TaskWatch: IST, PT, or a UTC offset. */
export function zoneLabel(timeZone: string, at: Date = new Date()): string {
  if (timeZone === 'Asia/Kolkata') return 'IST';
  if (timeZone === 'America/Los_Angeles') return 'PT';
  return DateTime.fromJSDate(at, { zone: timeZone }).toFormat('ZZZZ');
}

export function formatInZone(at: Date, timeZone: string): string {
  return `${DateTime.fromJSDate(at, { zone: timeZone }).toFormat('ccc d LLL, h:mm a')} ${zoneLabel(timeZone, at)}`;
}
