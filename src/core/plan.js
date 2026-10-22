// Core reconciliation engine. Pure JS: no Node APIs, no imports, no I/O.
// Inputs in, plan out. Runs unmodified under Node (via module.exports below)
// and Apps Script V8 (which ignores the `module` branch entirely).
//
// plan(roster, systems, options) -> { actions, quarantined, held }
//
//   roster:  array of { employee_id, name, email, region, role, status,
//                        mfa_enrolled, manager_email }
//   systems: { fieldApp, storeAssignments, timeOff, groups } -- see adapters
//            for exact per-system shapes.
//   options: { now: Date|string|undefined, appliedKeys: Iterable<string> }
//
// Every action has a deterministic key: `${system}:${subject}:${verb}:${week}`.
// An action whose key is already in options.appliedKeys is treated as already
// done and is omitted from the result -- this is what makes a second plan()
// over an unchanged world come out empty even before the adapter re-reads
// the (now-updated) downstream systems.

const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const ROLES = ['rep', 'lead', 'manager'];
const STATUSES = ['active', 'leave', 'offboarded'];

const REMOVAL_CONFIRMATION_THRESHOLD = 0.2;

function groupKey(role, region) {
  return `${role}-${region}`;
}

// ISO-8601 week string, e.g. "2026-W43". Pure date math, no Node APIs.
function toIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function makeAction(system, subject, verb, week, before, after, extra) {
  return Object.assign(
    {
      key: `${system}:${subject}:${verb}:${week}`,
      system,
      subject,
      verb,
      week,
      before,
      after,
    },
    extra || {}
  );
}

function validateRoster(roster) {
  const validRoster = [];
  const quarantined = [];
  const seenIds = new Set();

  roster.forEach((row, index) => {
    const reasons = [];

    if (!row.employee_id) {
      reasons.push('missing-employee-id');
    } else if (seenIds.has(row.employee_id)) {
      reasons.push('duplicate-employee-id');
    }

    if (!row.email) {
      reasons.push('missing-email');
    }

    if (!row.region || REGIONS.indexOf(row.region) === -1) {
      reasons.push('unknown-region');
    }

    if (!row.role || ROLES.indexOf(row.role) === -1) {
      reasons.push('unknown-role');
    }

    if (!row.status || STATUSES.indexOf(row.status) === -1) {
      reasons.push('unknown-status');
    }

    if (reasons.length > 0) {
      quarantined.push({ index, employee_id: row.employee_id || null, reasons });
      return;
    }

    seenIds.add(row.employee_id);
    validRoster.push(row);
  });

  return { validRoster, quarantined };
}

function computeFieldAppActions(validRoster, systems, week) {
  const actions = [];
  const held = [];
  const byEmail = new Map();
  (systems.fieldApp || []).forEach((account) => byEmail.set(account.email, account));

  for (const row of validRoster) {
    const account = byEmail.get(row.email);
    const wantActive = row.status === 'active';

    if (!wantActive) {
      if (account && account.active) {
        actions.push(
          makeAction(
            'field-app',
            row.employee_id,
            'deactivate-account',
            week,
            { active: true, role: account.role },
            { active: false, role: account.role },
            { reason: row.status === 'offboarded' ? 'offboarded' : 'leave', email: row.email }
          )
        );
      }
      continue;
    }

    // wantActive === true from here down.
    if (!account) {
      if (row.mfa_enrolled) {
        actions.push(
          makeAction(
            'field-app',
            row.employee_id,
            'create-account',
            week,
            null,
            { email: row.email, active: true, role: row.role },
            { email: row.email }
          )
        );
      } else {
        held.push(
          makeAction(
            'field-app',
            row.employee_id,
            'create-account',
            week,
            null,
            { email: row.email, active: true, role: row.role },
            { reason: 'pending-2fa', email: row.email }
          )
        );
      }
      continue;
    }

    if (!account.active) {
      if (row.mfa_enrolled) {
        actions.push(
          makeAction(
            'field-app',
            row.employee_id,
            'activate-account',
            week,
            { active: false, role: account.role },
            { active: true, role: account.role },
            { email: row.email }
          )
        );
      } else {
        held.push(
          makeAction(
            'field-app',
            row.employee_id,
            'activate-account',
            week,
            { active: false, role: account.role },
            { active: true, role: account.role },
            { reason: 'pending-2fa', email: row.email }
          )
        );
      }
    }

    if (account.role !== row.role) {
      actions.push(
        makeAction(
          'field-app',
          row.employee_id,
          'update-role',
          week,
          { role: account.role },
          { role: row.role },
          { email: row.email }
        )
      );
    }
  }

  return { actions, held };
}

function computeStoreActions(validRoster, systems, week) {
  const actions = [];
  const byEmployeeId = new Map();
  (systems.storeAssignments || []).forEach((row) => byEmployeeId.set(row.employee_id, row));

  for (const row of validRoster) {
    const assignment = byEmployeeId.get(row.employee_id);
    if (!assignment || !assignment.store_ids || assignment.store_ids.length === 0) continue;

    const isOffboarded = row.status === 'offboarded';
    const regionChanged = assignment.region && assignment.region !== row.region;

    if (isOffboarded || regionChanged) {
      actions.push(
        makeAction(
          'store-assignments',
          row.employee_id,
          'revoke-stores',
          week,
          { store_ids: assignment.store_ids, region: assignment.region },
          { store_ids: [], region: assignment.region },
          { reason: isOffboarded ? 'offboarded' : 'region-change' }
        )
      );
    }
  }

  return { actions };
}

