#!/usr/bin/env node
// Stands in for an installed Grok Build CLI in the routing tests.
const [first] = process.argv.slice(2);
if (first === "--version" || first === "-v") {
  process.stdout.write("grok 9.9.9 (fake real install)\n");
  process.exit(0);
}
process.stdout.write(`fake-real-grok ${process.argv.slice(2).join(" ")}\n`);
process.exit(0);
