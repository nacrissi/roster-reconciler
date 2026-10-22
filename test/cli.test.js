const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function run(args, dataDir) {
  return execFileSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { ROSTER_DATA_DIR: dataDir }),
  });
}

function withTempDataDir(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-reconciler-cli-'));
  try {
    fn(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('dry-run is the default and never writes fixtures or an audit log', () => {
  withTempDataDir((dataDir) => {
    execFileSync('node', ['scripts/generate-fixtures.js', '--seed', '7', '--out', path.join(dataDir, 'fixtures')], {
      cwd: ROOT,
    });
    const before = fs.readFileSync(path.join(dataDir, 'fixtures', 'roster.json'), 'utf8');

    const output = run(['bin/reconcile.js'], dataDir); // no flags at all
    assert.match(output, /Dry run only/);

    const after = fs.readFileSync(path.join(dataDir, 'fixtures', 'roster.json'), 'utf8');
    assert.equal(before, after);
    assert.equal(fs.existsSync(path.join(dataDir, 'audit-log.jsonl')), false);
  });
});

test('apply without an allowlisted approver refuses and makes no changes', () => {
  withTempDataDir((dataDir) => {
    execFileSync('node', ['scripts/generate-fixtures.js', '--seed', '7', '--out', path.join(dataDir, 'fixtures')], {
      cwd: ROOT,
    });
    const before = fs.readFileSync(path.join(dataDir, 'fixtures', 'roster.json'), 'utf8');

    assert.throws(() =>
      run(['bin/reconcile.js', '--apply', '--approver', 'nobody@example.com'], dataDir)
    );

    const after = fs.readFileSync(path.join(dataDir, 'fixtures', 'roster.json'), 'utf8');
    assert.equal(before, after);
    assert.equal(fs.existsSync(path.join(dataDir, 'audit-log.jsonl')), false);
  });
});

test('console output never leaks the real home directory, only paths relative to the data root', () => {
  withTempDataDir((dataDir) => {
    const generateOutput = execFileSync(
      'node',
      ['scripts/generate-fixtures.js', '--seed', '7', '--out', path.join(dataDir, 'fixtures')],
      { cwd: ROOT, encoding: 'utf8' }
    );
    const dryRunOutput = run(['bin/reconcile.js', '--dry-run'], dataDir);

    for (const output of [generateOutput, dryRunOutput]) {
      assert.ok(!output.includes(os.homedir()));
    }
    assert.match(dryRunOutput, /Full plan written to out[\\/]plan\.json/);
  });
});

test('a second --apply over an unchanged world applies zero actions', () => {
  withTempDataDir((dataDir) => {
    execFileSync('node', ['scripts/generate-fixtures.js', '--seed', '7', '--out', path.join(dataDir, 'fixtures')], {
      cwd: ROOT,
    });

    const first = run(['bin/reconcile.js', '--apply', '--approver', 'ops-lead@example.com', '--now', '2026-01-05T09:00:00Z'], dataDir);
    assert.match(first, /Applied \d+ actions/);

    const second = run(['bin/reconcile.js', '--apply', '--approver', 'ops-lead@example.com', '--now', '2026-01-05T09:00:00Z'], dataDir);
    assert.match(second, /Applied 0 actions/);
  });
});
