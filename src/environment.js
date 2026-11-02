/**
 * Maka's Runtime Host prepends this block to every turn, as a system-prompt
 * context named `runtime.environment`
 * (packages/runtime-host/src/server/execution-model-composition.ts). ACP has no
 * system-prompt channel, so a backend driven through this shim gets nothing
 * equivalent — and agy in particular has no idea what its cwd, platform or
 * timezone are.
 *
 * Same shape, same wording, so an agent that already recognises Maka's block
 * reads ours the same way.
 */
export function runtimeEnvironmentText({
  cwd,
  platform = process.platform,
  sampledAt = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  return [
    "Runtime Host environment for this turn:",
    JSON.stringify({
      cwd: cwd ?? process.cwd(),
      platform,
      sampledAt: sampledAt.toISOString(),
      timeZone,
    }),
  ].join("\n");
}
