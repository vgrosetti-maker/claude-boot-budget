#!/usr/bin/env node
/**
 * Minimal CLI: runs the auditor over a profiles directory and exits 0 (clean) or 1 (problems).
 *
 * Usage:
 *   claude-boot-budget [profilesDir]
 *   claude-boot-budget --anchor <profile-file.json>
 *   claude-boot-budget measure <profile> [profilesDir] --sim [options]
 *
 * With no argument, audits ./profiles relative to the current working directory.
 */

import path from "path";
import { audit, anchor } from "../src/budget.js";
import { discoverProfiles, measureProfile, DEFAULT_ROOT } from "../src/measure.js";

const args = process.argv.slice(2);

if (args[0] === "--anchor") {
  const file = args[1];
  if (!file) {
    console.error("usage: claude-boot-budget --anchor <profile-file.json>");
    process.exit(2);
  }
  try {
    console.log(anchor(file));
    process.exit(0);
  } catch (e) {
    console.error(`anchor: could not compute for '${file}' (${e.message})`);
    process.exit(2);
  }
}

if (args[0] === "measure") {
  // claude-boot-budget measure <profile> [profilesDir] --sim
  //   --global-load <n> --global-load-source "<text citing the ablation pair>"
  //   --control "<reason, must cite a ticket #N>"
  //   --extra <raw flag> (repeatable, passed through to the probe's argv)
  const rest = args.slice(1);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positionals = [];
  const extra = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--extra") {
      extra.push(rest[++i]);
    } else if (a === "--global-load" || a === "--global-load-source" || a === "--control") {
      i++; // value consumed below
    } else if (!a.startsWith("--")) {
      positionals.push(a);
    }
  }
  const getValue = (flag) => {
    const i = rest.indexOf(flag);
    return i === -1 ? undefined : rest[i + 1];
  };

  const profile = positionals[0];
  const profilesDir = positionals[1] ? path.resolve(positionals[1]) : DEFAULT_ROOT;
  const sim = flags.has("--sim");
  const globalLoadRaw = getValue("--global-load");
  const globalLoad = globalLoadRaw !== undefined ? Number(globalLoadRaw) : undefined;
  const globalLoadSource = getValue("--global-load-source");
  const control = getValue("--control");

  if (!profile) {
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
    console.log("  claude-boot-budget measure <profile> --sim");
    process.exit(1);
  }
  if (!sim) {
    console.log(`This would measure profile '${profile}' with one real headless session (prompt: 'ok').`);
    console.log("");
    console.log("NOTHING WAS RUN. Add --sim to run the measurement for real. It spends credit.");
    process.exit(0);
  }
  measureProfile({ profilesDir, profile, extra, globalLoad, globalLoadSource, control })
    .then(({ line, measurementsPath, cost_usd }) => {
      console.log(JSON.stringify(line, null, 2));
      console.log(`Appended to ${measurementsPath}. This run cost US$ ${cost_usd}.`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(`measure: ${e.message}`);
      process.exit(1);
    });
} else {
  const root = args[0] ? path.resolve(args[0]) : path.resolve(process.cwd(), "profiles");
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
