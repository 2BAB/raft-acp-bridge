#!/usr/bin/env node
/**
 * One entry point for the local Raft stack.
 *
 * The stack has four independent lifetimes — the Raft app, its Computer
 * supervisor, Maka's Runtime Host (launchd), and this shim (a `grok` on PATH).
 * `status` reports health; the other commands change installation or service
 * state. Raft Computer is the supervisor for its workers.
 *
 *   raft-stack status          read-only report
 *   raft-stack up              link the shim and start configured services
 *   raft-stack down            stop the CLI-owned Computer and Maka host
 *   raft-stack install-agent   run `up` at login
 *   raft-stack uninstall-agent remove that login item
 *
 * Use service controls only when that ownership is intentional; a second
 * supervisor must not compete for the same state. See docs/troubleshooting.md.
 */
import '../src/bootstrap.js';
import { readConfig, findExecutable } from '../src/config.js';
import { computerCommand, computerProcessPattern, launchAgentPlist, makaExecutable } from '../src/installation.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const config = readConfig();
const REPO = config.repoRoot;
const GROK = config.shimBin;
const SLOCK = config.raftHome;
const OWNER = path.join(SLOCK, 'computer/host-lifecycle-owner.json');
const RUNTIMES = path.join(SLOCK, 'computer/runtime-cli-versions.json');
const WORKSPACE = config.makaWorkspace;
const MARKER = path.join(WORKSPACE, '.maka-storage-root.json');
const AGENT_LABEL = 'com.2bab.raft-stack';
const AGENT_PLIST = config.launchAgentFile;
const AGENT_LOG = config.launchAgentLog;
const computer = computerCommand(config);
const opsEnv = () => ({ ...process.env, PATH: shellPath() });
const maka = () => makaExecutable(config, opsEnv());

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env: { ...process.env, PATH: shellPath(), ...options.env },
  });
  return {
    code: result.status ?? 1,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
};

/**
 * launchd starts login items with `/usr/bin:/bin:/usr/sbin:/sbin`, which holds
 * neither `~/.local/bin` (maka, grok) nor nvm's bin (node, npx). A daemon
 * started from here hands that PATH to every agent it spawns, so the login
 * shell's PATH is resolved once and used for every child this script starts.
 */
let cachedShellPath;
function shellPath() {
  if (cachedShellPath !== undefined) return cachedShellPath;
  const result = spawnSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const fromShell = (result.stdout ?? '').trim();
  const parts = [...new Set(`${fromShell}:${process.env.PATH ?? ''}`.split(':').filter(Boolean))];
  cachedShellPath = parts.join(':');
  return cachedShellPath;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const processesMatching = (pattern) => {
  const { out } = run('ps', ['-Ao', 'pid=,command=']);
  return out
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
};

const portOpen = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: config.makaHost, port: config.makaPort });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1_500, () => done(false));
  });

const shimState = () => {
  const target = config.shimEntry;
  try {
    const actual = fs.realpathSync(GROK);
    return actual === fs.realpathSync(target) ? 'ok' : `wrong -> ${actual}`;
  } catch {
    return 'missing';
  }
};

const hostState = () => {
  const command = maka();
  if (!command) return { text: 'maka missing', running: false };
  const { out } = run(command, ['runtime-host', 'service', 'status']);
  return { text: out.split('\n')[0] || 'no status', running: /\bis running at\b/.test(out) };
};

const ownerMode = () => readJson(OWNER)?.owner ?? 'unset';

const daemonState = () => ({
  source: processesMatching(computerProcessPattern(config, opsEnv())).length,
  app: processesMatching(new RegExp(`${escapeRegExp(path.basename(config.raftApp, '.app'))}.* __(service|run)`)).length,
});

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const appRunning = () => processesMatching(new RegExp(`${escapeRegExp(config.raftApp)}/Contents/MacOS/[^/]+$`)).length > 0;

/**
 * The storage-root marker binds a random rootId to the directory's (dev, ino).
 * `ino` identifies the directory object; `dev` is a per-mount number the kernel
 * hands out again after a remount, so a reboot can change it while the inode
 * stays. Maka's own `--repair-root-after-remount` is that repair; the managed
 * service never passes it, so the host crash-loops instead. We repair only the
 * case the marker's own comment calls ambiguous-but-safe to verify here: same
 * inode. A different inode is a different directory and is left alone.
 */
const markerState = () => {
  const marker = readJson(MARKER);
  if (!marker) return { state: 'missing' };
  let stat;
  try {
    stat = fs.statSync(WORKSPACE);
  } catch {
    return { state: 'workspace-missing' };
  }
  const dev = String(stat.dev);
  const ino = String(stat.ino);
  if (marker.rootIdentity?.dev === dev && marker.rootIdentity?.ino === ino) return { state: 'ok' };
  if (marker.rootIdentity?.ino === ino) return { state: 'remounted', dev, ino, marker };
  return { state: 'different-directory' };
};

