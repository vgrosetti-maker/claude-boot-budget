import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { parseUsage, buildArgs, runProbe } from "./probe.js";

function fixtureResultLine(overrides = {}) {
  return JSON.stringify({
    type: "result",
    usage: {
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 250,
      ...overrides.usage,
    },
    total_cost_usd: 0.0123,
    ...overrides.top,
  });
}

// --- parseUsage --------------------------------------------------------------------------

test("parseUsage: reads the recipe (input + cache_creation + cache_read) from a single line", () => {
  const u = parseUsage(fixtureResultLine());
  assert.equal(u.input_tokens, 1000);
  assert.equal(u.cache_creation_input_tokens, 500);
  assert.equal(u.cache_read_input_tokens, 250);
  assert.equal(u.total_tokens, 1750);
  assert.equal(u.total_cost_usd, 0.0123);
});

test("parseUsage: picks the LAST type:result line when several appear", () => {
  const text = [
    JSON.stringify({ type: "system", subtype: "init" }),
    fixtureResultLine({ usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 } }),
    fixtureResultLine({ usage: { input_tokens: 42, cache_creation_input_tokens: 8, cache_read_input_tokens: 0 } }),
  ].join("\n");
  const u = parseUsage(text);
  assert.equal(u.total_tokens, 50);
});

test("parseUsage: ignores lines that aren't valid JSON (banners, partial output)", () => {
  const text = ["not json at all", fixtureResultLine()].join("\n");
  const u = parseUsage(text);
  assert.equal(u.total_tokens, 1750);
});

test("parseUsage: NEGATIVE — throws on empty output", () => {
  assert.throws(() => parseUsage(""), /no output lines/);
  assert.throws(() => parseUsage("   \n  \n"), /no output lines/);
});

test("parseUsage: NEGATIVE — throws when there is no type:result line (truncated session)", () => {
  const text = JSON.stringify({ type: "assistant", message: { content: [] } });
  assert.throws(() => parseUsage(text), /no 'type':'result' line/);
});

test("parseUsage: NEGATIVE — throws when the result line has no usage object", () => {
  const text = JSON.stringify({ type: "result", total_cost_usd: 0.01 });
  assert.throws(() => parseUsage(text), /no 'usage' object/);
});

test("parseUsage: NEGATIVE — throws when usage is missing a required field (never becomes zero)", () => {
  const text = JSON.stringify({
    type: "result",
    usage: { input_tokens: 10, cache_creation_input_tokens: 0 }, // cache_read_input_tokens absent
    total_cost_usd: 0.01,
  });
  assert.throws(() => parseUsage(text), /missing required field: cache_read_input_tokens/);
});

test("parseUsage: NEGATIVE — a null field counts as missing, not zero", () => {
  const text = JSON.stringify({
    type: "result",
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: null },
    total_cost_usd: 0.01,
  });
  assert.throws(() => parseUsage(text), /missing required field: cache_read_input_tokens/);
});

test("parseUsage: NEGATIVE — throws when total_cost_usd is absent", () => {
  const text = JSON.stringify({
    type: "result",
    usage: { input_tokens: 1, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 },
  });
  assert.throws(() => parseUsage(text), /no 'total_cost_usd'/);
});

// --- buildArgs -----------------------------------------------------------------------------

test("buildArgs: --strict-mcp-config first, then --settings, then scenario extras, by default", () => {
  const args = buildArgs({ settingsPath: "/tmp/profile.json", extra: ["--agents", "{}"] });
  assert.deepEqual(args, ["--strict-mcp-config", "--settings", "/tmp/profile.json", "--agents", "{}"]);
});

test("buildArgs: no settings path is a legitimate call (base acervo, whatever settings.json already applies)", () => {
  const args = buildArgs({});
  assert.deepEqual(args, ["--strict-mcp-config"]);
});

test("buildArgs: strictMcp:false drops the flag for a caller that explicitly wants MCP included", () => {
  const args = buildArgs({ settingsPath: "x.json", strictMcp: false });
  assert.deepEqual(args, ["--settings", "x.json"]);
});

// --- runProbe (spawn is injected — never shells out to a real CLI in tests) ----------------

function fakeSpawn({ stdout = "", stderr = "", code = 0, emitError = null }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (emitError) {
        child.emit("error", emitError);
        return;
      }
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    });
    return child;
  };
}

test("runProbe: resolves with parsed usage from the injected spawn's stdout", async () => {
  const spawnFn = fakeSpawn({ stdout: fixtureResultLine() + "\n" });
  const r = await runProbe({ spawnFn });
  assert.equal(r.usage.total_tokens, 1750);
  assert.equal(r.code, 0);
});

test("runProbe: NEGATIVE — rejects when settingsPath does not exist, without spawning anything", async () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    return fakeSpawn({ stdout: fixtureResultLine() })();
  };
  await assert.rejects(
    () => runProbe({ settingsPath: "/definitely/not/a/real/path.json", spawnFn }),
    /settings file not found/
  );
  assert.equal(spawned, false);
});

test("runProbe: NEGATIVE — rejects with stderr context when the CLI output can't be parsed", async () => {
  const spawnFn = fakeSpawn({ stdout: "garbage, no result line", stderr: "some CLI warning", code: 1 });
  await assert.rejects(() => runProbe({ spawnFn }), /no 'type':'result' line.*stderr: some CLI warning/s);
});

test("runProbe: NEGATIVE — rejects when the process itself errors (e.g. binary not found)", async () => {
  const spawnFn = fakeSpawn({ emitError: new Error("spawn claude ENOENT") });
  await assert.rejects(() => runProbe({ spawnFn }), /ENOENT/);
});

test("runProbe: cleans up its neutral temp working directory after a run", async () => {
  const dirsBefore = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("boot-probe-"));
  const spawnFn = fakeSpawn({ stdout: fixtureResultLine() });
  await runProbe({ spawnFn });
  const dirsAfter = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("boot-probe-"));
  assert.equal(dirsAfter.length, dirsBefore.length);
});

test("runProbe: passes settingsPath through to the CLI argv via the injected spawn", async () => {
  const settingsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "probe-fixture-")), "profile.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }));
  let seenArgs = null;
  const spawnFn = (bin, args) => {
    seenArgs = args;
    return fakeSpawn({ stdout: fixtureResultLine() })();
  };
  await runProbe({ settingsPath, spawnFn });
  assert.ok(seenArgs.includes("--settings"));
  assert.ok(seenArgs.includes(settingsPath));
  fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });
});

test("runProbe: NEGATIVE — the real CLI refuses --output-format=stream-json without --verbose, so argv must never combine them without it", async () => {
  let seenArgs = null;
  const spawnFn = (bin, args) => {
    seenArgs = args;
    return fakeSpawn({ stdout: fixtureResultLine() })();
  };
  await runProbe({ outputFormat: "stream-json", spawnFn });
  const hasStreamJson = seenArgs.includes("stream-json");
  const hasVerbose = seenArgs.includes("--verbose");
  assert.ok(hasStreamJson, "expected this run to actually request stream-json");
  assert.ok(hasVerbose, "stream-json without --verbose is rejected by the real `claude` binary");
});

test("runProbe: default output format never needs --verbose (confirmed against the real CLI: plain 'json' returns usage without it)", async () => {
  let seenArgs = null;
  const spawnFn = (bin, args) => {
    seenArgs = args;
    return fakeSpawn({ stdout: fixtureResultLine() })();
  };
  await runProbe({ spawnFn });
  assert.ok(seenArgs.includes("json"));
  assert.ok(!seenArgs.includes("stream-json"));
});
