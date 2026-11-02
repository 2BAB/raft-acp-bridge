import fs from "node:fs";
import path from "node:path";
import { findExecutable, readConfig } from "./config.js";
import { computerCommand } from "./installation.js";
import { readable } from "./checks.js";
import { checkAgyInstallation } from "./backends/agy/doctor.js";
import { checkMakaInstallation } from "./backends/maka/doctor.js";

/** Installation checks only: no login, model calls, builds or service changes. */
export function checkInstallation({ env = process.env, profile = env.GROK_SHIM_PROFILE || "all", platform = process.platform } = {}) {
  profile = profile.trim().toLowerCase();
  if (!["agy", "maka", "all"].includes(profile)) throw new Error("profile must be agy, maka or all");
  const config = readConfig(env);
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const executable = (name, command) => {
    const found = findExecutable(command, env);
    add(name, found ? "ok" : "error", found || `not executable or not on PATH: ${command}`);
    return found;
  };
  add("platform", platform === "darwin" ? "ok" : "error", `${platform}/${process.arch}; this setup targets macOS`);
  add("node", Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "error", `${process.version} (${process.execPath}); requires Node >=22`);
  add("environment", fs.existsSync(config.envFile) ? "ok" : "warn", `${config.envFile}${fs.existsSync(config.envFile) ? "" : " absent; using environment and defaults"}`);
  add("raft-app", fs.existsSync(config.raftApp) ? "ok" : "warn", config.raftApp);
  const target = config.shimEntry;
  let linked = false;
  try { linked = fs.realpathSync(config.shimBin) === fs.realpathSync(target); } catch { /* Not installed yet. */ }
  add("shim-link", linked ? "ok" : "error", linked ? config.shimBin : `link ${config.shimBin} to ${target}`);
  // An alternate install directory also has to be on the PATH Raft captures.
  const onPath = findExecutable("grok", env);
  let detected = false;
  try { detected = onPath && fs.realpathSync(onPath) === fs.realpathSync(target); } catch { /* Missing entry. */ }
  add("shim-path", detected ? "ok" : "warn", detected ? onPath : "PATH does not resolve grok to this checkout; check the login-shell PATH before restarting Raft");
  let owner;
  try { owner = JSON.parse(fs.readFileSync(path.join(config.raftHome, "computer/host-lifecycle-owner.json"), "utf8")).owner; } catch { /* First install. */ }
  add("raft-home", owner ? "ok" : "warn", `${config.raftHome}; owner=${owner || "unset (open Raft once)"}`);
  if (owner === "cli" || env.RAFT_COMPUTER_BIN || env.RAFT_SOURCE) {
    const computer = computerCommand(config, env);
    executable("raft-computer", computer.command);
    if (computer.args[0]) add("raft-source-build", readable(computer.args[0]) ? "ok" : "error", computer.args[0]);
  }
  add("login-item", fs.existsSync(config.launchAgentFile) ? "warn" : "ok", fs.existsSync(config.launchAgentFile)
    ? `${config.launchAgentFile}; regenerate with install-agent after moving this checkout or Node`
    : "optional; no raft-stack login item installed");

  if (profile !== "maka") checkAgyInstallation({ config, env, add, executable });
  if (profile !== "agy") checkMakaInstallation({ config, env, add, executable });
  return { profile, checks, ok: checks.every((check) => check.status !== "error") };
}