const repairMarker = () => {
  const state = markerState();
  if (state.state !== 'remounted') return state.state;
  const backup = `${MARKER}.bak-${Date.now()}`;
  fs.copyFileSync(MARKER, backup);
  const marker = { ...state.marker, rootIdentity: { dev: state.dev, ino: state.ino } };
  fs.writeFileSync(MARKER, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  console.log(`  repaired storage-root identity after a remount (backup: ${backup})`);
  return 'repaired';
};

const ensureHost = async () => {
  const marker = repairMarker();
  if (marker === 'different-directory') {
    console.log('  storage root points at a different directory — refusing to repair');
    return false;
  }
  const before = hostState();
  if (before.running && (await portOpen())) return true;
  console.log(`  host: ${before.text} — starting`);
  const command = maka();
  if (!command) return false;
  run(command, ['runtime-host', 'service', 'install']);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (hostState().running && (await portOpen())) return true;
  }
  return false;
};

const ensureDaemon = () => {
  const mode = ownerMode();
  const state = daemonState();
  if (mode === 'cli') {
    if (state.source > 0) return true;
    if (!findExecutable(computer.command, opsEnv()) || (computer.args[0] && !fs.existsSync(computer.args[0]))) {
      console.log(`  owner=cli but the Raft Computer command is missing; set RAFT_COMPUTER_BIN or RAFT_SOURCE`);
      return false;
    }
    console.log('  daemon: Computer CLI is not running — starting');
    const { code, out } = run(computer.command, [...computer.args, 'start'], {
      env: { RAFT_HOME: SLOCK },
      timeoutMs: 120_000,
    });
    if (code !== 0) console.log(`  ${out.split('\n').slice(-2).join(' ')}`);
    return code === 0;
  }
  if (mode === 'app') {
    if (state.app > 0) return true;
    if (!appRunning()) {
      console.log('  daemon: app daemon is not running — opening Raft Desktop');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      spawnSync('open', ['-a', config.raftApp], { env, timeout: 30_000 });
    }
    return true;
  }
  console.log('  daemon: host-lifecycle-owner.json is unset — launch Raft Desktop once');
  return false;
};

const ensureShim = () => {
  if (shimState() === 'ok') return true;
  const target = config.shimEntry;
  fs.mkdirSync(path.dirname(GROK), { recursive: true });
  try {
    fs.rmSync(GROK);
  } catch {}
  fs.symlinkSync(target, GROK);
  console.log(`  shim: linked ${GROK} -> ${target}`);
  return true;
};

const cmdStatus = async () => {
  const open = await portOpen();
  const host = hostState();
  const marker = markerState();
  const state = daemonState();
  const mode = ownerMode();
  const versions = readJson(RUNTIMES)?.versions ?? {};
  const shim = shimState();
  console.log('raft-stack');
  console.log(`  shim      ${shim === 'ok' ? 'ok' : shim}`);
  console.log(`  host      ${host.text}${open ? ' (port open)' : ' (port closed)'}`);
  console.log(`  marker    ${marker.state}`);
  console.log(`  owner     ${mode}`);
  console.log(
    `  daemon    source=${state.source} app=${state.app}${
      mode === 'cli' ? (state.source > 0 ? ' ok' : ' down') : state.app > 0 ? ' ok' : ' down'
    }`,
  );
  const runtimes = Object.keys(versions);
  console.log(`  runtimes  ${runtimes.length > 0 ? runtimes.join(', ') : 'none reported'}`);
  return 0;
};

const cmdUp = async () => {
  console.log('raft-stack up');
  ensureShim();
  const host = await ensureHost();
  const daemon = ensureDaemon();
  console.log('');
  await cmdStatus();
  const open = await portOpen();
  return host && daemon && open ? 0 : 1;
};

const cmdDown = () => {
  console.log('raft-stack down');
  const command = maka();
  if (command) run(command, ['runtime-host', 'service', 'stop']);
  const mode = ownerMode();
  if (mode === 'cli') {
    run(computer.command, [...computer.args, 'stop'], { env: { RAFT_HOME: SLOCK } });
  }
  console.log('  stopped (the Raft app, if open, is untouched)');
  return 0;
};

const cmdInstallAgent = () => {
  fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(AGENT_LOG), { recursive: true });
  fs.writeFileSync(AGENT_PLIST, launchAgentPlist(config, shellPath()));
  run('launchctl', ['bootout', `gui/${process.getuid()}`, AGENT_PLIST]);
  const { code, out } = run('launchctl', ['bootstrap', `gui/${process.getuid()}`, AGENT_PLIST]);
  if (code !== 0) {
    console.log(`  could not load the login item: ${out}`);
    return 1;
  }
  console.log(`  installed ${AGENT_LABEL}: runs "raft-stack up" at login (log: ${AGENT_LOG})`);
  return 0;
};

const cmdUninstallAgent = () => {
  run('launchctl', ['bootout', `gui/${process.getuid()}`, AGENT_PLIST]);
  try {
    fs.rmSync(AGENT_PLIST);
  } catch {}
  console.log(`  removed ${AGENT_LABEL}`);
  return 0;
};

const commands = {
  status: cmdStatus,
  up: cmdUp,
  down: cmdDown,
  'install-agent': cmdInstallAgent,
  'uninstall-agent': cmdUninstallAgent,
};

const command = process.argv[2] ?? 'status';
if (!commands[command]) {
  console.error(`usage: raft-stack [${Object.keys(commands).join('|')}]`);
  process.exit(2);
}
process.exit(await commands[command]());
