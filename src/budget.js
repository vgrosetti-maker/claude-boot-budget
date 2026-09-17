#!/usr/bin/env node
/**
 * Fail-closed auditor for the boot token budget of Claude Code session profiles.
 *
 * A profile only stays cheap if someone enforces it. This auditor is that someone, meant to
 * run as a pre-publish gate in your own repo's check script.
 *
 * It checks eight things, all fail-closed (a missing file BLOCKS, it never just warns):
 *
 *   1. Every profile declares the FULL universe of plugins from base.json, no more, no less.
 *      An id missing from the file is not "off": it is at the mercy of whatever settings sit
 *      above it. An extra id is a silent no-op: it looks enabled and isn't.
 *   2. Every ENABLED plugin has a line of justification in budget.json, and every line
 *      corresponds to an enabled plugin. A plugin with no reason written down is exactly how
 *      boot budgets quietly bloat: one plugin at a time, with nobody ever answering "why?".
 *   3. Every profile on disk has a NUMERIC cap in the budget file (and vice versa). A missing
 *      cap is not "unlimited": it is an assertion that never fails, i.e. a fake gate.
 *   4. The measurement for the profile exists in the measurements log and was taken against
 *      the file AS IT STANDS TODAY (the anchor matches). Editing the profile invalidates the
 *      measurement instead of inheriting a number that no longer applies — a number without a
 *      version is hearsay. The anchor is the CANONICAL content, never the raw bytes: line
 *      endings, BOM and indentation cost no tokens, so they don't invalidate a measurement;
 *      enabling, disabling or renaming a plugin costs tokens, so it does.
 *   5. The valid measurement is under the PROFILE's cap, which measures plugin cost only.
 *   6. The declared global load is under the global-load cap. This line only starts failing
 *      once the global load has actually been measured — while nobody has the number, this
 *      line is a warning; once measured, a cap of `null` stops being a legitimate "pending"
 *      state and starts blocking. Otherwise "pending" would survive its own measurement and
 *      become a silent off-switch.
 *   7. The SUM (profile + global load) is under the sum cap. This is the real guardrail: the
 *      two partial caps can both stay green while the session as a whole gets worse, because
 *      the context window is one window and does not care where a token came from.
 *   8. The cap declares the measurement that produced it, in `calibrated_cap`: a measurement
 *      that starts separating the global load invalidates a cap that was written against the
 *      combined total, and a cap above what the rule derives from its own calibration is slack
 *      nobody measured. A cap number without its calibration next to it is a number floating
 *      free.
 *
 * THREE LINES. A cap on the profile alone used to charge the profile for weight that isn't
 * its own: the global load (auto-loaded memory files + loose top-level commands) enters every
 * profile and is invisible to a per-profile measurement tool that isolates plugins only. A
 * measurement can declare `global_load` (and `global_load_source`, with the ablation pair that
 * backs it) to split the two accounts; a measurement that does NOT declare it is treated as
 * the full combined total, and the profile cap keeps charging the sum — conservative on
 * purpose, never assuming a discount nobody measured.
 *
 * Usage:
 *   node src/budget.js [profilesDir]        # audits and exits 1 if anything is wrong
 *   node src/budget.js --anchor <file.json> # prints the canonical anchor of one profile file
 *   require(...).audit(profilesDir)         # used by CI and by the test suite
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ROOT = path.join(__dirname, "..", "profiles");
const NON_PROFILE_FILES = new Set(["budget.json"]);

// Canonical serialization: same semantic content, same string, no matter which editor wrote
// the file. Keys sorted recursively, no whitespace — the order an editor happened to write
// keys in doesn't change a single boot token, so it can't change the anchor either.
function canonicalize(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

// The anchor that identifies WHICH profile was measured. Computed over the canonical content,
// never over raw bytes: a byte-hash carries line endings, BOM and indentation, and none of
// that costs a token. What the anchor needs to catch — enabling, disabling, adding or renaming
// a plugin — changes the object, and that changes the hash.
//
// Why this matters: a hash over raw bytes makes the SAME commit produce two different anchors
// depending on whether the working tree checked it out with CRLF or LF line endings (e.g. via
// .gitattributes normalization vs. a local autocrlf setting), and the auditor will then demand
// a re-measurement of a profile nobody actually touched.
function anchor(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  return crypto.createHash("sha256").update(canonicalize(JSON.parse(raw)), "utf8").digest("hex");
}

/**
 * The house rule, as code: cap = measurement x 1.08, rounded up to the nearest hundred. This
 * exists as a function so the auditor, the tests and whoever recalibrates all use the SAME
 * arithmetic — a rule reimplemented by hand in three places stops being a rule the moment one
 * of them drifts.
 */
