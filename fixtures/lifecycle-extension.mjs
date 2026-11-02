import fs from "node:fs";

export default {
  configureEnvironment() { return { SHIM_TEST_CONFIGURED: "yes" }; },
  createLifecycle({ env }) {
    const record = (event, details = {}) => fs.appendFileSync(env.SHIM_TEST_LIFECYCLE_LOG,
      JSON.stringify({ event, ...details }) + "\n");
    record("created", { configured: env.SHIM_TEST_CONFIGURED });
    return {
      sessionReady: (details) => record("ready", details),
      beforePrompt: (details) => record("prompt", details),
      beforeModelChange: (details) => record("before-model", details),
      afterModelChange: (details) => record("after-model", details),
      dispose: () => record("disposed"),
    };
  },
  installationChecks() {
    return [{ name: "fixture-extension", status: "ok", message: "read-only fixture check" }];
  },
};
