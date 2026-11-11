# Troubleshooting

Start with the installation check for the backend in use:

```sh
npm run doctor -- --profile agy    # or maka / all
```

It checks files and configuration, not authentication, service health or model
output. Enable `GROK_SHIM_DEBUG=1` for shim diagnostics on stderr.

## Runtime and session failures

| Symptom | Check |
| --- | --- |
| Grok Build is not detected | `grok --version`, `grok agent stdio --help`, the installed symlink and login-shell `PATH`; restart Computer after changing its environment |
| Session says no backend is declared | set `GROK_SHIM_PROFILE=agy` or `maka` on that agent |
| The real Grok CLI runs instead of the selected profile | set `RAFT_GROK_BACKEND=shim` on the agent to force the shim |
| Antigravity fails to start | run `agy acp --help` and check which executable the bridge finds with `npm run doctor -- --profile agy` |
| Model selection rejects a prefixed ID | the model prefix must agree with the agent profile |
| Antigravity authentication fails | follow the sign-in instructions for the installed CLI on this Mac |
| Maka returns `host_draining` | check `maka runtime-host service status` and the Host's logs before changing the shim |
| A message is announced as queued | expected when steering is unavailable; it is sent after the current turn |
| A session cannot be restored | confirm that the agent is using the backend that created the session and check its logs |

## Raft Computer lifecycle

Use the installed product's supervisor:

```sh
raft-computer status
raft-computer restart
```

Computer supervises workers and each worker starts the runtime CLI processes.
An agent's running process keeps its original backend after a bridge update.
Restart the affected agent or Raft Computer after switching backends. Closing
the Raft Desktop window can leave Computer and its agents running.

Restart and inspect the Computer service through its supervisor; internal
`__service` and `__run` modes manage individual processes. Inspect supervisor
status and logs when a worker exits.

`ops/raft-stack.mjs status` is a convenience report. Its `up`, `down` and
`install-agent` commands also manage services and should be used only when
that ownership is intentional. The optional login item must not compete with
another supervisor for the same Raft state.

`RAFT_HOME/computer/host-lifecycle-owner.json` records lifecycle ownership.
Machine identity and agent state are separate from this checkout. Before
reattaching or resetting a computer with existing agents, back up its state
through an appropriate consistent procedure; changing its display name is not
an identity migration.

For `child_failed` with `Cannot find module '/__service'`, check the installed
Computer version and launcher. This was observed in Desktop 1.21.22/1.21.24;
see the [integration article](https://2bab.me/en/blog/2026-10-20-raft-runtime-slot/)
for the version-specific investigation. Report matching failures upstream.

## Maka workspace after a reboot or move

Maka's storage-root marker records filesystem device/inode identity. A changed
mount identifier can produce `StorageRootAuthorityError` even when the directory
is still present. First confirm the configured workspace is the actual Host
workspace; a new directory on another Mac is not merely a remount.

Use Maka's supported recovery procedure. The existing `raft-stack up` helper
backs up and repairs a marker only when the inode matches and the device
changed, but it also starts services. `doctor` only reports marker differences.
Do not use `up` as a read-only marker check or copy another Mac's marker to make
its identity appear valid.
