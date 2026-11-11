import fs from "node:fs";
import path from "node:path";
import { findExecutable } from "./config.js";
import { isBridgeEntry } from "./realGrok.js";

/** Install only into an unused location or replace another bridge entry. */
export function installShim(config) {
  const target = fs.realpathSync(config.shimEntry);
  fs.accessSync(target, fs.constants.X_OK);
  let existing;
  try { existing = fs.lstatSync(config.shimBin); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    let resolved;
    try { resolved = fs.realpathSync(config.shimBin); } catch { /* A stale symlink is still an existing entry. */ }
    if (resolved === target) return { target, link: config.shimBin, changed: false };
    if (!resolved || !isBridgeEntry(resolved)) {
      throw new Error(`refusing to replace existing executable ${config.shimBin}; preserve it first and set GROK_SHIM_REAL_GROK to its new path, or choose an unused SHIM_BIN directory earlier on PATH`);
    }
    fs.unlinkSync(config.shimBin);
  }
  fs.mkdirSync(path.dirname(config.shimBin), { recursive: true });
  fs.symlinkSync(target, config.shimBin);
  return { target, link: config.shimBin, changed: true };
}

export function makaExecutable(config, env = process.env) {
  // launchd may start without the user's local bin directory on PATH.
  return findExecutable(config.makaBin, env)
    ?? (!env.MAKA_BIN?.trim() ? findExecutable(path.join(config.home, ".local/bin/maka"), env) : null);
}

export function computerCommand(config, env = process.env) {
  if (env.RAFT_COMPUTER_BIN?.trim()) return { command: config.raftComputerBin, args: [] };
  if (config.raftComputerScript) {
    return { command: process.execPath, args: [config.raftComputerScript] };
  }
  return { command: config.raftComputerBin, args: [] };
}

export function computerProcessPattern(config, env = process.env) {
  const selected = computerCommand(config, env);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const executable = selected.args[0] || findExecutable(selected.command, env) || selected.command;
  let canonical = executable;
  try { canonical = fs.realpathSync(executable); } catch { /* Not installed yet. */ }
  return new RegExp(`(?:${escape(executable)}|${escape(canonical)})\\s+__(?:service|run)(?:\\s|$)`);
}

const xml = (text) => String(text).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[char]);

export function launchAgentPlist(config, shellPath, node = process.execPath) {
  // Do not turn the optional, absent default .env into a required file at login.
  const envFile = config.envFileExplicit || fs.existsSync(config.envFile)
    ? `<key>SHIM_ENV_FILE</key><string>${xml(config.envFile)}</string>` : "";
  const extension = config.extensionModule
    ? `<key>SHIM_EXTENSION_MODULE</key><string>${xml(config.extensionModule)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.2bab.raft-stack</string>
  <key>ProgramArguments</key><array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(config.repoRoot, "ops/raft-stack.mjs"))}</string>
    <string>up</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(shellPath)}</string>
    <key>SHIM_CONFIG_ROOT</key><string>${xml(config.configRoot)}</string>
    ${envFile}
    ${extension}
  </dict>
  <key>StandardOutPath</key><string>${xml(config.launchAgentLog)}</string>
  <key>StandardErrorPath</key><string>${xml(config.launchAgentLog)}</string>
</dict></plist>
`;
}
