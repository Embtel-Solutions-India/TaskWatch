// Authorization rules live in shared/permissions.ts (ADR-0004, ADR-0007), the code the server runs. This adapter
// maps the prototype's data (one `role` per user, string ids) onto it; UI guards and every mock API call use it.
import * as rules from '@taskwatch/shared/permissions';
import { isClosed as statusIsClosed } from '@taskwatch/shared/workflow';
import type { Db, Permission, Task, User } from '../../types';

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500;

/** Every API failure, mock or server: status, a message for the user, field messages (422), retry time (429). */
export class ApiError extends Error {
  constructor(
    public status: ApiStatus,
    message: string,
    public fields?: Record<string, string>,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

// ponytail: rebuilt on every call (31 people in the prototype); cache per store revision if it ever shows up in a profile.
const person = (u: User): rules.Person => ({ id: u.id, roles: [u.role], managerId: u.managerId, active: u.status === 'active' });
const org = (db: Db): rules.Org => ({ people: db.users.map(person), rolePermissions: db.rolePermissions });
const toUsers = (db: People, people: rules.Person[]): User[] => people.map((p) => db.users.find((u) => u.id === p.id)!);
/** Reporting-line questions need only the people; pages in server mode pass the people the API returned. */
type People = Pick<Db, 'users'>;
const tree = (db: People): rules.Org => ({ people: db.users.map(person), rolePermissions: rules.DEFAULT_ROLE_PERMISSIONS }); // matrix not consulted

export function hasPerm(db: Db, user: User | null | undefined, p: Permission): boolean {
  return rules.hasPerm(org(db), user ? person(user) : null, p);
}

export function assertPerm(db: Db, user: User, p: Permission, what = 'do that'): void {
  if (!hasPerm(db, user, p)) throw new ApiError(403, `You don't have permission to ${what}.`);
}

/** Everyone below `userId` in the reporting tree (transitive). */
export const reportsOf = (db: People, userId: string): Set<string> => rules.reportsOf(tree(db), userId);

/** The chain of managers above a user, nearest first. Stops on loops. */
export const ancestorsOf = (db: People, userId: string): User[] => toUsers(db, rules.ancestorsOf(tree(db), userId));

/** Would making `managerId` the manager of `userId` create a reporting loop? */
export const wouldCreateLoop = (db: People, userId: string, managerId: string | null): boolean => rules.wouldCreateLoop(tree(db), userId, managerId);

/** Users whose tasks this user may see beyond their own: all for the Founder's Office, else the reporting line. */
export function visibleUserIds(db: Db, user: User): Set<string> | 'all' {
  if (rules.isFoundersOffice(person(user))) return 'all';
  const ids = hasPerm(db, user, 'view_tasks') ? reportsOf(db, user.id) : new Set<string>();
  ids.add(user.id);
  return ids;
}

export const isOverseer = (db: Db, user: User, task: Task): boolean => rules.isOverseer(org(db), person(user), task);

export const canViewTask = (db: Db, user: User | null, task: Task): boolean => rules.canViewTask(org(db), user ? person(user) : null, task);

export function assertCanViewTask(db: Db, user: User, task: Task): void {
  if (!canViewTask(db, user, task)) throw new ApiError(403, `You are not authorized to view ${task.id}.`);
}

/** People this user may assign work to (D-32: themselves and their reports; a CoS: anyone active). */
export const assignableUsers = (db: Db, user: User): User[] => toUsers(db, rules.assignableUsers(org(db), person(user)));

export const canAssignTo = (db: Db, user: User, targetId: string): boolean => rules.canAssignTo(org(db), person(user), targetId);

/** Can this user see the profile/record of another person (search, directory)? */
export const canViewUser = (db: Db, user: User, target: User): boolean => rules.canViewUser(org(db), person(user), person(target));

export const isClosed = (task: Task): boolean => statusIsClosed(task.status);
