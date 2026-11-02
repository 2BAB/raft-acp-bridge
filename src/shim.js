import { spawn } from "node:child_process";

import { MAKA_SENTINEL_MODEL, thinkingLevelFor } from "./backends/maka/index.js";
import { runtimeEnvironmentText } from "./environment.js";
import { DEFAULT_MODEL_ID } from "./backends/agy/models.js";
import { splitModelPrefix } from "./models.js";
import { LineChannel } from "./rpc.js";
import { arrayValue, nonEmptyString, recordValue } from "./util.js";

const INTERJECT_METHOD = "_x.ai/interject";
const SET_MODEL_METHOD = "session/set_model";
const PROMPT_METHOD = "session/prompt";
const SESSION_NEW = "session/new";
const SESSION_LOAD = "session/load";

/**
 * Reverse requests (backend -> Raft, e.g. `session/request_permission`) need
 * ids that cannot collide with the ones Raft allocates: it counts up from 1.
 */
const REVERSE_ID_BASE = 1_000_000;

/** Backends that do not implement a method answer one of these. */
const UNSUPPORTED_METHOD = /method not found|not implemented|unsupported/i;

/** The shim's first synthetic id; still stored on agents created back then. */
const LEGACY_MODEL_ID = "antigravity-auto";

/**
 * Raft's Grok driver recognizes this shape as "the session I asked to resume is
 * gone" and starts a fresh one, announcing the recovered state to the user.
 */
/**
 * Shown to Raft when a message has to wait. It is client-facing only: the
 * backend never sees it, and it is not part of any prompt.
 */
const DEFAULT_QUEUE_NOTICE =
  "Still working on the previous turn, and this runtime cannot be steered mid-turn, " +
  "so this message is queued and will be delivered as soon as that turn ends. " +
  "No need to send it again. If it is urgent, cancel my task and reassign it to another agent.";

const MISSING_SESSION = {
  code: -32602,
  message: "session not found: the backend has no record of this session",
};

/**
 * Raft's Grok Build driver is an ACP client: `initialize`, `session/new`,
 * `session/prompt`, and `session/update` notifications. Antigravity's ACP server
 * speaks the same method names, so most of this is a proxy. What the shim
 * actually owns:
 *
 *  - the `initialize` result. Raft refuses to start unless the reply carries
 *    `protocolVersion: 1` and `agentCapabilities.loadSession: true`, and it
 *    reads the model list out of `_meta.modelState`.
 *  - authentication. Raft never sends `authenticate`; agy wants it before it
 *    will serve a session.
 *  - the standing prompt. Raft hands its CLI-transport system prompt down as
 *    `_meta.systemPromptOverride` on `session/new`. ACP has no such field, so
 *    it is prepended to the first prompt of the session.
 *  - `session/set_model`, forwarded or translated to backend config options.
 *  - busy delivery (`_x.ai/interject`). agy cannot steer, and worse, it answers
 *    every `_`-prefixed extension method with `null` — an ack that means
 *    nothing. So the shim queues the text and delivers it at the turn boundary,
 *    holding Raft's prompt response until the queue drains so the queued turns
 *    land inside the turn Raft still believes is open.
 */
export class Shim {
  #log;
  #backendCommand;
  #backendArgs;
  #backendEnv;
  #models;
  #interjectMode;
  #queueNotice;
  #environment;
  #modelSelection;
  #prefixKind;
  #explicitProfile;
  #steerVia;
  #currentModelId;
  #lifecycle;
  #backendPending = new Map();
  /** Ids for shim-initiated backend calls; clear of Raft's and reverse-request ranges. */
  #nextInternalRequestId = 2_000_000;
  #client = null;
  #backend = null;
  #backendProc = null;
  #initializeResult = null;
  #nextBackendId = 1;
  #nextReverseId = REVERSE_ID_BASE;
  #forwarded = new Map();
  #reversePending = new Map();
  #sessions = new Map();
  #pendingSessionInit = null;
  #authSent = false;
  #authMethod;
  #exiting = false;

