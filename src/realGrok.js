import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, resolveCommand } from "./config.js";

/** The shim's own entry, so PATH scanning never finds the shim as "the real one". */
const SELF_ENTRY = fileURLToPath(new URL("../bin/grok", import.meta.url));

function realpathOrNull(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function isBridgeEntry(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    const header = Buffer.alloc(1024);
    const size = fs.readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, size).includes(Buffer.from("# raft-acp-bridge-entry"));
  } catch { return false; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/**
 * Finds the Grok Build CLI this shim stands in for, skipping itself.
 *
 * `GROK_SHIM_REAL_GROK` wins when set (tests use it). Otherwise PATH is scanned
 * in order and every candidate that resolves back to this repository is
 * skipped, so a symlink in ~/.local/bin pointing here is not mistaken for the
 * real thing.
 */
export function resolveRealGrok(env = process.env) {
  const excluded = new Set([SELF_ENTRY, readConfig(env).shimEntry].map(realpathOrNull).filter(Boolean));
  const explicit = (env.GROK_SHIM_REAL_GROK ?? "").trim();
  if (explicit) {
    const command = resolveCommand(explicit, env);
    const real = realpathOrNull(command);
    return real && (excluded.has(real) || isBridgeEntry(real)) ? null : command;
  }

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "grok");
    const real = realpathOrNull(candidate);
    if (!real) continue;
    if (excluded.has(real) || isBridgeEntry(real)) continue;
    if (!isExecutableFile(real)) continue;
    return candidate;
  }
  return null;
}

/** Hands the whole process over to the real CLI: same argv, same stdio. */
export function delegateToRealGrok(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`grok (raft-acp-bridge): could not run ${command}: ${result.error.message}\n`);
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}
