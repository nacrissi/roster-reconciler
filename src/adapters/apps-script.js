// REFERENCE ADAPTER -- not executed by any test or script in this repo.
//
// Sketches how the same core/plan.js output would be applied inside an
// Apps Script project: roster + the four downstream fixtures become Sheets
// tabs, and `field-app` accounts map onto a directory service's user
// records. The point of this file is to show the same adapter interface
// (`load`, `save`, `applyAction`, `loadAppliedKeys`, `appendAuditLog`) can
// be satisfied by Workspace services instead of the JSON-file adapter used
// in the demo, with no changes to src/core/plan.js.
//
// It references Apps Script globals (SpreadsheetApp, AdminDirectory,
// LockService, PropertiesService) that only exist inside the Apps Script
// V8 runtime, so it cannot run under plain Node and is excluded from
// `npm test`.

/* global SpreadsheetApp, AdminDirectory, LockService, PropertiesService */

var SHEET_NAMES = {
  roster: 'roster',
  storeAssignments: 'store-assignments',
  timeOff: 'time-off',
  groups: 'groups',
};

// Directory accounts (the field-app equivalent) are not a sheet at all --
// they come from the directory service, keyed by email, same shape the
// JSON adapter uses so core/plan.js doesn't care which adapter is live.
function loadFieldAppFromDirectory() {
  var accounts = [];
  var pageToken;
  do {
    var page = AdminDirectory.Users.list({
      domain: 'example.com',
      maxResults: 100,
      pageToken: pageToken,
    });
    (page.users || []).forEach(function (user) {
      accounts.push({
        email: user.primaryEmail,
        active: !user.suspended,
        role: (user.organizations && user.organizations[0] && user.organizations[0].title) || 'rep',
      });
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return accounts;
}

function sheetToObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  return values.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (header, i) {
      obj[header] = row[i];
    });
    return obj;
  });
}

function load(spreadsheetId) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  return {
    roster: sheetToObjects(ss.getSheetByName(SHEET_NAMES.roster)),
    systems: {
      fieldApp: loadFieldAppFromDirectory(),
      storeAssignments: sheetToObjects(ss.getSheetByName(SHEET_NAMES.storeAssignments)),
      timeOff: sheetToObjects(ss.getSheetByName(SHEET_NAMES.timeOff)),
      groups: sheetToObjects(ss.getSheetByName(SHEET_NAMES.groups)),
    },
  };
}

// Menu-triggered runs and time-driven triggers can both try to apply a
// plan at once; without a lock two runs could interleave writes to the
// same sheet row or directory record. Every entry point that calls
// applyAction/save should wrap the whole batch in this lock, same as the
// idempotency key guards double-application across runs.
function withReconciliationLock(fn) {
  var lock = LockService.getScriptLock();
  var gotLock = lock.tryLock(30000); // 30s: generous for a menu click, finite for a stuck trigger
  if (!gotLock) {
    throw new Error('reconciliation already running (lock held by another trigger or menu click)');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function applyAction(systems, action) {
  // Same switch shape as src/adapters/json-files.js, substituting
  // AdminDirectory.Users.update/insert for field-app and sheet row
  // writes for the other three systems. Omitted here since it is a
  // mechanical re-mapping, not a design decision worth sketching twice.
  throw new Error('reference adapter: not implemented, see src/adapters/json-files.js');
}

function appendAuditLog(spreadsheetId, entries) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sheet = ss.getSheetByName('audit-log') || ss.insertSheet('audit-log');
  entries.forEach(function (entry) {
    sheet.appendRow([
      entry.timestamp,
      entry.approver,
      entry.key,
      entry.system,
      entry.subject,
      entry.verb,
      JSON.stringify(entry.before),
      JSON.stringify(entry.after),
    ]);
  });
}

function loadAppliedKeys(spreadsheetId) {
  // A Properties store (not the audit sheet itself) keeps the idempotency
  // check O(1) instead of re-reading and JSON-parsing a growing sheet on
  // every run.
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('appliedKeys');
  return raw ? JSON.parse(raw) : [];
}

if (typeof module !== 'undefined') {
  module.exports = {
    load,
    applyAction,
    appendAuditLog,
    loadAppliedKeys,
    withReconciliationLock,
  };
}
