#!/usr/bin/env node
/**
 * Boot probe: runs ONE real headless Claude Code session with a minimal prompt and reads
 * back the token usage that paid for the boot itself, before the first real word of a task.
 *
 * This is deliberately narrow. It does not classify what a session did, does not compare
 * against a frozen baseline, does not decide a pass/fail verdict, and does not know what a
 * "scenario" or a "routing case" is — those are workflow concerns for whatever project
 * embeds this tool. This file only answers one question: for this settings file (or none),
 * what did the boot cost?
 *
 * Recipe, always this and only this:
 *   total_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * read from the LAST `type:result` line of the CLI's output. A missing field throws instead
 * of silently becoming zero — a number that can't be trusted is worse than no number.
 *
 * SPENDS REAL CREDIT: runProbe() spawns a real `claude` process. parseUsage() and buildArgs()
 * are pure and free to call as often as you like.
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

const RECIPE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

/**
 * Reads token usage from raw CLI output (one JSON object per line, or a single JSON object).
 * Picks the LAST line with `type: "result"` — a stream can carry more than one, and only the
 * last one is the final tally. Throws (never returns zero) when the shape is short a field:
 * a log truncated mid-session is a worse foundation for a number than no number at all.
 */
export function parseUsage(rawText) {
  const lines = String(rawText)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) {
    throw new Error("probe: no output lines to read");
  }

  let result = null;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // stderr noise, banners, partial lines — not our concern here
    }
    if (obj && obj.type === "result") result = obj;
  }
  if (!result) {
    throw new Error("probe: no 'type':'result' line found — session truncated or CLI output format changed");
  }

  const usage = result.usage;
  if (!usage || typeof usage !== "object") {
    throw new Error("probe: result line has no 'usage' object");
  }
  const missing = RECIPE_FIELDS.filter((f) => usage[f] === undefined || usage[f] === null);
  if (missing.length) {
    throw new Error(
      `probe: usage is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  }
  if (result.total_cost_usd === undefined || result.total_cost_usd === null) {
    throw new Error("probe: result line has no 'total_cost_usd'");
  }

  const input_tokens = Number(usage.input_tokens);
  const cache_creation_input_tokens = Number(usage.cache_creation_input_tokens);
  const cache_read_input_tokens = Number(usage.cache_read_input_tokens);

  return {
    input_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    total_tokens: input_tokens + cache_creation_input_tokens + cache_read_input_tokens,
    total_cost_usd: Number(result.total_cost_usd),
  };
}

/**
 * Assembles the argv for a boot probe. `settingsPath` selects the acervo under measurement
 * (the profile); `extra` carries any scenario-declared raw flags (e.g. an MCP toggle) that
 * the caller — not this file — decided the scenario needs. `--strict-mcp-config` defaults on
 * because MCP servers are a separate, much larger cost that a boot probe should isolate out
 * unless the caller explicitly asks to include it (pass `strictMcp: false`).
 */
export function buildArgs({ settingsPath, extra = [], strictMcp = true } = {}) {
  const args = [];
  if (strictMcp) args.push("--strict-mcp-config");
  if (settingsPath) args.push("--settings", settingsPath);
  for (const e of extra) args.push(e);
  return args;
}

/**
 * Runs one real headless boot probe in a neutral working directory, OUTSIDE any repo, so the
 * measurement never picks up a project's own CLAUDE.md or local settings by accident. Prompt
 * defaults to the cheapest possible turn ("ok") with no tool use expected.
 *
 * `spawnFn` is injectable so tests never have to shell out to a real `claude` binary — pass a
 * stub that mimics `child_process.spawn`'s EventEmitter shape.
 */
export function runProbe({
  settingsPath,
  extra = [],
  strictMcp = true,
  claudeBin = "claude",
  prompt = "ok",
  // "json" is the default because the CLI hands back a single `type:"result"` object with
  // `usage` on it without requiring `--verbose` — confirmed against the real binary. Only
  // "stream-json" needs `--verbose` (the CLI refuses `--print --output-format=stream-json`
  // without it); the guard below adds the flag automatically so this can never silently break.
  outputFormat = "json",
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    if (settingsPath && !fs.existsSync(settingsPath)) {
      reject(new Error(`probe: settings file not found: ${settingsPath}`));
      return;
    }

    let work;
    try {
      work = fs.mkdtempSync(path.join(os.tmpdir(), "boot-probe-"));
    } catch (e) {
      reject(new Error(`probe: could not create a neutral working directory (${e.message})`));
      return;
    }

    const args = [
      ...buildArgs({ settingsPath, extra, strictMcp }),
      "-p",
      prompt,
      "--output-format",
      outputFormat,
    ];
    // The CLI refuses `--print --output-format=stream-json` without `--verbose`. Guard here
    // instead of trusting every call site to remember it.
    if (outputFormat === "stream-json" && !args.includes("--verbose")) {
      args.push("--verbose");
    }

    let child;
    try {
      child = spawnFn(claudeBin, args, { cwd: work });
    } catch (e) {
      fs.rmSync(work, { recursive: true, force: true });
      reject(e);
      return;
    }

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      fs.rmSync(work, { recursive: true, force: true });
      reject(e);
    });
    child.on("close", (code) => {
      fs.rmSync(work, { recursive: true, force: true });
      try {
        const usage = parseUsage(out);
        resolve({ code, usage, raw: out, stderr: err });
      } catch (e) {
        reject(new Error(`${e.message} (exit ${code}); stderr: ${err.slice(0, 500)}`));
      }
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const settingsPath = process.argv[2];
  if (!settingsPath) {
    console.error("usage: node src/probe.js <settings-file.json>");
    console.error("Runs ONE real headless boot probe and prints the token usage. SPENDS REAL CREDIT.");
    process.exit(2);
  }
  runProbe({ settingsPath })
    .then((r) => {
      console.log(JSON.stringify(r.usage, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(`probe: ${e.message}`);
      process.exit(1);
    });
}
