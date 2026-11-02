// What Raft's Grok Build driver requires from the shim, checked end to end.
// The acceptance rules are reimplemented from the shipped driver rather than
// imported, so this test also documents them.
import assert from "node:assert/strict";
import test from "node:test";

import { echoedText, startShim } from "./harness.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("initialize satisfies the driver's compatibility gate", async () => {
  const shim = await startShim();
  try {
    const { result } = await shim.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentCapabilities.loadSession, true);

    const modelState = result._meta?.modelState;
    assert.ok(Array.isArray(modelState.availableModels) && modelState.availableModels.length > 0);
    // Agy's own ids, effort included: its proxy asks for gemini-4-argon-medium
    // by default and accepts the -low/-high variants through session/set_model.
    assert.deepEqual(
      modelState.availableModels.map((model) => model.modelId),
      ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"],
    );
    assert.equal(modelState.currentModelId, "gemini-4-argon-medium");
    // Each entry declares exactly the effort its suffix stands for; a model
    // that declares nothing makes Raft offer low/medium/high/extra high.
    assert.deepEqual(
      modelState.availableModels.map((model) => model._meta?.reasoningEfforts),
      [["low"], ["medium"], ["high"]],
    );
  } finally {
    shim.close();
  }
});

test("authenticates before the session is created", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const methods = shim
      .logs()
      .filter((entry) => entry.event === "request")
      .map((entry) => entry.method);
    assert.deepEqual(methods, ["initialize", "authenticate", "session/new"]);
  } finally {
    shim.close();
  }
});

test("session/new hands back the backend session id", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT", yoloMode: true },
    });
    assert.equal(result.sessionId, "fake-session-1");
  } finally {
    shim.close();
  }
});

test("the standing prompt is prepended once, to the first turn only", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT" },
    });
    const sessionId = result.sessionId;

    const first = await shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "first question" }],
    });
    assert.equal(first.result.stopReason, "end_turn");
    await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        (message.params?.update?.content?.text ?? "").includes("first question"),
    );

    await shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "second question" }],
    });

    const text = echoedText(shim.messages);
    const firstTurn = text.find((entry) => entry.includes("first question")) ?? "";
    const secondTurn = text.find((entry) => entry.includes("second question")) ?? "";
    assert.match(firstTurn, /STANDING PROMPT/);
    assert.match(firstTurn, /Runtime Host environment for this turn:/);
    assert.match(firstTurn, /"cwd":"\/tmp"/);
    assert.doesNotMatch(secondTurn, /STANDING PROMPT/);
    assert.doesNotMatch(secondTurn, /Runtime Host environment for this turn:/);
  } finally {
    shim.close();
  }
});

test("GROK_SHIM_ENVIRONMENT=off keeps the preamble to the standing prompt", async () => {
  const shim = await startShim({ env: { GROK_SHIM_ENVIRONMENT: "off" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT" },
    });
    await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    const first = shim.logs().find((entry) => entry.method === "session/prompt");
    assert.match(first.text, /STANDING PROMPT/);
    assert.doesNotMatch(first.text, /Runtime Host environment/);
  } finally {
    shim.close();
  }
});

test("set_model is forwarded so the backend really switches", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { result, error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "gemini-4-argon-high",
      _meta: { reasoningEffort: "high" },
    });
    assert.equal(error, undefined);
    assert.deepEqual(result, {});
    const forwarded = shim.logs().find((entry) => entry.method === "session/set_model");
    assert.ok(forwarded, "set_model must reach the backend");
    assert.equal(forwarded.modelId, "gemini-4-argon-high");
  } finally {
    shim.close();
  }
});

test("the shim's old invented model id migrates to agy's default", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "antigravity-auto",
    });
    assert.equal(error, undefined);
    const forwarded = shim.logs().find((entry) => entry.method === "session/set_model");
    assert.equal(forwarded.modelId, "gemini-4-argon-medium");
  } finally {
    shim.close();
  }
});

test("a rejected model reaches the caller instead of being swallowed", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "bad-model",
    });
    assert.equal(error.code, -32602);
    assert.match(error.message, /not available/);
  } finally {
    shim.close();
  }
});

test("a message sent to a busy agent is delivered before the turn closes", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT" },
    });
    const sessionId = result.sessionId;

    // "SLOW" keeps the fixture's turn open for 400ms.
    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await sleep(100);

    const ack = await shim.request("_x.ai/interject", {
      sessionId,
      text: "injected while busy",
      interjectionId: "raft-9",
    });
    assert.equal(ack.error, undefined, "busy delivery must be acked, not failed");

    const done = await turn;
    assert.equal(done.result.stopReason, "end_turn");

    const prompts = shim.logs().filter((entry) => entry.method === "session/prompt");
    assert.equal(prompts.length, 2, "the queued text must reach the backend as its own prompt");
    assert.match(prompts[1].text, /injected while busy/);
    assert.doesNotMatch(prompts[1].text, /STANDING PROMPT/, "the standing prompt goes out once");

    assert.match(echoedText(shim.messages).join("\n"), /injected while busy/);
  } finally {
    shim.close();
  }
});

