import { nonEmptyString } from "../../util.js";

/**
 * Agy IDs encode effort in their suffix, so each entry advertises that effort.
 * Server discovery supplies the IDs the installed build offers.
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
 * Other installed models are supplied by discovery.
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

/** Use the installed catalogue; explicit model settings act as filters. */
export function discoveredModels(servedIds, env = process.env) {
  const labels = new Map(modelsForFamilies(Object.keys(AGY_MODEL_FAMILIES)).map((model) => [model.modelId, model]));
  const explicit = nonEmptyString(env.GROK_SHIM_MODELS);
  if (explicit) {
    const configured = resolveModels(env);
    for (const model of configured) labels.set(model.modelId, model);
  }
  const allowed = explicit ? new Set(resolveModels(env).map((model) => model.modelId)) : null;
  const families = nonEmptyString(env.GROK_SHIM_MODEL_FAMILIES)?.split(",").map((entry) => entry.trim()).filter(Boolean);
  const ids = [...new Set(servedIds)].filter((id) => typeof id === "string" && id.length > 0)
    .filter((id) => allowed ? allowed.has(id) : !families || families.some((family) => id === family || id.startsWith(`${family}-`)));
  if (ids.length === 0) {
    throw new Error("Antigravity returned no matching models; check the backend account and GROK_SHIM_MODELS / GROK_SHIM_MODEL_FAMILIES filters");
  }
  return ids.map((modelId) => {
    if (labels.has(modelId)) return labels.get(modelId);
    const effort = modelId.match(/-(low|medium|high|xhigh|max)$/)?.[1];
    return { modelId, name: modelId, ...(effort ? { _meta: { reasoningEfforts: [effort] } } : {}) };
  });
}

export { DEFAULT_MODEL_ID, AGY_MODEL_FAMILY };
