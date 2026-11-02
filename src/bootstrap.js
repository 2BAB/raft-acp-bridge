import { loadRepositoryEnv, normalizePathEnv, readConfig } from "./config.js";

// This import must precede other application imports in executable entry points.
try {
  loadRepositoryEnv();
  normalizePathEnv();
  readConfig();
} catch (error) {
  console.error(`configuration: ${error.message}`);
  process.exit(2);
}
