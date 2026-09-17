#!/usr/bin/env node
/**
 * Two-sided test of the budget auditor — zero cost to run.
 *
 * House rule: a detector that never caught anything proves nothing. Every rule in budget.js
 * is proven here by deliberately breaking a fixture and requiring the auditor to catch it —
 * and the whole, unbroken fixture has to pass clean too.
 *
 * Everything happens in a temp folder: this test never reads or writes the shipped profiles/.
 *
 * Usage: node --test src/budget.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { audit, anchor } from "./budget.js";

const UNIVERSE = ["core-plugin@example", "browser-tools@example", "seo-toolkit@example"];

function writeProfile(dir, name, enabledIds) {
  const map = {};
  for (const id of UNIVERSE) map[id] = enabledIds.includes(id);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ enabledPlugins: map }, null, 2), "utf8");
  return file;
}

/** Sane fixture: two profiles, a reason per plugin, numeric caps, and matching measurements. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
  const fBase = writeProfile(dir, "base", ["core-plugin@example"]);
  const fSeo = writeProfile(dir, "seo", ["core-plugin@example", "seo-toolkit@example"]);

  fs.writeFileSync(
    path.join(dir, "budget.json"),
    JSON.stringify(
      {
        global_load: { cap: 12000 },
        profiles: {
          base: {
            usage: "floor profile",
            // Caps derived by the house rule from the measurement below (30,000, unsplit):
            // rule(30000) = 32,400 on both lines. A cap above that is a cap with no backing.
            cap: 32400,
            total_cap: 32400,
            calibrated_cap: { at: "2026-01-01", measurement: 30000, global_load: null },
            plugins: { "core-plugin@example": "always-on entry point for the session" },
          },
          seo: {
            usage: "seo audit",
            // 38,000 measured with 10,000 of global load: rule(28000) = 30,300 for the
            // profile and rule(38000) = 41,100 for the sum.
            cap: 30300,
            total_cap: 41100,
            calibrated_cap: { at: "2026-01-01", measurement: 38000, global_load: 10000 },
            plugins: {
              "core-plugin@example": "floor: seo tooling depends on it",
              "seo-toolkit@example": "the seo plugin itself",
            },
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );

  // The anchor comes from the module, never reimplemented here: a fixture that computes its
  // own hash would test the copy, and any drift between the two would go unnoticed.
  const sha = (f) => anchor(f);
  const measurement = (profile, file, total, extra = {}) =>
    JSON.stringify({
      profile,
      extras: [],
      sha256: sha(file),
      total_tokens: total,
      measured_at: "2026-01-01",
      ...extra,
    });
  fs.writeFileSync(
    path.join(dir, "boot-measurements.jsonl"),
    [
      // 'base' does not split the global load: exercises the conservative path (the profile
      // cap charges the sum) and the aggregate warning.
      measurement("base", fBase, 30000),
      // 'seo' splits, with backing: 28,000 plugin + 10,000 global load.
      measurement("seo", fSeo, 38000, {
        global_load: 10000,
        global_load_source: "ablation pair boot-20260101-000000 x boot-20260101-000001",
      }),
    ].join("\n") + "\n",
    "utf8"
  );
  return dir;
}

function withFixture(fn) {
  const dir = fixture();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Breaks the fixture and returns the problems the auditor reports. */
function broken(fn) {
  return withFixture((dir) => {
    fn(dir);
    return audit(dir).problems;
  });
}
const flags = (probs, term) => probs.some((p) => p.includes(term));

// --- side 1: the sane fixture passes clean -----------------------------------------------
test("sane fixture: zero problems, reports both profiles", () => {
  const { problems, ok } = withFixture((dir) => audit(dir));
  assert.equal(problems.length, 0, problems.join(" | "));
  assert.equal(ok.length, 2);
});

// --- side 2: every rule catches when broken ------------------------------------------------
test("1a: universe id omitted from a profile", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    delete j.enabledPlugins["browser-tools@example"];
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "does not declare"), p.join(" | "));
});

