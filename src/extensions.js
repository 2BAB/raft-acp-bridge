import { pathToFileURL } from "node:url";
import { envFilePath, resolvePath } from "./config.js";
import path from "node:path";

/** Load trusted, explicitly configured local code. No module is loaded by default. */
export async function loadExtension(env = process.env) {
  const selected = env.SHIM_EXTENSION_MODULE?.trim();
  if (!selected) return {};
  const file = resolvePath(selected, { home: env.HOME, base: path.dirname(envFilePath(env)) });
  const module = await import(pathToFileURL(file).href);
  if (!module.default || typeof module.default !== "object") throw new Error("extension module must default-export an object");
  return module.default;
}
