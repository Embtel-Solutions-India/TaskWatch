// Pure tests for the shared task workflow (T-1.3; ADR-0003, R-1, R-2). No database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedActions, canTransition, STATUSES, type ActionFacts, type ActionPermission, type Status } from '@taskwatch/shared/workflow';

// Every allowed move, written out independently of the table under test (ADR-0003 + R-2).
const EXPECTED: Record<Status, Status[]> = {
  draft: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'blocked', 'completed', 'cancelled'],
  in_progress: ['submitted', 'completed', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'assigned', 'completed', 'cancelled'],
  submitted: ['completed', 'changes_requested', 'cancelled'],
  changes_requested: ['in_progress', 'blocked', 'cancelled'],
  reopened: ['in_progress', 'blocked', 'cancelled'],
  completed: ['reopened'],
  cancelled: [],
};

const ALL: ActionPermission[] = ['update_assigned_tasks', 'review_tasks', 'approve_extensions', 'reassign_tasks', 'assign_tasks', 'create_tasks'];
const facts = (o: Partial<ActionFacts> & { perms?: ActionPermission[] } = {}): ActionFacts => {
  const perms = o.perms ?? ALL;
  return { canView: true, isAssignee: false, isOverseer: false, isGiver: false, pendingExtension: false, mayAckEscalation: false, can: (p) => perms.includes(p), ...o };
};
const assignee = (o: Partial<ActionFacts> = {}) => facts({ isAssignee: true, perms: ['update_assigned_tasks'], ...o });
const task = (status: Status, reviewRequired = false) => ({ status, reviewRequired, acknowledgedAt: null });

describe('shared workflow', () => {
  it('every from → to pair matches the decided transition table', () => {
    for (const from of STATUSES) for (const to of STATUSES) assert.equal(canTransition(from, to), EXPECTED[from].includes(to), `${from} → ${to}`);
  });

  it('R-2: the assignee may mark Done from Open, In progress or Blocked only when no review is required', () => {
    for (const s of ['assigned', 'in_progress', 'blocked'] as const) {
      assert.ok(allowedActions(task(s), assignee()).has('complete'), s);
      assert.ok(!allowedActions(task(s, true), assignee()).has('complete'), `${s} with review`);
    }
    assert.ok(allowedActions(task('in_progress', true), assignee()).has('submit'));
    assert.ok(!allowedActions(task('assigned', true), assignee()).has('submit'), 'review needs the work started');
  });

  it('WF-11: the assignee may mark Blocked from working states and unblock by starting', () => {
    for (const s of ['assigned', 'in_progress', 'changes_requested', 'reopened'] as const) assert.ok(allowedActions(task(s), assignee()).has('block'), s);
    for (const s of ['blocked', 'submitted', 'draft', 'completed', 'cancelled'] as const) assert.ok(!allowedActions(task(s), assignee()).has('block'), s);
    const b = allowedActions(task('blocked'), assignee());
    assert.ok(b.has('start') && b.has('progress'), 'blocked is still active work');
    assert.ok(!allowedActions(task('assigned'), facts({ isOverseer: true })).has('block'), 'only the assignee blocks');
  });

  it('R-1: escalation acknowledgement follows the caller-supplied recipient fact, not overseer status', () => {
    assert.ok(!allowedActions(task('in_progress'), facts({ isOverseer: true })).has('ack_escalation'));
    assert.ok(allowedActions(task('in_progress'), facts({ mayAckEscalation: true })).has('ack_escalation'));
  });

  it('nothing is allowed on a task the person cannot see', () => {
    assert.equal(allowedActions(task('in_progress'), facts({ canView: false, isGiver: true, isOverseer: true })).size, 0);
  });

  it('an assignee without update_assigned_tasks can neither work nor attach', () => {
    const a = allowedActions(task('in_progress'), facts({ isAssignee: true, perms: [] }));
    for (const x of ['progress', 'complete', 'block', 'attach'] as const) assert.ok(!a.has(x), x);
    assert.ok(a.has('comment'));
  });

  it('PERF: the giver may rate a ratable task; the assignee and other overseers may not', () => {
    const ratable = { ...task('completed'), ratable: true };
    assert.ok(allowedActions(ratable, facts({ isGiver: true, isOverseer: true })).has('rate'));
    assert.ok(!allowedActions(ratable, assignee()).has('rate'));
    assert.ok(!allowedActions(ratable, facts({ isOverseer: true })).has('rate'), 'a supervisor who did not give the task');
    assert.ok(!allowedActions(task('completed'), facts({ isGiver: true })).has('rate'), 'nothing to rate');
  });
});

describe('D-133: task giver actions', () => {
  const giver = (perms: ActionPermission[] = ['assign_tasks', 'create_tasks']) => facts({ isGiver: true, perms });

  it('the giver reassigns their own task without being above the assignee; not a draft, not a closed task', () => {
    assert.ok(allowedActions(task('in_progress'), giver()).has('reassign'));
    assert.ok(!allowedActions(task('in_progress'), giver(['create_tasks'])).has('reassign'), 'needs assign_tasks');
    assert.ok(!allowedActions(task('draft'), giver()).has('reassign'), 'a draft is published, not reassigned');
    assert.ok(!allowedActions(task('completed'), giver()).has('reassign'));
    assert.ok(!allowedActions(task('in_progress'), facts({ isGiver: true, isCurrentGiver: false, perms: ['assign_tasks', 'create_tasks'] })).has('reassign'), 'the creator, after a reassignment by someone else');
  });

  it('only the giver discards, and only a draft', () => {
    assert.ok(allowedActions(task('draft'), giver()).has('discard'));
    for (const s of ['assigned', 'in_progress', 'cancelled'] as const) assert.ok(!allowedActions(task(s), giver()).has('discard'), s);
    assert.ok(!allowedActions(task('draft'), facts({ isOverseer: true })).has('discard'), 'an overseer is not the giver');
    assert.ok(!allowedActions(task('draft'), giver(['assign_tasks'])).has('discard'), 'needs create_tasks');
  });
});
