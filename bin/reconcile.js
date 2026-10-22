#!/usr/bin/env node
// CLI entry point. Dry-run by default; --apply requires --approver to be
// in config/approvers.json. Reads/writes data/fixtures/*.json and
// data/audit-log.jsonl via the json-files adapter.
//
// Console output is a compact summary; the full plan (every action, held
// item, quarantined row, and data issue) is always written to
// out/plan.json so nothing is actually lost by keeping the terminal
// skimmable.

const fs = require('node:fs');
const path = require('node:path');
const { plan } = require('../src/core/plan');
const { applyActions, ApproverNotAllowedError } = require('../src/apply');
const adapter = require('../src/adapters/json-files');

const ROOT = path.join(__dirname, '..');
// Overridable so tests can point the CLI at a throwaway directory instead
// of the repo's shared data/ dir.
const DATA_ROOT = process.env.ROSTER_DATA_DIR
  ? path.resolve(process.env.ROSTER_DATA_DIR)
  : ROOT;
const DATA_DIR = process.env.ROSTER_DATA_DIR ? DATA_ROOT : path.join(ROOT, 'data');
const FIXTURES_DIR = path.join(DATA_DIR, 'fixtures');
const OUT_DIR = path.join(DATA_ROOT, 'out');
const APPROVERS_PATH = path.join(ROOT, 'config', 'approvers.json');

const MAX_LISTED = 5;

// Printed paths are always relative to the repo root (or the override
// root, under tests) -- never absolute. An absolute path would bake this
// machine's username into console output and any captured sample files.
function displayPath(absolutePath) {
  return path.relative(DATA_ROOT, absolutePath) || '.';
}

function parseArgs(argv) {
  const args = { apply: false, approver: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--dry-run') args.apply = false;
    else if (argv[i] === '--approver') args.approver = argv[++i];
    else if (argv[i] === '--now') args.now = argv[++i];
  }
  return args;
}

function verbCounts(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.verb, (counts.get(item.verb) || 0) + 1);
  }
  return counts;
}

// One row per system: how many actions, how many held. Everything a
// stranger skimming the README needs before they open the full plan.
function printSummaryTable(actions, held) {
  const systems = Array.from(new Set([...actions, ...held].map((item) => item.system))).sort();
  if (systems.length === 0) {
    console.log('  (nothing to reconcile)');
    return;
  }

  const actionCounts = verbCounts(actions.map((a) => ({ verb: a.system })));
  const heldCounts = verbCounts(held.map((h) => ({ verb: h.system })));

  const header = ['system', 'actions', 'held'];
  const rows = systems.map((system) => [
    system,
    String(actionCounts.get(system) || 0),
    String(heldCounts.get(system) || 0),
  ]);
  rows.push(['TOTAL', String(actions.length), String(held.length)]);

  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const formatRow = (cells) => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(formatRow(header));
  for (const row of rows) console.log(formatRow(row));
}

function printCapped(items, formatLine, label) {
  if (items.length === 0) {
    console.log('  (none)');
    return;
  }
  items.slice(0, MAX_LISTED).forEach((item) => console.log(`  ${formatLine(item)}`));
  if (items.length > MAX_LISTED) {
    console.log(`  ... and ${items.length - MAX_LISTED} more (see ${label})`);
  }
}

function printHeld(held, planPath) {
  if (held.length === 0) {
    console.log('  (none)');
    return;
  }
  const byReason = new Map();
  for (const item of held) {
    if (!byReason.has(item.reason)) byReason.set(item.reason, []);
    byReason.get(item.reason).push(item);
  }
  for (const [reason, items] of byReason.entries()) {
    console.log(`  ${reason} (${items.length}):`);
    printCapped(items, (item) => `  - ${item.system}/${item.subject} ${item.verb}`, planPath);
  }
}

function printQuarantine(quarantined, planPath) {
  printCapped(
    quarantined,
    (item) => `- row ${item.index} (employee_id: ${item.employee_id || 'n/a'}): ${item.reasons.join(', ')}`,
    planPath
  );
}

function printDataIssues(dataIssues, planPath) {
  printCapped(
    dataIssues,
    (item) => `- ${item.system}/${item.group_id}: ${item.reason} (role: ${item.role})`,
    planPath
  );
}

function writePlanFile(result) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'plan.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  return outPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(path.join(FIXTURES_DIR, 'roster.json'))) {
    console.error(`No fixtures found at ${displayPath(FIXTURES_DIR)}. Run "npm run generate" first.`);
    process.exit(1);
  }

  const { roster, systems } = adapter.load(FIXTURES_DIR);
  const appliedKeys = adapter.loadAppliedKeys(DATA_DIR);
  const now = args.now ? new Date(args.now) : new Date();
  const result = plan(roster, systems, { now, appliedKeys });
  const planPath = writePlanFile(result);
  const planPathDisplay = displayPath(planPath);

  console.log(`Week: ${result.week}`);
  console.log(`\nPlanned actions: ${result.actions.length}`);
  console.log(`Quarantined roster rows: ${result.quarantined.length}`);
  console.log(`Held actions: ${result.held.length}`);
  console.log(`Data issues: ${result.dataIssues.length}`);

  console.log('\nPlan summary:');
  printSummaryTable(result.actions, result.held);
  console.log(`\nFull plan written to ${planPathDisplay}`);

  console.log(`\nQuarantined roster rows (${result.quarantined.length}):`);
  printQuarantine(result.quarantined, planPathDisplay);

  console.log(`\nData issues (${result.dataIssues.length}):`);
  printDataIssues(result.dataIssues, planPathDisplay);

  console.log(`\nHeld actions (${result.held.length}):`);
  printHeld(result.held, planPathDisplay);

  if (!args.apply) {
    console.log(`\nDry run only -- nothing was written. Full plan: ${planPathDisplay}`);
    console.log('Pass --apply --approver <email> to apply.');
    return;
  }

  const { allowlist } = JSON.parse(fs.readFileSync(APPROVERS_PATH, 'utf8'));
  try {
    const { appliedCount } = applyActions({
      actions: result.actions,
      approver: args.approver,
      allowlist,
      systems,
      adapter,
      fixturesDir: FIXTURES_DIR,
      dataDir: DATA_DIR,
      now,
    });
    console.log(`\nApplied ${appliedCount} actions as ${args.approver}.`);
  } catch (err) {
    if (err instanceof ApproverNotAllowedError) {
      console.error(`\nRefused to apply: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main();
