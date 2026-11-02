#!/usr/bin/env node
import "../src/bootstrap.js";
import { readConfig } from "../src/config.js";
import { installShim } from "../src/installation.js";

if (process.argv.includes("--help")) {
  console.log("Usage: npm run install:cli\nLink the bridge at SHIM_BIN. Existing non-bridge programs are preserved.");
  process.exit(0);
}
try {
  if (process.argv.length > 2) throw new Error("this command takes no arguments; configure SHIM_BIN in .env");
  const result = installShim(readConfig());
  console.log(`${result.changed ? "Installed" : "Already installed"}: ${result.link} -> ${result.target}`);
  console.log("Put the install directory on your login-shell PATH, then restart Raft Computer.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