function computeTimeOffActions(validRoster, systems, week) {
  const actions = [];
  const byEmployeeId = new Map();
  (systems.timeOff || []).forEach((row) => byEmployeeId.set(row.employee_id, row));

  for (const row of validRoster) {
    const record = byEmployeeId.get(row.employee_id);
    const currentlyOnLeave = Boolean(record && record.on_leave);
    const wantsLeave = row.status === 'leave';

    if (wantsLeave && !currentlyOnLeave) {
      actions.push(
        makeAction(
          'time-off',
          row.employee_id,
          'mark-leave',
          week,
          { on_leave: currentlyOnLeave },
          { on_leave: true }
        )
      );
    } else if (!wantsLeave && currentlyOnLeave) {
      actions.push(
        makeAction(
          'time-off',
          row.employee_id,
          'mark-returned',
          week,
          { on_leave: true },
          { on_leave: false }
        )
      );
    }
  }

  return { actions };
}

function computeGroupActions(validRoster, systems, week) {
  const actions = [];
  const held = [];
  const dataIssues = [];
  const groups = systems.groups || [];
  const rosterByEmail = new Map();
  validRoster.forEach((row) => rosterByEmail.set(row.email, row));

  for (const group of groups) {
    const removalCandidates = [];

    // A member with no email isn't a reconciliation decision (there's
    // nothing to add or remove by email) -- it's bad downstream data,
    // most likely a roster row that was itself invalid and should have
    // been quarantined before anything downstream ever saw it. Report it
    // and leave it out of the removal math entirely, rather than planning
    // a remove-member action with a blank subject.
    const realMembers = group.members.filter((member) => {
      if (!member.email) {
        dataIssues.push({
          system: 'groups',
          group_id: group.group_id,
          role: member.role,
          reason: 'member-missing-email',
        });
        return false;
      }
      return true;
    });

    for (const member of realMembers) {
      const row = rosterByEmail.get(member.email);
      const desiredGroupId = row && row.status === 'active' ? groupKey(row.role, row.region) : null;
      const shouldBeMember = desiredGroupId === group.group_id;

      if (!shouldBeMember) {
        if (member.role === 'owner') continue; // owner protection: never remove an owner
        removalCandidates.push(member);
      }
    }

    const memberCount = realMembers.length;
    const overThreshold =
      memberCount > 0 && removalCandidates.length / memberCount > REMOVAL_CONFIRMATION_THRESHOLD;

    for (const member of removalCandidates) {
      // Subject includes the group id: the same person can simultaneously
      // need removal from one group and addition to another (or, with
      // messy enough data, removal from two), and each is a distinct
      // action with its own key.
      const action = makeAction(
        'groups',
        `${group.group_id}:${member.email}`,
        'remove-member',
        week,
        { group_id: group.group_id, role: member.role },
        null,
        { reason: 'no-longer-eligible', email: member.email }
      );
      if (overThreshold) {
        action.reason = 'needs-confirmation';
        held.push(action);
      } else {
        actions.push(action);
      }
    }
  }

  // Additions: every active roster member who belongs in a group and isn't yet in it.
  for (const row of validRoster) {
    if (row.status !== 'active') continue;
    const desiredGroupId = groupKey(row.role, row.region);
    const group = groups.find((g) => g.group_id === desiredGroupId);
    if (!group) continue; // no distribution list provisioned for this role/region pair

    const isMember = group.members.some((m) => m.email === row.email);
    if (isMember) continue;

    if (row.mfa_enrolled) {
      actions.push(
        makeAction(
          'groups',
          `${group.group_id}:${row.email}`,
          'add-member',
          week,
          null,
          { group_id: group.group_id, role: 'member' },
          { email: row.email }
        )
      );
    } else {
      held.push(
        makeAction(
          'groups',
          `${group.group_id}:${row.email}`,
          'add-member',
          week,
          null,
          { group_id: group.group_id, role: 'member' },
          { reason: 'pending-2fa', email: row.email }
        )
      );
    }
  }

  return { actions, held, dataIssues };
}

function plan(roster, systems, options) {
  const opts = options || {};
  const week = toIsoWeek(opts.now ? new Date(opts.now) : new Date());
  const appliedKeys = new Set(opts.appliedKeys || []);

  const { validRoster, quarantined } = validateRoster(roster || []);

  const fieldApp = computeFieldAppActions(validRoster, systems || {}, week);
  const stores = computeStoreActions(validRoster, systems || {}, week);
  const timeOff = computeTimeOffActions(validRoster, systems || {}, week);
  const groups = computeGroupActions(validRoster, systems || {}, week);

  const allActions = [
    ...fieldApp.actions,
    ...stores.actions,
    ...timeOff.actions,
    ...groups.actions,
  ].filter((action) => !appliedKeys.has(action.key));

  const allHeld = [...fieldApp.held, ...groups.held];

  return {
    week,
    actions: allActions,
    quarantined,
    held: allHeld,
    // Downstream data that can't be reconciled by email at all (e.g. a
    // group member with no email) -- a data-quality finding, not a planned
    // action. Kept separate from `quarantined`, which is roster-row-shaped.
    dataIssues: groups.dataIssues,
  };
}

const api = {
  plan,
  validateRoster,
  groupKey,
  toIsoWeek,
  REGIONS,
  ROLES,
  STATUSES,
  REMOVAL_CONFIRMATION_THRESHOLD,
};

if (typeof module !== 'undefined') {
  module.exports = api;
}
