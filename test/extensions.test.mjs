import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { REPO_ROOT, readConfig } from "../src/config.js";
import { resolveRealGrok } from "../src/realGrok.js";
import { launchAgentPlist } from "../src/installation.js";
import { startShim } from "./harness.mjs";

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-extension-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("extensions observe sessions, model results, direct/queued prompts and process cleanup", async (t) => {
  const directory = scratch(t);
  const log = path.join(directory, "events.jsonl");
  const shim = await startShim({ env: {
    SHIM_EXTENSION_MODULE: path.join(REPO_ROOT, "fixtures/lifecycle-extension.mjs"),
    SHIM_TEST_LIFECYCLE_LOG: log,
  } });
  const events = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: directory, mcpServers: [] });
    await shim.request("session/set_model", { sessionId: result.sessionId, modelId: "gemini-4-argon-high" });
    const rejected = await shim.request("session/set_model", { sessionId: result.sessionId, modelId: "bad-model" });
    assert.ok(rejected.error);
    const running = shim.request("session/prompt", { sessionId: result.sessionId, prompt: [{ type: "text", text: "SLOW" }] });
    await shim.waitFor((message) => message.method === "shim/test/log" && message.params.method === "session/prompt");
    await shim.request("_x.ai/interject", { sessionId: result.sessionId, text: "follow-up" });
    assert.equal((await running).result.stopReason, "end_turn");
    assert.equal(events()[0].configured, "yes");
    assert.equal(events().filter((item) => item.event === "ready").length, 1);
    assert.deepEqual(events().filter((item) => item.event === "after-model").map((item) => item.error), [false, true]);
    assert.deepEqual(events().filter((item) => item.event === "prompt").map((item) => item.queued), [false, true]);
  } finally {
    shim.close();
    for (let retry = 0; retry < 100 && !events().some((item) => item.event === "disposed"); retry += 1) await setTimeout(10);
  }
  assert.equal(events().filter((item) => item.event === "disposed").length, 1);
});

test("real CLI discovery skips both the package and the configured wrapper entry", (t) => {
  const directory = scratch(t);
  for (const name of ["bin", "standalone", "other", "real"]) fs.mkdirSync(path.join(directory, name));
  fs.writeFileSync(path.join(directory, "bin/grok"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.symlinkSync(path.join(REPO_ROOT, "bin/grok"), path.join(directory, "standalone/grok"));
  fs.symlinkSync(path.join(REPO_ROOT, "fixtures/fake-real-grok.mjs"), path.join(directory, "real/grok"));
  fs.writeFileSync(path.join(directory, "other/grok"), "#!/bin/sh\n# raft-acp-bridge-entry\nexit 99\n", { mode: 0o755 });
  const env = { SHIM_CONFIG_ROOT: directory, PATH: ["bin", "standalone", "other", "real"].map((name) => path.join(directory, name)).join(path.delimiter) };
  assert.equal(resolveRealGrok(env), path.join(directory, "real/grok"));
  assert.equal(resolveRealGrok({ ...env, GROK_SHIM_REAL_GROK: path.join(directory, "other/grok") }), null);
  const config = readConfig({ ...env, SHIM_EXTENSION_MODULE: "./extension.mjs" });
  const plist = launchAgentPlist(config, env.PATH);
  assert.match(plist, /<key>SHIM_CONFIG_ROOT<\/key>/);
  assert.match(plist, /<key>SHIM_EXTENSION_MODULE<\/key>/);
});

test("doctor can append extension checks without creating session resources", (t) => {
  const directory = scratch(t);
  const log = path.join(directory, "must-not-exist");
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "ops/doctor.mjs"), "--profile", "maka", "--json"], {
    encoding: "utf8", env: { ...process.env, SHIM_CONFIG_ROOT: "", SHIM_ENV_FILE: os.devNull,
      SHIM_EXTENSION_MODULE: path.join(REPO_ROOT, "fixtures/lifecycle-extension.mjs"), SHIM_TEST_LIFECYCLE_LOG: log },
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.find((item) => item.name === "fixture-extension").status, "ok");
  assert.equal(fs.existsSync(log), false);
});
