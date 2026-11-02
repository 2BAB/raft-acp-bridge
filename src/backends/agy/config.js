import path from "node:path";

export function agySettings({ env, home, at }) {
  const agyBin = at("AGY_ACP_BIN", path.join(home, "Library/Application Support/agy-acp/agy_acp_server.par"));
  return { agyBin, agyDir: path.dirname(agyBin), agyHelper: path.join(path.dirname(agyBin), "localharness_external") };
}
