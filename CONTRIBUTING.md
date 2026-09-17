# Contributing

## Requirements

- Node.js >= 20 (the engines field in `package.json` is enforced, not aspirational).
- No package manager setup needed: this project has zero runtime dependencies, so there is
  no lockfile and nothing to install.

## Running the tests

```
node --test
```

That's the whole test command. CI runs the same command on Linux, macOS and Windows, on
Node 20 and 22.

## Zero runtime dependencies — by policy, not by accident

This package audits token budgets and is meant to be readable end to end by anyone who
depends on it. A dependency is code you didn't write and didn't review, running with the
same access. Adding one breaks that property, so **pull requests that add a runtime
dependency are rejected by default.** If you believe a specific case justifies an exception,
open an issue first and make the case before sending the PR — don't lead with the diff.

Dev-only tooling (linters, formatters) is a separate conversation and still needs to be
justified: this project currently has none, and that's deliberate.

## Adding a new check to the auditor

Every check needs a **negative test**: a fixture that the check is supposed to catch, plus
an assertion that it does catch it. A check with no fixture that proves it fails when it
should fail is not a check — it's a check that always passes, and this project exists
specifically to catch that pattern in *others'* profiles. We hold our own code to the same
bar.

Concretely, for a new check:

1. Add the check itself (in `src/`).
2. Add at least one fixture/test where the check is expected to **pass** (clean profile).
3. Add at least one fixture/test where the check is expected to **fail** (the exact
   condition the check exists to catch), and assert on the failure — not just that a test
   runs, but that it reports the specific problem.
4. Run `node --test` locally and confirm both the positive and the negative case pass as
   expected before opening the PR.

A PR that adds a check without a negative test will be asked to add one before it's merged.

## Measuring vs. testing

`src/probe.js` can spawn a real `claude` process to measure actual token usage. That costs
real credit against a real account and requires the `claude` binary to be present. **CI
never does this** — every test that exercises `runProbe()` injects a fake `spawnFn` and
never touches the network or a real binary. Keep it that way: a new test should stub
`spawnFn` rather than let `runProbe()` fall through to a real spawn, and a PR should not add
a CI step that runs `claude-boot-budget measure ... --sim` against the real CLI.

If you want to verify real numbers while developing, run the `measure` subcommand locally
with `--sim` first (dry run, no spend) and only drop `--sim` when you're sure, on your own
machine, on your own account.
