# roster-reconciler

[![tests](https://github.com/nacrissi/roster-reconciler/actions/workflows/test.yml/badge.svg)](https://github.com/nacrissi/roster-reconciler/actions/workflows/test.yml)

**One roster, four systems that never agree. This plans every fix, holds the risky ones for a person, and is safe to run twice.**

When a new rep joins a field team, their name has to land in four places: the store-assignment list, the field app, the time-off tracker and the right distribution groups. Each system gets updated by a different person on a different day. So they drift. A rep who left in March still has an active account. A new hire can't log in on day one. Someone on leave still gets the weekly store list.

This repo is a working model of the fix: one source of truth, one planner that compares it to every downstream system, and guardrails that keep an automation from doing something nobody would sign off on.

All data here is invented and generated from a seed.

## Before and after

| | By hand | With the reconciler |
|---|---|---|
| Finding drift | Someone notices when a rep can't log in | Every run compares all four systems to the roster |
| Bad roster rows | Break the whole update, or get copied downstream | Quarantined with a reason; the rest of the run goes ahead |
| New hire access | Granted whenever the form is done | Held until 2FA is enrolled |
| Removing people from a group | One bulk edit, hard to undo | Held for confirmation if a group would lose more than 20% at once |
| Running it twice | Duplicate accounts, double emails | Second run changes nothing |
| "Who changed this?" | Nobody remembers | Every change is in an audit log with the approver's name |

## What a run looks like

`npm run demo` generates 125 roster rows with deliberate problems, then does a dry run, an apply and a second apply:

```
Plan summary:
  system             actions  held
  field-app          18       19
  groups             18       34
  store-assignments  16       0
  time-off           11       0
  TOTAL              63       53

Quarantined roster rows (5):
  - row 120 (employee_id: E1120): missing-email
  - row 121 (employee_id: E1118): duplicate-employee-id
  - row 122 (employee_id: E1121): unknown-region
  - row 123 (employee_id: E1122): unknown-role
  - row 124 (employee_id: n/a): missing-employee-id

Held actions (53):
  pending-2fa (38):
    - field-app/E1004 activate-account
    ...
  needs-confirmation (15):
    - groups/rep-north:xandi.underhay@example.com remove-member
    ...

===== Summary =====
Planned actions (dry run):   63
Quarantined roster rows:     5
Held actions (gated):        53
Applied on first --apply:    63
Applied on second --apply:   0 (expect 0 -- idempotent re-run)
```

Full output: [`docs/sample-output/demo-output.txt`](docs/sample-output/demo-output.txt). Every planned change, held item and quarantined row: [`docs/sample-output/plan.json`](docs/sample-output/plan.json). Audit log lines: [`docs/sample-output/audit-log-sample.jsonl`](docs/sample-output/audit-log-sample.jsonl).

## How it works

```
roster (source of truth)
        │
        ▼
  validate rows ──► quarantine (bad rows, with reasons)
        │
        ▼
  plan(roster, systems) ──► actions   (create, update, deactivate, add, remove)
        │               └─► held      (pending-2fa, needs-confirmation)
        ▼
  dry run (default)  ──►  apply --approver <allowlisted email>
                               │
                               ├─► adapter writes each system
                               └─► audit log (who, when, before, after)
```

It covers the whole rep lifecycle: onboarding, leave, return, offboarding, role change and region change.

- **`src/core/plan.js`** is the planner. It takes data in and returns a plan out. No file access, no clock, no imports.
- **`src/apply.js`** applies a plan through an adapter, checks the approver and writes the audit log.
- **`src/adapters/json-files.js`** is the adapter the demo uses: each system is a JSON file.
- **`src/adapters/apps-script.js`** is a reference sketch of the same interface on Sheets and the Workspace directory, with `LockService` so a scheduled run and a menu click can't collide. Tests don't run it.

## Design decisions

- **The planner runs unchanged in Node and in Apps Script.** It has no imports, so the same file can be pasted into an Apps Script project. The tests run against the exact code that would run in production.
- **Dry run is the default.** Writing anything takes `--apply` and an approver from `config/approvers.json`. A typo in a command can't change four systems.
- **Bad rows are quarantined, not fatal.** One missing email shouldn't block 120 good rows. Each quarantined row says why, so the fix goes to the right person.
- **Access waits for 2FA.** A new account is held as `pending-2fa` until the roster shows the rep is enrolled. Holding it is safer than granting it and hoping someone circles back.
- **Large removals wait for a person.** If one run would remove more than 20% of a group's members, every removal for that group is held. That pattern usually means the source data is wrong, not that a fifth of the team left.
- **Group owners are never removed.** The planner skips them. It doesn't even raise the question.
- **Every action has a key: system, subject, verb and week.** Applied keys are logged, so a second run in the same week plans nothing. For group changes the subject includes the group, because one person can leave one group and join another in the same run.
- **Every printed path is relative.** Sample output never carries a machine's username.

## Run it in 2 minutes

Needs Node 20 or newer. No dependencies to install.

```bash
git clone https://github.com/nacrissi/roster-reconciler.git
cd roster-reconciler
npm test          # 22 tests
npm run demo      # generate, dry run, apply, apply again
```

Try one step at a time:

```bash
npm run generate
node bin/reconcile.js --dry-run
node bin/reconcile.js --apply --approver ops-lead@example.com
node bin/reconcile.js --apply --approver ops-lead@example.com   # 0 changes
node bin/reconcile.js --apply --approver someone@example.com    # refused: not on the allowlist
```

## The real story

This is a from-scratch rebuild of one piece of my work on a retail field-sales program. No employer code or data is in this repo.

Field-rep onboarding was slow. The delay traced back to a roster split across four systems that never agreed. I built one automation to provision Workspace accounts through the Admin SDK, enforce 2FA gates and reconcile all four. It cut onboarding time about 60% across 125+ reps in the US, Canada and Mexico. The paired access reconciliation synced 200+ users across the program, and each automation shipped with an SOP so the team could run it on their own.

## License

MIT
