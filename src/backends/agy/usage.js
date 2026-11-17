import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readConfig, findExecutable } from "../../config.js";

const execute = promisify(execFile);

/** shortcut: Grok exposes one included window; use the limiting Gemini window until OAR supports native agy usage. */
export function projectAgyBilling(report) {
  if (report?.status !== "SUCCESS" || report.command?.name !== "usage" || report.num_turns !== 0) {
    throw new Error("agy did not return a non-inference usage report");
  }
  const buckets = (report.command.data?.groups ?? []).flatMap(group => group.buckets ?? []);
  const gemini = ["gemini-weekly", "gemini-5h"].map(id => {
    const matching = buckets.filter(bucket => bucket.id === id);
    if (matching.length !== 1) throw new Error(`agy quota report must contain exactly one ${id}`);
    const bucket = matching[0];
    if (typeof bucket.remaining_fraction !== "number" || !Number.isFinite(bucket.remaining_fraction)
      || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1
      || typeof bucket.reset_time !== "string" || !Number.isFinite(Date.parse(bucket.reset_time))) {
      throw new Error(`agy quota report contains invalid ${id} data`);
    }
    return bucket;
  });
  const limiting = gemini.reduce((a, b) => a.remaining_fraction <= b.remaining_fraction ? a : b);
  return {
    config: {
      creditUsagePercent: (1 - limiting.remaining_fraction) * 100,
      currentPeriod: {
        type: limiting.id === "gemini-weekly" ? "AGY Gemini weekly" : "AGY Gemini 5-hour",
        end: limiting.reset_time,
      },
    },
  };
}

export async function readAgyBilling(env = process.env, exec = execute) {
  const config = readConfig(env);
  const command = findExecutable(config.agyCli, env)
    ?? (!env.AGY_CLI_BIN?.trim() ? findExecutable(path.join(config.home, ".local/bin/agy"), env) : null);
  if (!command) throw new Error("Antigravity CLI is required for usage queries");
  try {
    const { stdout } = await exec(command, ["--print", "/usage", "--output-format", "json"], {
      env: { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return projectAgyBilling(JSON.parse(stdout));
  } catch {
    // Never expose subprocess output: authentication failures can contain private data.
    throw new Error("Antigravity usage query failed; run agy /usage to check login and quota");
  }
}