test("1b: id outside the universe (silent no-op)", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    j.enabledPlugins["made-up@nowhere"] = true;
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "outside base.json's universe"), p.join(" | "));
});

test("2a: plugin enabled without a written reason", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    j.enabledPlugins["browser-tools@example"] = true; // enabled, no reason written
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "without a written reason"), p.join(" | "));
});

test("2b: orphan reason (line without a plugin)", () => {
  const p = broken((dir) => {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"));
    o.profiles.seo.plugins["browser-tools@example"] = "reason for a plugin the profile does not enable";
    fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify(o, null, 2), "utf8");
  });
  assert.ok(flags(p, "does not enable"), p.join(" | "));
});

test("3a: missing cap is a fake gate", () => {
  const p = broken((dir) => {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"));
    o.profiles.seo.cap = null;
    fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify(o, null, 2), "utf8");
  });
  assert.ok(flags(p, "no numeric cap"), p.join(" | "));
});

test("3b: profile on disk with no budget.json entry", () => {
  const p = broken((dir) => writeProfile(dir, "site", ["core-plugin@example"]));
  assert.ok(flags(p, "has no entry"), p.join(" | "));
});

test("3c: budget.json describes a profile that does not exist", () => {
  const p = broken((dir) => {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"));
    o.profiles.ghost = { usage: "x", cap: 1000, plugins: {} };
    fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify(o, null, 2), "utf8");
  });
  assert.ok(flags(p, "does not exist on disk"), p.join(" | "));
});

// LF, CR and BOM built by code, never by literal escape: this file passes through editors and
// line-ending normalization, so a hand-typed CR is the first thing that disappears — the test
// for the EOL defect can't depend on the EOL of the test file itself.
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const BOM = String.fromCharCode(0xfeff);
const toLf = (t) => t.split(CRLF).join(LF);

// 4a-4d. The anchor is CONTENT, never bytes.
test("4a: reindenting does NOT invalidate the measurement", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 4), "utf8");
  });
  assert.ok(!flags(p, "different version of the file"), p.join(" | "));
});

test("4b: CRLF does NOT invalidate the measurement", () => {
  const p = broken((dir) => {
    const t = fs.readFileSync(path.join(dir, "seo.json"), "utf8");
    fs.writeFileSync(path.join(dir, "seo.json"), toLf(t).split(LF).join(CRLF), "utf8");
  });
  assert.ok(!flags(p, "different version of the file"), p.join(" | "));
});

test("4c: LF does NOT invalidate the measurement", () => {
  const p = broken((dir) => {
    const t = fs.readFileSync(path.join(dir, "seo.json"), "utf8");
    fs.writeFileSync(path.join(dir, "seo.json"), toLf(t), "utf8");
  });
  assert.ok(!flags(p, "different version of the file"), p.join(" | "));
});

test("4d: BOM does NOT invalidate the measurement", () => {
  const p = broken((dir) => {
    const t = fs.readFileSync(path.join(dir, "seo.json"), "utf8");
    fs.writeFileSync(path.join(dir, "seo.json"), BOM + t, "utf8");
  });
  assert.ok(!flags(p, "different version of the file"), p.join(" | "));
});

// The counter-case that stops the anchor check from becoming a sieve: it still has to catch
// what actually changes a boot token. Without this, an anchor function that always returned a
// constant would pass 4a-4d and nobody would notice.
test("4e: a DISABLED plugin invalidates the measurement", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    j.enabledPlugins["seo-toolkit@example"] = false;
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "different version of the file"), p.join(" | "));
});

test("4f: an ADDED plugin invalidates the measurement", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    j.enabledPlugins["new-plugin@x"] = true;
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "different version of the file"), p.join(" | "));
});

