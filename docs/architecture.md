# Architecture

```text
Raft Computer worker
  -> grok agent --no-leader --always-approve stdio
     -> bin/grok -> src/cli.js
        -> real Grok CLI, or
        -> Shim -> backend ACP process
                    -> backend-owned model endpoint
```

Raft Computer supervises workers. This repository supplies one executable those
workers can spawn; the shim owns its backend process. Use
Raft's own lifecycle tooling for the Computer service.

## Source map

| Files | Responsibility |
| --- | --- |
| `bin/grok` | resolve the installed symlink and locate Node |
| `src/bootstrap.js`, `src/config.js` | load machine settings before other startup code; resolve paths and commands |
| `src/cli.js`, `src/realGrok.js` | command dispatch, real CLI delegation and process startup |
| `src/rpc.js` | line-delimited JSON-RPC on client and backend pipes |
| `src/shim.js` | session state, request forwarding, reverse requests, prompt preamble and busy delivery |
| `src/profiles.js`, `src/models.js` | backend selection, model discovery, prefixes and profile capabilities |
| `src/backends/` | executable resolution and backend model discovery |
| `src/environment.js` | task directory, platform and timezone context |
| `src/installation.js`, `src/doctor.js` | installation inspection, executable selection and LaunchAgent generation |
| `ops/` | diagnostics, optional stack management and backend maintenance commands |

## Protocol responsibilities

The shim returns ACP `protocolVersion: 1`, `agentCapabilities.loadSession: true`
and `_meta.modelState` in the shape Raft's Grok driver consumes. Authentication
is completed before forwarding session creation when the backend advertises an
authentication method.

The standing prompt arrives through `_meta.systemPromptOverride` on session
creation. It is stored until the first nonempty prompt. Settings-only prompts
settle without calling the backend. Recognized text fields in prompt
metadata are normalized into text blocks before the empty-prompt check.

Model prefixes distinguish backends in Raft's machine-wide catalogue. Prefixes
are checked against the agent profile and stripped before forwarding. Backend
model selection is either `set-model` or `config-option`; Maka effort mapping
rejects values it cannot express rather than silently dropping them.

Client and backend request IDs are tracked separately. Reverse requests such as
`session/request_permission` are forwarded with a separate ID range to avoid
colliding with Raft's requests.

Busy delivery is either a backend injection or a sequential queue. Queueing
holds the original prompt response until the queued prompts finish. A backend
that returns `no_running_turn` during an injection race also uses the queue.

## Backend boundaries

A profile supplies the backend command/environment, model catalogue, selection
strategy, prefix, environment-context setting and steering strategy. Backend-specific executable resolution, models, settings and installation checks
live under `src/backends/agy/` and `src/backends/maka/`.

Backend installation requirements and maintenance commands are in
[backends.md](backends.md); machine-specific paths are in
[mac-setup.md](mac-setup.md).

## Tests

ACP conformance tests inspect what the fixture backend receives, including the
standing prompt, empty turns, model selection, session loading and queued or
injected messages. Routing tests cover real CLI coexistence. Configuration and
installation tests use relocated checkouts, isolated state and synthetic files.
Lifecycle extension tests cover callback ordering, queued prompts and cleanup.

## Local lifecycle extensions

`SHIM_EXTENSION_MODULE` selects a trusted local JavaScript module, resolved from
the env file's directory. It must default-export an object. Loading a module
executes code with the CLI's permissions; use only modules you control.

- `configureEnvironment({env})` may return environment overrides before model discovery.
- `createLifecycle({profile, env, log})` may asynchronously prepare resources and
  return backend environment additions, lifecycle callbacks and a `dispose` function.
- `installationChecks({env, profile})` may return additional doctor records.

Lifecycle callbacks are synchronous: `sessionReady`, `beforePrompt` (including
queued delivery), `beforeModelChange` and `afterModelChange` (including errors).
Resource setup belongs in `createLifecycle`; `dispose` runs on CLI process exit.
The extension is loaded for ACP sessions and doctor checks, not version/help
probes or delegation to the real CLI. Resource creation belongs only in the
session factory, keeping installation checks read-only.
