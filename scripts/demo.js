#!/usr/bin/env node
// Orchestrates the full demo: regenerate fixtures, dry-run, apply, apply
// again (should be a no-op), then print a summary. This is exactly what
// `npm run demo` runs, and is also how docs/sample-output/ was captured.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'out');
const SAMPLE_OUTPUT_DIR = path.join(ROOT, 'docs', 'sample-output');

// Fixed so the demo is reproducible run to run, independent of the real
// clock; the whole dataset is synthetic anyway.
const DEMO_NOW = '2026-01-05T09:00:00Z';
const APPROVER = 'ops-lead@example.com';

function run(label, args) {
  console.log(`\n===== ${label} =====`);
  const output = execFileSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  console.log(output);
  return output;
}

function extractCount(output, label) {
  const match = output.match(new RegExp(`${label}: (\\d+)`));
  return match ? Number(match[1]) : null;
}

function main() {
  // Start from a clean data/ dir so the demo's second-run-is-idempotent
  // claim is measuring this run, not leftovers from a previous one.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  run('1. generate fixtures (seed 7)', ['scripts/generate-fixtures.js', '--seed', '7']);

  const dryRun = run('2. dry run', ['bin/reconcile.js', '--dry-run', '--now', DEMO_NOW]);

  // The console output above is intentionally capped (~5 lines per list).
  // Snapshot the full plan -- every action, held item, quarantined row,
  // and data issue -- from this dry run, before anything below mutates
  // the fixtures and the next plan comes back emptier.
  fs.mkdirSync(SAMPLE_OUTPUT_DIR, { recursive: true });
  fs.copyFileSync(path.join(OUT_DIR, 'plan.json'), path.join(SAMPLE_OUTPUT_DIR, 'plan.json'));

  const apply1 = run('3. apply', [
    'bin/reconcile.js',
    '--apply',
    '--approver',
    APPROVER,
    '--now',
    DEMO_NOW,
  ]);

  const apply2 = run('4. apply again (should be a no-op)', [
    'bin/reconcile.js',
    '--apply',
    '--approver',
    APPROVER,
    '--now',
    DEMO_NOW,
  ]);

  const summary = {
    plannedActions: extractCount(dryRun, 'Planned actions'),
    quarantinedRows: extractCount(dryRun, 'Quarantined roster rows'),
    heldActions: extractCount(dryRun, 'Held actions'),
    dataIssues: extractCount(dryRun, 'Data issues'),
    firstApplyCount: (apply1.match(/Applied (\d+) actions/) || [])[1],
    secondApplyCount: (apply2.match(/Applied (\d+) actions/) || [])[1],
  };

  console.log('\n===== Summary =====');
  console.log(`Planned actions (dry run):   ${summary.plannedActions}`);
  console.log(`Quarantined roster rows:     ${summary.quarantinedRows}`);
  console.log(`Held actions (gated):        ${summary.heldActions}`);
  console.log(`Data issues:                 ${summary.dataIssues}`);
  console.log(`Applied on first --apply:    ${summary.firstApplyCount}`);
  console.log(`Applied on second --apply:   ${summary.secondApplyCount} (expect 0 -- idempotent re-run)`);
  console.log(`\nFull plan (dry-run snapshot): docs/sample-output/plan.json`);
}

main();
