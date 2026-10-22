const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/core/plan');

const NOW = '2026-01-05T09:00:00Z'; // a Monday; week "2026-W02"

function row(overrides) {
  return Object.assign(
    {
      employee_id: 'E1',
      name: 'Test Person',
      email: 'test.person@example.com',
      region: 'north',
      role: 'rep',
      status: 'active',
      mfa_enrolled: true,
      manager_email: 'lead-north@example.com',
    },
    overrides
  );
}

function emptySystems(overrides) {
  return Object.assign(
    { fieldApp: [], storeAssignments: [], timeOff: [], groups: [] },
    overrides
  );
}

function findAction(actions, system, verb, subject) {
  return actions.find((a) => a.system === system && a.verb === verb && a.subject === subject);
}

// Group action subjects are "group_id:email" (a person can need removal
// from one group and addition to another in the same run), so group
// assertions match on the `email` field instead of `subject`.
function findGroupAction(actions, verb, email) {
  return actions.find((a) => a.system === 'groups' && a.verb === verb && a.email === email);
}

// Padding roster rows + matching group members who stay firmly correct, so
// a single real removal in a lifecycle test stays under the 20%
// confirmation-gate threshold -- that guard gets its own dedicated test
// further down.
function padding(role, region, count = 9) {
  const rosterRows = Array.from({ length: count }, (_, i) =>
    row({
      employee_id: `PAD-${role}-${region}-${i}`,
      email: `padding-${role}-${region}-${i}@example.com`,
      role,
      region,
      status: 'active',
      mfa_enrolled: true,
    })
  );
  const members = rosterRows.map((r) => ({ email: r.email, role: 'member' }));
  return { rosterRows, members };
}

// --- Lifecycle cases ---------------------------------------------------

test('onboard: new active + mfa rep gets a field-app account and a group seat', () => {
  const roster = [row({})];
  const systems = emptySystems({ groups: [{ group_id: 'rep-north', role: 'rep', region: 'north', members: [] }] });
  const result = plan(roster, systems, { now: NOW });

  assert.ok(findAction(result.actions, 'field-app', 'create-account', 'E1'));
  assert.ok(findGroupAction(result.actions, 'add-member', 'test.person@example.com'));
  assert.equal(result.held.length, 0);
});

test('leave of absence: active rep going on leave is marked in time-off and loses field-app access', () => {
  const roster = [row({ status: 'leave' })];
  const systems = emptySystems({
    fieldApp: [{ email: 'test.person@example.com', active: true, role: 'rep' }],
  });
  const result = plan(roster, systems, { now: NOW });

  assert.ok(findAction(result.actions, 'time-off', 'mark-leave', 'E1'));
  assert.ok(findAction(result.actions, 'field-app', 'deactivate-account', 'E1'));
});

test('return: rep coming back from leave is reactivated and the tracker clears', () => {
  const roster = [row({ status: 'active' })];
  const systems = emptySystems({
    fieldApp: [{ email: 'test.person@example.com', active: false, role: 'rep' }],
    timeOff: [{ employee_id: 'E1', on_leave: true }],
  });
  const result = plan(roster, systems, { now: NOW });

  assert.ok(findAction(result.actions, 'time-off', 'mark-returned', 'E1'));
  assert.ok(findAction(result.actions, 'field-app', 'activate-account', 'E1'));
});

test('offboard: offboarded rep loses field-app access, stores, and group membership', () => {
  const pad = padding('rep', 'north');
  const roster = [row({ status: 'offboarded' }), ...pad.rosterRows];
  const systems = emptySystems({
    fieldApp: [{ email: 'test.person@example.com', active: true, role: 'rep' }],
    storeAssignments: [{ employee_id: 'E1', store_ids: ['S-1', 'S-2'], region: 'north' }],
    groups: [
      {
        group_id: 'rep-north',
        role: 'rep',
        region: 'north',
        members: [
          { email: 'test.person@example.com', role: 'member' },
          { email: 'owner@example.com', role: 'owner' },
          ...pad.members,
        ],
      },
    ],
  });
  const result = plan(roster, systems, { now: NOW });

  assert.ok(findAction(result.actions, 'field-app', 'deactivate-account', 'E1'));
  assert.ok(findAction(result.actions, 'store-assignments', 'revoke-stores', 'E1'));
  assert.ok(findGroupAction(result.actions, 'remove-member', 'test.person@example.com'));
});

test('role change: field-app role is updated and group membership moves to the new role group', () => {
  const pad = padding('rep', 'north');
  const roster = [row({ role: 'lead' }), ...pad.rosterRows];
  const systems = emptySystems({
    fieldApp: [{ email: 'test.person@example.com', active: true, role: 'rep' }],
    groups: [
      {
        group_id: 'rep-north',
        role: 'rep',
        region: 'north',
        members: [{ email: 'test.person@example.com', role: 'member' }, ...pad.members],
      },
      { group_id: 'lead-north', role: 'lead', region: 'north', members: [] },
    ],
  });
  const result = plan(roster, systems, { now: NOW });

  assert.ok(findAction(result.actions, 'field-app', 'update-role', 'E1'));
  assert.ok(findGroupAction(result.actions, 'remove-member', 'test.person@example.com'));
  assert.ok(findGroupAction(result.actions, 'add-member', 'test.person@example.com'));
});

