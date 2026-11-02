// A stand-in ACP backend: enough of the protocol to exercise the shim without
// an Antigravity login. Every request it receives is re-broadcast as a
// `shim/test/log` notification, so tests can assert on ordering.
import { createInterface } from "node:readline";

const sessionId = "fake-session-1";
/** A prompt containing this word answers slowly, so a turn can be caught busy. */
const SLOW_MARKER = "SLOW";
const SLOW_DELAY_MS = 400;

const send = (payload) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
const log = (event, extra = {}) => send({ method: "shim/test/log", params: { event, ...extra } });

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (message.id !== undefined && typeof message.method === "string") {
    if (message.method === "session/prompt") {
      const text = (message.params.prompt ?? []).map((block) => block?.text ?? "").join("\n---\n");
      log("request", { method: message.method, text });
      const reply = () => {
        send({
          method: "session/update",
          params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `received:${text}` } },
          },
        });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      };
      if (text.includes(SLOW_MARKER)) setTimeout(reply, SLOW_DELAY_MS);
      else reply();
      return;
    }

    log("request", {
      method: message.method,
      ...(message.method === "session/set_model" ? { modelId: message.params?.modelId } : {}),
      ...(message.method === "session/inject"
        ? {
            mode: message.params?.mode,
            text: (message.params?.content ?? []).map((block) => block?.text ?? "").join(""),
          }
        : {}),
    });
    switch (message.method) {
      case "initialize":
        send({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [
              { id: "oauth-personal", name: "Google account" },
              { id: "gemini-api-key", name: "Gemini API key" },
            ],
          },
        });
        return;
      case "authenticate":
        send({ id: message.id, result: {} });
        return;
      case "session/new":
        send({
          id: message.id,
          result: {
            sessionId,
            configOptions: [
              {
                type: "select",
                id: "model",
                name: "Model",
                category: "model",
                currentValue: "maka-one",
                options: [
                  { value: "maka-one", name: "Maka One" },
                  { value: "maka-two", name: "Maka Two" },
                ],
              },
            ],
          },
        });
        return;
      case "session/inject": {
        const text = (message.params?.content ?? []).map((block) => block?.text ?? "").join("");
        if (text.startsWith("no-turn")) {
          // What a backend answers when the turn it was asked to steer ended.
          send({
            id: message.id,
            error: { code: -32010, message: "Cannot steer a Session with no running turn" },
          });
          return;
        }
        if (text.startsWith("no-inject")) {
          send({ id: message.id, error: { code: -32601, message: "method not implemented" } });
          return;
        }
        send({ id: message.id, result: { messageId: "injected-1" } });
        return;
      }
      case "session/set_config_option": {
        log("request", {
          method: message.method,
          configId: message.params?.configId,
          value: message.params?.value,
        });
        send({ id: message.id, result: { configOptions: [] } });
        return;
      }
      case "session/load":
        // Agy answers a live session with modes/configOptions and no sessionId;
        // anything else is a miss Raft is expected to fall back from.
        if (String(message.params?.sessionId ?? "").startsWith("live")) {
          send({ id: message.id, result: { modes: { currentModeId: "default" } } });
          return;
        }
        send({ id: message.id, error: { code: -32002, message: "Session not found in the current GEMINI_HOME" } });
        return;
      case "session/set_model": {
        const modelId = String(message.params?.modelId ?? "");
        if (modelId.startsWith("bad")) {
          send({
            id: message.id,
            error: { code: -32602, message: `Model '${modelId}' is not available for the current authentication method.` },
          });
          return;
        }
        send({ id: message.id, result: {} });
        return;
      }
      default:
        send({ id: message.id, error: { code: -32601, message: "method not implemented" } });
        return;
    }
  }

  if (message.id !== undefined) log("response", { id: message.id });
  else if (typeof message.method === "string") log("notification", { method: message.method });
});
