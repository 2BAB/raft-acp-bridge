#!/usr/bin/env node
import "../src/bootstrap.js";
import { checkInstallation } from "../src/doctor.js";
import { loadExtension } from "../src/extensions.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node ops/doctor.mjs [--profile agy|maka|all] [--json]\nChecks installation only; never starts services, signs in, builds or calls models.");
  process.exit(0);
}
let profile = process.env.GROK_SHIM_PROFILE || "all";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--profile") profile = args[++index];
  else if (args[index] !== "--json") {
    console.error(`unknown argument: ${args[index]}`);
    process.exit(2);
  }
}
try {
  if (!profile) throw new Error("--profile requires agy, maka or all");
  const report = checkInstallation({ profile });
  const extension = await loadExtension();
  const extra = await extension.installationChecks?.({ env: process.env, profile: report.profile }) ?? [];
  report.checks.push(...extra);
  report.ok = report.checks.every((check) => check.status !== "error");
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`raft-acp-bridge installation check (${profile}; no services or models started)`);
    for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.message}`);
    console.log(report.ok ? "Installation checks passed; authentication and live turns were not tested." : "Installation checks failed; fix ERROR items before using this setup.");
  }
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
