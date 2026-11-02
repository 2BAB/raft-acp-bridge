// Configured catalogues are filtered by the installed server's advertised IDs.
import assert from "node:assert/strict";
import test from "node:test";

import { AGY_MODEL_FAMILIES, knownModels, resolveModels, servedModels } from "../src/backends/agy/models.js";

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

// What the installed server says it serves decides what the picker shows: a
// expanded build contributes the families it newly serves, a stock one only
// keeps the Gemini ids. Neither needs an environment variable.
test("the served list narrows the known catalogue, it cannot invent one", () => {
  const stock = servedModels(knownModels({}), [
    "gemini-4-argon-low",
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "gemini-flash-demo",
  ]);
  assert.deepEqual(ids(stock), ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]);

  const expanded = servedModels(knownModels({}), [
    "gemini-4-argon-medium",
    "claude-opus-5-5-high",
    "gpt-oss-120b-medium",
    "agy-demo-low",
  ]);
  assert.deepEqual(ids(expanded), [
    "gemini-4-argon-medium",
    "claude-opus-5-5-high",
    "gpt-oss-120b-medium",
  ]);
});

test("an unusable probe leaves the declared catalogue alone", () => {
  const declared = resolveModels({});
  // null means "nothing matched": the caller keeps what it declared instead of
  // advertising families this server has never heard of.
  assert.equal(servedModels(knownModels({}), []), null);
  assert.equal(servedModels(declared, ["something-else"]), null);
  assert.deepEqual(ids(declared), ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]);
});
