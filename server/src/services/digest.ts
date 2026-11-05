import { DateTime } from 'luxon';
import * as clock from '../clock.js';
import { HOUR } from '../clock.js';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { formatHours, LEVEL_LABELS, openSql } from '../domain.js';
import { emailHtml } from '../notify/channels.js';
import { notify } from '../notify/notify.js';
import { visibilityFilter } from './access.js';
import { getDirectory, hasRole, type Directory, type DirUser } from './directory.js';
import { organizationIds } from './organizations.js';
import { getRuleSet } from './rules.js';
import { getSettings } from './settings.js';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface DigestData {
  red: Array<{ id: number; title: string; assignee: string; entity: string; level: number; silentHours: number }>;
  offenders: Array<{ name: string; count: number }>;
  trend: Array<{ week: string; closed: number; onTime: number }>;
}

async function digestData(viewer: DirUser, dir: Directory, now: Date): Promise<DigestData> {
  const vis = visibilityFilter(viewer, dir, 't', 1);
  const n = vis.params.length;
  const red = await pool.query(
    `select t.id, t.title, a.name as assignee, t.entity_id as entity, t.level, t.clock_started_at
       from tasks t join users a on a.id = t.assignee_id
      where ${vis.sql} and ${openSql('t')} and t.level >= 2 order by t.level desc, t.clock_started_at limit 25`,
    vis.params,
  );
  const offenders = await pool.query(
    `select a.name, count(*) as count from escalations e
       join tasks t on t.id = e.task_id join users a on a.id = e.assignee_id
      where ${vis.sql} and e.level >= 1 and e.fired_at >= $${n + 1}
      group by a.name having count(*) >= 2 order by count desc, a.name limit 10`,
    [...vis.params, new Date(now.getTime() - 7 * 24 * HOUR)],
  );
  const trend: DigestData['trend'] = [];
  for (let w = 3; w >= 0; w--) {
    const end = new Date(now.getTime() - w * 7 * 24 * HOUR);
    const start = new Date(end.getTime() - 7 * 24 * HOUR);
    const { rows } = await pool.query(
      `select count(*) as closed, count(*) filter (where t.closed_at <= t.due_at) as on_time
         from tasks t where ${vis.sql} and t.status = 'completed' and t.closed_at > $${n + 1} and t.closed_at <= $${n + 2}`,
      [...vis.params, start, end],
    );
    trend.push({
      week: DateTime.fromJSDate(start, { zone: viewer.timeZone }).toFormat('d LLL'),
      closed: rows[0].closed,
      onTime: rows[0].on_time,
    });
  }
  return {
    red: red.rows.map((r) => ({ ...r, silentHours: (now.getTime() - r.clock_started_at.getTime()) / HOUR })),
    offenders: offenders.rows,
    trend,
  };
}

function digestHtml(viewer: DirUser, d: DigestData): string {
  const td = 'style="padding:6px 8px;border-bottom:1px solid #e5e7eb"';
  const th = 'style="padding:6px 8px;border-bottom:2px solid #cbd5e1;text-align:left"';
  const red = d.red.length
    ? `<table style="border-collapse:collapse;width:100%;font-size:13px"><tr><th ${th}>Task</th><th ${th}>Assignee</th><th ${th}>Level</th><th ${th}>Silent</th></tr>${d.red
        .map(
          (r) =>
            `<tr><td ${td}><a href="${config.appUrl}/tasks/${r.id}">${esc(r.title)}</a> <span style="color:#6b7280">${r.entity}</span></td><td ${td}>${esc(r.assignee)}</td><td ${td}>${LEVEL_LABELS[r.level]}</td><td ${td}>${formatHours(r.silentHours)}</td></tr>`,
        )
        .join('')}</table>`
    : '<p>No red items. 🎉</p>';
  const offenders = d.offenders.length
    ? `<ul>${d.offenders.map((o) => `<li>${esc(o.name)} — ${o.count} escalations in 7 days</li>`).join('')}</ul>`
    : '<p>No one was escalated more than once this week.</p>';
  const trend = `<table style="border-collapse:collapse;font-size:13px"><tr><th ${th}>Week of</th><th ${th}>Closed</th><th ${th}>On time</th></tr>${d.trend
    .map((w) => `<tr><td ${td}>${w.week}</td><td ${td}>${w.closed}</td><td ${td}>${w.closed ? Math.round((w.onTime / w.closed) * 100) + '%' : '—'}</td></tr>`)
    .join('')}</table>`;
  const intro = emailHtml(`Good morning ${viewer.name.split(' ')[0]}, here is this week's TaskWatch summary.`, null);
  return `${intro}<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;max-width:640px">
    <h3 style="margin:20px 0 8px">Red items (${d.red.length})</h3>${red}
    <h3 style="margin:20px 0 8px">Repeat offenders</h3>${offenders}
    <h3 style="margin:20px 0 8px">On-time trend</h3>${trend}
    <p style="margin-top:20px"><a href="${config.appUrl}/dashboard">Open the accountability dashboard</a></p></div>`;
}

/** Who receives the digest: active people holding manager, CoS or CEO (any of their roles, D-8). */
export const isDigestRecipient = (u: DirUser) => u.active && hasRole(u, 'manager', 'cos', 'ceo');

/** FR-12: email to each manager and the Founder's Office of one organization (or to one of them). */
export async function sendWeeklyDigest(org: number, onlyUserId?: number): Promise<number> {
  const now = clock.now();
  const dir = await getDirectory(org);
  const rules = (await getRuleSet(org)).defaults;
  const recipients = dir.all().filter((u) => isDigestRecipient(u) && (!onlyUserId || u.id === onlyUserId));
  for (const u of recipients) {
    const html = digestHtml(u, await digestData(u, dir, now));
    await tx((c) =>
      notify(c, dir, rules, [{ userId: u.id }], () => ({
        event: 'digest',
        subject: `TaskWatch weekly digest — ${DateTime.fromJSDate(now, { zone: config.digestTimeZone }).toFormat('d LLL yyyy')}`,
        text: 'Weekly digest',
        template: '',
        params: [],
        taskId: null,
        quietable: false,
        html,
      })),
    );
  }
  return recipients.length;
}

/**
 * Called every minute; sends once per ISO week per organization, on its digest day at or after its hour, in IST
 * (WO FR-12 Monday 09:00; D-44 keeps the Settings fields as an override, 0 = Sunday).
 */
export async function maybeRunDigest(): Promise<void> {
  const local = DateTime.fromJSDate(clock.now(), { zone: config.digestTimeZone });
  const week = `${local.weekYear}-W${String(local.weekNumber).padStart(2, '0')}`;
  for (const org of await organizationIds()) {
    const s = await getSettings(org);
    if (local.weekday !== (s.digestDay || 7) || local.hour < s.digestHour) continue;
    const { rowCount } = await pool.query(
      `insert into job_runs (job, run_key, ran_at) values ('weekly_digest', $1, $2) on conflict do nothing`,
      [`${week}:${org}`, clock.now()],
    );
    if (rowCount) await sendWeeklyDigest(org);
  }
}
