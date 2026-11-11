import test from "node:test";
import assert from "node:assert/strict";
import { projectAgyBilling, readAgyBilling } from "../src/backends/agy/usage.js";

const report = (weekly = 0.87, short = 0.96) => ({
  status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [{ buckets: [
    { id: "gemini-weekly", remaining_fraction: weekly, reset_time: "2026-11-14T08:19:52Z" },
    { id: "gemini-5h", remaining_fraction: short, reset_time: "2026-11-11T10:13:53Z" },
    { id: "3p-weekly", remaining_fraction: 0, reset_time: "2026-11-14T08:19:52Z" },
  ] }] } },
});
test("reports the more constrained Gemini window, independently of third-party quota", () => {
  const billing = projectAgyBilling(report()).config;
  assert.ok(Math.abs(billing.creditUsagePercent - 13) < 1e-8);
  assert.equal(billing.currentPeriod.type, "AGY Gemini weekly");
  assert.equal(billing.currentPeriod.end, "2026-11-14T08:19:52Z");
  assert.equal(projectAgyBilling(report(0.9, 0.2)).config.currentPeriod.type, "AGY Gemini 5-hour");
  assert.equal(projectAgyBilling(report(0, 1)).config.creditUsagePercent, 100);
  assert.equal(projectAgyBilling(report(1, 1)).config.creditUsagePercent, 0);
});
test("missing, ambiguous and malformed readings fail instead of claiming zero usage", () => {
  for (const value of [undefined, { status: "ERROR" }, { ...report(), num_turns: 1 }, report(-1), report(2), report(NaN), report("0.5")]) assert.throws(() => projectAgyBilling(value));
  const missing = report(); missing.command.data.groups[0].buckets.shift();
  assert.throws(() => projectAgyBilling(missing));
  const invalid = report(); invalid.command.data.groups[0].buckets[0].reset_time = "bad";
  assert.throws(() => projectAgyBilling(invalid));
  const duplicate = report(); duplicate.command.data.groups[0].buckets.push(duplicate.command.data.groups[0].buckets[0]);
  assert.throws(() => projectAgyBilling(duplicate));
});
test("quota subprocess is bounded, disables auto-updates, and never returns raw failures", async () => {
  let invocation;
  const env = { ...process.env, AGY_CLI_BIN: process.execPath };
  const billing = await readAgyBilling(env, async (...args) => { invocation = args; return { stdout: JSON.stringify(report()) }; });
  assert.ok(billing.config.creditUsagePercent > 0);
  assert.deepEqual(invocation[1], ["--print", "/usage", "--output-format", "json"]);
  assert.equal(invocation[2].timeout, 15000);
  assert.equal(invocation[2].env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  await assert.rejects(readAgyBilling(env, async () => { throw new Error("SECRET"); }), error => !error.message.includes("SECRET"));
});

test("ACP billing and optional identity work through the shim without exposing backend errors", async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { startShim } = await import("./harness.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "agy-usage-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "agy");
  writeFileSync(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(report()))});\n`, { mode: 0o755 });
  const shim = await startShim({ env: { AGY_CLI_BIN: executable, GROK_SHIM_PREFIX_KIND: "agy" } });
  try {
    await shim.request("initialize", { protocolVersion: 1 });
    const billing = await shim.request("_x.ai/billing", {});
    assert.ok(Math.abs(billing.result.config.creditUsagePercent - 13) < 1e-8);
    assert.deepEqual((await shim.request("_x.ai/auth/info", {})).result, {});
    writeFileSync(executable, '#!/usr/bin/env node\nconsole.error("SECRET");process.exit(1);\n', { mode: 0o755 });
    const failure = await shim.request("_x.ai/billing", {});
    assert.equal(failure.error.code, -32603);
    assert.ok(!failure.error.message.includes("SECRET"));
  } finally { shim.close(); }
});
