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
As of 2026-11-02 both PRs are open, so installing the published nightly alone
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

1. Read the [service terms](#compatibility-and-service-terms) for the intended
   account and authentication method.
2. Open the [ACP registry entry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
   Under `distribution.binary`, choose `darwin-aarch64` for Apple Silicon or
   `darwin-x86_64` for Intel. Download the Google-hosted archive and verify it
   against that entry's SHA-256 hash.
3. Extract the complete archive into
   `~/Library/Application Support/agy-acp/`, or set `AGY_ACP_BIN` in `.env` to
   the extracted `agy_acp_server.par`. Keep its matching `localharness_external`
   beside it and retain executable permissions.
4. Complete the backend's authentication flow on this Mac. Google's
   [authentication guide](https://antigravity.google/docs/install/) describes
   the supported flows; the bridge uses ACP authentication before opening a
   session. Set `GROK_SHIM_PROFILE=agy` on the Raft agent.

Credential storage follows the official runtime's default. Optional settings
such as `AGY_ACP_FORCE_FILE_STORAGE` are passed through when explicitly supplied.
`AGY_ACP_AUTH_METHOD` can select an advertised method; an unsupported method
is rejected. Authentication completion and service authorization are separate.

The model catalogue comes from the installed server, including new model IDs.
Known IDs receive friendly labels; other IDs use their own names. Explicit
`GROK_SHIM_MODELS` or `GROK_SHIM_MODEL_FAMILIES` settings filter that list. A
successful probe with no matching models reports an error. Discovery is cached
against the executable's size and modification time. If the probe fails or is
disabled, the declared catalogue is used as a fallback. Being listed does not
prove a live turn will succeed.

Busy messages use the shim's queue. The measured ACP server does not provide
usable mid-turn injection; accepting an extension request is not enough to prove
that it delivers text.

### Compatibility and service terms

The inspected ACP server 1.1.1 with personal authentication offered Gemini model
families. The adapter follows the installed server's catalogue; availability
also depends on authentication and service entitlements. That version
queues busy messages and has upstream session/checkpoint restoration limitations.
The registry can offer newer releases; those require separate live validation.
Successful connection or a single completed turn does not establish that every
history, model or authentication mode works.

As of 2026-11-02, Google's published terms and FAQ restrict third-party software
using Antigravity login. Forum replies about personal-subscription access through
the official ACP runtime are inconsistent. Permission to use a personal
subscription through this integration has not been established.

- [Antigravity terms](https://antigravity.google/terms)
- [Third-party access FAQ](https://antigravity.google/docs/faq)
- [Conflicting ACP guidance](https://discuss.ai.google.dev/t/conflicting-guidance-on-using-t3-code-with-personal-google-ai-subscriptions/197131)

The MIT license covers this project's code. The user-installed Google runtime
and its services retain their applicable terms. Check those terms and obtain
clarification for the intended account and authentication method before use.

### Model inspection

`node ops/agy-models.mjs` creates and closes a temporary ACP session to inspect
its catalogue. `--probe` also tests model selection. `--model <id> --prompt`
makes a real model call; run it only when authorized for that service.
