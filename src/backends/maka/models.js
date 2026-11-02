import { nonEmptyString, recordValue } from "../../util.js";

/** Raft's effort vocabulary, intersected with what Maka's `thinking_level` offers. */
export const MAKA_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const THINKING_TO_EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

/** The one value we can offer when the catalogue cannot be read. */
export const MAKA_SENTINEL_MODEL = "maka-default";

export function modelOption(configOptions) {
  return (configOptions ?? []).find((option) => recordValue(option)?.id === "model") ?? null;
}

function thinkingOption(configOptions) {
  return (configOptions ?? []).find((option) => recordValue(option)?.id === "thinking_level") ?? null;
}

export function entryFor(modelId, name, configOptions) {
  const values = (thinkingOption(configOptions)?.options ?? [])
    .map((option) => nonEmptyString(recordValue(option)?.value))
    .filter((value) => value !== null && value in THINKING_TO_EFFORT);
  return {
    modelId,
    name: name ?? modelId,
    _meta: { reasoningEfforts: values.length > 0 ? values : MAKA_EFFORTS },
  };
}

/** Raft's effort id → Maka's thinking level, or null when it has no equivalent. */
export function thinkingLevelFor(effort) {
  return effort === undefined || effort === null ? null : (THINKING_TO_EFFORT[effort] ?? null);
}
