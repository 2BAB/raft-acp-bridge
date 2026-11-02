import path from "node:path";

export function makaSettings({ env, home, at, command }) {
  const hostUrl = new URL(env.MAKA_HOST_URL?.trim() || "ws://127.0.0.1:64150/runtime-host");
  if (!["ws:", "wss:"].includes(hostUrl.protocol)) throw new Error("MAKA_HOST_URL must use ws:// or wss://");
  return {
    makaBin: command(env.MAKA_BIN?.trim() || "maka"),
    makaWorkspace: at("MAKA_WORKSPACE", path.join(home, "Library/Application Support/Maka/workspaces/default")),
    makaHostUrl: hostUrl.href,
    makaHost: hostUrl.hostname.replace(/^\[|\]$/g, ""),
    makaPort: Number(hostUrl.port || (hostUrl.protocol === "wss:" ? 443 : 80)),
  };
}
