import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT } from "../src/config.js";

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shim-install-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("doctor CLI loads a relocated checkout's config and reports installation and configuration failures", (t) => {
  const directory = scratch(t);
  const checkout = path.join(directory, "another Mac checkout");
  fs.mkdirSync(checkout);
  for (const entry of ["bin", "src", "ops", "package.json"]) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(checkout, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(checkout, "tools"));
  fs.symlinkSync(path.join(checkout, "bin/grok"), path.join(checkout, "tools/grok"));
  fs.writeFileSync(path.join(checkout, "tools/maka"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.writeFileSync(path.join(checkout, ".env"), "GROK_SHIM_PROFILE=maka\nSHIM_BIN=./tools/grok\nMAKA_BIN=./tools/maka\nPRIVATE_TEST_VALUE=do-not-print-this\n");
  const env = { ...process.env };
  for (const key of ["SHIM_CONFIG_ROOT", "SHIM_EXTENSION_MODULE", "SHIM_ENV_FILE", "GROK_SHIM_PROFILE", "SHIM_BIN", "MAKA_BIN", "RAFT_SOURCE", "RAFT_COMPUTER_BIN"]) delete env[key];
  const invoke = (overrides = {}) => spawnSync(process.execPath, [path.join(checkout, "ops/doctor.mjs"), "--json"], {
    env: { ...env, ...overrides }, cwd: os.tmpdir(), encoding: "utf8", timeout: 10_000,
  });
  const initial = invoke();
  assert.equal(initial.status, process.platform === "darwin" ? 0 : 1, initial.stderr);
  const report = JSON.parse(initial.stdout);
  assert.equal(report.profile, "maka");
  assert.equal(report.checks.find((check) => check.name === "maka").status, "ok");
  assert.doesNotMatch(initial.stdout, /do-not-print-this/);
  fs.rmSync(path.join(checkout, "tools/maka"));
  const missingBackend = invoke();
  assert.equal(missingBackend.status, 1);
  assert.equal(JSON.parse(missingBackend.stdout).checks.find((check) => check.name === "maka").status, "error");
  const invalidConfig = invoke({ SHIM_ENV_FILE: path.join(directory, "missing.env") });
  assert.equal(invalidConfig.status, 2);
  assert.equal(invalidConfig.stdout, "");
  assert.match(invalidConfig.stderr, /cannot read shim environment file/);
});