test("4g: a RENAMED plugin invalidates the measurement", () => {
  const p = broken((dir) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "seo.json"), "utf8"));
    const v = j.enabledPlugins["seo-toolkit@example"];
    delete j.enabledPlugins["seo-toolkit@example"];
    j.enabledPlugins["seo-toolkit@other-owner"] = v;
    fs.writeFileSync(path.join(dir, "seo.json"), JSON.stringify(j, null, 2), "utf8");
  });
  assert.ok(flags(p, "different version of the file"), p.join(" | "));
});

test("4h: a profile with no measurement at all", () => {
  const p = broken((dir) => {
    const l = fs.readFileSync(path.join(dir, "boot-measurements.jsonl"), "utf8").split("\n").filter((x) => x.trim());
    fs.writeFileSync(path.join(dir, "boot-measurements.jsonl"), l[0] + "\n", "utf8"); // drop seo's
  });
  assert.ok(flags(p, "no measurement"), p.join(" | "));
});

test("4i: missing measurements file BLOCKS (fail-closed)", () => {
  const p = broken((dir) => fs.rmSync(path.join(dir, "boot-measurements.jsonl")));
  assert.ok(flags(p, "boot-measurements.jsonl"), p.join(" | "));
});

test("5: boot above the cap fails the gate", () => {
  const p = broken((dir) => {
    const o = JSON.parse(fs.readFileSync(path.join(dir, "budget.json"), "utf8"));
    o.profiles.seo.cap = 100; // profile bloated past its cap
    fs.writeFileSync(path.join(dir, "budget.json"), JSON.stringify(o, null, 2), "utf8");
  });
  assert.ok(flags(p, "went over its boot budget"), p.join(" | "));
});

// --- the THREE lines -------------------------------------------------------------------
/** Rewrites a profile's measurement in the fixture's jsonl. */
function remeasure(dir, profile, patch) {
  const file = path.join(dir, "boot-measurements.jsonl");
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((x) => x.trim())
    .map((l) => {
      const m = JSON.parse(l);
      return m.profile === profile ? JSON.stringify({ ...m, ...patch }) : l;
    });
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}
/** Like broken(), but returns the whole result (warnings included). */
function brokenAll(fn) {
  return withFixture((dir) => {
    fn(dir);
    return audit(dir);
  });
}
function editBudget(dir, fn) {
  const file = path.join(dir, "budget.json");
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  fn(o);
  fs.writeFileSync(file, JSON.stringify(o, null, 2), "utf8");
}

test("6a: global load above its cap fails when measured", () => {
  const p = broken((dir) => remeasure(dir, "seo", { global_load: 12500 }));
  assert.ok(flags(p, "global load went over budget"), p.join(" | "));
});

test("6b: global-load cap of null BLOCKS once it's been measured", () => {
  const r = brokenAll((dir) => {
    editBudget(dir, (o) => {
      o.global_load.cap = null;
    });
    remeasure(dir, "seo", { global_load: 12500 });
  });
  assert.ok(flags(r.problems, "must be a positive number"), r.problems.join(" | "));
  assert.ok(flags(r.problems, "disables the global-load cap"), r.problems.join(" | "));
});

test("6b+: global load exactly at the cap does NOT fail", () => {
  const r = brokenAll((dir) => remeasure(dir, "seo", { global_load: 12000 }));
  assert.ok(!flags(r.problems, "global load went over budget"), r.problems.join(" | "));
});

test("7a: sum over budget even with both partial caps green", () => {
  // 39,000 of plugin (cap 40,000) and 11,000 of global load (cap 12,000) sum to 50,000
  // against a sum cap of 45,000 — the case the two partial caps alone would miss.
  const r = brokenAll((dir) => {
    editBudget(dir, (o) => {
      o.profiles.seo.cap = 42200;
      o.profiles.seo.total_cap = 45000;
      o.profiles.seo.calibrated_cap = { at: "2026-02-01", measurement: 50000, global_load: 11000 };
    });
    remeasure(dir, "seo", { total_tokens: 50000, global_load: 11000 });
  });
  assert.ok(flags(r.problems, "went over the SUM cap"), r.problems.join(" | "));
  assert.ok(!flags(r.problems, "went over its boot budget"), r.problems.join(" | "));
  assert.ok(!flags(r.problems, "global load went over budget"), r.problems.join(" | "));
});

