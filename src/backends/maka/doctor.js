import fs from "node:fs";
import path from "node:path";
import { writableDirectory } from "../../checks.js";
import { makaExecutable } from "../../installation.js";

export function checkMakaInstallation({ config, env, add }) {
  const command = makaExecutable(config, env);
  add("maka", command ? "ok" : "error", command || `not executable or not on PATH: ${config.makaBin}`);
  const endpoint = new URL(config.makaHostUrl);
  endpoint.username = endpoint.password = endpoint.search = endpoint.hash = "";
  add("maka-host", "warn", `${endpoint.href}; verify the actual endpoint using Maka's service status command`);
  add("maka-workspace", writableDirectory(config.makaWorkspace) ? "ok" : "error", config.makaWorkspace);
  const markerFile = path.join(config.makaWorkspace, ".maka-storage-root.json");
  if (!fs.existsSync(markerFile)) return;
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    const stat = fs.statSync(config.makaWorkspace);
    const matches = marker.rootIdentity?.dev === String(stat.dev) && marker.rootIdentity?.ino === String(stat.ino);
    add("maka-storage-root", matches ? "ok" : "warn", matches ? "marker matches this directory" : "marker differs from this filesystem; do not copy markers between Macs");
  } catch { add("maka-storage-root", "warn", "cannot inspect the workspace marker"); }
}