test('region change: stale store assignment is revoked and group membership moves to the new region group', () => {
  const pad = padding('rep', 'north');
  const roster = [row({ region: 'south' }), ...pad.rosterRows];
  const systems = emptySystems({
    storeAssignments: [{ employee_id: 'E1', store_ids: ['S-1'], region: 'north' }],
    groups: [
      {
        group_id: 'rep-north',
        role: 'rep',
        region: 'north',
        members: [{ email: 'test.person@example.com', role: 'member' }, ...pad.members],
      },
      { group_id: 'rep-south', role: 'rep', region: 'south', members: [] },
    ],
  });
  const result = plan(roster, systems, { now: NOW });

  const revoke = findAction(result.actions, 'store-assignments', 'revoke-stores', 'E1');
  assert.ok(revoke);
  assert.equal(revoke.reason, 'region-change');
  assert.ok(findGroupAction(result.actions, 'remove-member', 'test.person@example.com'));
  assert.ok(findGroupAction(result.actions, 'add-member', 'test.person@example.com'));
});

// --- Guards --------------------------------------------------------------

test('quarantine: invalid roster rows are set aside with a reason instead of failing the run', () => {
  const roster = [
    row({ employee_id: 'E1' }),
    row({ employee_id: 'E1', email: 'duplicate@example.com' }), // duplicate id
    row({ employee_id: 'E2', email: '' }), // missing email
    row({ employee_id: 'E3', region: 'nowhere' }), // unknown region
  ];
  const result = plan(roster, emptySystems(), { now: NOW });

  assert.equal(result.quarantined.length, 3);
  const reasons = result.quarantined.map((q) => q.reasons.join(',')).sort();
  assert.deepEqual(reasons, ['duplicate-employee-id', 'missing-email', 'unknown-region']);
  // The run still produces a plan for the valid rows; it doesn't throw.
  assert.ok(Array.isArray(result.actions));
});

test('2FA gate: field-app and group access are held, not granted, until mfa_enrolled is true', () => {
  const roster = [row({ mfa_enrolled: false })];
  const systems = emptySystems({
    groups: [{ group_id: 'rep-north', role: 'rep', region: 'north', members: [] }],
  });
  const result = plan(roster, systems, { now: NOW });

  assert.equal(result.actions.length, 0);
  const createHeld = result.held.find((h) => h.system === 'field-app' && h.verb === 'create-account');
  const addHeld = result.held.find((h) => h.system === 'groups' && h.verb === 'add-member');
  assert.equal(createHeld.reason, 'pending-2fa');
  assert.equal(addHeld.reason, 'pending-2fa');
});

test('owner protection: a group owner is never proposed for removal, even if no longer eligible', () => {
  const roster = [row({ employee_id: 'E1', email: 'owner@example.com', status: 'offboarded' })];
  const systems = emptySystems({
    groups: [
      {
        group_id: 'rep-north',
        role: 'rep',
        region: 'north',
        members: [{ email: 'owner@example.com', role: 'owner' }],
      },
    ],
  });
  const result = plan(roster, systems, { now: NOW });

  const removal = findGroupAction(result.actions, 'remove-member', 'owner@example.com');
  const heldRemoval = result.held.find((h) => h.system === 'groups' && h.subject === 'owner@example.com');
  assert.equal(removal, undefined);
  assert.equal(heldRemoval, undefined);
});

test('confirmation gate: removing more than 20% of a group in one run holds all its removals', () => {
  const members = [
    { email: 'owner@example.com', role: 'owner' },
    { email: 'a@example.com', role: 'member' },
    { email: 'b@example.com', role: 'member' },
    { email: 'c@example.com', role: 'member' },
    { email: 'd@example.com', role: 'member' },
  ];
  // Nobody on the roster matches rep-north any more, so all 4 non-owner
  // members (80% of 5) would otherwise be removed in one run.
  const roster = [row({ employee_id: 'E9', email: 'someone-else@example.com', region: 'south' })];
  const systems = emptySystems({
    groups: [{ group_id: 'rep-north', role: 'rep', region: 'north', members }],
  });
  const result = plan(roster, systems, { now: NOW });

  const removals = result.actions.filter((a) => a.system === 'groups' && a.verb === 'remove-member');
  const heldRemovals = result.held.filter((h) => h.system === 'groups' && h.verb === 'remove-member');
  assert.equal(removals.length, 0);
  assert.equal(heldRemovals.length, 4);
  assert.ok(heldRemovals.every((h) => h.reason === 'needs-confirmation'));
});

test('idempotency: actions whose key is already in the applied log are not planned again', () => {
  const roster = [row({})];
  const systems = emptySystems();
  const first = plan(roster, systems, { now: NOW });
  assert.ok(first.actions.length > 0);

  const appliedKeys = first.actions.map((a) => a.key);
  const second = plan(roster, systems, { now: NOW, appliedKeys });
  assert.equal(second.actions.length, 0);
});

test('data quality: a group member with no email is reported as a data issue, not a blank remove-member action', () => {
  const pad = padding('rep', 'north'); // keeps the group well under the 20% gate
  const roster = [...pad.rosterRows];
  const systems = emptySystems({
    groups: [
      {
        group_id: 'rep-north',
        role: 'rep',
        region: 'north',
        members: [{ email: '', role: 'member' }, ...pad.members],
      },
    ],
  });
  const result = plan(roster, systems, { now: NOW });

  const blankRemoval = result.actions.find((a) => a.system === 'groups' && a.email === '');
  const blankHeld = result.held.find((h) => h.system === 'groups' && h.email === '');
  assert.equal(blankRemoval, undefined);
  assert.equal(blankHeld, undefined);

  assert.equal(result.dataIssues.length, 1);
  assert.deepEqual(result.dataIssues[0], {
    system: 'groups',
    group_id: 'rep-north',
    role: 'member',
    reason: 'member-missing-email',
  });
});
