# claude-boot-budget

A fail-closed auditor and an ablation-based measurement tool for the boot token cost of Claude Code
session profiles. Node >= 20, zero external dependencies, MIT.

## The problem

Every Claude Code session pays for its own boot (plugins, skills, auto-loaded memory files, loose
top-level commands) before the first word of your task is read. A single `claude -p` call against an
**empty** `settings.json` (`{}`), measured with this repo's own probe, reported `input_tokens 2`,
`cache_creation_input_tokens 28,272`, `cache_read_input_tokens 17,728`: **46,002 tokens, US$ 0.293**
for one turn that did no work. Nobody gets a bill line for that, nobody gets a warning when it grows,
and a plugin enabled six weeks ago keeps charging every session that opens.

## What this does

**Profiles with a numeric cap.** A profile is an ordinary Claude Code settings file in `profiles/`.
`base.json` is the floor and declares the full plugin universe; every other `.json` is a profile.
`profiles/budget.json` holds, per profile, a written reason for each enabled plugin plus three caps:
the plugin cap, the global-load cap, and the sum cap.

**Three caps.** Plugins are the account that shrinks when you switch one off. Global load (auto-loaded
memory files and loose top-level commands) enters every profile and is invisible to a tool that
toggles plugins only; it is pruned rather than toggled. The sum cap covers the whole window, because
the context window is one window and does not care which account a token came from. Both partial caps
can stay green while the session as a whole gets worse.

**Measurement by ablation.** The number that matters is the difference between two real sessions that
differ in exactly one thing: a plugin on versus off, the global load present versus emptied out.
Dividing file size by a constant is not a substitute (see Limits). `measure` runs one real headless
session in a neutral working directory outside any repo, reads the last `type:result` line, and sums
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. A missing field throws rather
than becoming zero.

**A sha256 anchor on every measurement.** Each line in `profiles/boot-measurements.jsonl` carries the
anchor of the profile file it measured, hashed over the *canonical* JSON content. Key order, BOM,
indentation and line endings cost no tokens, so they do not invalidate anything, while enabling,
disabling or renaming a plugin does. Edit a profile and its measurement stops counting; the auditor
then demands a new one instead of letting a cap stand on a number that describes a different file.

**Fail-closed auditing, meant for CI.** `claude-boot-budget` exits 1 on any problem and 0 when clean.
A missing file blocks; it never degrades into a warning. The eight checks:

1. **Closed universe.** Every profile declares every plugin id from `base.json`, no more and no less.
   An omitted id is not "off": it inherits whatever settings sit above it. An extra id is a silent
   no-op that looks enabled.
2. **A written reason, both directions.** Every enabled plugin has a line of justification in
   `budget.json`, and every line matches a plugin that is actually enabled.
3. **A numeric cap.** Every profile on disk has a `cap` and a `total_cap`, both positive numbers, and
   every entry in `budget.json` has a profile on disk. A missing cap is an assertion that never
   fails.
4. **A measurement of today's file.** The profile has a line in `boot-measurements.jsonl` whose
   anchor matches the file as it stands now.
5. **Under the plugin cap.** The measured plugin cost is within `cap`.
6. **Under the global-load cap.** Once the global load has been measured, `global_load.cap` must be a
   positive number. `null` is the legitimate "not measured yet" state only until the first
   measurement exists; after that it would be an off switch for this check.
7. **Under the sum cap.** The full measured total is within `total_cap`.
8. **The cap declares its own calibration.** `calibrated_cap` records `{at, measurement, global_load}`,
   the measurement the cap was derived from, by the house rule `cap = measurement x 1.08, rounded up
   to the next hundred`. A cap above what the rule derives from its own calibration is slack nobody
   measured, and fails; a stricter cap passes. If the measurement starts splitting the global load
   while the cap was calibrated against the combined total, the audit stops and asks for a
   recalibration instead of judging the cap against an account it does not describe.

Two conditions report as warnings rather than blocking: a cap calibrated against an older measurement
than today's valid one (it prints the numbers the rule would derive now), and a measurement that does
not split the global load.

## Install

```
git clone <this repo>
cd claude-boot-budget
```

There is no install step and no `node_modules`. The tool uses `node:fs`, `node:crypto` and
`node:child_process` only.

