// ADR-0015 attendance (D-156…D-163). Server mode only: the prototype has no attendance.
import { http } from '../http';

export type AttendanceStatus = 'present' | 'absent' | 'half_day' | 'leave' | 'unmarked';
export interface AttendanceDay {
  userId: number;
  day: string;
  status: AttendanceStatus;
  awayFrom: string | null;
  awayTo: string | null;
}
export interface AttendanceList {
  /** Today in the members' vertical zone. */
  today: string;
  people: { id: number; name: string; teamId: number | null; entityId: string }[];
  days: AttendanceDay[];
}
export interface MarkInput {
  userIds: number[];
  from: string;
  to: string;
  status: AttendanceStatus;
  /** Half day: away in the morning (start of work to lunch) or the afternoon (lunch to the end); the GM picks. */
  half?: 'first' | 'second';
  /** Never overwrite a day that already has a mark. */
  onlyUnmarked?: boolean;
}

export const STATUS_LABEL: Record<AttendanceStatus, string> = { present: 'Present', absent: 'Absent', half_day: 'Half day', leave: 'Leave', unmarked: 'Not marked' };
/** D-157: a day nobody marked shows as absent (with its own look, so the GM sees the gap). */
export const STATUS_TONE: Record<AttendanceStatus, 'ok' | 'danger' | 'warn' | 'info' | 'muted'> = { present: 'ok', absent: 'danger', half_day: 'warn', leave: 'info', unmarked: 'muted' };

export function listAttendance(q: { from: string; to: string; teamId?: string; userId?: string; status?: string }): Promise<AttendanceList> {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => !!v) as [string, string][]);
  return http('GET', `/attendance?${p}`);
}
export const markAttendance = (m: MarkInput): Promise<{ updated: number }> => http('PUT', '/attendance', m);
export const myAttendance = (month: string): Promise<{ days: Omit<AttendanceDay, 'userId'>[] }> => http('GET', `/attendance/me?month=${month}`);

/** "YYYY-MM-DD" today in a time zone. */
export const todayIn = (zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