  constructor({ backend, backendEnv, models, log, interjectMode = "queue", queueNotice, environment = true, modelSelection = "set-model", currentModelId = null, prefixKind = null, explicitProfile = true, steerVia = "queue", lifecycle = {}, authMethod = null }) {
    this.#backendCommand = backend.command;
    this.#backendArgs = backend.args;
    // A profile may need to change what the backend sees (agy's file credential
    // store). Everything else inherits this process's environment unchanged.
    this.#backendEnv = backendEnv ?? process.env;
    this.#lifecycle = lifecycle;
    this.#authMethod = authMethod;
    this.#models = models;
    this.#log = log;
    this.#interjectMode = interjectMode;
    // undefined means "use the built-in text"; null means "stay quiet".
    this.#queueNotice = queueNotice === undefined ? DEFAULT_QUEUE_NOTICE : queueNotice;
    this.#environment = environment;
    this.#modelSelection = modelSelection;
    this.#currentModelId = currentModelId;
    this.#prefixKind = prefixKind;
    this.#explicitProfile = explicitProfile;
    this.#steerVia = steerVia;
  }

  start(client) {
    this.#client = client;
    this.#backendProc = spawn(this.#backendCommand, this.#backendArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#backendEnv,
      shell: false,
    });

    this.#backendProc.on("error", (error) => {
      this.#log(`backend: spawn failed: ${error.message}`);
      this.#failEverything(`backend failed to start: ${error.message}`);
    });
    this.#backendProc.on("exit", (code, signal) => {
      this.#log(`backend: exited (code=${code}, signal=${signal})`);
      if (!this.#exiting) process.exit(code ?? 1);
    });
    this.#backendProc.stderr?.on("data", (chunk) => process.stderr.write(chunk));

    this.#backend = new LineChannel({
      input: this.#backendProc.stdout,
      output: this.#backendProc.stdin,
      onMessage: (message) => this.#onBackendMessage(message),
      onClose: () => this.#log("backend: closed stdout"),
      label: "backend",
      log: this.#log,
    });
  }

  /** Raft is gone, so the backend child has no session left to serve. */
  shutdown() {
    this.#exiting = true;
    try {
      this.#backendProc?.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  /** Entry point for messages arriving from Raft. */
  handleClientMessage(message) {
    if (message.id !== undefined && typeof message.method === "string") {
      return this.#onClientRequest(message);
    }
    if (message.id !== undefined) return this.#onClientResponse(message);
    if (typeof message.method === "string") {
      return this.#backend.notify(message.method, message.params);
    }
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  #onBackendMessage(message) {
    if (message.id !== undefined && typeof message.method === "string") {
      return this.#onBackendRequest(message);
    }
    if (message.id !== undefined) return this.#onBackendResponse(message);
    if (typeof message.method === "string") return this.#onBackendNotification(message);
  }

  #onBackendNotification(message) {
    this.#client.notify(message.method, message.params);
  }

  #onBackendRequest(message) {
    const reverseId = this.#nextReverseId++;
    this.#reversePending.set(reverseId, message.id);
    this.#client.request(reverseId, message.method, message.params);
  }

  #onBackendResponse(message) {
    const internal = this.#backendPending.get(message.id);
    if (internal) {
      this.#backendPending.delete(message.id);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        // Keep the JSON-RPC code: callers distinguish "this backend cannot do
        // it" from "it can, just not now", and the message text is not a
        // contract.
        internal.reject(
          Object.assign(new Error(message.error?.message ?? "backend rejected the request"), {
            code: message.error?.code,
          }),
        );
      } else {
        internal.resolve(message.result);
      }
      return;
    }
    const entry = this.#forwarded.get(message.id);
    if (!entry) {
      this.#log(`backend: response for unknown id ${String(message.id)}`);
      return;
    }
    this.#forwarded.delete(message.id);

    switch (entry.tag) {
      case "initialize":
        return this.#finishInitialize(entry, message);
      case "authenticate":
        return this.#finishAuthenticate(entry, message);
      case SESSION_NEW:
      case SESSION_LOAD:
        return this.#finishSession(entry, message);
      case PROMPT_METHOD:
        return this.#finishPrompt(entry, message);
      case SET_MODEL_METHOD:
        this.#lifecycle.afterModelChange?.({ sessionId: entry.sessionId, error: hasError(message) });
        this.#relayResponse(entry, message);
        return;
      default:
        return this.#relayResponse(entry, message);
    }
  }

  #relayResponse(entry, message) {
    if (entry.clientId === null) return;
    if (hasError(message)) {
      this.#client.fail(
        entry.clientId,
        message.error?.code ?? -32603,
        message.error?.message ?? "backend error",
        message.error?.data,
      );
      return;
    }
    this.#client.respond(entry.clientId, message.result);
  }

  #finishInitialize(entry, message) {
    if (hasError(message)) {
      this.#client.fail(
        entry.clientId,
        message.error?.code ?? -32603,
        message.error?.message ?? "backend initialize failed",
        message.error?.data,
      );
      return;
    }

    const result = recordValue(message.result) ?? {};
    const capabilities = recordValue(result.agentCapabilities) ?? {};
    this.#initializeResult = {
      ...result,
      protocolVersion: 1,
      agentCapabilities: { ...capabilities, loadSession: true },
      _meta: {
        ...(recordValue(result._meta) ?? {}),
        modelState: {
          availableModels: this.#models,
          // Agy's default, not "whatever sorts first" — the list is
          // low/medium/high and the session actually starts on medium.
          currentModelId:
            this.#currentModelId ??
            (this.#models.some((model) => model.modelId === DEFAULT_MODEL_ID)
              ? DEFAULT_MODEL_ID
              : this.#models[0]?.modelId),
        },
      },
    };

    const methods = arrayValue(result.authMethods) ?? [];
    if (this.#authMethod && !methods.some((method) => method.id === this.#authMethod)) {
      this.#client.fail(entry.clientId, -32602, "configured authentication method is not advertised by this backend");
      return;
    }
    const methodId = this.#authMethod ?? pickAuthMethod(methods);
    if (methodId && !this.#authSent) {
      // `session/new` arrives from Raft the moment initialize is answered, so
      // authentication has to finish first or the backend rejects the session.
      this.#authSent = true;
      this.#sendToBackend("authenticate", { methodId }, {
        clientId: entry.clientId,
        tag: "authenticate",
      });
      return;
    }
    this.#client.respond(entry.clientId, this.#initializeResult);
  }

  #finishAuthenticate(entry, message) {
    // Interactive authentication is owned by the backend. Session creation
    // reports a missing setup, so this preliminary reply remains advisory.
    if (hasError(message)) {
      this.#log(`backend: authenticate failed: ${message.error?.message ?? "unknown"}`);
    }
    this.#client.respond(entry.clientId, this.#initializeResult);
  }

  #finishSession(entry, message) {
    if (hasError(message)) {
      this.#pendingSessionInit = null;
      if (entry.tag === SESSION_LOAD && isUnsupportedMethod(message.error)) {
        this.#client.fail(entry.clientId, MISSING_SESSION.code, MISSING_SESSION.message);
        return;
      }
      this.#relayResponse(entry, message);
      return;
    }

    const result = recordValue(message.result) ?? {};
    // Agy answers a live `session/load` with modes/configOptions and NO
    // sessionId, because the id never changed. Requiring one here turned a
    // successful resume into "backend returned a session without a sessionId",
    // which Raft cannot recover from.
    const sessionId =
      nonEmptyString(result.sessionId) ??
      nonEmptyString(recordValue(result._meta)?.sessionId) ??
      nonEmptyString(entry.requestedSessionId);
    if (!sessionId) {
      this.#pendingSessionInit = null;
      this.#client.fail(entry.clientId, -32603, "backend returned a session without a sessionId");
      return;
    }

    const pending = this.#pendingSessionInit;
    this.#pendingSessionInit = null;
    // Backends that expose the model as a config option report the session's
    // current model here; it is the baseline for "did the selection change?".
    const configOptions = recordValue(message.result)?.configOptions;
    const modelOption = Array.isArray(configOptions)
      ? configOptions.map(recordValue).find((option) => option?.id === "model")
      : null;
    this.#sessions.set(sessionId, {
      id: sessionId,
      model: nonEmptyString(modelOption?.currentValue),
      systemPromptOverride: pending?.systemPromptOverride ?? null,
      cwd: pending?.cwd ?? null,
      systemPromptSent: false,
      queue: [],
      inFlight: false,
      heldResponse: null,
    });
    this.#client.respond(entry.clientId, { ...result, sessionId });
    this.#lifecycle.sessionReady?.({ sessionId, method: entry.tag });
  }

  /**
   * A prompt finished on the backend. If Raft queued anything while it ran, the
   * response is held back and the queued text goes out first, so the whole
   * exchange lands inside the one turn Raft still has open.
   */
  #finishPrompt(entry, message) {
    const session = entry.sessionId ? this.#sessions.get(entry.sessionId) : null;
    if (!session) return this.#relayResponse(entry, message);

    const lastStop = hasError(message)
      ? "error"
      : nonEmptyString(recordValue(message.result)?.stopReason);

    if (session.queue.length > 0) {
      if (!entry.autonomous) session.heldResponse = { clientId: entry.clientId, message };
      this.#log(`session ${session.id}: holding the turn open for ${session.queue.length} queued message(s)`);
      return this.#drain(session);
    }

    if (entry.autonomous) {
      const held = session.heldResponse;
      session.heldResponse = null;
      session.inFlight = false;
      if (hasError(message)) this.#surfaceBackendError(session, message.error);
      if (!held) return;
      if (hasError(held.message)) return this.#relayResponse({ clientId: held.clientId }, held.message);
      const result = recordValue(held.message.result) ?? {};
      return this.#relayResponse(
        { clientId: held.clientId },
        { result: { ...result, ...(lastStop ? { stopReason: lastStop } : {}) } },
      );
    }

    session.inFlight = false;
    return this.#relayResponse(entry, message);
  }

  /** Sends the next queued message as a fresh prompt, without a Raft-side id. */
  #drain(session) {
    const next = session.queue.shift();
    if (!next) return;
    session.inFlight = true;
    this.#lifecycle.beforePrompt?.({ sessionId: session.id, queued: true });
    this.#sendToBackend(PROMPT_METHOD, {
      sessionId: session.id,
      prompt: [{ type: "text", text: next.text }],
    }, { clientId: null, tag: PROMPT_METHOD, sessionId: session.id, autonomous: true });
  }

  #surfaceBackendError(session, error) {
    const text = `\n[raft-acp-bridge] queued message failed: ${error?.message ?? "backend error"}\n`;
    this.#client.notify("session/update", {
      sessionId: session.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  }

  #onClientResponse(message) {
    const backendId = this.#reversePending.get(message.id);
    if (backendId === undefined) {
      this.#log(`client: response for unknown reverse id ${String(message.id)}`);
      return;
    }
    this.#reversePending.delete(message.id);
    if (hasError(message)) {
      this.#backend.fail(
        backendId,
        message.error?.code ?? -32603,
        message.error?.message ?? "client error",
        message.error?.data,
      );
      return;
    }
    this.#backend.respond(backendId, message.result);
  }

  #onClientRequest(message) {
    const method = message.method;

    if (method === SET_MODEL_METHOD) {
      const params = { ...(message.params ?? {}) };
      const sessionId = nonEmptyString(params.sessionId);
      const requestedModelId = nonEmptyString(params.modelId);
      if (!sessionId || !requestedModelId) {
        this.#client.fail(message.id, -32602, "session/set_model needs a sessionId and a modelId");
        return;
      }
      // The catalogue is machine-wide, so the id names its backend. A prefix
      // that disagrees with this agent's profile is a configuration mistake
      // worth failing loudly over — running the other backend would silently
      // contradict what the operator picked.
      const routed = splitModelPrefix(requestedModelId);
      if (routed.kind && this.#prefixKind && routed.kind !== this.#prefixKind) {
        this.#client.fail(
          message.id,
          -32602,
          `model "${requestedModelId}" belongs to the ${routed.kind} backend; set GROK_SHIM_PROFILE=${routed.kind}`,
        );
        return;
      }
      const modelId = routed.bare;
      if (this.#modelSelection === "config-option") {
        this.#selectModelViaConfig(message, { sessionId, modelId, params });
        return;
      }
      // Agy implements `session/set_model` for real: it accepts its own
      // `gemini-4-argon-<effort>` ids and the next backend request uses the
      // chosen one. So this is forwarded, not faked — and a rejection reaches
      // the caller instead of being swallowed.
      // The effort lives in the model id; `_meta.reasoningEffort` means nothing.
      delete params._meta;
      // Agents created before the real ids existed still carry the shim's old
      // invented one; agy would reject it, so route it to its own default.
      const effectiveModelId = modelId === LEGACY_MODEL_ID ? DEFAULT_MODEL_ID : modelId;
      this.#log(`session ${sessionId}: selecting ${effectiveModelId}`);
      this.#lifecycle.beforeModelChange?.({ sessionId });
      this.#sendToBackend(SET_MODEL_METHOD, { sessionId, modelId: effectiveModelId }, {
        clientId: message.id,
        tag: SET_MODEL_METHOD,
        sessionId,
      });
      return;
    }

    if (method === INTERJECT_METHOD) {
      this.#onInterject(message);
      return;
    }

    if (method === "initialize") {
      this.#sendToBackend("initialize", message.params ?? {}, { clientId: message.id, tag: "initialize" });
      return;
    }

    if (method === SESSION_NEW || method === SESSION_LOAD) {
      if (!this.#explicitProfile) {
        // Model detection only needs `initialize`, so this refusal costs the
        // machine-wide catalogue nothing while removing the guess: a real agent
        // must say which backend it runs.
        this.#client.fail(
          message.id,
          -32602,
          "no backend declared: set GROK_SHIM_PROFILE=agy or GROK_SHIM_PROFILE=maka on this agent",
        );
        return;
      }
      const params = { ...(message.params ?? {}) };
      const meta = recordValue(params._meta) ?? {};
      delete params._meta;
      this.#pendingSessionInit = {
        systemPromptOverride: nonEmptyString(meta.systemPromptOverride),
        cwd: nonEmptyString(params.cwd),
      };
      this.#sendToBackend(method, params, {
        clientId: message.id,
        tag: method,
        requestedSessionId: method === SESSION_LOAD ? nonEmptyString(params.sessionId) : null,
      });
      return;
    }

    if (method === PROMPT_METHOD) {
      const params = { ...(message.params ?? {}) };
      // `prompt` is the content channel; `_meta` carries Raft's hints
      // (reasoningEffort and friends). Keep the original so a turn whose text
      // only arrived in `_meta` is not mistaken for an empty one.
      const promptMeta = recordValue(message.params?._meta);
      delete params._meta;
      const sessionId = nonEmptyString(params.sessionId);
      const session = sessionId ? this.#sessions.get(sessionId) : null;

      // Order matters. Recover anything that arrived in `_meta` first, then
      // decide whether the turn has content at all, and only then spend the
      // standing prompt on it. Prepending the preamble before this check made a
      // wake turn look non-empty: the preamble was sent on its own, the flag
      // flipped, and the first real message never carried the standing prompt.
      params.prompt = promoteMetaText(params.prompt, promptMeta);
      // A turn with nothing in it is not an error: Raft sends empty prompts as
      // wake/notice turns, and a stricter backend rejects them outright (Maka
      // answers `runtime_host_admission_rejected` for empty content). Answering
      // `end_turn` here is honest — there was nothing to do — and leaves the
      // preamble for the first turn that actually says something.
      if (!hasPromptContent(params.prompt)) {
        this.#log(`session ${sessionId ?? "(none)"}: settled an empty prompt`);
        this.#client.respond(message.id, { stopReason: "end_turn" });
        return;
      }
      if (session && !session.systemPromptSent) {
        // One preamble, first real turn: Raft's standing prompt plus the
        // environment block Maka's Runtime Host would have supplied itself.
        const preamble = [
          session.systemPromptOverride,
          this.#environment ? runtimeEnvironmentText({ cwd: session.cwd ?? undefined }) : null,
        ].filter(Boolean).join("\n\n");
        if (preamble) params.prompt = prependText(params.prompt, preamble);
        session.systemPromptSent = true;
      }
      if (session) session.inFlight = true;
      this.#lifecycle.beforePrompt?.({ sessionId, queued: false });
      this.#sendToBackend(PROMPT_METHOD, params, {
        clientId: message.id,
        tag: PROMPT_METHOD,
        sessionId,
      });
      return;
    }

    this.#sendToBackend(method, message.params ?? {}, { clientId: message.id, tag: method });
  }

  /**
   * Raft's busy delivery. Queuing is the only honest option Agy offers: it
   * answers `_x.ai/interject` with `null` while doing nothing, so acking and
   * forwarding the text to a backend that ignores it would be silent loss.
   */
  #onInterject(message) {
    if (this.#interjectMode === "reject") {
      this.#client.fail(
        message.id,
        -32601,
        "raft-acp-bridge does not implement steering: this message was not delivered to the agent",
      );
      return;
    }

    const params = recordValue(message.params) ?? {};
    const sessionId = nonEmptyString(params.sessionId);
    const text = nonEmptyString(params.text);
    const session = sessionId ? this.#sessions.get(sessionId) : null;
    if (!session || !text) {
      this.#client.fail(message.id, -32602, "interject needs a live session id and non-empty text");
      return;
    }

    if (this.#steerVia === "inject") {
      this.#steerViaInject(message, session, text);
      return;
    }

    session.queue.push({ text });
    this.#emitQueueNotice(session);
    this.#client.respond(message.id, {});
    this.#log(`session ${session.id}: queued a mid-turn message (${text.length} chars)`);

    // Racing past the end of a turn is possible; deliver anyway rather than
    // drop it, even though Raft has already closed its turn by then.
    if (!session.inFlight && !session.heldResponse) this.#drain(session);
  }

  /**
   * A backend that implements `session/inject` absorbs the message into the
   * running turn instead of queueing it behind one. The request answers as soon
   * as the backend admits it; delivery happens at its next break point.
   */
  #steerViaInject(message, session, text) {
    void (async () => {
      try {
        await this.#requestBackend("session/inject", {
          sessionId: session.id,
          mode: "steer",
          content: [{ type: "text", text }],
        });
        this.#client.respond(message.id, {});
        this.#log(`session ${session.id}: steered a mid-turn message (${text.length} chars)`);
      } catch (error) {
        const why = error?.message ?? "backend error";
        if (isNoRunningTurn(error)) {
          // The turn ended between Raft deciding to steer and the backend being
          // asked. The message is still the user's next message, not a failed
          // steer: deliver it instead of handing Raft an error it cannot retry.
          this.#log(
            `session ${session.id}: backend has no running turn (${why}); delivering as the next message`,
          );
          session.queue.push({ text });
          this.#emitQueueNotice(session);
          this.#client.respond(message.id, {});
          if (!session.inFlight && !session.heldResponse) this.#drain(session);
          return;
        }
        if (!isUnsupportedMethod(error)) {
          // A real rejection is not an admission; say so instead of swallowing.
          this.#client.fail(message.id, -32602, why);
          return;
        }
        this.#log(`session ${session.id}: backend cannot inject (${why}); queueing instead`);
        session.queue.push({ text });
        this.#emitQueueNotice(session);
        this.#client.respond(message.id, {});
        if (!session.inFlight && !session.heldResponse) this.#drain(session);
      }
    })();
  }

  /** Tells Raft, in the open turn, that the message is waiting rather than lost. */
  #emitQueueNotice(session) {
    if (this.#queueNotice === null) return;
    const pending = session.queue.length;
    const text = pending > 1 ? `${this.#queueNotice} (${pending} messages queued)` : this.#queueNotice;
    this.#client.notify("session/update", {
      sessionId: session.id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\n" + text + "\n\n" },
      },
    });
  }

  /** A shim-initiated backend call, outside Raft's id space. */
  #requestBackend(method, params) {
    const id = this.#nextInternalRequestId++;
    return new Promise((resolve, reject) => {
      this.#backendPending.set(id, { resolve, reject });
      this.#backend.request(id, method, params);
    });
  }

  /**
   * Backends that expose the model as an ACP config option (Maka) have no
   * `session/set_model`. Raft's vendor call is translated into the standard
   * ones, and the whole exchange answers once: Raft waits for it before the
   * first prompt.
   */
  #selectModelViaConfig(message, { sessionId, modelId, params }) {
    const effort = nonEmptyString(recordValue(params._meta)?.reasoningEffort);
    const session = this.#sessions.get(sessionId) ?? null;

    const level = effort === null ? null : thinkingLevelFor(effort);
    if (effort !== null && level === null) {
      // No silent downgrade: an effort Maka cannot express is a failed request.
      this.#client.fail(message.id, -32602, `reasoning effort "${effort}" has no Maka equivalent`);
      return;
    }
    const changed = modelId !== MAKA_SENTINEL_MODEL && modelId !== session?.model;

    void (async () => {
      try {
        if (changed) {
          await this.#requestBackend("session/set_config_option", {
            sessionId,
            configId: "model",
            value: modelId,
          });
          if (session) session.model = modelId;
        }
        if (level) {
          await this.#requestBackend("session/set_config_option", {
            sessionId,
            configId: "thinking_level",
            value: level,
          });
        }
        this.#client.respond(message.id, {});
      } catch (error) {
        this.#client.fail(message.id, -32602, error?.message ?? "model selection failed");
      }
    })();
  }

  #sendToBackend(method, params, { clientId, tag, sessionId = null, autonomous = false, requestedSessionId = null }) {
    const id = this.#nextBackendId++;
    this.#forwarded.set(id, { clientId, tag, sessionId, autonomous, requestedSessionId });
    this.#backend.request(id, method, params);
    return id;
  }

  #failEverything(message) {
    for (const entry of this.#forwarded.values()) {
      if (entry.clientId !== null) this.#client.fail(entry.clientId, -32603, message);
    }
    this.#forwarded.clear();
    this.#exiting = true;
  }
}

