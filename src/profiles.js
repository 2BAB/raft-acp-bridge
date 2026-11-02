import { agyBackendEnv, discoverAgyModels, resolveAgyAcpCommand } from "./backends/agy/index.js";
import { MAKA_EFFORTS, MAKA_SENTINEL_MODEL, discoverMakaModels, resolveMakaCommand } from "./backends/maka/index.js";
import { DEFAULT_MODEL_ID, knownModels, resolveModels, servedModels } from "./backends/agy/models.js";
import { splitModelPrefix, withModelPrefix } from "./models.js";
import { nonEmptyString } from "./util.js";
import { resolveCommand, backendArguments } from "./config.js";

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
  if (requested === "agy") {
    return agyUnionProfile(env, log, { explicit: true });
  }
  if (requested === "maka") {
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

  return agyUnionProfile(env, log, { explicit: false });
}

/**
 * The agy profile, plus the Maka catalogue in the same list: this is what the
 * machine-level probe sees, and what lets an agent be created with a model its
 * own backend actually offers. `explicit` is false when no GROK_SHIM_PROFILE
 * was set — such a process can answer model detection, but refuses to create a
 * session, because running a backend nobody declared is exactly the ambiguity
 * the explicit profile exists to remove.
 */
async function agyUnionProfile(env, log, { explicit }) {
  const declared = resolveModels(env);
  // Discover the installed server's catalogue; a failed probe uses declared IDs.
  const backend = resolveAgyAcpCommand(env);
  const backendEnv = agyBackendEnv(env);
  const served = nonEmptyString(env.GROK_SHIM_PROBE) === "off"
    ? null
    : await discoverAgyModels({ ...backend, cwd: process.cwd(), log, timeoutMs: 15_000, env: backendEnv });
  const agyModels = withModelPrefix("agy", (served && servedModels(knownModels(env), served.ids)) || declared);
  const makaProbe = explicit
    ? null
    : await discoverMakaModels({
        ...resolveMakaCommand(env),
        env,
        cwd: process.cwd(),
        log,
        timeoutMs: 8000,
      });
  const makaModels =
    !explicit && makaProbe?.models?.length ? withModelPrefix("maka", makaProbe.models) : [];
  return {
    kind: "agy-acp",
    backend: { ...backend, args: [] },
    backendEnv,
    authMethod: nonEmptyString(env.AGY_ACP_AUTH_METHOD),
    modelSelection: "set-model",
    environment: true,
    models: [...agyModels, ...makaModels],
    currentModelId: `agy_${DEFAULT_MODEL_ID}`,
    prefixKind: "agy",
    explicitProfile: explicit,
    // agy answers `_x.ai/interject` with null and does nothing, so its busy
    // messages are queued and delivered at the turn boundary.
    steerVia: "queue",
  };
}