test("7b: missing total_cap is a fake gate", () => {
  const p = broken((dir) => editBudget(dir, (o) => delete o.profiles.seo.total_cap));
  assert.ok(flags(p, "no numeric total_cap"), p.join(" | "));
});

test("7c: global-load discount without backing", () => {
  const p = broken((dir) => remeasure(dir, "base", { global_load: 5000 }));
  assert.ok(flags(p, "'global_load_source'"), p.join(" | "));
});

test("7d: discount larger than the measured total", () => {
  const p = broken((dir) => remeasure(dir, "seo", { global_load: 99999 }));
  assert.ok(flags(p, "discounted"), p.join(" | "));
});

// The 'control' flag removes a measurement from the verdict, so it's a door: without a cited
// ticket, any amount of bloat could leave the accounting in silence.
function append(dir, obj) {
  fs.appendFileSync(path.join(dir, "boot-measurements.jsonl"), JSON.stringify(obj) + "\n", "utf8");
}
test("8a: 'control' without a cited ticket", () => {
  const p = broken((dir) => {
    const sha = anchor(path.join(dir, "seo.json"));
    append(dir, { profile: "seo", extras: [], sha256: sha, total_tokens: 99999, control: "some experiment" });
  });
  assert.ok(flags(p, "without citing a ticket"), p.join(" | "));
});

test("8b: 'control' with a cited ticket leaves the verdict and does not fail", () => {
  const r = brokenAll((dir) => {
    const sha = anchor(path.join(dir, "seo.json"));
    append(dir, { profile: "seo", extras: [], sha256: sha, total_tokens: 99999, control: "ticket #79: ablation" });
  });
  assert.equal(r.problems.length, 0, r.problems.join(" | "));
});

test("6c: missing global_load block BLOCKS (line 2 can't silently disappear)", () => {
  const p = broken((dir) => editBudget(dir, (o) => delete o.global_load));
  assert.ok(flags(p, "no 'global_load' block"), p.join(" | "));
});

test("6d: non-numeric global_load.cap BLOCKS", () => {
  const p = broken((dir) =>
    editBudget(dir, (o) => {
      o.global_load.cap = "12000";
    })
  );
  assert.ok(flags(p, "must be a positive number"), p.join(" | "));
});

test("6d2: zero cap BLOCKS (0 is absence wearing a number's clothes)", () => {
  const p = broken((dir) =>
    editBudget(dir, (o) => {
      o.global_load.cap = 0;
    })
  );
  assert.ok(flags(p, "must be a positive number"), p.join(" | "));
});

// A string that merely looks like a reference would unlock any discount, and the discount
// loosens line 1 directly. The ablation pair is TWO logs.
test("7e: backing without the ablation pair", () => {
  const p = broken((dir) => remeasure(dir, "seo", { global_load_source: "boot-1" }));
  assert.ok(flags(p, "ablation PAIR"), p.join(" | "));
});

test("7f: the same log cited twice is not a pair", () => {
  const p = broken((dir) =>
    remeasure(dir, "seo", { global_load_source: "boot-20260101-000000 and boot-20260101-000000" })
  );
  assert.ok(flags(p, "ablation PAIR"), p.join(" | "));
});

test("missing base.json: BLOCKS instead of warning", () => {
  const p = broken((dir) => fs.rmSync(path.join(dir, "base.json")));
  assert.ok(flags(p, "base.json is missing"), p.join(" | "));
});

test("missing budget.json: BLOCKS", () => {
  const p = broken((dir) => fs.rmSync(path.join(dir, "budget.json")));
  assert.ok(flags(p, "budget.json is missing"), p.join(" | "));
});

