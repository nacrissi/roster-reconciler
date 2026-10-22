#!/usr/bin/env node
// Generates a deterministic, seeded, messy roster + four downstream system
// fixtures under data/fixtures/. Every person, email, and company in the
// output is invented; emails are @example.com.
//
// Usage: node scripts/generate-fixtures.js --seed 7 [--out data/fixtures] [--reps 120]

const fs = require('node:fs');
const path = require('node:path');
const { createPrng } = require('../src/core/prng');
const { REGIONS, ROLES, groupKey } = require('../src/core/plan');

const ROOT = path.join(__dirname, '..');

// Printed paths are always relative to the repo root, never absolute --
// an absolute path would bake this machine's username into console output
// and any captured sample files.
function displayPath(absolutePath) {
  return path.relative(ROOT, absolutePath) || '.';
}

function parseArgs(argv) {
  const args = { seed: 7, out: path.join(__dirname, '..', 'data', 'fixtures'), reps: 120 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--reps') args.reps = Number(argv[++i]);
  }
  return args;
}

const FIRST_NAMES = [
  'Arden', 'Bryn', 'Cael', 'Dessa', 'Enzo', 'Fira', 'Garnet', 'Hollis',
  'Ina', 'Jovan', 'Kerra', 'Lior', 'Maren', 'Noor', 'Osric', 'Pria',
  'Quinley', 'Rasa', 'Soren', 'Talen', 'Uma', 'Vace', 'Wrenna', 'Xandi',
  'Yusra', 'Zeph',
];

const LAST_NAMES = [
  'Albright', 'Bowen', 'Carrow', 'Deming', 'Elsworth', 'Faulk', 'Granger',
  'Haldane', 'Ibarra', 'Jessop', 'Kestrel', 'Larkspur', 'Morrow', 'Nesbit',
  'Oakwell', 'Prentiss', 'Quintrell', 'Ravelle', 'Stanwick', 'Torvald',
  'Underhay', 'Vesper', 'Wraye', 'Yarnell',
];

function weightedPick(rng, weighted) {
  const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.next() * total;
  for (const [value, weight] of weighted) {
    if (roll < weight) return value;
    roll -= weight;
  }
  return weighted[weighted.length - 1][0];
}

function buildRoster(rng, count) {
  const roster = [];
  const usedEmails = new Set();

  for (let i = 0; i < count; i++) {
    const employee_id = `E${1000 + i}`;
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
    let suffix = 1;
    while (usedEmails.has(email)) {
      email = `${first.toLowerCase()}.${last.toLowerCase()}${suffix}@example.com`;
      suffix += 1;
    }
    usedEmails.add(email);

    const role = weightedPick(rng, [
      ['rep', 70],
      ['lead', 22],
      ['manager', 8],
    ]);
    const region = rng.pick(REGIONS);
    const status = weightedPick(rng, [
      ['active', 80],
      ['leave', 10],
      ['offboarded', 10],
    ]);
    const mfa_enrolled = rng.chance(0.82);
    const manager_email =
      role === 'manager' ? 'regional-director@example.com' : `lead-${region}@example.com`;

    roster.push({
      employee_id,
      name: `${first} ${last}`,
      email,
      region,
      role,
      status,
      mfa_enrolled,
      manager_email,
    });
  }

  return roster;
}

function addBadRows(rng, roster) {
  const sample = roster[rng.int(0, roster.length)];

  const missingEmail = {
    employee_id: `E${1000 + roster.length}`,
    name: 'Unknown Person',
    email: '',
    region: rng.pick(REGIONS),
    role: rng.pick(ROLES),
    status: 'active',
    mfa_enrolled: true,
    manager_email: 'lead-north@example.com',
  };

  const duplicateId = {
    employee_id: sample.employee_id, // reuses an existing id on purpose
    name: 'Duplicate Entry',
    email: `dup.${sample.employee_id.toLowerCase()}@example.com`,
    region: rng.pick(REGIONS),
    role: rng.pick(ROLES),
    status: 'active',
    mfa_enrolled: true,
    manager_email: 'lead-south@example.com',
  };

  const unknownRegion = {
    employee_id: `E${1000 + roster.length + 1}`,
    name: 'Nowhere Person',
    email: 'nowhere.person@example.com',
    region: 'arctic-outpost',
    role: 'rep',
    status: 'active',
    mfa_enrolled: true,
    manager_email: 'lead-north@example.com',
  };

  const unknownRole = {
    employee_id: `E${1000 + roster.length + 2}`,
    name: 'Roleless Person',
    email: 'roleless.person@example.com',
    region: rng.pick(REGIONS),
    role: 'astronaut',
    status: 'active',
    mfa_enrolled: true,
    manager_email: 'lead-east@example.com',
  };

  const missingId = {
    employee_id: '',
    name: 'Idless Person',
    email: 'idless.person@example.com',
    region: rng.pick(REGIONS),
    role: 'rep',
    status: 'active',
    mfa_enrolled: true,
    manager_email: 'lead-west@example.com',
  };

  return roster.concat([missingEmail, duplicateId, unknownRegion, unknownRole, missingId]);
}

function buildFieldApp(rng, roster) {
  const accounts = [];
  for (const row of roster) {
    if (row.status === 'active') {
      // Correctly provisioned reps mostly have an account; some don't
      // (the "missing accounts" drift) -- those become create-account
      // actions, held on 2FA if mfa_enrolled is false.
      if (rng.chance(0.85)) {
        accounts.push({ email: row.email, active: row.mfa_enrolled, role: row.role });
      }
    } else if (row.status === 'leave') {
      // Leave is often not reflected downstream: the account stays active.
      if (rng.chance(0.7)) {
        accounts.push({ email: row.email, active: true, role: row.role });
      }
    } else {
      // Offboarded: "stale actives" drift -- about 40% still show active.
      if (rng.chance(0.55)) {
        accounts.push({ email: row.email, active: rng.chance(0.4), role: row.role });
      }
    }
  }
  return accounts;
}

