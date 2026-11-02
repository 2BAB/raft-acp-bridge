import { agyBackendEnv, discoverAgyModels, resolveAgyAcpCommand } from "./backends/agy/index.js";
import { MAKA_EFFORTS, MAKA_SENTINEL_MODEL, discoverMakaModels, resolveMakaCommand } from "./backends/maka/index.js";
import { DEFAULT_MODEL_ID, discoveredModels, resolveModels } from "./backends/agy/models.js";
import { withModelPrefix } from "./models.js";
import { nonEmptyString } from "./util.js";
import { resolveCommand, backendArguments, findExecutable } from "./config.js";

/**
 * One Raft runtime slot (`grok`), several possible backends. Raft spawns one
 * shim per agent and merges that agent's env vars into it, so the backend is
 * chosen per agent with `GROK_SHIM_PROFILE=agy` or `maka`.
 *
 * A profile declares how the backend answers the two vendor-dialect calls Raft
 * makes: where the model list comes from, and how a model selection is applied.
 */
export async function resolveProfile(env = process.env, log = () => {}) {
  const profile = await resolveBaseProfile(env, log);
  const forcedSelection = nonEmptyString(env.GROK_SHIM_MODEL_SELECTION);
  const forcedPrefix = nonEmptyString(env.GROK_SHIM_PREFIX_KIND);
  const forcedSteer = nonEmptyString(env.GROK_SHIM_STEER);
  return {
    ...profile,
    ...(forcedSelection ? { modelSelection: forcedSelection } : {}),
    ...(forcedPrefix ? { prefixKind: forcedPrefix } : {}),
    ...(forcedSteer ? { steerVia: forcedSteer } : {}),
  };
}

async function resolveBaseProfile(env, log) {
  const custom = nonEmptyString(env.GROK_SHIM_BACKEND_BIN);
  if (custom) {
    const args = backendArguments(env.GROK_SHIM_BACKEND_ARGS);
    return {
      kind: "custom",
      backend: { command: resolveCommand(custom, env), args },
      modelSelection: "set-model",
      environment: true,
      models: resolveModels(env),
      currentModelId: DEFAULT_MODEL_ID,
      prefixKind: null,
      explicitProfile: true,
      steerVia: "queue",
    };
  }

  const requested = (nonEmptyString(env.GROK_SHIM_PROFILE) ?? "").toLowerCase();
  if (requested === "agy") return agyProfile(env, log);
  if (requested === "maka") return makaProfile(env, log);
  if (requested) throw new Error(`unknown GROK_SHIM_PROFILE "${requested}": expected agy or maka`);

  // Machine-level discovery must work with either backend installed alone.
  const available = [
    ["agy", resolveAgyAcpCommand(env)],
    ["maka", resolveMakaCommand(env)],
  ].filter(([, backend]) => findExecutable(backend.command, env));
  if (available.length === 0) throw new Error("no ACP backend found: install Maka or configure AGY_ACP_BIN / MAKA_BIN");
  const profiles = await Promise.all(available.map(([kind]) => kind === "agy" ? agyProfile(env, log) : makaProfile(env, log)));
  return { ...profiles[0], models: profiles.flatMap((profile) => profile.models), explicitProfile: false };
}

async function makaProfile(env, log) {
  const backend = resolveMakaCommand(env);
  const discovered = await discoverMakaModels({ ...backend, cwd: process.cwd(), log, env });
  const bare = discovered?.models?.length
    ? discovered.models
    : [{ modelId: MAKA_SENTINEL_MODEL, name: "Maka default", _meta: { reasoningEfforts: MAKA_EFFORTS } }];
  const models = withModelPrefix("maka", bare);
  const currentBare = discovered?.currentModelId ?? bare[0]?.modelId ?? null;
  return {
    kind: "maka",
    backend,
    // Maka exposes the model as an ACP config option, not `session/set_model`.
    modelSelection: "config-option",
    // Maka's Runtime Host already injects its own environment context.
    environment: false,
    models,
    currentModelId: currentBare ? `maka_${currentBare}` : null,
    prefixKind: "maka",
    explicitProfile: true,
    // Maka implements `session/inject`, so a mid-turn message is steered
    // rather than queued behind the turn.
    steerVia: "inject",
  };
}

async function agyProfile(env, log) {
  const declared = resolveModels(env);
  // Discover the installed server's catalogue; a failed probe uses declared IDs.
  const backend = resolveAgyAcpCommand(env);
  const backendEnv = agyBackendEnv(env);
  const served = nonEmptyString(env.GROK_SHIM_PROBE) === "off"
    ? null
    : await discoverAgyModels({ ...backend, cwd: process.cwd(), log, timeoutMs: 15_000, env: backendEnv });
  const bare = served ? discoveredModels(served.ids, env) : declared;
  const current = [served?.currentModelId, DEFAULT_MODEL_ID].find((id) => bare.some((model) => model.modelId === id)) ?? bare[0].modelId;
  const agyModels = withModelPrefix("agy", bare);
  return {
    kind: "agy-acp",
    backend: { ...backend, args: [] },
    backendEnv,
    authMethod: nonEmptyString(env.AGY_ACP_AUTH_METHOD),
    modelSelection: "set-model",
    environment: true,
    models: agyModels,
    currentModelId: `agy_${current}`,
    prefixKind: "agy",
    explicitProfile: true,
    // agy answers `_x.ai/interject` with null and does nothing, so its busy
    // messages are queued and delivered at the turn boundary.
    steerVia: "queue",
  };
}
