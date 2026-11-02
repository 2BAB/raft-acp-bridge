import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { REPO_ROOT, loadRepositoryEnv, normalizePathEnv, readConfig, backendArguments } from "../src/config.js";
import { computerCommand, computerProcessPattern, launchAgentPlist } from "../src/installation.js";
import { checkInstallation } from "../src/doctor.js";
import { startShim } from "./harness.mjs";

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shim-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("without .env, legacy macOS paths and command defaults are preserved", () => {
  const config = readConfig({ HOME: "/example/home" });
  assert.equal(config.agyBin, "/example/home/Library/Application Support/agy-acp/agy_acp_server.par");
  assert.equal(config.makaBin, "maka");
  assert.equal(config.makaWorkspace, "/example/home/Library/Application Support/Maka/workspaces/default");
  assert.equal(config.makaPort, 64150);
  assert.equal(config.raftApp, "/Applications/Raft Desktop.app");
  assert.equal(config.raftHome, "/example/home/.slock");
  assert.equal(config.raftComputerScript, "/example/home/Desktop/code/active/raft-source/packages/computer/dist/raft-computer.js");
});

test("dotenv fills missing values, preserves even empty process overrides, and does not evaluate shell text", (t) => {
  const directory = scratch(t);
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, 'MAKA_BIN=./tools/maka\nGROK_SHIM_PROFILE=agy\nGROK_SHIM_DEBUG=1\nLITERAL="${HOME} $(false)"\nSHIM_ENV_FILE=/ignored\n');
  const env = { SHIM_ENV_FILE: file, GROK_SHIM_PROFILE: "maka", GROK_SHIM_DEBUG: "" };
  assert.equal(loadRepositoryEnv(env).loaded, true);
  assert.equal(env.GROK_SHIM_PROFILE, "maka");
  assert.equal(env.GROK_SHIM_DEBUG, "");
  assert.equal(env.LITERAL, "${HOME} $(false)");
  normalizePathEnv(env);
  assert.equal(env.MAKA_BIN, path.join(directory, "tools/maka"));
  assert.equal(env.SHIM_ENV_FILE, file);
});

test("path settings share one base and expand the current Mac's home", (t) => {
  const directory = scratch(t);
  const config = readConfig({
    HOME: "/other/mac", SHIM_ENV_FILE: path.join(directory, ".env"),
    AGY_ACP_BIN: "./vendor/agy/server.par", SHIM_DATA_DIR: "~/state",
    SHIM_BIN: "./bin/grok", MAKA_BIN: "maka",
    RAFT_HOME: "./raft data", MAKA_HOST_URL: "ws://localhost:65123/runtime-host",
  });
  assert.equal(config.agyHelper, path.join(directory, "vendor/agy/localharness_external"));
  assert.equal(config.shimBin, path.join(directory, "bin/grok"));
  assert.equal(config.raftHome, path.join(directory, "raft data"));
  assert.equal(config.makaBin, "maka");
  assert.equal(config.makaPort, 65123);
  assert.equal(config.makaHost, "localhost");
});

test("only the implicit missing dotenv is optional", (t) => {
  const directory = scratch(t);
  assert.equal(loadRepositoryEnv({}, directory).loaded, false);
  assert.throws(() => loadRepositoryEnv({ SHIM_ENV_FILE: path.join(directory, "missing") }), /cannot read shim environment/);
});

test("a relocated checkout reads its own .env even when Raft starts it in a different cwd", (t) => {
  const directory = scratch(t);
  const checkout = path.join(directory, "checkout with spaces");
  fs.mkdirSync(checkout);
  for (const entry of ["bin", "src", "package.json"]) fs.cpSync(path.join(REPO_ROOT, entry), path.join(checkout, entry), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "fixtures/fake-real-grok.mjs"), path.join(checkout, "real-grok.mjs"));
  fs.writeFileSync(path.join(checkout, ".env"), "RAFT_GROK_BACKEND=grok\nGROK_SHIM_REAL_GROK=./real-grok.mjs\n");
  const env = { ...process.env };
  for (const key of ["SHIM_CONFIG_ROOT", "SHIM_EXTENSION_MODULE", "SHIM_ENV_FILE", "RAFT_GROK_BACKEND", "GROK_SHIM_REAL_GROK"]) delete env[key];
  const result = spawnSync(path.join(checkout, "bin/grok"), ["--version"], { env, cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /9\.9\.9 \(fake real install\)/);
});