function rule(measurement) {
  // The inner round is not decoration: 30000 * 1.08 is 32400.000000000004 in floating point,
  // and ceil alone would push that to 32500 — a full hundred of slack nobody asked for, in a
  // number that exists specifically to have none. Rounding to a whole token before stepping up
  // to the next hundred kills the residue without changing any legitimate case (the residue is
  // always < 0.5 token).
  return Math.ceil(Math.round(measurement * 1.08) / 100) * 100;
}

function readJson(file, label, problems) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    problems.push(`profiles: ${label} unreadable (${e.message})`);
    return null;
  }
}

/** Latest measurement per profile, skipping composite `+plugin` runs (not a profile on disk). */
function readMeasurements(file, problems) {
  const byProfile = new Map();
  if (!fs.existsSync(file)) {
    problems.push(
      `profiles: ${path.basename(file)} is missing — without a measurement, a cap is a guess. ` +
        `Run your measurement tool for every profile first.`
    );
    return byProfile;
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  lines.forEach((l, i) => {
    let m;
    try {
      m = JSON.parse(l.replace(/^﻿/, ""));
    } catch (e) {
      problems.push(`profiles: measurements file line ${i + 1} unreadable (${e.message})`);
      return;
    }
    for (const field of ["profile", "sha256", "total_tokens"]) {
      if (m[field] === undefined || m[field] === null) {
        problems.push(`profiles: measurements file line ${i + 1} missing '${field}'`);
        return;
      }
    }
    if (Array.isArray(m.extras) && m.extras.length) return; // composite run: has no cap of its own
    // CONTROL measurement: an experiment that deliberately messed with the disk (e.g.
    // restoring loose files to measure what they cost). Same profile, same sha256, and it
    // still doesn't describe the state of the repo — if it counted, the experiment itself
    // would fail the budget. It stays in history, out of the verdict. (issue reference required)
    if (m.control) {
      // The flag removes the line from the verdict, so it's a door: whoever marks a REAL
      // measurement as control hides bloat. The price of using the door is leaving a trail —
      // a reason in text citing the ticket that authorized the experiment.
      if (!/#\d+/.test(String(m.control))) {
        problems.push(
          `profiles: measurements file line ${i + 1} marked as 'control' without citing a ticket (#N) — ` +
            `a measurement only leaves the verdict when the experiment is pointed to in writing`
        );
      }
      return;
    }
    byProfile.set(m.profile, m); // append-only: the last line for a profile wins
  });
  return byProfile;
}

function audit(profilesDir = DEFAULT_ROOT) {
  const problems = [];
  const ok = [];
  const warnings = [];

  if (!fs.existsSync(profilesDir)) {
    problems.push(`profiles: folder ${profilesDir} does not exist`);
    return { problems, ok, warnings };
  }

  const basePath = path.join(profilesDir, "base.json");
  if (!fs.existsSync(basePath)) {
    problems.push("profiles: base.json is missing — without it there is no plugin universe to validate anything against");
    return { problems, ok, warnings };
  }
  const jBase = readJson(basePath, "base.json", problems);
  if (!jBase || !jBase.enabledPlugins) {
    if (jBase) problems.push("profiles: base.json has no 'enabledPlugins'");
    return { problems, ok, warnings };
  }
  const universe = Object.keys(jBase.enabledPlugins);

  const budgetPath = path.join(profilesDir, "budget.json");
  if (!fs.existsSync(budgetPath)) {
    problems.push("profiles: budget.json is missing — an enabled plugin with no reason written down is exactly how boot budgets bloat");
    return { problems, ok, warnings };
  }
  const budget = readJson(budgetPath, "budget.json", problems);
  if (!budget || !budget.profiles) {
    if (budget) problems.push("profiles: budget.json has no 'profiles'");
    return { problems, ok, warnings };
  }

  // LINE 2 (global load): the cap belongs to the FILE, not the profile — auto-loaded memory
  // and loose top-level commands enter every profile. This line starts failing once it has
  // been measured: the block being absent BLOCKS, and so does `cap: null`. The "pending
  // measurement" state was legitimate only while nobody had the number; keeping that door open
  // after measuring it would turn a one-line edit into a silent way to disable this whole line
  // — exactly the hole the missing-block check already guards against.
  if (!budget.global_load || typeof budget.global_load !== "object") {
    problems.push(
      "profiles: budget.json has no 'global_load' block — if the block is allowed to be missing, the " +
        "global-load cap disappears without anyone noticing. Declare the block with cap null until you " +
        "have measured the global load."
    );
    return { problems, ok, warnings };
  }
  const globalCap = budget.global_load.cap;
  if (!(typeof globalCap === "number" && globalCap > 0)) {
    problems.push(
      `profiles: 'global_load.cap' must be a positive number — got ${JSON.stringify(globalCap)}. ` +
        `null was a legitimate 'not measured yet' state only until the global load was measured; after ` +
        `that, setting the cap back to null does not declare a pending measurement, it disables the ` +
        `global-load cap. If the load changed, remeasure with an ablation pair and reapply the rule ` +
        `(x1.08, rounded up to the next hundred).`
    );
    return { problems, ok, warnings };
  }
  const noSplit = [];

  const names = fs
    .readdirSync(profilesDir)
    .filter((f) => f.endsWith(".json") && !NON_PROFILE_FILES.has(f))
    .map((f) => path.basename(f, ".json"))
    .sort();

  for (const n of Object.keys(budget.profiles)) {
    if (!names.includes(n)) {
      problems.push(`profiles: budget.json describes '${n}', which does not exist on disk`);
    }
  }

  const measurements = readMeasurements(path.join(profilesDir, "boot-measurements.jsonl"), problems);

  for (const name of names) {
    const file = path.join(profilesDir, `${name}.json`);
    const j = readJson(file, `${name}.json`, problems);
    if (!j) continue;
    if (!j.enabledPlugins) {
      problems.push(`profiles: ${name}.json has no 'enabledPlugins'`);
      continue;
    }

    // 1. closed universe
    const keys = Object.keys(j.enabledPlugins);
    const missing = universe.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !universe.includes(k));
    if (missing.length) {
      problems.push(
        `profiles: ${name}.json does not declare ${missing.length} plugin${missing.length === 1 ? "" : "s"} ` +
          `from base.json's universe ` +
          `(an omitted id is not "off", it is at the mercy of whatever sits above it): ${missing.join(", ")}`
      );
    }
    if (extra.length) {
      problems.push(
        `profiles: ${name}.json enables an id outside base.json's universe (silent no-op): ${extra.join(", ")}`
      );
    }

    const enabled = keys.filter((k) => j.enabledPlugins[k] === true).sort();

    const entry = budget.profiles[name];
    if (!entry) {
      problems.push(`profiles: ${name}.json exists on disk and has no entry in budget.json`);
      continue;
    }

    // 2. reason written down, both directions
    const justified = Object.keys(entry.plugins || {}).sort();
    const noReason = enabled.filter((p) => !justified.includes(p));
    const orphanReason = justified.filter((p) => !enabled.includes(p));
    if (noReason.length) {
      problems.push(`profiles: '${name}' enables without a written reason in budget.json: ${noReason.join(", ")}`);
    }
    if (orphanReason.length) {
      problems.push(`profiles: budget.json justifies a plugin '${name}' does not enable: ${orphanReason.join(", ")}`);
    }

    // 3. numeric cap — BOTH: the profile's own cap (plugins only) and the sum cap (the whole window)
    const cap = entry.cap;
    if (typeof cap !== "number" || !(cap > 0)) {
      problems.push(
        `profiles: '${name}' has no numeric cap in budget.json — an assertion that never fails is a fake gate. ` +
          `Measure it and write the cap down.`
      );
      continue;
    }
    const totalCap = entry.total_cap;
    if (typeof totalCap !== "number" || !(totalCap > 0)) {
      problems.push(
        `profiles: '${name}' has no numeric total_cap in budget.json — the context window is one window and ` +
          `does not care where a token came from; without this line the two partial caps let the session get ` +
          `worse in silence.`
      );
      continue;
    }

    // 3b. SHAPE of calibrated_cap. A cap number without the semantics that produced it is a
    // number floating free: a copy-pasted cap with no calibration data means nobody can tell
    // whether it charges plugins only or the combined total, and swapping one account for the
    // other passes silently. Fail-closed like the rest — a missing block blocks, it never
    // becomes a silent default.
    const cal = entry.calibrated_cap;
    const calOk =
      cal &&
      typeof cal === "object" &&
      typeof cal.at === "string" &&
      cal.at &&
      typeof cal.measurement === "number" &&
      cal.measurement > 0 &&
      (cal.global_load === null || (typeof cal.global_load === "number" && cal.global_load >= 0)) &&
      (cal.global_load || 0) <= cal.measurement;
    if (!calOk) {
      problems.push(
        `profiles: '${name}' has no valid 'calibrated_cap' ({at, measurement, global_load: number|null}) in ` +
          `budget.json — a cap without the measurement that produced it is a number floating free: nobody can ` +
          `tell whether it charges plugins only or the combined total, and swapping one account for the other ` +
          `passes silently.`
      );
      continue;
    }
    // BACKING — the anchor is the measurement that CALIBRATED the cap, not today's: a cap
    // above what the rule derives from it is slack nobody measured. Anchoring to today's
    // measurement instead would turn every boot improvement into a red gate, which is noise,
    // not a guardrail.
    const calProfile = cal.measurement - (cal.global_load || 0);
    if (cap > rule(calProfile) || totalCap > rule(cal.measurement)) {
      const over = [];
      if (cap > rule(calProfile)) over.push(`cap ${cap} vs. ${rule(calProfile)} derived from ${calProfile}`);
      if (totalCap > rule(cal.measurement))
        over.push(`total_cap ${totalCap} vs. ${rule(cal.measurement)} derived from ${cal.measurement}`);
      problems.push(
        `profiles: cap for '${name}' is above what the rule derives from the measurement that calibrated it on ` +
          `${cal.at} (${over.join("; ")}) — slack nobody measured is not a guardrail. Tighten it to the rule ` +
          `(x1.08, next hundred up) or recalibrate with a measurement that justifies the larger number.`
      );
      continue;
    }

    // 4 and 5. valid measurement, under the cap
    const m = measurements.get(name);
    if (!m) {
      problems.push(
        `profiles: '${name}' has no measurement in boot-measurements.jsonl — a cap without a measurement is a ` +
          `guess. Measure it and append the line.`
      );
      continue;
    }
    const currentSha = anchor(file);
    if (m.sha256 !== currentSha) {
      problems.push(
        `profiles: the measurement for '${name}' is for a different version of the file (measured ` +
          `${String(m.sha256).slice(0, 12)}, today ${currentSha.slice(0, 12)}) — remeasure instead of inheriting ` +
          `the old number.`
      );
      continue;
    }
    // Splitting the two accounts. An unbacked discount hides bloat the same way an unbacked
    // 'control' flag would: whoever splits leaves a trail of the ablation pair that measured it.
    let globalLoad = null;
    if (m.global_load !== undefined && m.global_load !== null) {
      if (typeof m.global_load !== "number" || !(m.global_load >= 0)) {
        problems.push(`profiles: measurement for '${name}' has a non-numeric 'global_load'`);
        continue;
      }
      // The backing is the ablation PAIR itself, not a string that merely looks like a
      // reference: splitting the two accounts takes two measurements (baseline and ablation),
      // so the source cites two boot-<log-id> entries. A loose regex would accept a single log
      // id, and the discount — which loosens line 1 by whatever value is claimed — would pass
      // with a fake backing.
      const logs = String(m.global_load_source || "").match(/boot-\d{8}-\d{6}/g) || [];
      if (new Set(logs).size < 2) {
        problems.push(
          `profiles: measurement for '${name}' discounts ${m.global_load} of global load without ` +
            `'global_load_source' citing the ablation PAIR (two boot-<YYYYMMDD-hhmmss> log ids: baseline and ` +
            `ablation) — an unbacked discount hides bloat`
        );
        continue;
      }
      if (m.global_load > m.total_tokens) {
        problems.push(
          `profiles: measurement for '${name}' discounted ${m.global_load} of global load from a total of ${m.total_tokens}`
        );
        continue;
      }
      globalLoad = m.global_load;
    } else {
      noSplit.push(name);
    }
    const profileTokens = globalLoad === null ? m.total_tokens : m.total_tokens - globalLoad;

    // 5b. SEMANTICS — checked before the three lines, on purpose. If the measurement started
    // splitting the global load but the cap was calibrated against the combined total (or the
    // reverse), the cap is neither tight nor loose: it is measuring something else. Judging
    // lines 1-3 against it would give a verdict with the wrong explanation. Here the verdict
    // STOPS and names the actual fix: recalibrate.
    const splitsToday = globalLoad !== null;
    if ((cal.global_load !== null) !== splitsToday) {
      problems.push(
        splitsToday
          ? `profiles: measurement for '${name}' started splitting the global load, and the cap is still ` +
            `calibrated against the combined total (calibrated_cap.at ${cal.at}) — the cap stopped being 1.08x ` +
            `of anything real. Recalibrate with the rule using the new measurement: cap ${rule(profileTokens)} ` +
            `(${profileTokens} of plugin tokens), total_cap ${rule(m.total_tokens)} (${m.total_tokens} of total), ` +
            `with calibrated_cap {at, measurement: ${m.total_tokens}, global_load: ${globalLoad}}.`
          : `profiles: '${name}' declares a cap calibrated WITH a global-load split, but the valid measurement ` +
            `does not split it (combined total) — the cap derives from an account the measurement does not ` +
            `report. Remeasure with an ablation pair or fix calibrated_cap.global_load to null.`
      );
      continue;
    }

    // 5c. STALE CALIBRATION — the valid measurement has moved and the cap is still the old
    // one. This does not fail the gate (a cap is a guardrail, and one stricter than the
    // minimum is legitimate), but it is reported: what the rule would derive today, so a cap
    // nobody revisits doesn't quietly describe the past.
    if (cal.measurement !== m.total_tokens) {
      warnings.push(
        `profiles: cap for '${name}' was calibrated on ${cal.at} against ${cal.measurement}, and today's valid ` +
          `measurement is ${m.total_tokens} — the rule would derive cap ${rule(profileTokens)} and total_cap ${rule(m.total_tokens)}.`
      );
    }

    // LINE 1 — profile cap: plugins only, the account that shrinks when you disable a plugin.
    if (profileTokens > cap) {
      problems.push(
        `profiles: '${name}' went over its boot budget — ${profileTokens} plugin tokens against a cap of ${cap} ` +
          `(measured on ${m.measured_at}). Remove a plugin from the profile or justify a higher cap.` +
          (globalLoad === null
            ? ` NOTE: this measurement does NOT split the two accounts, so the number charged includes the ` +
              `global load — it can grow without touching the profile's own anchor, and the overrun might not ` +
              `involve any plugin at all. Remeasure with an ablation pair before removing anything.`
            : "")
      );
      continue;
    }

    // LINE 2 — global load: its own lever (pruning), only fails once measured.
    if (globalLoad !== null && globalLoad > globalCap) {
      problems.push(
        `profiles: global load went over budget in the measurement for '${name}' — ${globalLoad} tokens against ` +
          `a cap of ${globalCap}. Plugins are toggled per profile; global load is pruned.`
      );
      continue;
    }

    // LINE 3 — sum cap: the real guardrail, because the window is one window.
    if (m.total_tokens > totalCap) {
      problems.push(
        `profiles: '${name}' went over the SUM cap — ${m.total_tokens} tokens against ${totalCap} ` +
          `(profile ${profileTokens} + global load ${globalLoad === null ? "not split" : globalLoad}). Both ` +
          `partial caps passed: the sum is what protects the window.`
      );
      continue;
    }

    const globalDetail = globalLoad === null ? "" : ` (+${globalLoad} of global load)`;
    ok.push(
      `profiles: '${name}' ${profileTokens}/${cap} plugin tokens${globalDetail}, sum ${m.total_tokens}/${totalCap}, ` +
        `${enabled.length} enabled plugin${enabled.length === 1 ? "" : "s"} with a written reason`
    );
  }

  if (noSplit.length) {
    warnings.push(
      `profiles: ${noSplit.length} measurement${noSplit.length === 1 ? " does" : "s do"} not split the global ` +
        `load (${noSplit.join(", ")}) — for ${noSplit.length === 1 ? "that profile" : "those profiles"} the ` +
        `plugin cap is charging the combined total. Remeasure with an ablation pair.`
    );
  }

  return { problems, ok, warnings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  // ANCHOR mode: prints the anchor of one profile file and exits. Exists so that whatever tool
  // produces the measurement log doesn't reimplement the hash on its own — a second
  // implementation, in another language, is exactly the kind of thing that quietly drifts.
  // One rule, one place.
  if (process.argv[2] === "--anchor") {
    const file = process.argv[3];
    if (!file) {
      console.error("usage: node src/budget.js --anchor <profile-file.json>");
      process.exit(2);
    }
    try {
      console.log(anchor(file));
      process.exit(0);
    } catch (e) {
      // Fail-closed, and the caller relies on this: whoever calls this writes a paid
      // measurement afterward.
      console.error(`anchor: could not compute for '${file}' (${e.message})`);
      process.exit(2);
    }
  }

  const root = process.argv[2] || DEFAULT_ROOT;
  const { problems, ok, warnings } = audit(root);
  for (const o of ok) console.log(`ok      ${o}`);
  for (const w of warnings) console.log(`warning ${w}`);
  for (const p of problems) console.log(`ERROR   ${p}`);
  if (problems.length) {
    console.log(`BUDGET: FAIL — ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
    process.exit(1);
  }
  console.log(
    `BUDGET: PASS — ${ok.length} profile${ok.length === 1 ? "" : "s"} under all three caps (plugins, ` +
      `global load, sum), every enabled plugin with a written reason` +
      (warnings.length ? `; ${warnings.length} warning${warnings.length === 1 ? "" : "s"}` : "")
  );
  process.exit(0);
}

export { audit, anchor, canonicalize, rule };
