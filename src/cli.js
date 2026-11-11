import "./bootstrap.js";
import { resolveProfile } from "./profiles.js";
import { loadExtension } from "./extensions.js";
import { delegateToRealGrok, resolveRealGrok } from "./realGrok.js";
import { LineChannel } from "./rpc.js";
import { Shim } from "./shim.js";
import { readAgyBilling } from "./backends/agy/usage.js";

const SHIM_VERSION = "0.3.0";
const CLI_VERSION_LINE = `grok 0.9.0 (raft-acp-bridge ${SHIM_VERSION})`;

const USAGE = `grok - raft-acp-bridge ${SHIM_VERSION}

Usage:
  grok --version
  grok agent [--no-leader] [--always-approve] stdio

The stdio subcommand speaks ACP (JSON-RPC over stdio) the way Raft's Grok Build
driver expects, and forwards each session to the configured backend. Any other
verb is handed to the real Grok Build CLI when one is installed.

Environment:
  SHIM_ENV_FILE          optional .env path (default: this repository's .env)
  RAFT_GROK_BACKEND       "shim" (or "agy") forces this shim; "grok" forces the real CLI.
                          Unset: the real CLI when found, else this shim.
  GROK_SHIM_REAL_GROK     path to the real grok binary (skips the PATH scan)
  GROK_SHIM_BACKEND_BIN   custom ACP backend command
  GROK_SHIM_BACKEND_ARGS  JSON-array or whitespace-separated backend args
  AGY_CLI_BIN             path to Antigravity CLI (defaults to PATH or ~/.local/bin/agy)
  AGY_ACP_BIN             path to an existing standalone ACP server
  AGY_ACP_AUTH_METHOD     optional backend authentication method id
  GROK_SHIM_INTERJECT     "reject" refuses messages sent during an active turn
  GROK_SHIM_QUEUE_NOTICE  text of the notice shown while a message waits;
                          "off" keeps the queue silent
  GROK_SHIM_ENVIRONMENT   "off" stops the per-session environment block from
                          being prepended (default: on)
  GROK_SHIM_STEER         override steering: prompt, queue or inject
  GROK_SHIM_MODELS        comma-separated model list, id:Label
  GROK_SHIM_DEBUG         set to 1 to log to stderr
`;

const argv = process.argv.slice(2);
const [first, ...rest] = argv;

/**
 * Raft spawns one `grok` process per agent and merges the agent's own env vars
 * into it, so the route is decided per agent, not per session. The default is
 * deliberately the real CLI: installing this shim must not change what an
 * agent on a machine with Grok Build installed already does.
 */
function resolveRoute() {
  const forced = (process.env.RAFT_GROK_BACKEND ?? "").trim().toLowerCase();
  if (forced === "agy" || forced === "shim") return { kind: "agy" };
  if (forced === "grok" || forced === "real") return { kind: "grok", forced: true };
  const realGrok = resolveRealGrok();
  return realGrok ? { kind: "grok", command: realGrok } : { kind: "agy" };
}

const route = resolveRoute();
const realGrok = route.kind === "grok" ? route.command ?? resolveRealGrok() : resolveRealGrok();

if (route.kind === "grok") {
  if (!realGrok) {
    process.stderr.write(
      "grok (raft-acp-bridge): RAFT_GROK_BACKEND=grok but no real Grok Build CLI was found on PATH.\n" +
        "Install Grok Build, or set GROK_SHIM_REAL_GROK to its path.\n",
    );
    process.exit(127);
  }
  delegateToRealGrok(realGrok, argv);
}

// Verbs this shim does not implement belong to the real CLI (`grok login`, the
// interactive session, and whatever else ships next).
const owns = new Set(["--version", "-v", "version", "--help", "-h", "help", "agent"]);
if (realGrok && (!first || !owns.has(first))) {
  delegateToRealGrok(realGrok, argv);
}

if (!first || first === "--help" || first === "-h" || first === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (first === "--version" || first === "-v" || first === "version") {
  process.stdout.write(`${CLI_VERSION_LINE}\n`);
  process.exit(0);
}

if (first !== "agent") {
  process.stderr.write(USAGE);
  process.exit(2);
}

if (rest.includes("--help") || rest.includes("-h")) {
  // Raft probes with `agent stdio --help` and only checks the exit code.
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!rest.includes("stdio")) {
  process.stderr.write(USAGE);
  process.exit(2);
}

startStdioServer().catch((error) => {
  process.stderr.write(`grok (raft-acp-bridge): ${error?.message ?? error}\n`);
  process.exit(1);
});

async function startStdioServer() {
  const debug = process.env.GROK_SHIM_DEBUG === "1";
  const log = (line) => {
    if (debug) process.stderr.write(`[raft-acp-bridge] ${line}\n`);
  };

  const extension = await loadExtension();
  const env = { ...process.env, ...await extension.configureEnvironment?.({ env: process.env }) };
  const profile = await resolveProfile(env, log);
  log(`profile: ${profile.kind} (${profile.backend.command})`);

  const lifecycle = await extension.createLifecycle?.({ profile, env, log }) ?? {};
  profile.backendEnv = { ...env, ...profile.backendEnv, ...lifecycle.backendEnv };
  let disposed = false;
  process.once("exit", () => {
    if (!disposed) { disposed = true; lifecycle.dispose?.(); }
  });

  const interjectMode =
    (process.env.GROK_SHIM_INTERJECT ?? "").trim().toLowerCase() === "reject" ? "reject" : "queue";
  const rawNotice = (process.env.GROK_SHIM_QUEUE_NOTICE ?? "").trim();
  const queueNotice = rawNotice.toLowerCase() === "off" ? null : rawNotice || undefined;
  const environmentEnv = (process.env.GROK_SHIM_ENVIRONMENT ?? "").trim().toLowerCase();
  const environment = ["0", "off", "false", "no"].includes(environmentEnv)
    ? false
    : ["1", "on", "true", "yes"].includes(environmentEnv)
      ? true
      : profile.environment;
  const shim = new Shim({
    backend: profile.backend,
    backendEnv: profile.backendEnv,
    models: profile.models,
    log,
    interjectMode,
    queueNotice,
    environment,
    modelSelection: profile.modelSelection,
    currentModelId: profile.currentModelId,
    prefixKind: profile.prefixKind,
    steerVia: profile.steerVia,
    resumeVia: profile.resumeVia,
    explicitProfile: profile.explicitProfile !== false,
    lifecycle,
    authMethod: profile.authMethod,
    readAccountUsage: profile.prefixKind === "agy" ? () => readAgyBilling(env) : null,
  });
  const client = new LineChannel({
    input: process.stdin,
    output: process.stdout,
    onMessage: (message) => shim.handleClientMessage(message),
    onClose: () => {
      shim.shutdown();
      process.exit(0);
    },
    label: "client",
    log,
  });

  shim.start(client);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      shim.shutdown();
      process.exit(0);
    });
  }
}
