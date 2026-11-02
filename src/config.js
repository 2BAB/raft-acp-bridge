import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { agySettings } from "./backends/agy/config.js";
import { makaSettings } from "./backends/maka/config.js";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const value = (env, key, fallback) => env[key]?.trim() || fallback;

export function configurationRoot(env = process.env) {
  return resolvePath(value(env, "SHIM_CONFIG_ROOT", REPO_ROOT), { home: env.HOME || os.homedir(), base: REPO_ROOT });
}

export function resolvePath(input, { home = os.homedir(), base = REPO_ROOT } = {}) {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.resolve(home, input.slice(2));
  return path.resolve(base, input);
}

export function envFilePath(env = process.env, root = configurationRoot(env)) {
  return resolvePath(value(env, "SHIM_ENV_FILE", path.join(root, ".env")), {
    home: env.HOME || os.homedir(), base: root,
  });
}

/** Load once at each executable entry, before modules read environment values. */
export function loadRepositoryEnv(env = process.env, root = configurationRoot(env)) {
  const file = envFilePath(env, root);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !env.SHIM_ENV_FILE?.trim()) return { file, loaded: false };
    throw new Error(`cannot read shim environment file ${file}: ${error.code}`, { cause: error });
  }
  for (const [key, entry] of Object.entries(parseEnv(source))) {
    // The file cannot redirect itself; an agent's existing environment wins.
    if (!["SHIM_ENV_FILE", "SHIM_CONFIG_ROOT"].includes(key) && env[key] === undefined) env[key] = entry;
  }
  return { file, loaded: true };
}

/** Bare command names use PATH; paths are anchored to the selected .env file. */
export function resolveCommand(input, env = process.env) {
  return input.includes("/") || input.startsWith(".") || input === "~"
    ? resolvePath(input, { home: env.HOME || os.homedir(), base: path.dirname(envFilePath(env)) })
    : input;
}

export function findExecutable(command, env = process.env) {
  const resolved = resolveCommand(command, env);
  const candidates = resolved.includes(path.sep)
    ? [resolved]
    : (env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, resolved));
  return candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

export function readConfig(env = process.env) {
  const home = env.HOME || os.homedir();
  const envFile = envFilePath(env);
  const at = (key, fallback) => resolvePath(value(env, key, fallback), { home, base: path.dirname(envFile) });
  const dataDir = at("SHIM_DATA_DIR", path.join(home, "Library/Application Support/raft-acp-bridge"));
  const raftSource = at("RAFT_SOURCE", path.join(home, "Desktop/code/active/raft-source"));
  return {
    repoRoot: REPO_ROOT, configRoot: configurationRoot(env), home, envFile,
    envFileExplicit: Boolean(env.SHIM_ENV_FILE?.trim()), dataDir,
    shimEntry: path.join(configurationRoot(env), "bin/grok"),
    extensionModule: env.SHIM_EXTENSION_MODULE?.trim()
      ? at("SHIM_EXTENSION_MODULE", "") : null,
    ...agySettings({ env, home, at }),
    ...makaSettings({ env, home, at, command: (input) => resolveCommand(input, env) }),
    shimBin: at("SHIM_BIN", path.join(home, ".local/bin/grok")),
    raftHome: at("RAFT_HOME", path.join(home, ".slock")),
    raftApp: at("RAFT_APP_PATH", "/Applications/Raft Desktop.app"),
    raftSource,
    raftComputerScript: path.join(raftSource, "packages/computer/dist/raft-computer.js"),
    raftComputerBin: resolveCommand(value(env, "RAFT_COMPUTER_BIN", path.join(home, ".local/bin/raft-computer")), env),
    launchAgentFile: path.join(home, "Library/LaunchAgents/com.2bab.raft-stack.plist"),
    launchAgentLog: path.join(home, "Library/Logs/raft-stack.log"),
  };
}

// Normalize values inherited by external backends as well as this shim.
export function normalizePathEnv(env = process.env) {
  const base = path.dirname(envFilePath(env));
  const home = env.HOME || os.homedir();
  for (const key of ["AGY_ACP_BIN", "SHIM_DATA_DIR", "SHIM_EXTENSION_MODULE",
    "RAFT_HOME", "RAFT_SOURCE", "RAFT_APP_PATH", "MAKA_WORKSPACE", "GEMINI_HOME"]) {
    if (env[key]?.trim()) env[key] = resolvePath(env[key].trim(), { home, base });
  }
  for (const key of ["MAKA_BIN", "RAFT_COMPUTER_BIN", "GROK_SHIM_BACKEND_BIN", "GROK_SHIM_REAL_GROK"]) {
    if (env[key]?.trim()) env[key] = resolveCommand(env[key].trim(), env);
  }
}
