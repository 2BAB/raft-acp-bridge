import { createInterface } from "node:readline";

/**
 * One line-delimited JSON-RPC 2.0 endpoint. Both sides of the shim speak this
 * (Raft on stdin/stdout, the backend on its pipes), so one class covers both.
 * Malformed lines are dropped: a parse error here must not take down a session
 * Raft believes is alive.
 */
export class LineChannel {
  #output;
  #label;
  #log;
  #closed = false;

  constructor({ input, output, onMessage, onClose, label, log }) {
    this.#output = output;
    this.#label = label;
    this.#log = log;

    const reader = createInterface({ input, crlfDelay: Infinity, terminal: false });
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.#log(`${label}: dropped a line that was not JSON (${trimmed.length} bytes)`);
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      onMessage(message);
    });
    reader.on("close", () => {
      if (this.#closed) return;
      this.#closed = true;
      onClose?.();
    });
  }

  get closed() {
    return this.#closed;
  }

  #write(payload) {
    if (this.#closed) return;
    try {
      this.#output.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
    } catch (error) {
      this.#log(`${this.#label}: write failed: ${error?.message ?? error}`);
    }
  }

  respond(id, result) {
    this.#write({ id, result: result ?? {} });
  }

  fail(id, code, message, data) {
    this.#write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  notify(method, params) {
    this.#write({ method, params: params ?? {} });
  }

  request(id, method, params) {
    this.#write({ id, method, params: params ?? {} });
  }
}
