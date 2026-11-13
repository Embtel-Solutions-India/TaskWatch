// Branded HTML email (design refs: Welcome, Task Assigned, Overdue Alert, Task Updated). Email-client safe:
// tables + inline styles only, no SVG, no external images, no web fonts.
import { config } from '../config.js';
import { formatHours, PRIORITY_LABELS, STATUS_LABELS, type Priority, type Status } from '../domain.js';
import { formatInZone } from './format.js';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Tone = 'blue' | 'red' | 'green' | 'amber';
const TONES: Record<Tone, { fg: string; soft: string; line: string }> = {
  blue: { fg: '#1a56db', soft: '#eef4ff', line: '#dbe4f3' },
  red: { fg: '#c0262d', soft: '#fdf1f1', line: '#f3cfd1' },
  green: { fg: '#167a43', soft: '#ecf8f0', line: '#d3ecdc' },
  amber: { fg: '#b45309', soft: '#fff6e8', line: '#f5dfbd' },
};
const INK = '#0f172a';
const MUTED = '#475569';
const FAINT = '#64748b';
// Inter, as in the app. Apple Mail / iOS / Outlook apps load the web font; Gmail and desktop Outlook ignore it and use the fallbacks.
const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const paragraphs = (text: string, style: string) =>
  esc(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;${style}">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

function pill(label: string, tone: Tone | 'grey', dot = false): string {
  const t = tone === 'grey' ? { fg: MUTED, soft: '#eef1f5' } : TONES[tone];
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${t.soft};color:${t.fg};font-size:13px;font-weight:600;white-space:nowrap">${dot ? '&#9679;&nbsp;' : ''}${esc(label)}</span>`;
}

function button(label: string, href: string, tone: Tone): string {
  const bg = tone === 'red' ? TONES.red.fg : '#0b4fd1';
  return `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;padding:13px 24px;border-radius:9px;text-decoration:none;font-weight:700;font-size:15px">${esc(label)}&nbsp;&rarr;</a>`;
}

export interface Layout {
  tone: Tone;
  badge?: string;
  /** Headline: plain lead-in, then the coloured words. */
  title: [string, string];
  intro?: string;
  /** Illustration beside the headline: notify/art/<name>.png, attached inline by sendEmail (clients strip inline SVG). */
  art?: 'checklist' | 'overdue' | 'attention' | 'updated';
  /** Pre-built (already escaped) HTML between intro and the buttons. */
  content?: string;
  cta?: { label: string; href: string };
  secondary?: { label: string; href: string };
}

/** The shared shell: logo + badge, headline, intro, content, buttons, footer. */
export function emailLayout(l: Layout): string {
  const t = TONES[l.tone];
  const badge = l.badge
    ? `<span style="display:inline-block;padding:7px 14px;border-radius:9px;background:${t.soft};color:${t.fg};font-size:13px;font-weight:600;white-space:nowrap">${esc(l.badge)}</span>`
    : '';
  const buttons = l.cta
    ? `<tr><td style="padding:28px 0 4px">${button(l.cta.label, l.cta.href, l.tone)}${
        l.secondary ? `<a href="${esc(l.secondary.href)}" style="display:inline-block;margin-left:22px;padding:13px 0;color:#1a56db;text-decoration:none;font-size:15px">${esc(l.secondary.label)}</a>` : ''
      }</td></tr>`
    : '';
  const sep = '&nbsp;&nbsp;&middot;&nbsp;&nbsp;';
  const footLink = (label: string, path: string) => `<a href="${config.appUrl}${path}" style="color:${MUTED};text-decoration:none">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet"><style>@media (max-width:520px){.tw-art{display:none!important}}</style></head>
<body style="margin:0;padding:0;background:#f4f6fa">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;font-family:${FONT};color:${INK}">
<tr><td style="padding:32px 32px 0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="vertical-align:middle"><img src="cid:tw-art-logo" width="170" height="36" alt="TaskWatch" style="display:block;width:170px;height:auto;border:0;font-size:22px;font-weight:800;color:${INK}"></td>
    <td align="right" style="vertical-align:middle">${badge}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:28px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="vertical-align:middle">
  <h1 style="margin:0 0 12px;font-size:30px;line-height:1.2;font-weight:800;letter-spacing:-0.6px;color:${INK}">${esc(l.title[0])}<span style="color:${t.fg}">${esc(l.title[1])}</span></h1>
  ${l.intro ? paragraphs(l.intro, `font-size:16px;line-height:1.55;color:${MUTED}`) : ''}
  </td>
  ${l.art ? `<td class="tw-art" width="170" style="width:170px;padding-left:12px;vertical-align:middle"><img src="cid:tw-art-${l.art}" width="170" height="145" alt="" style="display:block;width:170px;height:auto;border:0"></td>` : ''}
</tr></table></td></tr>
<tr><td style="padding:12px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${l.content ? `<tr><td>${l.content}</td></tr>` : ''}
  ${buttons}
</table></td></tr>
<tr><td style="padding:28px 32px 32px">
  <div style="border-top:1px solid #e5e9f0;padding-top:20px;font-size:13px;line-height:1.6;color:${FAINT}">
    ${footLink('Email preferences', '/settings/account')}${sep}${footLink('Log in to TaskWatch', '/')}
    <div style="margin-top:12px">TaskWatch &middot; A product of Embtel Solutions Inc</div>
  </div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** Plain message in the shell: account emails, system alerts, and the fallback for anything without a task. */
export function emailHtml(body: string, link: string | null, linkLabel = 'Open TaskWatch', heading = ''): string {
  return emailLayout({
    tone: 'blue',
    title: [heading, ''],
    content: paragraphs(body, `font-size:16px;line-height:1.55;color:${MUTED}`),
    cta: link ? { label: linkLabel, href: link } : undefined,
  });
}

/** A tinted note box: "What you need to do", "Action required", "Update note". */
function callout(tone: Tone, icon: string, heading: string, text: string, italic = false): string {
  const t = TONES[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:${t.soft};border-radius:12px"><tr>
    <td style="width:28px;padding:18px 0 18px 20px;vertical-align:top;color:${t.fg};font-size:20px;line-height:22px">${icon}</td>
    <td style="padding:18px 20px 18px 12px;vertical-align:top">
      <div style="font-size:16px;font-weight:700;color:${t.fg};margin-bottom:4px">${esc(heading)}</div>
      <div style="font-size:15px;line-height:1.55;color:${MUTED}${italic ? ';font-style:italic' : ''}">${esc(text).replace(/\n/g, '<br>')}</div>
    </td></tr></table>`;
}

export interface TaskContext {
  id: number;
  title: string;
  entity: string;
  priority: Priority;
  status: Status;
  dueAt: Date;
  level: number;
  assignee: string;
  assigneeId: number;
  assigner: string;
  description: string;
  recipientId: number;
  timeZone: string;
}

/** The task card: icon, title, TW-id · entity, a pill, then a row of label/value cells. */
function taskCard(t: TaskContext, tone: Tone, corner: string, cells: [string, string][]): string {
  const c = TONES[tone];
  const cellHtml = cells
    .map(
      ([label, value], i) =>
        `<td style="padding:14px 12px;vertical-align:top;${i ? `border-left:1px solid ${c.line};` : ''}">
          <div style="font-size:12px;color:${FAINT};margin-bottom:3px">${esc(label)}</div>
          <div style="font-size:14px;font-weight:700;color:${INK}">${value}</div></td>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border:1px solid ${c.line};border-radius:14px;background:${tone === 'red' ? '#fffafa' : '#fbfcfe'}">
    <tr><td style="padding:18px 18px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:48px;vertical-align:top"><div style="width:44px;height:44px;border-radius:11px;background:${c.soft};text-align:center;line-height:44px;font-size:20px">&#128203;</div></td>
      <td style="padding-left:12px;vertical-align:top">
        <div style="font-size:18px;font-weight:800;line-height:1.3;color:${INK}">${esc(t.title)}</div>
        <div style="font-size:14px;color:${MUTED};margin-top:3px">TW-${t.id}&nbsp;&middot;&nbsp;${esc(t.entity)}</div>
      </td>
      <td align="right" style="vertical-align:top;padding-left:8px">${corner}</td>
    </tr></table></td></tr>
    <tr><td style="padding:0 6px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${c.line}"><tr>${cellHtml}</tr></table></td></tr>
  </table>`;
}

const priorityTone = (p: Priority): Tone => (p === 'critical' || p === 'high' ? 'red' : p === 'normal' ? 'blue' : 'green');

const UPDATE_TITLES: Record<string, [string, string, string]> = {
  // event: [lead-in, highlight, badge]
  completed: ['A task is ', 'done', 'Task Done'],
  progress: ['A task has been ', 'updated', 'Task Updated'],
  comment: ['New ', 'comment', 'New Comment'],
  mention: ['You were ', 'mentioned', 'Mention'],
  review_required: ['A task needs your ', 'review', 'Review Needed'],
  review_r1: ['A review is ', 'overdue', 'Review Overdue'],
  review_r2: ['A review is ', 'still pending', 'Review Pending'],
  review_decision: ['Your task was ', 'reviewed', 'Review Decision'],
  due_change: ['A due date has ', 'changed', 'Due Date Changed'],
  reassigned: ['A task was ', 'reassigned', 'Task Reassigned'],
  cancelled: ['A task was ', 'cancelled', 'Task Cancelled'],
  reopened: ['A task was ', 'reopened', 'Task Reopened'],
  extension_requested: ['An extension was ', 'requested', 'Extension Request'],
  extension_decided: ['Your extension was ', 'decided', 'Extension Decision'],
  escalation_ack: ['An escalation was ', 'acknowledged', 'Acknowledged'],
  start_notice: ['A task ', 'starts soon', 'Starting Soon'],
  due_soon: ['A task is ', 'due soon', 'Due Soon'],
  deadline_warning: ['10 minutes ', 'left', 'Deadline Warning'],
};

/**
 * Pick the design for a task notification. `body` is the stored alert text (shown as the note);
 * `now` decides whether an escalation is about lateness (overdue design) or silence.
 */
export function taskEmail(event: string, t: TaskContext, body: string, link: string, now: Date): string {
  const due = formatInZone(t.dueAt, t.timeZone);
  const priority = PRIORITY_LABELS[t.priority];
  const status = STATUS_LABELS[t.status] ?? t.status;
  const secondary = { label: 'View my tasks', href: `${config.appUrl}/tasks/mine` };
  const priorityPill = pill(priority, priorityTone(t.priority));

  if ((event === 'assigned' || event === 'reassigned') && t.recipientId === t.assigneeId) {
    return emailLayout({
      tone: 'blue',
      badge: event === 'assigned' ? 'Task Assigned' : 'Task Reassigned',
      art: 'checklist',
      title: event === 'assigned' ? ["You've been assigned a ", 'new task'] : ['A task was ', 'reassigned to you'],
      intro: 'A task has been assigned to you in TaskWatch. Review the details below and post your first update — only your updates reset the update clock.',
      content:
        taskCard(t, 'blue', pill(priority, priorityTone(t.priority), true), [
          ['Due date', esc(due)],
          ['Assigned by', esc(t.assigner)],
          ['Status', pill(status, 'blue')],
        ]) + (t.description ? callout('blue', '&#9432;', 'What you need to do', t.description.slice(0, 600)) : ''),
      cta: { label: 'Open Task in TaskWatch', href: link },
      secondary,
    });
  }

  const ladder = /^L[0-3]$/.test(event) || event === 'repeat';
  if (ladder || event === 'blocked') {
    const overdueMs = now.getTime() - t.dueAt.getTime();
    const late = overdueMs > 0 && event !== 'blocked' && t.level >= 1;
    const reminder = ladder && t.level <= 0;
    const tone: Tone = reminder || event === 'blocked' ? 'amber' : 'red';
    const title: [string, string] = late
      ? ['A task is now ', 'overdue']
      : event === 'blocked'
        ? ['A task is ', 'blocked']
        : reminder
          ? ['An update is ', 'needed']
          : ['A task has been ', `escalated to L${t.level}`];
    const cells: [string, string][] = [['Due date', esc(due)]];
    if (late) cells.push(['Overdue by', `<span style="color:${TONES.red.fg}">${esc(formatHours(overdueMs / 3_600_000))}</span>`]);
    cells.push(['Assigned to', esc(t.assignee)]);
    if (!late) cells.push(['Status', pill(status, tone)]);
    return emailLayout({
      tone,
      art: tone === 'red' ? 'overdue' : 'attention',
      badge: late ? 'Overdue Alert' : event === 'blocked' ? 'Task Blocked' : reminder ? 'Update Reminder' : `Escalation L${t.level}`,
      title,
      intro: late
        ? 'The following task has passed its due date and requires your immediate attention.'
        : reminder
          ? 'This task has gone quiet. Post an update so the escalation clock resets.'
          : 'The following task needs attention.',
      content: taskCard(t, tone, priorityPill, cells) + callout(tone, '&#9888;', 'Action required', body),
      cta: { label: 'Update Task in TaskWatch', href: link },
      secondary,
    });
  }

  const [lead, hl, badge] = UPDATE_TITLES[event] ?? ['A task has been ', 'updated', 'Task Updated'];
  return emailLayout({
    tone: 'green',
    badge,
    art: 'updated',
    title: [lead, hl],
    intro: 'There is a new update on a task you are involved in.',
    content:
      taskCard(t, 'blue', pill(status, 'blue', true), [
        ['Due date', esc(due)],
        ['Assigned to', esc(t.assignee)],
        ['Priority', priorityPill],
      ]) + callout('blue', '&#128172;', 'Update note', body, true),
    cta: { label: 'View Task in TaskWatch', href: link },
    secondary,
  });
}

/** D-172: the onboarding email, sent from the Staff page. With `setPasswordLink`, its button sets the first password. */
export function welcomeEmail(name: string, setPasswordLink?: string): string {
  return emailLayout({
    tone: 'blue',
    title: ['Welcome, ', `${name.split(' ')[0]}!`],
    art: 'checklist',
    intro:
      'TaskWatch helps teams turn work into clear ownership, track progress in real time, and make sure nothing falls through the cracks. We’re excited to have you on board.',
    content: `<div style="border-top:1px solid #e5e9f0;margin-top:12px;padding-top:24px">
      <h2 style="margin:0 0 10px;font-size:22px;font-weight:800;color:${INK}">Ready to get started?</h2>
      ${paragraphs(
        setPasswordLink
          ? 'Choose your password with the button below (the link works for 7 days), then sign in. Every task you receive has a due date and an update rhythm — post updates and TaskWatch keeps everyone in the loop.'
          : 'Sign in with your Google work account on the sign-in page. Every task you receive has a due date and an update rhythm — post updates and TaskWatch keeps everyone in the loop.',
        `font-size:16px;line-height:1.55;color:${MUTED}`,
      )}
    </div>`,
    cta: setPasswordLink ? { label: 'Set your password', href: setPasswordLink } : { label: 'Open TaskWatch', href: `${config.appUrl}/` },
  });
}
