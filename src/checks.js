import fs from "node:fs";
import path from "node:path";

export function readable(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

export function writableDirectory(directory) {
  let existing = directory;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try {
    fs.accessSync(existing, fs.constants.W_OK | fs.constants.X_OK);
    return fs.statSync(existing).isDirectory();
  } catch { return false; }
}

/** Read headers only; never execute the proprietary agent to inspect it. */
export function macArchitectures(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(4096);
    const size = fs.readSync(fd, header, 0, header.length, 0);
    if (size < 8) return [];
    const magic = header.readUInt32BE(0);
    const cpu = (type) => ({ 0x01000007: "x64", 0x0100000c: "arm64" })[type] ?? "unknown";
    if ([0xfeedface, 0xfeedfacf].includes(magic)) return [cpu(header.readUInt32BE(4))];
    if ([0xcefaedfe, 0xcffaedfe].includes(magic)) return [cpu(header.readUInt32LE(4))];
    if ([0xcafebabe, 0xcafebabf].includes(magic)) {
      const stride = magic === 0xcafebabf ? 32 : 20;
      const count = Math.min(header.readUInt32BE(4), Math.floor((size - 8) / stride));
      return Array.from({ length: count }, (_, index) => cpu(header.readUInt32BE(8 + index * stride)));
    }
    return [];
  } finally { fs.closeSync(fd); }
}