test("queued messages are delivered in arrival order", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = result.sessionId;

    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await sleep(80);
    await shim.request("_x.ai/interject", { sessionId, text: "second point", interjectionId: "a" });
    await sleep(80);
    await shim.request("_x.ai/interject", { sessionId, text: "third point", interjectionId: "b" });

    const done = await turn;
    assert.equal(done.result.stopReason, "end_turn");

    const delivered = shim
      .logs()
      .filter((entry) => entry.method === "session/prompt")
      .map((entry) => entry.text);
    assert.equal(delivered.length, 3);
    assert.match(delivered[1], /second point/);
    assert.match(delivered[2], /third point/);
  } finally {
    shim.close();
  }
});

test("GROK_SHIM_INTERJECT=reject keeps the loud failure", async () => {
  const shim = await startShim({ env: { GROK_SHIM_INTERJECT: "reject" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("_x.ai/interject", {
      sessionId: result.sessionId,
      text: "interrupt",
      interjectionId: "raft-1",
    });
    assert.equal(error.code, -32601);
    assert.match(error.message, /steering/);
  } finally {
    shim.close();
  }
});

test("a successful resume keeps the requested session id even when agy omits it", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result, error } = await shim.request("session/load", {
      sessionId: "live-1",
      cwd: "/tmp",
      mcpServers: [],
    });
    assert.equal(error, undefined);
    assert.equal(result.sessionId, "live-1");
    shim.close();
  } finally {
    shim.close();
  }
});

test("an unsupported session/load becomes a missing session, so Raft starts a fresh one", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { error } = await shim.request("session/load", {
      sessionId: "gone",
      cwd: "/tmp",
      mcpServers: [],
    });
    // The driver's fallback test: /\b(path|session)\b.*\b(not found|missing)\b/i
    assert.match(error.message, /\bsession\b.*\bnot found\b/i);
  } finally {
    shim.close();
  }
});

test("a queued message gets a visible note inside the open turn", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = result.sessionId;

    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await sleep(100);
    await shim.request("_x.ai/interject", {
      sessionId,
      text: "queued thing",
      interjectionId: "raft-8",
    });

    const notice = await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        /cannot be steered mid-turn/.test(message.params?.update?.content?.text ?? ""),
    );
    assert.equal(notice.params.sessionId, sessionId);
    assert.match(notice.params.update.content.text, /queued/);
    assert.match(notice.params.update.content.text, /cancel my task/);
    assert.match(notice.params.update.content.text, /reassign it to another agent/);

    const done = await turn;
    assert.equal(done.result.stopReason, "end_turn");
    assert.equal(
      shim.logs().some((entry) => /cannot be steered/.test(entry.text ?? "")),
      false,
      "the notice is client-facing only and must never reach the backend prompt",
    );
  } finally {
    shim.close();
  }
});

test("GROK_SHIM_QUEUE_NOTICE=off keeps the queue silent", async () => {
  const shim = await startShim({ env: { GROK_SHIM_QUEUE_NOTICE: "off" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = result.sessionId;

    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await sleep(100);
    await shim.request("_x.ai/interject", { sessionId, text: "queued thing", interjectionId: "raft-8" });
    const done = await turn;

    assert.equal(done.result.stopReason, "end_turn");
    assert.equal(
      shim.messages.some(
        (message) =>
          message.method === "session/update" &&
          /cannot be steered mid-turn/.test(message.params?.update?.content?.text ?? ""),
      ),
      false,
    );
  } finally {
    shim.close();
  }
});

// --- backends that expose the model as an ACP config option (Maka) ---------

const CONFIG_OPTION_ENV = {
  GROK_SHIM_MODEL_SELECTION: "config-option",
  GROK_SHIM_MODELS: "maka-one:Maka One,maka-two:Maka Two",
};

test("a config-option backend receives a model change as set_config_option", async () => {
  const shim = await startShim({ env: CONFIG_OPTION_ENV });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "maka-two",
    });
    assert.equal(error, undefined);

    const patch = shim
      .logs()
      .find((entry) => entry.method === "session/set_config_option" && entry.configId === "model");
    assert.ok(patch, "the model change must reach the backend as a config option");
    assert.equal(patch.value, "maka-two");

    assert.equal(
      shim.logs().some((entry) => entry.method === "session/set_model"),
      false,
      "the vendor method must not be forwarded to this backend",
    );
  } finally {
    shim.close();
  }
});