function buildStoreAssignments(rng, roster) {
  const assignments = [];
  for (const row of roster) {
    if (row.role !== 'rep') continue;
    if (!rng.chance(0.9)) continue;

    const storeCount = rng.int(1, 4);
    const store_ids = Array.from({ length: storeCount }, () => `S-${rng.int(1000, 9999)}`);

    // Most assignments carry the rep's current region. A slice drift to a
    // stale region (the rep changed region but the store roster wasn't
    // updated), and offboarded reps keep their stores far more often than
    // they should.
    let region = row.region;
    if (row.status === 'active' && rng.chance(0.1)) {
      region = rng.pick(REGIONS.filter((r) => r !== row.region));
    }

    assignments.push({ employee_id: row.employee_id, store_ids, region });
  }
  return assignments;
}

function buildTimeOff(rng, roster) {
  const rows = [];
  for (const row of roster) {
    if (row.status === 'leave') {
      // "Leave not reflected": about 55% of the time the tracker is stale.
      if (rng.chance(0.45)) {
        rows.push({ employee_id: row.employee_id, on_leave: true });
      }
    } else if (row.status === 'active' && rng.chance(0.04)) {
      // A handful of stale "still on leave" rows for people who returned.
      rows.push({ employee_id: row.employee_id, on_leave: true });
    }
  }
  return rows;
}

function buildGroups(rng, roster) {
  const byGroup = new Map();
  for (const role of ROLES) {
    for (const region of REGIONS) {
      byGroup.set(groupKey(role, region), []);
    }
  }

  for (const row of roster) {
    // A row with no email can't become a real distribution-list member --
    // that's exactly the "missing-email" bad row the generator plants on
    // purpose, and it should surface as a roster quarantine case, not leak
    // into a group's membership with a blank email.
    if (
      row.email &&
      row.status === 'active' &&
      row.mfa_enrolled &&
      byGroup.has(groupKey(row.role, row.region))
    ) {
      byGroup.get(groupKey(row.role, row.region)).push(row);
    }
  }

  const groups = [];
  let forcedConfirmationGate = false;

  for (const [group_id, idealMembers] of byGroup.entries()) {
    if (idealMembers.length === 0) continue;

    const [role, region] = [idealMembers[0].role, idealMembers[0].region];

    // Start from the correct membership, then drop a slice (becomes
    // add-member actions) and add a slice of people who don't belong
    // (becomes remove-member actions, gated by the 20% rule).
    let members = idealMembers
      .filter(() => rng.chance(0.85))
      .map((row) => ({ email: row.email, role: 'member' }));

    const foreignPool = roster.filter(
      (row) => row.email && (row.region !== region || row.role !== role || row.status !== 'active')
    );
    const foreignCount = rng.int(1, 3);
    for (let i = 0; i < foreignCount; i++) {
      const foreign = rng.pick(foreignPool);
      if (!members.some((m) => m.email === foreign.email)) {
        members.push({ email: foreign.email, role: 'member' });
      }
    }

    // Force exactly one group over the 20%-removal confirmation threshold,
    // so the demo deterministically exercises that guard.
    if (!forcedConfirmationGate && idealMembers.length >= 4) {
      const extraForeign = foreignPool.filter((row) => !members.some((m) => m.email === row.email));
      const need = Math.ceil(members.length * 0.35);
      for (let i = 0; i < need && i < extraForeign.length; i++) {
        members.push({ email: extraForeign[i].email, role: 'member' });
      }
      forcedConfirmationGate = true;
    }

    // Owner: prefer a real member; fall back to someone who has since
    // drifted out of eligibility (exercises owner protection).
    const ownerCandidate = members[0] || { email: idealMembers[0].email, role: 'member' };
    ownerCandidate.role = 'owner';

    groups.push({ group_id, role, region, members });
  }

  return groups;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rng = createPrng(args.seed);

  let roster = buildRoster(rng, args.reps);
  roster = addBadRows(rng, roster);

  const fieldApp = buildFieldApp(rng, roster);
  const storeAssignments = buildStoreAssignments(rng, roster);
  const timeOff = buildTimeOff(rng, roster);
  const groups = buildGroups(rng, roster);

  fs.mkdirSync(args.out, { recursive: true });
  const write = (name, data) =>
    fs.writeFileSync(path.join(args.out, name), JSON.stringify(data, null, 2) + '\n');

  write('roster.json', roster);
  write('field-app.json', fieldApp);
  write('store-assignments.json', storeAssignments);
  write('time-off.json', timeOff);
  write('groups.json', groups);

  console.log(`Generated fixtures (seed ${args.seed}) in ${displayPath(args.out)}`);
  console.log(`  roster: ${roster.length} rows`);
  console.log(`  field-app: ${fieldApp.length} accounts`);
  console.log(`  store-assignments: ${storeAssignments.length} rows`);
  console.log(`  time-off: ${timeOff.length} rows`);
  console.log(`  groups: ${groups.length} groups`);
}

if (require.main === module) {
  main();
}

module.exports = { buildRoster, addBadRows, buildFieldApp, buildStoreAssignments, buildTimeOff, buildGroups };
