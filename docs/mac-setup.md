# Using one checkout on multiple Macs

Each Mac gets the same Git revision and its own `.env`, installed executables,
sign-in and runtime state. Intel and Apple Silicon Macs need matching agent
downloads.

## Machine configuration

```sh
cp .env.sample .env
# Edit .env only where this Mac differs from the defaults.
```

All settings are optional. Without `.env`, the existing paths and routing remain
in effect. `.env` and `vendor/` are ignored by Git. Commit `.env.sample` when a
new setting needs documentation; keep machine-specific values in `.env`.
For the initial backend install and sign-in, follow [Backends](backends.md).

Every Node executable entry loads the root `.env` before reading configuration:
the `grok` CLI, `raft-stack`, `agy-models` and `doctor`. The loader does not change the task's
working directory or run shell commands from the file.

Precedence is **process environment > `.env` > defaults**. This includes an
explicitly empty process value, so a Raft agent can clear a setting from the
machine file. Most empty path settings select their normal default.

Path settings expand `~` and `~/`. Relative paths use the directory containing
the selected `.env`, even when Raft starts the agent inside another project.
Bare command names such as `maka` use `PATH`. Shell interpolation such
as `${HOME}`, `$HOME` or `$(command)` is not evaluated. Custom backend arguments accept a JSON string array, preserving spaces inside
each argument. Legacy whitespace-separated strings are also accepted. File
arguments are passed unchanged; use absolute paths when the backend needs them.

An alternate file can be selected with `SHIM_ENV_FILE` in the process environment.
A relative `SHIM_ENV_FILE` is resolved from the configuration root.
`SHIM_CONFIG_ROOT` can select that root from the process environment; it defaults
to this checkout. A local wrapper can use it while reusing this CLI. An explicitly
selected file must exist; the absent default root `.env` is optional.

| Setting | Default / purpose |
| --- | --- |
| `AGY_ACP_BIN` | `~/Library/Application Support/agy-acp/agy_acp_server.par`; its matching `localharness_external` must be beside it |
| `MAKA_BIN` | `maka` on `PATH`, then `~/.local/bin/maka` when unset (runtime and checks) |
| `MAKA_WORKSPACE` | `~/Library/Application Support/Maka/workspaces/default`; workspace inspected by ops |
| `MAKA_HOST_URL` | `ws://127.0.0.1:64150/runtime-host`; endpoint inspected by ops |
| `SHIM_BIN` | `~/.local/bin/grok`; symlink managed by `install:cli` or `raft-stack`, checked by `doctor` |
| `AGY_ACP_AUTH_METHOD` | optional method ID advertised by the backend |
| `RAFT_APP_PATH` | `/Applications/Raft Desktop.app` |
| `RAFT_HOME` | `~/.slock`; Raft Computer state inspected and passed to CLI launches |
| `RAFT_COMPUTER_BIN` | `~/.local/bin/raft-computer`; explicit configuration takes precedence over source mode |
| `RAFT_SOURCE` | Optional source checkout. Legacy source builds at `~/Desktop/code/active/raft-source` keep their launch command when present; otherwise ops use the installed Computer CLI |

`MAKA_WORKSPACE` and `MAKA_HOST_URL` configure this repository's ops checks. They
do not move Maka's data or reconfigure its Runtime Host. Configure Maka itself
to match. Likewise, `RAFT_HOME` does not move an existing Desktop installation's
state; it selects the state this tool reads and passes to Computer CLI commands.

## Check a new Mac

1. Install Node >=22. Put Node on the
   login shell's `PATH`; `bin/grok` also keeps its existing macOS installer fallbacks.
2. Install the backend for this Mac's CPU. Keep the agy server and helper from
   the same release together. Complete backend sign-in on this Mac. Install
   Raft Desktop and open it once to establish its Computer configuration.
3. Create `.env` if paths differ from the defaults. Leave the profile unset for
   mixed-backend installations and set `GROK_SHIM_PROFILE` on each Raft agent.
4. Install the bridge and check the backend you chose:

   ```sh
   npm run install:cli
   npm run doctor -- --profile maka  # or agy
   ```

   Put the install directory earlier on your login-shell `PATH`. Use
   `--profile all` only when both backends are installed.

`doctor` defaults to the configured `GROK_SHIM_PROFILE`, or `all` when unset.
Exit code 0 means no installation errors, 1 means an `ERROR` needs attention,
and 2 means invalid configuration or arguments. `WARN` lines describe optional
setup or checks that cannot prove readiness. `--json` produces a structured report.

The check reads paths, executable permissions, Mach-O CPU headers and the Maka
storage marker. It does not start
agents or services, build binaries, sign in, inspect credentials, call models,
repair markers or write installation files. It cannot prove that the server and
helper came from one release, that authentication works, or that a turn completes.
Check the backend's service status and a real turn separately when ready.

Restart Raft's Computer service after changing the installation or its login-shell
`PATH`. There is no need to install the optional `raft-stack` login item just to
use the shim with Raft's existing supervisor.

## Coexisting with the real Grok CLI

The bridge must be the first `grok` on Raft's login-shell `PATH`. If the default
`~/.local/bin/grok` already belongs to the real CLI, the installer stops. Choose
an unused location in `.env`, for example:

```sh
SHIM_BIN=~/.local/raft-acp-bridge/bin/grok
```

Put that directory before the real CLI's directory on the login-shell `PATH`,
then rerun `npm run install:cli` and `doctor`. The bridge finds the real CLI
later on `PATH`; `GROK_SHIM_REAL_GROK` can also specify it explicitly. Set
`RAFT_GROK_BACKEND=shim` on bridge-backed Raft agents and restart Computer.

## Maintenance commands

The optional `raft-stack install-agent` command generates a local LaunchAgent
with this checkout's path, current Node executable, login-shell `PATH` and selected
env file, configuration root and explicitly selected extension. Re-run it after moving the checkout or changing Node. Put persistent
machine settings in `.env`; arbitrary one-off exported variables are not copied
into the generated plist. Source-mode or supervisor ownership should remain a
deliberate choice; see [Computer lifecycle](troubleshooting.md#raft-computer-lifecycle).

Do not sync OAuth credentials, LaunchAgent plists, logs, or Maka storage-root
markers through
Git. A marker records the local filesystem's device/inode identity. Conversation
migration is a separate operation; copying this repository does not migrate an
agent's history.
