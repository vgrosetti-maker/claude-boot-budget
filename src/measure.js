#!/usr/bin/env node
/**
 * Measures the boot cost of a session profile by ablation and appends the result to
 * `profiles/boot-measurements.jsonl`, in the exact shape `src/budget.js` audits against.
 *
 * "By ablation" means: the number that matters is never a session in isolation, it's the
 * DIFFERENCE between two sessions that differ in exactly one thing (a plugin on vs. off, or
 * the global load present vs. emptied out). This file does not run the ablation PAIR itself
 * — that decision (what to turn off, whether it's safe to empty out global load on this
 * machine) belongs to the caller. What this file guarantees is that a discount never enters
 * the record without a citation of the two boot-<log-id>s that backed it, the same rule
 * `budget.js` enforces on read.
 *
 * Preserves the invalidation semantics from the profile format: the line this writes is
 * anchored to the CANONICAL content of the profile file (see `anchor()` in `./budget.js`),
 * so editing the profile after measuring it does not silently keep the old number — the next
 * audit sees a stale anchor and demands a remeasurement instead of inheriting hearsay.
 *
 * Plugin/skill discovery is automatic, never a hardcoded list: the universe under ablation is
 * whatever `profiles/base.json` declares in `enabledPlugins` — the same file `budget.js`
 * already treats as the one file obligated to list everyone.
 *
 * SPENDS REAL CREDIT: measureProfile() runs a real probe (see ./probe.js) unless a `probeFn` stub
 * is injected (that's how the test suite exercises this without spending anything).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { anchor } from "./budget.js";
import { runProbe } from "./probe.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.join(__dirname, "..", "profiles");
const NON_PROFILE_FILES = new Set(["budget.json"]);

/** Profile names on disk, alphabetical — the only place this is allowed to be a hardcoded list. */
export function discoverProfiles(profilesDir = DEFAULT_ROOT) {
  if (!fs.existsSync(profilesDir)) {
    throw new Error(`measure: profiles folder ${profilesDir} does not exist`);
  }
  return fs
    .readdirSync(profilesDir)
    .filter((f) => f.endsWith(".json") && !NON_PROFILE_FILES.has(f))
    .map((f) => path.basename(f, ".json"))
    .sort();
}

/**
 * Every plugin id the profiles know about, read from base.json — never a list maintained by
 * hand here. base.json is the one file required to declare the full universe (all false but
 * the floor), the same contract `budget.js` already relies on for its closed-universe check.
 */
export function discoverPluginUniverse(profilesDir = DEFAULT_ROOT) {
  const basePath = path.join(profilesDir, "base.json");
  if (!fs.existsSync(basePath)) {
    throw new Error(`measure: ${basePath} is missing — no plugin universe to ablate against`);
  }
  const j = JSON.parse(fs.readFileSync(basePath, "utf8").replace(/^﻿/, ""));
  if (!j.enabledPlugins) {
    throw new Error(`measure: ${basePath} has no 'enabledPlugins'`);
  }
  return Object.keys(j.enabledPlugins);
}

/**
 * Validates the (globalLoad, globalLoadSource) pair BEFORE any credit is spent: the two travel
 * together (one without the other hides a discount with no backing), and the source has to
 * name the ablation PAIR — two distinct boot-<YYYYMMDD-hhmmss> log ids — not just something
 * that looks like a citation. Mirrors the check `budget.js` runs on read, so a bad pair never
 * gets as far as a paid probe.
 */
export function assertGlobalLoadPair(globalLoad, globalLoadSource) {
  const hasLoad = globalLoad !== undefined && globalLoad !== null;
  const hasSource = Boolean(globalLoadSource);
  if (hasLoad !== hasSource) {
    throw new Error(
      "measure: globalLoad and globalLoadSource travel together — pass both or neither. A discount with " +
        "no written backing hides bloat."
    );
  }
  if (!hasLoad) return false;
  if (typeof globalLoad !== "number" || !(globalLoad >= 0)) {
    throw new Error(`measure: globalLoad must be a non-negative number, got ${JSON.stringify(globalLoad)}`);
  }
  const logs = new Set(String(globalLoadSource).match(/boot-\d{8}-\d{6}/g) || []);
  if (logs.size < 2) {
    throw new Error(
      `measure: globalLoadSource must cite the ablation PAIR — two distinct boot-<YYYYMMDD-hhmmss> log ids ` +
        `(baseline and ablation). Found ${logs.size}.`
    );
  }
  return true;
}

