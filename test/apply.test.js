const test = require('node:test');
const assert = require('node:assert/strict');
const { applyActions, ApproverNotAllowedError } = require('../src/apply');
const { plan } = require('../src/core/plan');

function fakeAdapter() {
  const calls = { applyAction: [], save: [], appendAuditLog: [] };
  return {
    calls,
    applyAction(systems, action) {
      calls.applyAction.push(action.key);
    },
    save(fixturesDir, systems) {
      calls.save.push({ fixturesDir, systems });
    },
    appendAuditLog(dataDir, entries) {
      calls.appendAuditLog.push({ dataDir, entries });
    },
  };
}

test('approver allowlist: an approver not on the list is refused and nothing is written', () => {
  const adapter = fakeAdapter();
  const actions = [{ key: 'a:b:c:w1', system: 'field-app', subject: 'E1', verb: 'create-account' }];

  assert.throws(
    () =>
      applyActions({
        actions,
        approver: 'random-person@example.com',
        allowlist: ['ops-lead@example.com'],
        systems: {},
        adapter,
        fixturesDir: '/tmp/fixtures',
        dataDir: '/tmp/data',
      }),
    ApproverNotAllowedError
  );

  assert.equal(adapter.calls.applyAction.length, 0);
  assert.equal(adapter.calls.save.length, 0);
  assert.equal(adapter.calls.appendAuditLog.length, 0);
});

test('approver allowlist: an allowlisted approver applies every action and writes one audit entry each', () => {
  const adapter = fakeAdapter();
  const actions = [
    { key: 'a:b:c:w1', system: 'field-app', subject: 'E1', verb: 'create-account', before: null, after: { role: 'rep' } },
    { key: 'a:b:d:w1', system: 'groups', subject: 'e1@example.com', verb: 'add-member', before: null, after: { group_id: 'rep-north' } },
  ];

  const { appliedCount } = applyActions({
    actions,
    approver: 'ops-lead@example.com',
    allowlist: ['ops-lead@example.com'],
    systems: {},
    adapter,
    fixturesDir: '/tmp/fixtures',
    dataDir: '/tmp/data',
    now: new Date('2026-01-05T09:00:00Z'),
  });

  assert.equal(appliedCount, 2);
  assert.deepEqual(adapter.calls.applyAction, ['a:b:c:w1', 'a:b:d:w1']);
  assert.equal(adapter.calls.save.length, 1);
  assert.equal(adapter.calls.appendAuditLog.length, 1);
  const entries = adapter.calls.appendAuditLog[0].entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].approver, 'ops-lead@example.com');
  assert.equal(entries[0].timestamp, '2026-01-05T09:00:00.000Z');
  assert.equal(entries[0].key, 'a:b:c:w1');
});

test('dry-run default: plan() alone never mutates the systems object it was given', () => {
  const systems = { fieldApp: [], storeAssignments: [], timeOff: [], groups: [] };
  const before = JSON.stringify(systems);
  plan(
    [
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
    ],
    systems,
    { now: '2026-01-05T09:00:00Z' }
  );
  assert.equal(JSON.stringify(systems), before);
});
