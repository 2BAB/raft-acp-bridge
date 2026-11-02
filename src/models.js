/**
 * Raft reveals one model catalogue per machine, not per agent, and never passes
 * an agent's chosen model to the runtime process. So the catalogue carries the
 * backend in the id itself: `agy_…` / `maka_…`. The shim strips the prefix when
 * it talks to the backend, and refuses a prefix that does not match the agent's
 * profile instead of quietly running the wrong backend.
 */
export const MODEL_PREFIX = { agy: "agy_", maka: "maka_" };

export function withModelPrefix(kind, models) {
  const prefix = MODEL_PREFIX[kind];
  if (!prefix) return models;
  // The display name stays the model's own name; the backend is already legible
  // in the id the picker shows underneath (`agy_…`, `maka_…`).
  return models.map((model) => ({
    ...model,
    modelId: model.modelId.startsWith(prefix) ? model.modelId : `${prefix}${model.modelId}`,
  }));
}

export function splitModelPrefix(modelId) {
  for (const [kind, prefix] of Object.entries(MODEL_PREFIX)) {
    if (modelId.startsWith(prefix)) return { kind, bare: modelId.slice(prefix.length) };
  }
  return { kind: null, bare: modelId };
}