function hasError(message) {
  return Object.prototype.hasOwnProperty.call(message, "error");
}

function pickAuthMethod(authMethods) {
  const ids = authMethods
    .map((entry) => nonEmptyString(recordValue(entry)?.id))
    .filter(Boolean);
  if (ids.length === 0) return null;
  return ids.includes("oauth-personal") ? "oauth-personal" : ids[0];
}

function isUnsupportedMethod(error) {
  if (!error) return false;
  return (
    error.code === -32601 ||
    /method not found|not implemented|unsupported/i.test(error.message ?? "")
  );
}

/**
 * Maka answers `-32010 no_running_turn` when a steer arrives after its turn
 * already ended. The client decided to steer while the turn was still busy, so
 * the message stays valid — it simply belongs to the next turn.
 */
function isNoRunningTurn(error) {
  if (!error) return false;
  return error.code === -32010 || /no running turn/i.test(error.message ?? "");
}

function prependText(prompt, text) {
  const blocks = Array.isArray(prompt) ? prompt : [];
  return [{ type: "text", text }, ...blocks];
}

/**
 * True when a prompt carries something a backend can act on. Raft sends empty
 * prompts as wake/notice turns; forwarding those is what a stricter backend
 * rejects (Maka answers `runtime_host_admission_rejected` when the content is
 * empty, and a whitespace-only text is fine), so the shim settles them itself.
 */
