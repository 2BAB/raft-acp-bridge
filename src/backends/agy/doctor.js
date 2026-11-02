import { macArchitectures } from "../../checks.js";

export function checkAgyInstallation({ config, add, executable }) {
  for (const [name, file] of [["agy-server", config.agyBin], ["agy-helper", config.agyHelper]]) {
    if (!executable(name, file)) continue;
    try {
      const cpus = macArchitectures(file);
      if (cpus.length) add(`${name}-cpu`, cpus.includes(process.arch) ? "ok" : "warn",
        `${cpus.join(", ")}; Node is ${process.arch}; check CPU compatibility and Rosetta availability`);
    } catch { add(`${name}-cpu`, "warn", "cannot read executable header"); }
  }
  add("agy-pair", "warn", "server and helper must come from the same release; presence alone cannot verify pairing or login");
}