test("dotenv backend configuration reaches an actual ACP round trip", async (t) => {
  const directory = scratch(t);
  const fixture = path.join(REPO_ROOT, "fixtures/fake-acp-backend.mjs");
  fs.symlinkSync(process.execPath, path.join(directory, "node"));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, `GROK_SHIM_BACKEND_BIN=./node\nGROK_SHIM_BACKEND_ARGS=${JSON.stringify([fixture])}\nGROK_SHIM_ENVIRONMENT=off\n`);
  const shim = await startShim({ env: { SHIM_ENV_FILE: file, GROK_SHIM_BACKEND_BIN: undefined, GROK_SHIM_BACKEND_ARGS: undefined, GROK_SHIM_ENVIRONMENT: undefined } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: directory, mcpServers: [] });
    const reply = await shim.request("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "hello" }] });
    assert.equal(reply.result.stopReason, "end_turn");
    assert.equal(shim.logs().find((entry) => entry.method === "session/prompt").text, "hello");
  } finally { shim.close(); }
});

test("custom backend arguments support spaced paths without invoking a shell", () => {
  assert.deepEqual(backendArguments('--flag value'), ['--flag', 'value']);
  assert.deepEqual(backendArguments('["/path with spaces/backend.mjs","literal $(false)"]'), ['/path with spaces/backend.mjs', 'literal $(false)']);
  assert.throws(() => backendArguments('[1]'), /strings only/);
  assert.throws(() => backendArguments('[broken'), /valid JSON/);
});

test("Computer CLI works without a source checkout and explicit source setups stay supported", (t) => {
  const directory = scratch(t);
  const env = { HOME: directory, RAFT_COMPUTER_BIN: "./tools/computer" };
  assert.deepEqual(computerCommand(readConfig(env), env), { command: path.join(REPO_ROOT, "tools/computer"), args: [] });
  const defaults = { HOME: directory };
  assert.deepEqual(computerCommand(readConfig(defaults), defaults), { command: path.join(directory, ".local/bin/raft-computer"), args: [] });
  const source = { HOME: directory, RAFT_SOURCE: "./source" };
  assert.deepEqual(computerCommand(readConfig(source), source).args, [path.join(REPO_ROOT, "source/packages/computer/dist/raft-computer.js")]);
  assert.match(`${path.join(directory, ".local/bin/raft-computer")} __service`, computerProcessPattern(readConfig(defaults), defaults));
  assert.match(`${process.execPath} ${path.join(REPO_ROOT, "source/packages/computer/dist/raft-computer.js")} __run --port 1234`, computerProcessPattern(readConfig(source), source));
});

test("LaunchAgent keeps the selected env file and escapes machine-specific paths", () => {
  const config = { ...readConfig({}), repoRoot: '/tmp/Mac & "Work"', envFile: "/tmp/custom & config/.env", envFileExplicit: true };
  const plist = launchAgentPlist(config, "/bin:/tmp/tools&more", "/tmp/Node & Tools/node");
  assert.match(plist, /Mac &amp; &quot;Work&quot;/);
  assert.match(plist, /<key>SHIM_ENV_FILE<\/key><string>\/tmp\/custom &amp; config\/\.env<\/string>/);
  assert.match(plist, /Node &amp; Tools/);
});

test("a default setup without .env can still generate a working login item", (t) => {
  const directory = scratch(t);
  const config = { ...readConfig({}), envFile: path.join(directory, ".env"), envFileExplicit: false };
  assert.doesNotMatch(launchAgentPlist(config, "/usr/bin:/bin"), /<key>SHIM_ENV_FILE<\/key>/);
});

test("doctor inspects an isolated Mac setup without executing backends or changing state", (t) => {
  const directory = scratch(t);
  const envFile = path.join(directory, ".env");
  fs.writeFileSync(envFile, "");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(REPO_ROOT, "bin/grok"), path.join(bin, "grok"));
  fs.writeFileSync(path.join(bin, "maka"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const env = { HOME: directory, SHIM_ENV_FILE: envFile, SHIM_BIN: "./bin/grok", MAKA_BIN: "./bin/maka", PATH: bin };
  const before = fs.readdirSync(directory, { recursive: true });
  const report = checkInstallation({ env, profile: "maka", platform: "darwin" });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(fs.readdirSync(directory, { recursive: true }), before);
  env.MAKA_BIN = "./missing";
  assert.equal(checkInstallation({ env, profile: "maka", platform: "darwin" }).ok, false);
  env.MAKA_HOST_URL = "ws://user:private-password@localhost:64150/runtime-host?token=private-token";
  const output = JSON.stringify(checkInstallation({ env, profile: "maka", platform: "darwin" }));
  assert.doesNotMatch(output, /private-password|private-token/);
});
