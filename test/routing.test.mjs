// Installing the shim must not change what an agent on a machine with a real
// Grok Build install already does. These tests pin that down.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import os from "node:os";

import { agyBackendEnv } from "../src/backends/agy/index.js";
import { resolveProfile } from "../src/profiles.js";

const BIN = new URL("../bin/grok", import.meta.url).pathname;
const FAKE_REAL = new URL("../fixtures/fake-real-grok.mjs", import.meta.url).pathname;

function run(args, env = {}) {
  const result = spawnSync(BIN, args, {
    encoding: "utf8",
    env: { ...process.env, SHIM_ENV_FILE: os.devNull, SHIM_CONFIG_ROOT: "", SHIM_EXTENSION_MODULE: "", RAFT_GROK_BACKEND: "", GROK_SHIM_REAL_GROK: "", ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("with no real CLI present, the shim answers for itself", () => {
  const { status, stdout } = run(["--version"], { RAFT_GROK_BACKEND: "agy" });
  assert.equal(status, 0);
  assert.match(stdout, /raft-acp-bridge/);
});

test("RAFT_GROK_BACKEND=agy keeps the real CLI out of the way", () => {
  const { stdout } = run(["--version"], {
    RAFT_GROK_BACKEND: "agy",
    GROK_SHIM_REAL_GROK: FAKE_REAL,
  });
  assert.match(stdout, /raft-acp-bridge/);
  assert.doesNotMatch(stdout, /9\.9\.9/);
});

test("unset route prefers the real CLI when one is installed", () => {
  const { status, stdout } = run(["--version"], { GROK_SHIM_REAL_GROK: FAKE_REAL });
  assert.equal(status, 0);
  assert.match(stdout, /9\.9\.9 \(fake real install\)/);
});

test("RAFT_GROK_BACKEND=grok delegates even without a real CLI", () => {
  const { stdout } = run(["--version"], {
    RAFT_GROK_BACKEND: "grok",
    GROK_SHIM_REAL_GROK: FAKE_REAL,
  });
  assert.match(stdout, /9\.9\.9/);
});

test("RAFT_GROK_BACKEND=grok fails loudly when no real CLI can be found", () => {
  const { status, stderr } = run(["agent", "stdio"], {
    RAFT_GROK_BACKEND: "grok",
    GROK_SHIM_REAL_GROK: "",
    PATH: "/usr/bin:/bin",
  });
  assert.equal(status, 127);
  assert.match(stderr, /no real Grok Build CLI was found/);
});

test("verbs the shim does not implement are handed to the real CLI", () => {
  const { status, stdout } = run(["login", "--device"], {
    RAFT_GROK_BACKEND: "agy",
    GROK_SHIM_REAL_GROK: FAKE_REAL,
  });
  assert.equal(status, 0);
  assert.match(stdout, /fake-real-grok login --device/);
});

test("without a real CLI, an unimplemented verb is a usage error", () => {
  const { status, stderr } = run(["login"], { RAFT_GROK_BACKEND: "agy", GROK_SHIM_REAL_GROK: "" });
  assert.equal(status, 2);
  assert.match(stderr, /Usage/);
});

test("the official backend keeps its credential-store default unless explicitly configured", () => {
  assert.equal(agyBackendEnv({}).AGY_ACP_FORCE_FILE_STORAGE, undefined);
  assert.equal(agyBackendEnv({ AGY_ACP_FORCE_FILE_STORAGE: "0" }).AGY_ACP_FORCE_FILE_STORAGE, "0");
  assert.equal(agyBackendEnv({ AGY_ACP_FORCE_FILE_STORAGE: "1" }).AGY_ACP_FORCE_FILE_STORAGE, "1");
});

test("the agy profile carries that env, and other backends inherit this process's", async () => {
  // GROK_SHIM_PROBE=off keeps the profile honest without spawning a server.
  const agy = await resolveProfile({ GROK_SHIM_PROFILE: "agy", GROK_SHIM_PROBE: "off" });
  assert.equal(agy.backendEnv.AGY_ACP_FORCE_FILE_STORAGE, undefined);

  const custom = await resolveProfile({
    GROK_SHIM_BACKEND_BIN: "/bin/echo",
    GROK_SHIM_PROFILE: "agy",
    GROK_SHIM_PROBE: "off",
  });
  assert.equal(custom.backendEnv, undefined);
});