test("selecting the model the session already has sends no model patch", async () => {
  const shim = await startShim({ env: CONFIG_OPTION_ENV });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "maka-one",
    });
    assert.equal(error, undefined);
    assert.equal(
      shim.logs().some((entry) => entry.method === "session/set_config_option" && entry.configId === "model"),
      false,
    );
  } finally {
    shim.close();
  }
});

test("the sentinel skips the model patch but still applies the effort", async () => {
  const shim = await startShim({ env: CONFIG_OPTION_ENV });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "maka-default",
      _meta: { reasoningEffort: "high" },
    });
    assert.equal(error, undefined);

    const configs = shim.logs().filter((entry) => entry.method === "session/set_config_option");
    assert.equal(
      configs.some((entry) => entry.configId === "model"),
      false,
      "the sentinel must not be sent as a model value",
    );
    assert.equal(configs.find((entry) => entry.configId === "thinking_level")?.value, "high");
  } finally {
    shim.close();
  }
});

test("an effort the backend cannot express is refused, not dropped", async () => {
  const shim = await startShim({ env: CONFIG_OPTION_ENV });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "maka-two",
      _meta: { reasoningEffort: "ultra" },
    });
    assert.equal(error.code, -32602);
    assert.match(error.message, /ultra/);
    assert.equal(
      shim.logs().some((entry) => entry.method === "session/set_config_option"),
      false,
      "a refused request must not half-apply",
    );
  } finally {
    shim.close();
  }
});

// --- model-id prefixes route the machine-wide catalogue --------------------

test("a prefixed model is stripped before it reaches the backend", async () => {
  const shim = await startShim({
    env: {
      GROK_SHIM_MODEL_SELECTION: "set-model",
      GROK_SHIM_MODELS: "agy_fake-one:Fake One",
    },
  });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "agy_fake-one",
    });
    assert.equal(error, undefined);
    const forwarded = shim.logs().find((entry) => entry.method === "session/set_model");
    assert.equal(forwarded.modelId, "fake-one");
  } finally {
    shim.close();
  }
});

test("a model belonging to another backend fails loudly", async () => {
  const shim = await startShim({
    env: {
      GROK_SHIM_PREFIX_KIND: "agy",
      GROK_SHIM_MODELS: "agy_fake-one:Fake One",
    },
  });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const { error } = await shim.request("session/set_model", {
      sessionId: session.result.sessionId,
      modelId: "maka_deepseek-flash",
    });
    assert.equal(error.code, -32602);
    assert.match(error.message, /GROK_SHIM_PROFILE=maka/);
    assert.equal(
      shim.logs().some((entry) => entry.method === "session/set_model"),
      false,
      "a cross-backend model must not be forwarded",
    );
  } finally {
    shim.close();
  }
});

// --- backends that can steer (session/inject) ------------------------------

test("a steer-capable backend receives the busy message as an injection", async () => {
  const shim = await startShim({ env: { GROK_SHIM_STEER: "inject" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = session.result.sessionId;
    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ack = await shim.request("_x.ai/interject", {
      sessionId,
      text: "steer this",
      interjectionId: "raft-3",
    });
    assert.equal(ack.error, undefined);

    const injected = shim.logs().find((entry) => entry.method === "session/inject");
    assert.ok(injected, "the message must reach the backend as an injection");
    assert.equal(injected.mode, "steer");
    assert.match(injected.text, /steer this/);

    // Steered, not queued: no queue notice and no follow-up turn.
    assert.equal(
      echoedText(shim.messages).some((text) => /cannot be steered/.test(text)),
      false,
    );
    await turn;
  } finally {
    shim.close();
  }
});

test("a backend without injection falls back to the queue instead of losing the text", async () => {
  const shim = await startShim({ env: { GROK_SHIM_STEER: "inject" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = session.result.sessionId;
    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ack = await shim.request("_x.ai/interject", {
      sessionId,
      text: "no-inject please queue me",
      interjectionId: "raft-4",
    });
    assert.equal(ack.error, undefined, "the fallback still acks: the text is not lost");

    const notice = await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        /cannot be steered/.test(message.params?.update?.content?.text ?? ""),
    );
    assert.ok(notice, "the caller is told it was queued");
    await turn;
  } finally {
    shim.close();
  }
});

test("a steer the backend calls idle is delivered as the next message, not as a failure", async () => {
  const shim = await startShim({ env: { GROK_SHIM_STEER: "inject" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const session = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });
    const sessionId = session.result.sessionId;
    const turn = shim.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "SLOW first" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ack = await shim.request("_x.ai/interject", {
      sessionId,
      text: "no-turn note",
      interjectionId: "raft-5",
    });
    // Maka answers -32010 when the turn it was asked to steer already ended.
    // The user sent the message while the turn was still busy, so it must not
    // come back as a delivery failure they have to retry.
    assert.equal(ack.error, undefined, "an ended turn must not fail a message already sent");
    assert.ok(
      shim.logs().some((entry) => entry.method === "session/inject"),
      "the shim tried the injection before falling back",
    );
    await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        /cannot be steered/.test(message.params?.update?.content?.text ?? ""),
    );

    await turn;
    // Delivered as its own prompt once the slowed turn finished.
    await shim.waitFor(
      (message) =>
        message.method === "shim/test/log" &&
        message.params?.event === "request" &&
        message.params?.method === "session/prompt" &&
        /no-turn note/.test(message.params?.text ?? ""),
    );
  } finally {
    shim.close();
  }
});

// Raft sends empty prompts as wake/notice turns, and a stricter backend rejects
// them (Maka answers `runtime_host_admission_rejected` for empty content). The
// shim settles them itself: `end_turn`, no backend call, session still usable.
test("an empty prompt is settled locally, not forwarded", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const empty = await shim.request("session/prompt", { sessionId: result.sessionId, prompt: [] });
    assert.equal(empty.result.stopReason, "end_turn");
    const blank = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "" }],
    });
    assert.equal(blank.result.stopReason, "end_turn");

    // The session still works afterwards: the empty turns must not wedge it.
    const real = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "after empty" }],
    });
    assert.equal(real.result.stopReason, "end_turn");
    await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        (message.params?.update?.content?.text ?? "").includes("after empty"),
    );
  } finally {
    shim.close();
  }
});

