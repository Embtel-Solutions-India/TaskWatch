// GET /api/me bootstrap (T-1.15, AUTH-06; API_CONTRACTS): everything the client needs on load, scoped to the caller.
import type { Permission } from '@taskwatch/shared/permissions';
import * as clock from '../clock.js';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { zoneLabel } from '../notify/format.js';
import { visibilityFilter } from './access.js';
import { hasRole, type Directory, type DirUser } from './directory.js';
import { effectivePermissions, getRoleMatrix } from './permissions.js';
import { getOrganization } from './organizations.js';
import { getRuleSet } from './rules.js';
import { getSettings } from './settings.js';

/** Nav badge counts, scoped exactly like the task lists (visibilityFilter). */
async function badges(user: DirUser, dir: Directory, perms: Permission[]) {
  // $1 is the caller; the visibility parameters follow. Every query uses both, so no parameter is left unbound.
  const v = visibilityFilter(user, dir, 't', 2);
  const count = async (sql: string) => (await pool.query<{ n: number }>(sql, [user.id, ...v.params])).rows[0]!.n;
  const isCos = hasRole(user, 'cos') ? 'true' : 'false'; // server-computed boolean literal, never input
  const [unread, escalations, reviews, extensions] = await Promise.all([
    pool.query<{ n: number }>(`select count(*)::int n from notifications where user_id = $1 and channel = 'inapp' and read_at is null`, [user.id]).then((r) => r.rows[0]!.n),
    // Tasks escalated to L1+ that nobody has acknowledged; the CoS also counts their own.
    count(`select count(distinct e.task_id)::int n from escalations e join tasks t on t.id = e.task_id
           where e.cleared_at is null and e.acknowledged_at is null and e.level >= 1 and (t.assignee_id <> $1 or ${isCos}) and ${v.sql}`),
    perms.includes('review_tasks')
      ? count(`select count(*)::int n from reviews r join tasks t on t.id = r.task_id where r.decision is null and t.assignee_id <> $1 and ${v.sql}`)
      : 0,
    perms.includes('approve_extensions')
      ? count(`select count(*)::int n from extensions x join tasks t on t.id = x.task_id where x.status = 'pending' and x.requested_by <> $1 and ${v.sql}`)
      : 0,
  ]);
  return { unread, escalations, reviews, extensions };
}

export async function bootstrap(user: DirUser, dir: Directory) {
  const [matrix, settings, ruleSet, organization, names] = await Promise.all([
    getRoleMatrix(user.organizationId),
    getSettings(user.organizationId),
    getRuleSet(user.organizationId),
    getOrganization(user.organizationId),
    pool.query<{ entity: string | null; team: { id: number; name: string } | null }>(
      `select (select name from entities where id = $1) entity, (select json_build_object('id', id, 'name', name) from teams where id = $2) team`,
      [user.entityId, user.teamId],
    ),
  ]);
  const permissions = effectivePermissions(user, matrix);
  const manager = user.managerId ? dir.get(user.managerId) : null;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      title: user.title,
      roles: user.roles,
      entityId: user.entityId,
      entityName: names.rows[0]?.entity ?? null,
      team: names.rows[0]?.team ?? null,
      timezone: user.timeZone,
      zone: zoneLabel(user.timeZone),
      manager: manager ? { id: manager.id, name: manager.name } : null,
    },
    organization, // ADR-0010: no picker; one organization per user (D-96)
    permissions,
    settings: {
      orgName: settings.orgName,
      timezone: settings.timezone,
      categories: settings.categories,
      sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
      workdayStart: settings.workdayStart,
      workdayEnd: settings.workdayEnd,
    },
    rules: ruleSet.for(user.entityId),
    badges: await badges(user, dir, permissions),
    integrations: { google: config.google.enabled, whatsapp: config.whatsapp.enabled, email: config.smtp.enabled, devLogin: config.devLogin },
    demo: config.demoTools ? { offsetHours: Math.round((clock.getOffsetMs() / 3_600_000) * 100) / 100 } : null,
    serverTime: clock.now(),
  };
}
