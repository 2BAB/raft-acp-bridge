# Backends

## Maka

Set `GROK_SHIM_PROFILE=maka` on the Raft agent. `MAKA_BIN` selects the executable;
otherwise the runtime uses `maka` on `PATH` with `--acp`.

The Runtime Host must be running:

```sh
maka runtime-host service install
maka runtime-host service status
```

Use a Maka build that exposes the session `model` config option for model
selection, and `session/inject` for steering. Related implementations are
[model config options #6189](https://github.com/apache/maka/pull/6189) and
[mid-turn injection #6192](https://github.com/apache/maka/pull/6192). Check the
installed build's capabilities rather than assuming a branch or release has them.
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

Set `GROK_SHIM_PROFILE=agy` on the Raft agent. Configure `AGY_ACP_BIN` or use the
default path in [.env.sample](../.env.sample). Keep the executable and matching
`localharness_external` from one release together and use the appropriate Mac
CPU build. Complete authentication through the backend's own flow on each Mac;
installation checks do not establish a working login.

Credential storage follows the official runtime's default. Optional settings
such as `AGY_ACP_FORCE_FILE_STORAGE` are passed through when explicitly supplied.
`AGY_ACP_AUTH_METHOD` can select an advertised method; an unsupported method
is rejected. Authentication completion and service authorization are separate.

The model catalogue is the intersection of models the installed server reports
and models the shim can describe. Discovery is cached against the executable's
size and modification time. Effort is encoded in agy's model IDs. If discovery
fails, the declared catalogue is used; being listed does not prove a live turn
will succeed.

Busy messages use the shim's queue. The measured ACP server does not provide
usable mid-turn injection; accepting an extension request is not enough to prove
that it delivers text.

### Compatibility and service terms

The inspected ACP server 1.1.1 with personal authentication offered Gemini model
families. The adapter follows the installed server's catalogue; availability
also depends on authentication and service entitlements. The inspected version
queues busy messages and has upstream session/checkpoint restoration limitations.
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
