const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrng } = require('../src/core/prng');
const {
  buildRoster,
  addBadRows,
  buildFieldApp,
  buildStoreAssignments,
  buildTimeOff,
  buildGroups,
} = require('../scripts/generate-fixtures');

function generateAll(seed) {
  const rng = createPrng(seed);
  let roster = buildRoster(rng, 120);
  roster = addBadRows(rng, roster);
  return {
    roster,
    fieldApp: buildFieldApp(rng, roster),
    storeAssignments: buildStoreAssignments(rng, roster),
    timeOff: buildTimeOff(rng, roster),
    groups: buildGroups(rng, roster),
  };
}

test('determinism: the same seed produces byte-identical fixtures', () => {
  const first = generateAll(7);
  const second = generateAll(7);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('determinism: a different seed produces a different roster', () => {
  const seedSeven = generateAll(7);
  const seedEight = generateAll(8);
  assert.notEqual(JSON.stringify(seedSeven.roster), JSON.stringify(seedEight.roster));
});

test('the generator plants the bad rows it promises: missing email, duplicate id, unknown region', () => {
  const { roster } = generateAll(7);
  assert.ok(roster.some((r) => r.email === ''));
  assert.ok(roster.some((r) => r.region === 'arctic-outpost'));

  const ids = roster.map((r) => r.employee_id).filter(Boolean);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.ok(duplicates.length > 0);
});
