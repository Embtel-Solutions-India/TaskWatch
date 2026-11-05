import { HOUR } from '../constants';
import { now } from '../services/mock/store';

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = JSON.stringify(opts);
  let f = cache.get(k);
  if (!f) cache.set(k, (f = new Intl.DateTimeFormat('en-US', opts)));
  return f;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return fmt({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function formatShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  return fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return fmt({ month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

export function hoursLabel(hours: number): string {
  const h = Math.abs(hours);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.floor(h)} h${h % 1 >= 0.5 && h < 10 ? ' 30 m' : ''}`;
  const d = Math.floor(h / 24);
  const r = Math.floor(h % 24);
  return r ? `${d} d ${r} h` : `${d} d`;
}

/** "3 h ago" / "in 2 d", relative to the (possibly simulated) demo clock. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = (Date.parse(iso) - now()) / HOUR;
  if (Math.abs(diff) < 1 / 60) return 'just now';
  return diff < 0 ? `${hoursLabel(-diff)} ago` : `in ${hoursLabel(diff)}`;
}

export function dueLabel(iso: string): { text: string; overdue: boolean; soon: boolean } {
  const diff = (Date.parse(iso) - now()) / HOUR;
  if (diff < 0) return { text: `${hoursLabel(-diff)} overdue`, overdue: true, soon: false };
  return { text: `due in ${hoursLabel(diff)}`, overdue: false, soon: diff < 24 };
}

export function pct(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Date input value (local) for a timestamp. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function toTimeInput(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Download rows as a real CSV file. */
export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const esc = (v: string | number | null | undefined) => {
    const raw = v === null || v === undefined ? '' : String(v);
    const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