test("broken JSON: BLOCKS", () => {
  const p = broken((dir) => fs.writeFileSync(path.join(dir, "seo.json"), "{ this is not json", "utf8"));
  assert.ok(flags(p, "unreadable"), p.join(" | "));
});

test("nonexistent folder: BLOCKS", () => {
  const p = audit(path.join(os.tmpdir(), "folder-that-does-not-exist-" + Date.now())).problems;
  assert.ok(p.length > 0);
});

// --- the cap declares the measurement that produced it ------------------------------------
const PAIR = "ablation pair boot-20260201-000000 x boot-20260201-000001";

test("9a: cap with no 'calibrated_cap' BLOCKS", () => {
  const p = broken((dir) => editBudget(dir, (o) => delete o.profiles.seo.calibrated_cap));
  assert.ok(flags(p, "no valid 'calibrated_cap'"), p.join(" | "));
});

test("9b: missing 'global_load' in the calibration BLOCKS (null is a declaration, not an omission)", () => {
  const p = broken((dir) =>
    editBudget(dir, (o) => {
      o.profiles.seo.calibrated_cap = { at: "2026-01-01", measurement: 38000 };
    })
  );
  assert.ok(flags(p, "no valid 'calibrated_cap'"), p.join(" | "));
});

test("9c: measurement started splitting and the cap was not recalibrated", () => {
  const p = broken((dir) => remeasure(dir, "base", { global_load: 5000, global_load_source: PAIR }));
  assert.ok(flags(p, "started splitting the global load"), p.join(" | "));
  assert.ok(flags(p, "cap 27000"), p.join(" | ")); // 25,000 of plugin -> 27,000
});

test("9d: cap calibrated with a split and the measurement does not split", () => {
  const p = broken((dir) => remeasure(dir, "seo", { global_load: null }));
  assert.ok(flags(p, "calibrated WITH a global-load split"), p.join(" | "));
  assert.ok(!flags(p, "went over its boot budget"), p.join(" | "));
});

test("9e: cap one hundred above the rule is a cap with no backing", () => {
  const p = broken((dir) =>
    editBudget(dir, (o) => {
      o.profiles.base.cap = 32500;
    })
  );
  assert.ok(flags(p, "above what the rule derives"), p.join(" | "));
});

test("9f: total_cap above the rule, same story", () => {
  const p = broken((dir) =>
    editBudget(dir, (o) => {
      o.profiles.seo.total_cap = 41200;
    })
  );
  assert.ok(flags(p, "total_cap 41200 vs. 41100"), p.join(" | "));
});

test("9g: cap below the rule passes clean (a stricter-than-minimum cap is legitimate)", () => {
  const r = brokenAll((dir) =>
    editBudget(dir, (o) => {
      o.profiles.base.cap = 31000;
    })
  );
  assert.equal(r.problems.length, 0, r.problems.join(" | "));
});

test("9h: fresh measurement over a stale cap does not fail, just warns", () => {
  const r = brokenAll((dir) => remeasure(dir, "base", { total_tokens: 31000 }));
  assert.equal(r.problems.length, 0, r.problems.join(" | "));
  assert.ok(
    r.warnings.some((w) => w.includes("calibrated on 2026-01-01 against 30000") && w.includes("33500")),
    r.warnings.join(" | ")
  );
});

test("9i: overrun in an unsplit measurement is caught, with the caveat about global load", () => {
  const p = broken((dir) => remeasure(dir, "base", { total_tokens: 42079 }));
  assert.ok(flags(p, "went over its boot budget"), p.join(" | "));
  assert.ok(flags(p, "does NOT split the two accounts"), p.join(" | "));
  const pSplit = broken((dir) => remeasure(dir, "seo", { total_tokens: 99000 }));
  assert.ok(!flags(pSplit, "does NOT split the two accounts"));
});