function hasPromptContent(prompt) {
  if (!Array.isArray(prompt)) return false;
  return prompt.some((part) => {
    const block = recordValue(part);
    if (!block) return false;
    if (block.type === "text") return nonEmptyString(block.text) !== null;
    // Images, resources, terminal output — anything that is not a text part.
    return true;
  });
}

/**
 * Content-looking keys Raft has been seen putting in `_meta`. `reasoningEffort`
 * and similar hints are deliberately absent: they are settings, not content.
 */
const META_TEXT_KEYS = ["text", "message", "content", "prompt", "notice", "instructions", "systemPrompt", "systemPromptOverride"];

/**
 * Moves text that arrived in `_meta` into the prompt. The shim drops `_meta`
 * before forwarding (its effort hints mean nothing to these backends), so
 * without this a turn carrying its text only in `_meta` would look empty and be
 * settled as a no-op — silently losing what Raft said.
 */
function promoteMetaText(prompt, meta) {
  if (hasPromptContent(prompt)) return prompt;
  const block = recordValue(meta);
  if (!block) return prompt;
  const texts = [];
  for (const key of META_TEXT_KEYS) {
    const value = nonEmptyString(block[key]);
    if (value) texts.push(value);
  }
  if (texts.length === 0) return prompt;
  return prependText(prompt, texts.join("\n\n"));
}
