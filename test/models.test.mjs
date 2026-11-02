// Discovery controls the catalogue; configuration can narrow it.
import assert from "node:assert/strict";
import test from "node:test";

import { AGY_MODEL_FAMILIES, discoveredModels, resolveModels } from "../src/backends/agy/models.js";

const ids = (models) => models.map((model) => model.modelId);
const efforts = (models) => models.map((model) => model._meta.reasoningEfforts);

test("the default catalogue is the family agy itself starts on", () => {
  const models = resolveModels({});
  assert.deepEqual(ids(models), ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]);
  assert.deepEqual(efforts(models), [["low"], ["medium"], ["high"]]);
});

test("declared model families can be selected by name", () => {
  const models = resolveModels({
    GROK_SHIM_MODEL_FAMILIES: "gemini-4-argon,claude-opus-5-5,gpt-oss-120b",
  });
  assert.deepEqual(ids(models), [
    "gemini-4-argon-low",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "claude-opus-5-5-low",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-high",
    // One effort only, because the backend lists no other variant.
    "gpt-oss-120b-medium",
  ]);
  assert.equal(models[3].name, "Claude Opus 5.5 Low");
  assert.equal(models[6].name, "GPT-OSS 120B Medium");
  assert.deepEqual(efforts(models).at(-1), ["medium"]);
});

test("an unknown family name cannot empty the catalogue", () => {
  const models = resolveModels({ GROK_SHIM_MODEL_FAMILIES: "nonsense" });
  assert.deepEqual(ids(models), ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]);
});

test("an explicit model list still wins, and keeps each id's own effort", () => {
  const models = resolveModels({
    GROK_SHIM_MODEL_FAMILIES: "claude-opus-5-5",
    GROK_SHIM_MODELS: "claude-opus-5-5-high:Mine,agy-demo-low:Demo",
  });
  assert.deepEqual(ids(models), ["claude-opus-5-5-high", "agy-demo-low"]);
  assert.deepEqual(models.map((model) => model.name), ["Mine", "Demo"]);
  // `agy-demo-low` is not a family the shim knows, so the effort falls back.
  assert.deepEqual(efforts(models), [["high"], ["medium"]]);
});

test("every family the shim knows names itself for the picker", () => {
  for (const [family, spec] of Object.entries(AGY_MODEL_FAMILIES)) {
    assert.ok(spec.name.length > 0, family);
    assert.ok(spec.efforts.length > 0, family);
  }
});

test("discovery keeps new model IDs and adds known labels without inventing models", () => {
  const models = discoveredModels(["gemini-4-argon-low", "gemini-flash-demo", "future-model-high", "gemini-flash-demo"]);
  assert.deepEqual(ids(models), ["gemini-4-argon-low", "gemini-flash-demo", "future-model-high"]);
  assert.equal(models[0].name, "Gemini 4 Argon Low");
  assert.equal(models[1]._meta, undefined);
  assert.deepEqual(models[2]._meta.reasoningEfforts, ["high"]);
});

test("explicit model and family settings filter discovery", () => {
  const served = ["gemini-4-argon-low", "future-model-high"];
  assert.deepEqual(ids(discoveredModels(served, { GROK_SHIM_MODEL_FAMILIES: "future-model" })), ["future-model-high"]);
  const models = discoveredModels(served, { GROK_SHIM_MODELS: "gemini-4-argon-low:Mine", GROK_SHIM_MODEL_FAMILIES: "other" });
  assert.deepEqual(ids(models), ["gemini-4-argon-low"]);
  assert.equal(models[0].name, "Mine");
});

test("an empty successful catalogue or a filter mismatch reports an error", () => {
  assert.throws(() => discoveredModels([]), /no matching models/);
  assert.throws(() => discoveredModels(["future-model"], { GROK_SHIM_MODELS: "old-model:Old" }), /no matching models/);
  assert.throws(() => discoveredModels(["future-model"], { GROK_SHIM_MODEL_FAMILIES: "unknown" }), /no matching models/);
});
