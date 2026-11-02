// Raft decides whether the Grok runtime is available by running two commands.
// Both have to succeed before anything else in this repository matters.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/grok", import.meta.url));

test("`grok --version` prints a version line", async () => {
  const { stdout } = await run(BIN, ["--version"], { env: { ...process.env, SHIM_ENV_FILE: os.devNull, SHIM_CONFIG_ROOT: "", SHIM_EXTENSION_MODULE: "" } });
  assert.match(stdout.trim().split("\n")[0], /\S/);
});

test("`grok agent stdio --help` exits successfully", async () => {
  const { stdout } = await run(BIN, ["agent", "stdio", "--help"], { env: { ...process.env, SHIM_ENV_FILE: os.devNull, SHIM_CONFIG_ROOT: "", SHIM_EXTENSION_MODULE: "" } });
  assert.match(stdout, /stdio/);
});
