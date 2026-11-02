import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT, readConfig } from "../src/config.js";
import { installShim } from "../src/installation.js";
import { resolveMakaCommand } from "../src/backends/maka/index.js";
import { checkInstallation } from "../src/doctor.js";

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
  const env = { ...process.env, PATH: `${path.join(checkout, "tools")}${path.delimiter}${process.env.PATH}` };
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

test("CLI installation works in a spaced directory and can be repeated", (t) => {
  const directory = scratch(t);
  const config = { ...readConfig({}), shimBin: path.join(directory, "my tools/grok") };
  const env = { ...process.env, SHIM_BIN: config.shimBin };
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "ops/install.mjs")], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.realpathSync(config.shimBin), fs.realpathSync(config.shimEntry));
  assert.equal(installShim(config).changed, false);
});

test("installation preserves a real Grok executable and its symlink", (t) => {
  const directory = scratch(t);
  const executable = path.join(directory, "real-grok");
  const original = "#!/bin/sh\necho real-grok\n";
  fs.writeFileSync(executable, original, { mode: 0o755 });
  const link = path.join(directory, "grok");
  fs.symlinkSync(executable, link);
  for (const shimBin of [executable, link]) {
    assert.throws(() => installShim({ ...readConfig({}), shimBin }), /refusing to replace/);
    assert.equal(fs.readFileSync(shimBin, "utf8"), original);
  }
  assert.equal(fs.readlinkSync(link), executable);
});

test("installation can replace another bridge entry", (t) => {
  const directory = scratch(t);
  const older = path.join(directory, "old-bridge");
  fs.writeFileSync(older, "#!/bin/sh\n# raft-acp-bridge-entry\nexit 0\n", { mode: 0o755 });
  const shimBin = path.join(directory, "grok");
  fs.symlinkSync(older, shimBin);
  assert.equal(installShim({ ...readConfig({}), shimBin }).changed, true);
  assert.equal(fs.realpathSync(shimBin), fs.realpathSync(path.join(REPO_ROOT, "bin/grok")));
});

test("doctor and the runtime use the same Maka fallback when home bin is absent from PATH", (t) => {
  const directory = scratch(t);
  const bin = path.join(directory, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  const maka = path.join(bin, "maka");
  fs.writeFileSync(maka, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { HOME: directory, PATH: "/usr/bin:/bin" };
  const report = checkInstallation({ env, profile: "maka", platform: "darwin" });
  assert.equal(report.checks.find((check) => check.name === "maka").message, maka);
  assert.equal(resolveMakaCommand(env).command, maka);
  assert.equal(resolveMakaCommand({ ...env, MAKA_BIN: "missing-explicit-maka" }).command, "missing-explicit-maka");
});

test("doctor fails when grok on PATH belongs to another installation", (t) => {
  const directory = scratch(t);
  const ownBin = path.join(directory, "own");
  const foreignBin = path.join(directory, "foreign");
  fs.mkdirSync(foreignBin);
  fs.writeFileSync(path.join(foreignBin, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { HOME: directory, SHIM_BIN: path.join(ownBin, "grok"), PATH: foreignBin };
  installShim(readConfig(env));
  const report = checkInstallation({ env, profile: "maka", platform: "darwin" });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "shim-path").status, "error");
  const missing = checkInstallation({ env: { ...env, PATH: "" }, profile: "maka", platform: "darwin" });
  assert.equal(missing.checks.find((check) => check.name === "shim-path").status, "error");
});
