// Pure tests for the shared permission rules (T-1.4; ADR-0004, D-8, D-29, D-32, D-33). Numeric ids, as on the server.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assignableUsers,
  canAssignTo,
  canViewTask,
  canViewUser,
  DEFAULT_ROLE_PERMISSIONS,
  hasPerm,
  isOverseer,
  reportsOf,
  wouldCreateLoop,
  type Org,
  type Person,
  type Role,
} from '@taskwatch/shared/permissions';
import { allowedActions } from '@taskwatch/shared/workflow';

// CEO 1 ← CoS 2 ← Manager 3 ← Lead 4 ← Staff 5, 6 ; Lead 7 (other team, under 3) ← Staff 8 ; Lead 9 with no manager ← Staff 10
const p = (id: number, roles: Role[], managerId: number | null, active = true): Person<number> => ({ id, roles, managerId, active });
const people = [
  p(1, ['ceo'], null),
  p(2, ['cos'], 1),
  p(3, ['manager'], 2),
  p(4, ['lead'], 3),
  p(5, ['staff'], 4),
  p(6, ['staff'], 4),
  p(7, ['lead'], 3),
  p(8, ['staff'], 7),
  p(9, ['lead'], null),
  p(10, ['staff'], 9),
  p(11, ['staff'], 4, false),
];
const org: Org<number> = { people, rolePermissions: DEFAULT_ROLE_PERMISSIONS };
const who = (id: number) => people.find((x) => x.id === id)!;
const task = (assigneeId: number, by = 4) => ({ assigneeId, createdBy: by, assignedBy: by, reviewerId: by });

describe('shared permissions', () => {
  it('D-8: permissions are the union over all of a person\'s roles; CoS holds everything; inactive holds nothing', () => {
    const leadAndStaff = p(20, ['staff', 'lead'], 3);
    assert.ok(!hasPerm(org, who(5), 'assign_tasks'));
    assert.ok(hasPerm(org, leadAndStaff, 'assign_tasks'), 'second role adds permissions');
    assert.ok(hasPerm(org, who(2), 'manage_roles'));
    assert.ok(!hasPerm(org, p(21, ['cos'], null, false), 'view_tasks'), 'inactive CoS has nothing');
  });

  it('D-29: leads cannot reassign by default; managers can', () => {
    assert.ok(!hasPerm(org, who(4), 'reassign_tasks'));
    assert.ok(hasPerm(org, who(3), 'reassign_tasks'));
  });

  it('scope follows the reporting line; a staff member cannot see another team\'s task (AC-6, logic half)', () => {
    assert.deepEqual([...reportsOf(org, 3)].sort((a, b) => a - b), [4, 5, 6, 7, 8, 11]);
    assert.ok(canViewTask(org, who(5), task(5)));
    assert.ok(!canViewTask(org, who(6), task(5)), 'peer');
    assert.ok(!canViewTask(org, who(8), task(5)), 'other team');
    assert.ok(!canViewTask(org, who(7), task(5)), 'other lead');
    assert.ok(canViewTask(org, who(3), task(5)), 'manager above');
    assert.ok(!canViewTask(org, who(11), task(11)), 'inactive sees nothing');
  });

  it('D-33: the Founder\'s Office sees everything, including people outside any reporting line', () => {
    assert.ok(canViewTask(org, who(1), task(10, 9)), 'CEO sees an orphan subtree');
    assert.ok(canViewTask(org, who(2), task(10, 9)), 'CoS sees an orphan subtree');
    assert.ok(canViewUser(org, who(1), who(10)));
    assert.ok(!canViewUser(org, who(5), who(10)));
  });

  it('D-33: the CEO is read-only — oversees work but can neither attach nor take giver actions', () => {
    const t = task(5);
    const ceo = who(1);
    assert.ok(isOverseer(org, ceo, t));
    const actions = allowedActions(
      { status: 'in_progress', reviewRequired: false, acknowledgedAt: null },
      { canView: true, isAssignee: false, isOverseer: true, isGiver: false, pendingExtension: false, mayAckEscalation: false, can: (x) => hasPerm(org, ceo, x) },
    );
    assert.deepEqual([...actions].sort(), ['comment']);
  });

  it('D-32: anyone who may assign can assign to themselves and their reports; staff to nobody; CoS to anyone active', () => {
    assert.deepEqual(assignableUsers(org, who(4)).map((x) => x.id).sort((a, b) => a - b), [4, 5, 6]);
    assert.ok(!canAssignTo(org, who(4), 8), 'not outside the line');
    assert.ok(!canAssignTo(org, who(4), 11), 'not inactive people');
    assert.equal(assignableUsers(org, who(5)).length, 0);
    assert.equal(assignableUsers(org, who(2)).length, people.filter((x) => x.active).length);
    assert.equal(assignableUsers(org, who(1)).length, 0, 'CEO cannot assign by default');
  });

  it('reporting loops are detected, including through several levels', () => {
    assert.ok(wouldCreateLoop(org, 3, 5), 'manager under own staff');
    assert.ok(wouldCreateLoop(org, 4, 4), 'self');
    assert.ok(!wouldCreateLoop(org, 5, 7), 'moving staff to another lead');
    assert.ok(!wouldCreateLoop(org, 9, null));
  });
});
