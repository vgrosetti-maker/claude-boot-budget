import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { anchor } from "./budget.js";
import {
  discoverProfiles,
  discoverPluginUniverse,
  assertGlobalLoadPair,
  formatMeasurementLine,
  appendMeasurement,
  measureProfile,
} from "./measure.js";

// Fixture profiles dir — synthetic, never anyone's real measurements. Fresh tmp dir per
// test so appends in one test can't leak into another.
function makeFixtureProfilesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-budget-fixture-"));
  fs.writeFileSync(
    path.join(dir, "base.json"),
    JSON.stringify({ enabledPlugins: { "widget-a@example-org": false, "widget-b@example-org": true } })
  );
  fs.writeFileSync(
    path.join(dir, "light.json"),
    JSON.stringify({ enabledPlugins: { "widget-a@example-org": false, "widget-b@example-org": true } })
  );
  fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify({ profiles: {} }));
  return dir;
}

// --- discoverProfiles / discoverPluginUniverse (no hardcoded list of ours) -----------------

test("discoverProfiles: lists profile names from disk, alphabetical, budget.json excluded", () => {
  const dir = makeFixtureProfilesDir();
  assert.deepEqual(discoverProfiles(dir), ["base", "light"]);
});

test("discoverProfiles: NEGATIVE — throws when the folder does not exist", () => {
  assert.throws(() => discoverProfiles("/definitely/not/a/real/dir"), /does not exist/);
});

test("discoverPluginUniverse: reads the universe from base.json, not a fixed list", () => {
  const dir = makeFixtureProfilesDir();
  assert.deepEqual(discoverPluginUniverse(dir).sort(), ["widget-a@example-org", "widget-b@example-org"]);
});

test("discoverPluginUniverse: NEGATIVE — throws when base.json is missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-budget-empty-"));
  assert.throws(() => discoverPluginUniverse(dir), /is missing/);
});

test("discoverPluginUniverse: NEGATIVE — throws when base.json has no enabledPlugins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-budget-bad-base-"));
  fs.writeFileSync(path.join(dir, "base.json"), JSON.stringify({}));
  assert.throws(() => discoverPluginUniverse(dir), /no 'enabledPlugins'/);
});

// --- assertGlobalLoadPair -------------------------------------------------------------------

test("assertGlobalLoadPair: a well-formed ablation pair (two distinct log ids) passes", () => {
  const splits = assertGlobalLoadPair(
    9500,
    "ablation pair boot-20260101-090000 (baseline) x boot-20260101-090500 (ablation)"
  );
  assert.equal(splits, true);
});

test("assertGlobalLoadPair: no globalLoad at all is a legitimate 'not splitting' call", () => {
  assert.equal(assertGlobalLoadPair(undefined, undefined), false);
});

test("assertGlobalLoadPair: NEGATIVE — globalLoad without a source", () => {
  assert.throws(() => assertGlobalLoadPair(9500, undefined), /travel together/);
});

test("assertGlobalLoadPair: NEGATIVE — source without a globalLoad", () => {
  assert.throws(() => assertGlobalLoadPair(undefined, "boot-20260101-090000 boot-20260101-090500"), /travel together/);
});

test("assertGlobalLoadPair: NEGATIVE — negative globalLoad", () => {
  assert.throws(() => assertGlobalLoadPair(-1, "boot-20260101-090000 boot-20260101-090500"), /non-negative number/);
});

test("assertGlobalLoadPair: NEGATIVE — source cites only ONE log id, not the pair", () => {
  assert.throws(() => assertGlobalLoadPair(9500, "only boot-20260101-090000 here"), /ablation PAIR/);
});

test("assertGlobalLoadPair: NEGATIVE — source cites the same log id twice (not a pair, a repeat)", () => {
  assert.throws(
    () => assertGlobalLoadPair(9500, "boot-20260101-090000 and boot-20260101-090000 again"),
    /ablation PAIR/
  );
});

// --- formatMeasurementLine — must match the exact shape budget.js's readMeasurements() reads ---

test("formatMeasurementLine: shape matches what budget.js expects, anchored to the profile file", () => {
  const dir = makeFixtureProfilesDir();
  const settingsPath = path.join(dir, "light.json");
  const line = formatMeasurementLine({
    profile: "light",
    extras: [],
    settingsPath,
    usage: { total_tokens: 21500 },
    measuredAt: "2026-01-01",
  });
  assert.equal(line.profile, "light");
  assert.deepEqual(line.extras, []);
  assert.equal(line.sha256, anchor(settingsPath));
  assert.equal(line.total_tokens, 21500);
  assert.equal(line.measured_at, "2026-01-01");
  assert.equal(line.global_load, undefined);
});