## Use

Audit a profiles directory (exit 0 clean, 1 with problems):

```
$ node bin/claude-boot-budget.js profiles
ok      profiles: 'base' 12000/13000 plugin tokens, sum 12000/13000, 1 enabled plugin with a written reason
ok      profiles: 'light' 12000/13000 plugin tokens (+9500 of global load), sum 21500/23300, 1 enabled plugin with a written reason
warning profiles: 1 measurement does not split the global load (base) — for that profile the plugin cap is charging the combined total. Remeasure with an ablation pair.
BUDGET: PASS — 2 profiles under all three caps (plugins, global load, sum), every enabled plugin with a written reason; 1 warning
```

With no argument it audits `./profiles` relative to the working directory. Wire it into a pre-publish
or CI check script and the non-zero exit does the rest.

Print the canonical anchor of one profile file, which is useful when another tool writes your
measurement log and the hash rule should live in one place:

```
node bin/claude-boot-budget.js --anchor profiles/light.json
```

Measure a profile. Without `--sim` nothing runs: the command prints what it would do and exits 0.
With `--sim` it runs one real session, **spends real credit**, and appends a line to
`boot-measurements.jsonl`. The log is append-only, so the history shows a profile bloating over time.

```
node bin/claude-boot-budget.js measure light profiles --sim
node bin/claude-boot-budget.js measure light profiles --sim \
  --global-load 9500 \
  --global-load-source "ablation pair boot-20260101-090000 x boot-20260101-090500"
```

The first positional argument is always the profile name and the second is the directory that holds
the profile files, so `measure light profiles --sim` measures the profile `light` found in
`./profiles`. Passing only the directory reads as a profile name: `measure profiles` means "a profile
called profiles", which exits 1 under `--sim` without spending anything, and without `--sim` prints a
dry run for a profile that does not exist.

Naming no profile is a stop, not a request to measure all of them: the command lists what is on disk
and exits 1 without spending anything. A `--global-load` discount is refused unless
`--global-load-source` cites two distinct `boot-<YYYYMMDD-hhmmss>` log ids, the baseline and the
ablation, and that check runs before the probe rather than after.

Tests:

```
$ node --test
ℹ tests 88
ℹ pass 88
ℹ fail 0
```

The suite never calls the real `claude` binary. `runProbe()` takes an injectable `spawnFn`, so no test
spends credit.

## Limits

**A bytes-per-token ruler undercounts outside English.** The constant in that estimate is
calibrated on English prose, where one token covers several bytes of ASCII. Other languages tokenize
into more and shorter pieces, and accented or non-Latin characters cost more than one byte each, so
the same file size carries more tokens than the ruler predicts. How much more depends on the language
and on the file, so there is no fixed correction to apply. This tool measures a real
session instead of reading file sizes.

**Measuring spends real credit.** One real API call per scenario, and an ablation needs at least two
of them. No dry run produces a real number; `--sim` is the flag that authorizes the spend, and
everything the tool can validate for free is validated before the call goes out.

**A measurement that does not separate global load from plugin cost makes the plugin cap charge the
combined total.** That is deliberate, since assuming an unmeasured discount would be worse, but it
means a cap can fail because auto-loaded memory grew, with no plugin involved. The auditor reports
this case as a warning so the number is never silently misread, and the fix is a remeasurement with an
ablation pair rather than removing a plugin.

**The probe passes `--strict-mcp-config` by default.** MCP servers are a separate and much larger
cost, and a measurement that inherits whatever MCP configuration happens to sit on the machine is not
comparable to one taken anywhere else. Pass `strictMcp: false` to include them on purpose.

**The tool has no opinion about what is acceptable.** It produces today's number and enforces the caps
you wrote down. Comparison against a frozen baseline, tolerance bands and promotion rules are project
policy; build them on top of `measureProfile()` and two lines of the JSONL.

**`control` removes a measurement from the verdict.** It exists for experiments that deliberately
altered the disk. The auditor requires a written reason citing a ticket (`#N`) so the exclusion leaves
a trail, but it cannot tell an honest experiment from a hidden overrun.

## License

MIT. See `LICENSE`. Copyright Vitor Grosetti.
