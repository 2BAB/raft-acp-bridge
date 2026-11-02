import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { nonEmptyString, recordValue } from "../../util.js";
import { readConfig } from "../../config.js";

/** Maka serves ACP v1 over stdio; one flag, no auth. */
export function resolveMakaCommand(env = process.env) {
  return { command: readConfig(env).makaBin, args: ["--acp"] };
}

import { modelOption, entryFor } from "./models.js";
export { MAKA_EFFORTS, MAKA_SENTINEL_MODEL, thinkingLevelFor } from "./models.js";

/**
 * Maka reveals its models per session, but Raft asks for them on the
 * initialize result. So a short probe session is opened, read, and closed —
 * `session/close` included so the Host does not keep an orphan entry.
 */
export async function discoverMakaModels({ command, args = [], cwd, timeoutMs = 20_000, log = () => {} }) {
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env, shell: false });
  const pending = new Map();
  let nextId = 1;
  let stderrTail = "";
  let probeSessionId = null;

  const finish = () => {
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
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry(message);
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
    const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: { terminal: false } });
    if (initialize.error || initialize.timeout) {
      log(`maka probe: initialize failed (${initialize.error?.message ?? "timeout"})`);
      return null;
    }
    const created = await request("session/new", { cwd, mcpServers: [] });
    const sessionId = nonEmptyString(recordValue(created.result)?.sessionId);
    probeSessionId = sessionId;
    const configOptions = recordValue(created.result)?.configOptions;
    const option = modelOption(configOptions);
    if (!sessionId || !option) {
      log("maka probe: session/new returned no model option");
      return null;
    }
    const available = (option.options ?? [])
      .map((entry) => recordValue(entry))
      .map((entry) => ({
        id: nonEmptyString(entry?.value),
        name: nonEmptyString(entry?.name),
      }))
      .filter((entry) => entry.id !== null);
    log(`maka probe: ${available.length} model(s), current ${String(option.currentValue)}`);
    return {
      models: available.map(({ id, name }) => entryFor(id, name, configOptions)),
      currentModelId: nonEmptyString(option.currentValue) ?? available[0]?.id ?? null,
      thinkingOption: thinkingOption(configOptions),
    };
  } catch (error) {
    log(`maka probe failed: ${error?.message ?? error}${stderrTail ? ` | ${stderrTail.slice(0, 160)}` : ""}`);
    return null;
  } finally {
    // Best effort: close before killing so the Host drops the probe session.
    try {
      if (probeSessionId) await request("session/close", { sessionId: probeSessionId });
    } catch {
      // Ignore.
    }
    finish();
  }
}