test("formatMeasurementLine: splits global_load + global_load_source when a backed pair is given", () => {
  const dir = makeFixtureProfilesDir();
  const line = formatMeasurementLine({
    profile: "light",
    settingsPath: path.join(dir, "light.json"),
    usage: { total_tokens: 21500 },
    globalLoad: 9500,
    globalLoadSource: "boot-20260101-090000 x boot-20260101-090500",
  });
  assert.equal(line.global_load, 9500);
  assert.match(line.global_load_source, /boot-20260101-090000/);
});

test("formatMeasurementLine: editing the profile after formatting changes the anchor (invalidation semantics)", () => {
  const dir = makeFixtureProfilesDir();
  const settingsPath = path.join(dir, "light.json");
  const before = formatMeasurementLine({ profile: "light", settingsPath, usage: { total_tokens: 100 } });
  fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "widget-a@example-org": true, "widget-b@example-org": true } }));
  const after = formatMeasurementLine({ profile: "light", settingsPath, usage: { total_tokens: 100 } });
  assert.notEqual(before.sha256, after.sha256);
});

test("formatMeasurementLine: NEGATIVE — no profile named", () => {
  assert.throws(() => formatMeasurementLine({ settingsPath: "x.json", usage: { total_tokens: 1 } }), /needs 'profile'/);
});

test("formatMeasurementLine: NEGATIVE — usage without total_tokens", () => {
  assert.throws(() => formatMeasurementLine({ profile: "light", settingsPath: "x.json", usage: {} }), /needs usage.total_tokens/);
});

// --- appendMeasurement — append-only history ------------------------------------------------

test("appendMeasurement: appends a JSONL line without touching what was already there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-budget-append-"));
  const file = path.join(dir, "boot-measurements.jsonl");
  appendMeasurement(file, { profile: "base", total_tokens: 100 });
  appendMeasurement(file, { profile: "light", total_tokens: 200 });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].profile, "base");
  assert.equal(lines[1].profile, "light");
});

// --- measureProfile — orchestration, with an injected probeFn (never spends credit in tests) ---

test("measureProfile: probes, anchors and appends the line for a known profile", async () => {
  const dir = makeFixtureProfilesDir();
  let seenSettingsPath = null;
  const probeFn = async ({ settingsPath }) => {
    seenSettingsPath = settingsPath;
    return { usage: { total_tokens: 12000, total_cost_usd: 0.03 } };
  };
  const { line, measurementsPath, cost_usd } = await measureProfile({
    profilesDir: dir,
    profile: "light",
    probeFn,
  });
  assert.equal(seenSettingsPath, path.join(dir, "light.json"));
  assert.equal(line.profile, "light");
  assert.equal(line.total_tokens, 12000);
  assert.equal(cost_usd, 0.03);
  assert.equal(fs.existsSync(measurementsPath), true);
  const stored = JSON.parse(fs.readFileSync(measurementsPath, "utf8").trim());
  assert.equal(stored.sha256, line.sha256);
});

test("measureProfile: NEGATIVE — no profile named stops before probing", async () => {
  const dir = makeFixtureProfilesDir();
  let probed = false;
  const probeFn = async () => {
    probed = true;
    return { usage: { total_tokens: 1, total_cost_usd: 0 } };
  };
  await assert.rejects(() => measureProfile({ profilesDir: dir, probeFn }), /absent target is a stop/);
  assert.equal(probed, false);
});

test("measureProfile: NEGATIVE — unknown profile stops before probing (fail-closed, before any credit)", async () => {
  const dir = makeFixtureProfilesDir();
  let probed = false;
  const probeFn = async () => {
    probed = true;
    return { usage: { total_tokens: 1, total_cost_usd: 0 } };
  };
  await assert.rejects(() => measureProfile({ profilesDir: dir, profile: "ghost", probeFn }), /unknown profile 'ghost'/);
  assert.equal(probed, false);
});

test("measureProfile: NEGATIVE — unbacked globalLoad stops before probing", async () => {
  const dir = makeFixtureProfilesDir();
  let probed = false;
  const probeFn = async () => {
    probed = true;
    return { usage: { total_tokens: 1, total_cost_usd: 0 } };
  };
  await assert.rejects(
    () => measureProfile({ profilesDir: dir, profile: "light", globalLoad: 500, probeFn }),
    /travel together/
  );
  assert.equal(probed, false);
});

test("measureProfile: appends multiple lines across calls (history, not overwrite)", async () => {
  const dir = makeFixtureProfilesDir();
  const probeFn = async () => ({ usage: { total_tokens: 100, total_cost_usd: 0.01 } });
  await measureProfile({ profilesDir: dir, profile: "base", probeFn });
  await measureProfile({ profilesDir: dir, profile: "light", probeFn });
  const lines = fs
    .readFileSync(path.join(dir, "boot-measurements.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.profile), ["base", "light"]);
});
