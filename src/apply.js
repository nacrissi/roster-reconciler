// Node-side apply step. Takes a plan's `actions` and actually writes them
// through an adapter, gated on an allowlisted approver. Dry-run is the
// default everywhere above this module; this file is only ever reached
// when the caller has explicitly asked to apply.

class ApproverNotAllowedError extends Error {
  constructor(approver) {
    super(`approver "${approver}" is not in the allowlist`);
    this.name = 'ApproverNotAllowedError';
    this.approver = approver;
  }
}

function applyActions({ actions, approver, allowlist, systems, adapter, fixturesDir, dataDir, now }) {
  if (!approver || !allowlist.includes(approver)) {
    throw new ApproverNotAllowedError(approver);
  }

  const timestamp = (now || new Date()).toISOString();

  for (const action of actions) {
    adapter.applyAction(systems, action);
  }
  adapter.save(fixturesDir, systems);

  const auditEntries = actions.map((action) => ({
    timestamp,
    approver,
    key: action.key,
    system: action.system,
    subject: action.subject,
    verb: action.verb,
    before: action.before,
    after: action.after,
  }));
  adapter.appendAuditLog(dataDir, auditEntries);

  return { appliedCount: actions.length };
}

module.exports = { applyActions, ApproverNotAllowedError };