/** Builds one boot-measurements.jsonl line in the shape budget.js's readMeasurements() expects. */
export function formatMeasurementLine({
  profile,
  extras = [],
  settingsPath,
  usage,
  measuredAt,
  globalLoad,
  globalLoadSource,
  control,
}) {
  if (!profile) throw new Error("measure: formatMeasurementLine needs 'profile'");
  if (!usage || typeof usage.total_tokens !== "number") {
    throw new Error("measure: formatMeasurementLine needs usage.total_tokens");
  }
  const line = {
    profile,
    extras: [...extras],
    sha256: anchor(settingsPath),
    total_tokens: usage.total_tokens,
    measured_at: measuredAt || new Date().toISOString().slice(0, 10),
  };
  const splits = assertGlobalLoadPair(globalLoad, globalLoadSource);
  if (splits) {
    line.global_load = globalLoad;
    line.global_load_source = globalLoadSource;
  }
  if (control) line.control = control;
  return line;
}

/** Append-only, on purpose: the measurement history is what shows a profile bloating over time. */
export function appendMeasurement(measurementsPath, line) {
  fs.appendFileSync(measurementsPath, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Measures ONE profile (optionally with `+plugin` extras layered on) and appends the line.
 * Fail-closed like the PowerShell original: unknown profile stops before any credit is spent,
 * and an unbacked global-load pair stops before the probe runs, not after.
 */
export async function measureProfile({
  profilesDir = DEFAULT_ROOT,
  profile,
  extra = [],
  globalLoad,
  globalLoadSource,
  control,
  claudeBin = "claude",
  probeFn = runProbe,
} = {}) {
  if (!profile) {
    throw new Error(
      "measure: no profile named — an absent target is a stop, not a request to measure all of them"
    );
  }
  const names = discoverProfiles(profilesDir);
  if (!names.includes(profile)) {
    throw new Error(`measure: unknown profile '${profile}'. Available: ${names.join(", ")}`);
  }
  assertGlobalLoadPair(globalLoad, globalLoadSource); // stop BEFORE spending, not after

  const settingsPath = path.join(profilesDir, `${profile}.json`);
  const result = await probeFn({ settingsPath, extra, claudeBin });

  const line = formatMeasurementLine({
    profile,
    extras: extra,
    settingsPath,
    usage: result.usage,
    globalLoad,
    globalLoadSource,
    control,
  });

  const measurementsPath = path.join(profilesDir, "boot-measurements.jsonl");
  appendMeasurement(measurementsPath, line);
  return { line, measurementsPath, cost_usd: result.usage.total_cost_usd };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const profile = args[0];
  const sim = args.includes("--sim");
  const profilesDir = args.find((a, i) => i > 0 && !a.startsWith("--")) || DEFAULT_ROOT;

  if (!profile || profile.startsWith("--")) {
    let names = [];
    try {
      names = discoverProfiles(profilesDir);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    console.log(`Profiles on disk: ${names.join(", ")}`);
    console.log("");
    console.log("NOTHING WAS RUN. Name one profile to measure — leaving the target out is a stop here,");
    console.log("not a request to measure all of them:");
    console.log("  node src/measure.js <profile> --sim");
    process.exit(1);
  }
  if (!sim) {
    console.log(`This would measure profile '${profile}' with one real headless session (prompt: 'ok').`);
    console.log("");
    console.log("NOTHING WAS RUN. Add --sim to run the measurement for real. It spends credit.");
    process.exit(0);
  }
  measureProfile({ profilesDir, profile })
    .then(({ line, measurementsPath, cost_usd }) => {
      console.log(JSON.stringify(line, null, 2));
      console.log(`Appended to ${measurementsPath}. This run cost US$ ${cost_usd}.`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`measure: ${e.message}`);
      process.exit(1);
    });
}

export { DEFAULT_ROOT };
