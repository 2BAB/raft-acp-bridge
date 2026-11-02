import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverMakaModels } from "../src/backends/maka/index.js";
import { discoverAgyModels } from "../src/backends/agy/index.js";
import { resolveProfile } from "../src/profiles.js";
import { startShim } from "./harness.mjs";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-backend.mjs", import.meta.url));

test("Maka discovery returns session models and thinking choices instead of the fallback", async () => {
  const logs = [];
  const result = await discoverMakaModels({ command: process.execPath, args: [FIXTURE],
    cwd: process.cwd(), timeoutMs: 1000, log: (line) => logs.push(line) });
  assert.ok(result, logs.join("\n"));
  assert.equal(result.currentModelId, "maka-one");
  assert.deepEqual(result.models.map((model) => model.modelId), ["maka-one", "maka-two"]);
  assert.deepEqual(result.models.map((model) => model._meta.reasoningEfforts), [["low", "high"], ["low", "high"]]);
  assert.equal(result.thinkingOption.id, "thinking_level");
});

function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

for (const [name, discover] of [["Maka", discoverMakaModels], ["agy", discoverAgyModels]]) {
  test(`${name} discovery settles a missing executable and a backend that exits without replying`, async (t) => {
    const directory = scratch(t);
    assert.equal(await discover({ command: path.join(directory, "missing"), timeoutMs: 1000 }), null);
    assert.equal(await discover({ command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000 }), null);
  });
}

for (const kind of ["maka", "agy"]) {
  test(`machine-level initialization works when only ${kind} is installed`, async (t) => {
    const directory = scratch(t);
    const backend = path.join(directory, "backend.mjs");
    fs.writeFileSync(backend, `#!${process.execPath}\nimport ${JSON.stringify(new URL("../fixtures/fake-acp-backend.mjs", import.meta.url).href)};\n`, { mode: 0o755 });
    const missing = path.join(directory, "missing");
    const shim = await startShim({ env: {
      GROK_SHIM_BACKEND_BIN: undefined, GROK_SHIM_BACKEND_ARGS: undefined, GROK_SHIM_PROFILE: "",
      MAKA_BIN: kind === "maka" ? backend : missing,
      AGY_ACP_BIN: kind === "agy" ? backend : missing, TMPDIR: directory,
    } });
    try {
      const { result } = await shim.request("initialize", { protocolVersion: 1 });
      const models = result._meta.modelState.availableModels;
      assert.ok(models.length);
      assert.ok(models.every((model) => model.modelId.startsWith(`${kind}_`)));
      assert.ok(result._meta.modelState.currentModelId.startsWith(`${kind}_`));
      if (kind === "maka") assert.deepEqual(models.map((model) => model.modelId), ["maka_maka-one", "maka_maka-two"]);
      const creation = await shim.request("session/new", { cwd: directory, mcpServers: [] });
      assert.match(creation.error.message, /no backend declared/);
    } finally { shim.close(); }
  });
}

test("unknown profiles and a machine with no backend produce actionable errors", async (t) => {
  const directory = scratch(t);
  await assert.rejects(resolveProfile({ GROK_SHIM_PROFILE: "makka" }), /unknown GROK_SHIM_PROFILE/);
  await assert.rejects(resolveProfile({ AGY_ACP_BIN: path.join(directory, "agy"), MAKA_BIN: path.join(directory, "maka") }), /no ACP backend found/);
});

for (const modelId of ["gemini-4-argon-low", "gemini-flash-demo"]) {
  test(`agy advertises the discovered ${modelId} as the current model`, async (t) => {
    const directory = scratch(t);
    const backend = path.join(directory, "backend.mjs");
    fs.writeFileSync(backend, `#!${process.execPath}\nimport ${JSON.stringify(new URL("../fixtures/fake-acp-backend.mjs", import.meta.url).href)};\n`, { mode: 0o755 });
    const shim = await startShim({ env: { GROK_SHIM_BACKEND_BIN: undefined, GROK_SHIM_BACKEND_ARGS: undefined,
      GROK_SHIM_PROFILE: "agy", AGY_ACP_BIN: backend, TMPDIR: directory, FIXTURE_MODEL_IDS: JSON.stringify([modelId]) } });
    try {
      const { result } = await shim.request("initialize", { protocolVersion: 1 });
      assert.deepEqual(result._meta.modelState.availableModels.map((model) => model.modelId), [`agy_${modelId}`]);
      assert.equal(result._meta.modelState.currentModelId, `agy_${modelId}`);
    } finally { shim.close(); }
  });
}

test("a successful agy probe with no models stays distinguishable from a failed probe", async () => {
  const discovered = await discoverAgyModels({ command: process.execPath, args: [FIXTURE], timeoutMs: 1000,
    env: { ...process.env, FIXTURE_MODEL_IDS: "[]" } });
  assert.deepEqual(discovered.ids, []);
});
