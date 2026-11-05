import type { RulesConfig } from '../domain.js';
import type { Directory, DirUser } from '../services/directory.js';
import { hasRole } from '../services/directory.js';

/** The assignee's team lead: the nearest lead above them, below any manager or the Founder's Office. */
export function findLead(dir: Directory, assigneeId: number): DirUser | null {
  for (const a of dir.ancestors(assigneeId)) {
    if (hasRole(a, 'lead')) {
      if (a.active) return a;
      continue;
    }
    if (hasRole(a, 'manager', 'cos', 'ceo')) return null;
  }
  return null;
}

/** The assignee's manager: the nearest manager above them, below the Founder's Office. */
export function findManager(dir: Directory, assigneeId: number): DirUser | null {
  for (const a of dir.ancestors(assigneeId)) {
    if (hasRole(a, 'manager')) {
      if (a.active) return a;
      continue;
    }
    if (hasRole(a, 'cos', 'ceo')) return null;
  }
  return null;
}

/**
 * Founder's Office recipients: every active Chief of Staff, plus the CEO when decision D7 says so (or when there is
 * no Chief of Staff). A lower level that falls through to the Founder's Office routes the same way (D-28).
 */
export function founderOffice(dir: Directory, cfg: RulesConfig): DirUser[] {
  const cos = dir.withRole('cos');
  const ceo = cfg.l3NotifyCeo || cos.length === 0 ? dir.withRole('ceo') : [];
  return dedupe([...cos, ...ceo]);
}

function dedupe(users: DirUser[]): DirUser[] {
  const seen = new Set<number>();
  return users.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
}

export interface Route {
  to: number[];
  cc: number[];
}

/**
 * Who an escalation at a given level reaches. A level with no one in the role escalates
 * straight to the next existing level (work order: "Users, roles and visibility").
 */
export function routeEscalation(dir: Directory, assigneeId: number, level: number, cfg: RulesConfig): Route {
  const assignee = dir.must(assigneeId);
  const lead = findLead(dir, assigneeId);
  const manager = findManager(dir, assigneeId);
  const fo = founderOffice(dir, cfg);

  let to: DirUser[] = [];
  let cc: DirUser[] = [];
  switch (level) {
    case 0:
      to = [assignee];
      break;
    case 1:
      to = lead ? [lead] : manager ? [manager] : fo;
      cc = [assignee];
      break;
    case 2:
      to = manager ? [manager] : fo;
      cc = [...(lead ? [lead] : []), assignee];
      break;
    default:
      to = fo;
      cc = manager ? [manager] : [];
  }
  const toIds = dedupe(to).map((u) => u.id);
  const ccIds = dedupe(cc)
    .map((u) => u.id)
    .filter((id) => !toIds.includes(id));
  return { to: toIds, cc: ccIds };
}
