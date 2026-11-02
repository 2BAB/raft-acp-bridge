#!/usr/bin/env node
// Inspect the installed ACP server's session model catalogue.
// --probe tests model selection; --prompt also makes real model calls.
// --model <id> restricts the check to a model returned by that server.
import "../src/bootstrap.js";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { resolveAgyAcpCommand } from "../src/backends/agy/index.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const probe = flag("probe");
const prompt = flag("prompt");
const onlyModel = value("model");
const authMethodId = value("auth") ?? "oauth-personal";

const { command, args } = resolveAgyAcpCommand(process.env);
const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
const pending = new Map();
let nextId = 1;
let stderrTail = "";
let sessionId = null;
// Anything the server streams for the turn in flight. A turn can end with
// `end_turn` and still carry no answer — the harness turns a backend rejection
// into an error string and closes normally, which is exactly the failure mode a
// stopReason check alone hides.
const streamed = [];

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle(message);
    }
    return;
  }
  const content = message.params?.update?.content;
  if (typeof content?.text === "string") streamed.push(content.text);
});
child.stderr.on("data", (chunk) => {
  stderrTail = `${stderrTail}${chunk}`.slice(-800);
});

const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

const timer = setTimeout(() => {
  console.error(`timed out; backend stderr tail:\n${stderrTail}`);
  process.exit(2);
}, 300_000);

function done(code = 0) {
  clearTimeout(timer);
  if (sessionId && code === 0) {
    // Best effort: a half-closed probe session lingers in the server otherwise.
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "session/close", params: { sessionId } })}\n`,
      );
    } catch {
      // Already gone.
    }
  }
  child.kill("SIGTERM");
  process.exit(code);
}

await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
await request("authenticate", { methodId: authMethodId });

const session = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
if (session.error) {
  console.error(`session/new failed: ${JSON.stringify(session.error)}`);
  done(1);
}
sessionId = session.result.sessionId;

const modelOption = (session.result.configOptions ?? []).find((option) => option?.id === "model");
const offered = (modelOption?.options ?? []).map((option) => option.value);
console.log(`server offers ${offered.length} models, current ${modelOption?.currentValue}:`);
for (const option of modelOption?.options ?? []) {
  console.log(`  ${option.value.padEnd(26)} ${option.name}`);
}

const candidates = onlyModel ? [onlyModel] : offered;
let mismatches = 0;

if (onlyModel || probe) {
  console.log("\nset_model:");
  for (const modelId of candidates) {
    const response = await request("session/set_model", { sessionId, modelId });
    if (response.error) {
      console.log(`  ${modelId.padEnd(26)} rejected ${response.error.code}: ${response.error.message}`);
      const available = response.error.data?.availableModels;
      if (available) console.log(`    available: ${available.join(", ")}`);
      if (!onlyModel) mismatches += 1;
      continue;
    }
    console.log(`  ${modelId.padEnd(26)} ok`);
  }
}

if (prompt) {
  console.log("\nfirst turn:");
  for (const modelId of candidates) {
    const selected = await request("session/set_model", { sessionId, modelId });
    if (selected.error) {
      console.log(`  ${modelId.padEnd(26)} skipped (selection rejected)`);
      continue;
    }
    streamed.length = 0;
    const started = Date.now();
    const turn = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (turn.error) {
      console.log(`  ${modelId.padEnd(26)} failed after ${seconds}s: ${turn.error.message}`);
      mismatches += 1;
      continue;
    }
    const answer = streamed.join("").trim();
    const verdict = answer.length === 0
      ? "NO TEXT — the backend rejected the turn"
      : /^Agent execution error/i.test(answer)
        ? "ERROR TEXT — the backend rejected the turn"
        : "answered";
    if (verdict !== "answered") mismatches += 1;
    console.log(`  ${modelId.padEnd(26)} ${verdict} after ${seconds}s (${turn.result?.stopReason ?? "?"})`);
    if (answer) console.log(`    ${answer.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

done(mismatches > 0 ? 1 : 0);
