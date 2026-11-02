import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { nonEmptyString, recordValue } from "../../util.js";
import { readConfig, resolveCommand } from "../../config.js";

/**
 * The Antigravity ACP server is a packaged executable (`agy_acp_server.par`,
 * hundreds of MB) that must stay beside its helper binary. It is a Google
 * artifact, not something this repository ships: extract it and either point
 * `AGY_ACP_BIN` at it or drop the pair into the default location below.
 */
export function resolveAgyAcpCommand(env = process.env) {
  return { command: readConfig(env).agyBin, args: [] };
}

/**
 * `GROK_SHIM_BACKEND_BIN` replaces the backend entirely (the test fixture uses
 * it, and it is the seam for driving Maka or dsh later). Without it the shim
 * drives the Antigravity ACP server.
 */
export function resolveBackend(env = process.env) {
  const command = nonEmptyString(env.GROK_SHIM_BACKEND_BIN);
  if (command) {
    const args = nonEmptyString(env.GROK_SHIM_BACKEND_ARGS)
      ? env.GROK_SHIM_BACKEND_ARGS.split(" ").filter(Boolean)
      : [];
    return { command: resolveCommand(command, env), args, kind: "custom" };
  }
  return { ...resolveAgyAcpCommand(env), kind: "agy-acp" };
}

/** Backend authentication and credential storage remain under its own control. */
export function agyBackendEnv(env = process.env) {
  return { ...env };
}

/** Discovery is cached against the installed server executable. */
const PROBE_CACHE = path.join(os.tmpdir(), "raft-acp-bridge-agy-models.json");

function cacheKey(command) {
  try {
    const stats = fs.statSync(command);
    return `${command}|${stats.size}|${Math.floor(stats.mtimeMs)}`;
  } catch {
    return null;
  }
}

function readCached(key) {
  try {
    const parsed = recordValue(JSON.parse(fs.readFileSync(PROBE_CACHE, "utf8")));
    if (parsed?.key !== key || !Array.isArray(parsed.ids) || parsed.ids.length === 0) return null;
    return { ids: parsed.ids.filter((id) => typeof id === "string" && id.length > 0), currentModelId: parsed.currentModelId ?? null };
  } catch {
    return null;
  }
}

function writeCached(key, result) {
  try {
    fs.writeFileSync(PROBE_CACHE, JSON.stringify({ key, ...result }));
  } catch {
    // A cache that cannot be written only costs a probe next time.
  }
}

export async function discoverAgyModels({ command, args = [], cwd, timeoutMs = 15_000, log = () => {}, env = process.env }) {
  const key = cacheKey(command);
  const cached = key ? readCached(key) : null;
  if (cached) {
    log(`agy probe: ${cached.ids.length} model(s) (cached)`);
    return cached;
  }

  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, shell: false });
  const pending = new Map();
  let nextId = 1;
  let stderrTail = "";
  let sessionId = null;

  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  };

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  reader.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-400);
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true });
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (initialize.error || initialize.timeout) {
      log(`agy probe: initialize failed (${initialize.error?.message ?? "timeout"})`);
      return null;
    }
    // The server refuses a session before it is authenticated.
    const methods = initialize.result?.authMethods ?? [];
    const configuredAuth = nonEmptyString(env.AGY_ACP_AUTH_METHOD);
    const methodId = configuredAuth ?? methods.find((method) => method.id === "oauth-personal")?.id ?? methods[0]?.id;
    if (configuredAuth && !methods.some((method) => method.id === configuredAuth)) {
      throw new Error("configured AGY_ACP_AUTH_METHOD is not advertised by this server");
    }
    if (methodId) await request("authenticate", { methodId });
    const created = await request("session/new", { cwd, mcpServers: [] });
    const result = recordValue(created.result);
    sessionId = nonEmptyString(result?.sessionId);
    const option = (result?.configOptions ?? [])
      .map((entry) => recordValue(entry))
      .find((entry) => entry?.id === "model");
    if (!sessionId || !option) {
      log(`agy probe: session/new returned no model option${stderrTail ? ` (${stderrTail.trim().slice(-120)})` : ""}`);
      return null;
    }
    const ids = (option.options ?? [])
      .map((entry) => nonEmptyString(recordValue(entry)?.value))
      .filter((id) => id !== null);
    log(`agy probe: ${ids.length} model(s), current ${String(option.currentValue)}`);
    if (ids.length === 0) return null;
    // The probe session would otherwise linger in the server's store.
    await request("session/close", { sessionId });
    sessionId = null;
    const discovered = { ids, currentModelId: nonEmptyString(option.currentValue) };
    if (key) writeCached(key, discovered);
    return discovered;
  } catch (error) {
    log(`agy probe: ${error.message}`);
    return null;
  } finally {
    if (sessionId) request("session/close", { sessionId }).catch(() => {});
    stop();
  }
}
