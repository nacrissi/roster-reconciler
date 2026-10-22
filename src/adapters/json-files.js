// Node-side adapter: reads/writes the demo's JSON fixtures and JSONL logs.
// This is the adapter actually exercised by tests and the CLI. The
// Apps Script adapter (src/adapters/apps-script.js) is a reference sketch
// of the same interface against Sheets + Admin Directory and is not run here.

const fs = require('node:fs');
const path = require('node:path');

const FILES = {
  roster: 'roster.json',
  fieldApp: 'field-app.json',
  storeAssignments: 'store-assignments.json',
  timeOff: 'time-off.json',
  groups: 'groups.json',
};

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function load(fixturesDir) {
  const roster = readJson(path.join(fixturesDir, FILES.roster), []);
  const systems = {
    fieldApp: readJson(path.join(fixturesDir, FILES.fieldApp), []),
    storeAssignments: readJson(path.join(fixturesDir, FILES.storeAssignments), []),
    timeOff: readJson(path.join(fixturesDir, FILES.timeOff), []),
    groups: readJson(path.join(fixturesDir, FILES.groups), []),
  };
  return { roster, systems };
}

function save(fixturesDir, systems) {
  writeJson(path.join(fixturesDir, FILES.fieldApp), systems.fieldApp);
  writeJson(path.join(fixturesDir, FILES.storeAssignments), systems.storeAssignments);
  writeJson(path.join(fixturesDir, FILES.timeOff), systems.timeOff);
  writeJson(path.join(fixturesDir, FILES.groups), systems.groups);
}

// Mutates `systems` in place to reflect one action. Returns nothing; the
// action's own before/after already describe what changed, for the audit
// log. Unknown verbs are a bug in the core planner, not a data problem, so
// this throws rather than silently skipping.
function applyAction(systems, action) {
  switch (`${action.system}:${action.verb}`) {
    case 'field-app:create-account': {
      systems.fieldApp.push({ email: action.email, active: true, role: action.after.role });
      return;
    }
    case 'field-app:activate-account': {
      const account = systems.fieldApp.find((a) => a.email === action.email);
      if (account) account.active = true;
      return;
    }
    case 'field-app:deactivate-account': {
      const account = systems.fieldApp.find((a) => a.email === action.email);
      if (account) account.active = false;
      return;
    }
    case 'field-app:update-role': {
      const account = systems.fieldApp.find((a) => a.email === action.email);
      if (account) account.role = action.after.role;
      return;
    }
    case 'store-assignments:revoke-stores': {
      const row = systems.storeAssignments.find((r) => r.employee_id === action.subject);
      if (row) row.store_ids = [];
      return;
    }
    case 'time-off:mark-leave': {
      let row = systems.timeOff.find((r) => r.employee_id === action.subject);
      if (!row) {
        row = { employee_id: action.subject, on_leave: false };
        systems.timeOff.push(row);
      }
      row.on_leave = true;
      return;
    }
    case 'time-off:mark-returned': {
      const row = systems.timeOff.find((r) => r.employee_id === action.subject);
      if (row) row.on_leave = false;
      return;
    }
    case 'groups:add-member': {
      const group = systems.groups.find((g) => g.group_id === action.after.group_id);
      if (group && !group.members.some((m) => m.email === action.email)) {
        group.members.push({ email: action.email, role: action.after.role });
      }
      return;
    }
    case 'groups:remove-member': {
      const group = systems.groups.find((g) => g.group_id === action.before.group_id);
      if (group) {
        group.members = group.members.filter((m) => m.email !== action.email);
      }
      return;
    }
    default:
      throw new Error(`json-files adapter: no handler for ${action.system}:${action.verb}`);
  }
}

function auditLogPath(dataDir) {
  return path.join(dataDir, 'audit-log.jsonl');
}

function loadAppliedKeys(dataDir) {
  const logPath = auditLogPath(dataDir);
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line).key);
}

function appendAuditLog(dataDir, entries) {
  if (entries.length === 0) return;
  fs.mkdirSync(dataDir, { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  fs.appendFileSync(auditLogPath(dataDir), lines);
}

module.exports = {
  FILES,
  load,
  save,
  applyAction,
  loadAppliedKeys,
  appendAuditLog,
  auditLogPath,
};
