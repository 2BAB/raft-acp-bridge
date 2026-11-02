import { nonEmptyString } from "../../util.js";

/**
 * Agy IDs encode effort in their suffix, so each entry advertises that effort.
 * Server discovery narrows known families to IDs the installed build offers.
 * The default family supplies a fallback when discovery is unavailable;
 * GROK_SHIM_MODELS and GROK_SHIM_MODEL_FAMILIES can override that declaration.
 */

export const AGY_MODEL_FAMILIES = {
  "gemini-4-argon": { name: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
  "claude-opus-5-5": { name: "Claude Opus 5.5", efforts: ["low", "medium", "high"] },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] },
  // One effort only: the backend lists no other variant for it.
  "gpt-oss-120b": { name: "GPT-OSS 120B", efforts: ["medium"] },
};

const AGY_MODEL_FAMILY = "gemini-4-argon";

const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High" };

const EFFORTS = Object.entries(EFFORT_LABELS).map(([id, label]) => ({ id, label }));

const DEFAULT_MODEL_ID = `${AGY_MODEL_FAMILY}-medium`;

function modelEntry(modelId, name, effort) {
  return { modelId, name, _meta: { reasoningEfforts: [effort] } };
}

function familyOf(modelId) {
  for (const [family, spec] of Object.entries(AGY_MODEL_FAMILIES)) {
    if (modelId.startsWith(`${family}-`)) return { family, spec };
  }
  return null;
}

function effortOf(modelId, fallback = "medium") {
  const match = familyOf(modelId);
  if (!match) return fallback;
  const suffix = modelId.slice(match.family.length + 1);
  return match.spec.efforts.includes(suffix) ? suffix : fallback;
}

/**
 * `gemini-4-argon` stays the default: it is the family agy itself starts a
 * session on, so a fresh agent opens on the model the backend would have picked.
 * Every other family in the table is only offered when the server is seen
 * serving it — see `knownModels`.
 */
function selectedFamilies(env) {
  const configured = nonEmptyString(env.GROK_SHIM_MODEL_FAMILIES);
  if (!configured) return [AGY_MODEL_FAMILY];
  const requested = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry in AGY_MODEL_FAMILIES);
  return requested.length > 0 ? requested : [AGY_MODEL_FAMILY];
}

function modelsForFamilies(families) {
  const models = [];
  for (const family of families) {
    const spec = AGY_MODEL_FAMILIES[family];
    for (const effort of spec.efforts) {
      const label = EFFORT_LABELS[effort] ?? effort;
      models.push(modelEntry(`${family}-${effort}`, `${spec.name} ${label}`, effort));
    }
  }
  return models;
}

export function resolveModels(env = process.env) {
  const configured = nonEmptyString(env.GROK_SHIM_MODELS);
  if (configured) {
    const parsed = configured
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [id, ...labelParts] = entry.split(":");
        const modelId = nonEmptyString(id);
        if (!modelId) return null;
        return modelEntry(modelId, nonEmptyString(labelParts.join(":")) ?? modelId, effortOf(modelId));
      })
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return modelsForFamilies(selectedFamilies(env));
}

/**
 * Everything the shim could name, before the server has an opinion: an explicit
 * `GROK_SHIM_MODELS` list, else every family in the table. This is what gets
 * intersected with the probe, so discovery contributes only IDs the installed server reports.
 */
export function knownModels(env = process.env) {
  if (nonEmptyString(env.GROK_SHIM_MODELS)) return resolveModels(env);
  const configured = nonEmptyString(env.GROK_SHIM_MODEL_FAMILIES);
  const families = configured
    ? configured
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry in AGY_MODEL_FAMILIES)
    : Object.keys(AGY_MODEL_FAMILIES);
  return modelsForFamilies(families.length > 0 ? families : Object.keys(AGY_MODEL_FAMILIES));
}

/**
 * Keep only the entries the server says it serves. The static catalogue is the
 * shim's opinion of a family; the probe is the server's. Where they disagree the
 * server wins, because an entry the backend rejects is worse than a missing one.
 *
 * Returns null when nothing matches, which is what a probe talking to a foreign
 * backend looks like; the caller then keeps the declared catalogue rather than
 * advertising families that server has never heard of.
 */
export function servedModels(models, servedIds) {
  if (!Array.isArray(servedIds) || servedIds.length === 0) return null;
  const served = new Set(servedIds);
  const kept = models.filter((model) => served.has(model.modelId));
  return kept.length > 0 ? kept : null;
}


export { DEFAULT_MODEL_ID, AGY_MODEL_FAMILY };
