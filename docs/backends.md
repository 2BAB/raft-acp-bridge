# Backends

## Maka

Install the CLI using the [upstream install guide](https://github.com/apache/maka/blob/main/packages/cli/README.md#install).
The package is `maka-agent@nightly`; the unrelated npm package `maka` is a different
project. Use a Node version supported by Maka (currently 22.19+ on the 22 line,
or 24+).

```sh
npm install --global maka-agent@nightly
maka
```

Complete Maka's first-run model connection setup, then install and check its
Runtime Host service:

```sh
maka runtime-host service install
maka runtime-host service status
```

Set `GROK_SHIM_PROFILE=maka` on the Raft agent. `MAKA_BIN` selects the executable;
otherwise both the runtime and installation checks search `PATH`, then
`~/.local/bin/maka`. The bridge starts it with `--acp`.

**Capability requirement:** model selection needs the session `model` config
option from [#6189](https://github.com/apache/maka/pull/6189). Mid-turn steering
needs `session/inject` from [#6192](https://github.com/apache/maka/pull/6192).
Both PRs are open as of 2026-11-11, so installing the published nightly alone
does not establish full bridge compatibility. Use a build containing those
changes for both features; without injection, busy messages use the queue.
After rebuilding a source installation, restart its Host so it uses the new code.

The shim opens and closes a throwaway session to discover models and effort
options. Failed discovery produces a `maka-default` sentinel: selecting it skips
the model change but can still apply the requested effort. A selected model
must belong to the real session's options. `ultra` has no mapping and is rejected.

`session/set_model` becomes `session/set_config_option` for `model` and, when
supplied, `thinking_level`. `_x.ai/interject` becomes `session/inject` with
`mode: steer`; unsupported injection and `no_running_turn` fall back to queueing.
Maka supplies its own environment context, so the shim does not duplicate it.

## Antigravity ACP

1. Install Antigravity CLI 1.5.1 or later and follow the
   [Antigravity ACP setup guide](https://antigravity.google/docs/cli/acp).
2. Confirm `agy acp --help` works, then set `GROK_SHIM_PROFILE=agy` on the Raft
   agent. The bridge searches `PATH`
   and `~/.local/bin/agy`. Set `AGY_CLI_BIN` if the CLI is installed elsewhere.
   Rescan runtimes to refresh the model picker.

Antigravity CLI manages authentication and credentials. `AGY_ACP_AUTH_METHOD`
can select a method advertised by the installed runtime. Use a method permitted
for your account under Google's third-party access rules.
[Antigravity terms](https://antigravity.google/terms) · [Antigravity FAQ](https://antigravity.google/docs/faq)

The model catalogue comes from the installed server. Explicit
`GROK_SHIM_MODELS` or `GROK_SHIM_MODEL_FAMILIES` settings filter that list. A
successful probe with no matching models reports an error. Discovery is cached
by executable and arguments. If the probe fails or is disabled, the bridge
uses the configured or default model list.

Antigravity CLI accepts a concurrent prompt to steer an active turn. The
bridge keeps Raft's turn open until the original and steering prompts settle.
It uses `session/resume` to reopen a saved session without replaying history.

### Standalone ACP installations

Existing standalone installations can set `AGY_ACP_BIN` to their
`agy_acp_server.par`, with its matching `localharness_external` beside it.
The bridge also tries the default standalone installation when it finds no
Antigravity CLI. The standalone server queues busy messages. Switching to
`agy acp` may require starting a new conversation.

### Model inspection

`node ops/agy-models.mjs` creates and closes a temporary ACP session to inspect
its catalogue. `--probe` also tests model selection. `--model <id> --prompt`
makes a real model call; run it only when authorized for that service.
