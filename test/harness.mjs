import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";

const BIN = new URL("../bin/grok", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/fake-acp-backend.mjs", import.meta.url).pathname;
const REQUEST_TIMEOUT_MS = 5_000;

/** Boots `grok agent stdio` against the fixture backend and speaks to it. */
export async function startShim({ env = {}, bin = BIN } = {}) {
  const child = spawn(bin, ["agent", "--no-leader", "--always-approve", "stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SHIM_ENV_FILE: os.devNull, SHIM_CONFIG_ROOT: "", SHIM_EXTENSION_MODULE: "",
      RAFT_GROK_BACKEND: "agy",
      GROK_SHIM_BACKEND_BIN: process.execPath,
      GROK_SHIM_BACKEND_ARGS: FIXTURE,
      ...env,
    },
  });

  const messages = [];
  const waiters = new Set();
  const pending = new Map();
  const stderrChunks = [];
  let nextId = 1;
  let exited = null;

  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf8")));
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    for (const waiter of [...waiters]) waiter.reject(new Error(`shim exited: ${JSON.stringify(exited)}`));
    waiters.clear();
  });

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      throw new Error(`shim wrote a non-JSON line: ${trimmed}`);
    }

    const isResponse = message.id !== undefined && (message.result !== undefined || message.error !== undefined);
    const request = isResponse ? pending.get(message.id) : undefined;
    if (request) {
      pending.delete(message.id);
      request.resolve(message);
      return;
    }

    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method} (id ${id}); stderr:\n${stderrChunks.join("")}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function waitFor(predicate) {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.add(waiter);
      setTimeout(() => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        reject(new Error(`timed out waiting for a notification; stderr:\n${stderrChunks.join("")}`));
      }, REQUEST_TIMEOUT_MS);
    });
  }

  return {
    request,
    waitFor,
    messages,
    stderr: () => stderrChunks.join(""),
    logs: () =>
      messages
        .filter((message) => message.method === "shim/test/log")
        .map((message) => message.params),
    close: () => child.kill("SIGTERM"),
  };
}

/** Text the fixture echoed back, one string per `agent_message_chunk`. */
export function echoedText(messages) {
  return messages
    .filter(
      (message) =>
        message.method === "session/update" &&
        message.params?.update?.sessionUpdate === "agent_message_chunk",
    )
    .map((message) => message.params.update.content?.text ?? "");
}