// `_meta` is where Raft puts its hints, and the shim drops it before forwarding.
// A wake turn whose text only arrived there must not be settled as empty — and a
// turn carrying nothing but settings must not be forwarded as if it had text.
test("text in _meta is promoted; settings alone stay a no-op", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });

    // Settings only: nothing to do, settled locally.
    const hintOnly = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [],
      _meta: { reasoningEffort: "high" },
    });
    assert.equal(hintOnly.result.stopReason, "end_turn");

    // Text hiding in _meta: forwarded, not swallowed.
    const carried = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [],
      _meta: { text: "carried instruction" },
    });
    assert.equal(carried.result.stopReason, "end_turn");
    await shim.waitFor(
      (message) =>
        message.method === "session/update" &&
        (message.params?.update?.content?.text ?? "").includes("carried instruction"),
    );
  } finally {
    shim.close();
  }
});

// The action order in the prompt path is part of the contract: recover `_meta`
// text, decide whether the turn says anything, and only then spend the standing
// prompt. Asserting what the backend received (and how often) is the only way to
// catch a regression here — the client cannot see the difference.
// Only prompt turns are interesting here: the fixture logs every backend request,
// including initialize and session/new.
const backendRequests = (shim) =>
  shim.messages.filter(
    (message) =>
      message.method === "shim/test/log" &&
      message.params?.event === "request" &&
      message.params?.method === "session/prompt",
  );

test("an empty first turn does not consume the standing prompt", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT" },
    });

    const empty = await shim.request("session/prompt", { sessionId: result.sessionId, prompt: [] });
    assert.equal(empty.result.stopReason, "end_turn");
    assert.equal(backendRequests(shim).length, 0, "an empty turn must not reach the backend");

    await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "first real message" }],
    });
    const requests = backendRequests(shim);
    assert.equal(requests.length, 1, "exactly one request should have been forwarded");
    const text = requests[0].params?.text ?? "";
    assert.match(text, /STANDING PROMPT/, "the first real turn carries the standing prompt");
    assert.match(text, /Runtime Host environment for this turn:/, "and the environment block");
    assert.match(text, /first real message/);
  } finally {
    shim.close();
  }
});

test("text that only arrives in _meta still gets the standing prompt", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", {
      cwd: "/tmp",
      mcpServers: [],
      _meta: { systemPromptOverride: "STANDING PROMPT" },
    });

    const carried = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [],
      _meta: { text: "carried instruction" },
    });
    assert.equal(carried.result.stopReason, "end_turn");

    const requests = backendRequests(shim);
    assert.equal(requests.length, 1);
    const text = requests[0].params?.text ?? "";
    assert.match(text, /STANDING PROMPT/);
    assert.match(text, /carried instruction/);
  } finally {
    shim.close();
  }
});

test("a turn carrying only settings never reaches the backend", async () => {
  const shim = await startShim();
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const { result } = await shim.request("session/new", { cwd: "/tmp", mcpServers: [] });

    const hintOnly = await shim.request("session/prompt", {
      sessionId: result.sessionId,
      prompt: [{ type: "text", text: "" }],
      _meta: { reasoningEffort: "high" },
    });
    assert.equal(hintOnly.result.stopReason, "end_turn");
    assert.equal(backendRequests(shim).length, 0);
  } finally {
    shim.close();
  }
});
