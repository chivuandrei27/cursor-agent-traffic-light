#!/usr/bin/env node

import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR } from './app-home.mjs';
import {
  bridgeCommand,
  detectOs,
  healthUrl,
  launchAgentPath,
  linuxUnit,
  linuxUnitPath,
  logDir,
  macosPlist,
  repoRoot,
  waitForHealth,
  windowsCmd,
  windowsLauncherPath,
  windowsStartupDir,
} from './autostart-utils.mjs';
import { ensureAppInstall } from './sync-app.mjs';

/**
 * LaunchAgents cannot read ~/Documents|Desktop|Downloads without Full Disk
 * Access (EPERM). Autostart must run from ~/.cursor-agent-traffic-light/app.
 * @param {string} root
 */
export function needsAutostartSync(root) {
  const home = homedir();
  const normalized = String(root || '');
  const markers = [
    join(home, 'Documents'),
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'Library', 'Mobile Documents'),
  ];
  return markers.some(
    (marker) => normalized === marker || normalized.startsWith(`${marker}/`),
  );
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    nodePath: process.execPath,
    repoRootPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--node') options.nodePath = argv[++i];
    else if (arg === '--repo-root') options.repoRootPath = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function backupIfPresent(path, dryRun) {
  if (!(await exists(path))) {
    return null;
  }
  const bak = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!dryRun) {
    await copyFile(path, bak);
  }
  return bak;
}

async function installMacos(cmd, logs, dryRun) {
  const plistPath = launchAgentPath();
  const content = macosPlist({
    node: cmd.node,
    script: cmd.script,
    cwd: cmd.cwd,
    stdoutLog: logs.stdout,
    stderrLog: logs.stderr,
  });

  console.log(`[install-autostart] target: ${plistPath}`);
  if (dryRun) {
    console.log(content);
    return { path: plistPath };
  }

  const bak = await backupIfPresent(plistPath, dryRun);
  await mkdir(logDir(), { recursive: true });
  await writeFile(plistPath, content, 'utf8');

  spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf8' });
  const loaded = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf8' });
  if (loaded.status !== 0) {
    const domain = `gui/${process.getuid?.() ?? 501}`;
    spawnSync('launchctl', ['bootout', domain, plistPath], { encoding: 'utf8' });
    const boot = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
    if (boot.status !== 0) {
      throw new Error(`launchctl failed: ${boot.stderr || loaded.stderr || 'unknown error'}`);
    }
  }

  return { path: plistPath, backup: bak };
}

async function installWindows(cmd, logs, dryRun) {
  const launcher = windowsLauncherPath();
  const content = windowsCmd({
    node: cmd.node,
    script: cmd.script,
    cwd: cmd.cwd,
    stdoutLog: logs.stdout,
    stderrLog: logs.stderr,
  });
  console.log(`[install-autostart] target: ${launcher}`);
  if (dryRun) {
    console.log(content);
    return { path: launcher };
  }
  await mkdir(windowsStartupDir(), { recursive: true });
  await mkdir(logDir(), { recursive: true });
  const bak = await backupIfPresent(launcher, dryRun);
  await writeFile(launcher, content, 'utf8');
  spawnSync('cmd.exe', ['/c', launcher], { encoding: 'utf8', detached: true, stdio: 'ignore' });
  return { path: launcher, backup: bak };
}

async function installLinux(cmd, logs, dryRun) {
  const unitPath = linuxUnitPath();
  const content = linuxUnit({
    node: cmd.node,
    script: cmd.script,
    cwd: cmd.cwd,
    stdoutLog: logs.stdout,
    stderrLog: logs.stderr,
  });
  console.log(`[install-autostart] target: ${unitPath}`);
  if (dryRun) {
    console.log(content);
    return { path: unitPath };
  }
  await mkdir(logDir(), { recursive: true });
  const bak = await backupIfPresent(unitPath, dryRun);
  await writeFile(unitPath, content, 'utf8');
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr}`);
  }
  const enable = spawnSync(
    'systemctl',
    ['--user', 'enable', '--now', 'cursor-agent-traffic-light.service'],
    {
      encoding: 'utf8',
    },
  );
  if (enable.status !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr}`);
  }
  return { path: unitPath, backup: bak };
}

export async function installAutostart({
  dryRun = false,
  nodePath = process.execPath,
  repoRootPath = repoRoot(),
  verifyHealth = true,
} = {}) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Refusing to install autostart as root');
  }

  const os = detectOs();
  let appRoot = repoRootPath;
  if (os === 'macos' && needsAutostartSync(repoRootPath)) {
    console.log(
      `[install-autostart] repo is under a macOS privacy-protected folder; syncing into ${APP_DIR}`,
    );
    if (!dryRun) {
      const synced = await ensureAppInstall({
        packageRoot: repoRootPath,
        nodePath,
        forceSync: true,
        onProgress: (line) => console.log(`[install-autostart] ${line}`),
      });
      appRoot = synced.appDir;
    } else {
      appRoot = APP_DIR;
    }
  }

  const cmd = bridgeCommand(appRoot, nodePath);
  const logs = {
    stdout: `${logDir()}/bridge.out.log`,
    stderr: `${logDir()}/bridge.err.log`,
  };

  console.log(`[install-autostart] os=${os}`);
  console.log(`[install-autostart] node=${cmd.node}`);
  console.log(`[install-autostart] script=${cmd.script}`);
  console.log(`[install-autostart] cwd=${cmd.cwd}`);
  console.log(`[install-autostart] logs=${logDir()}`);

  let result;
  if (os === 'macos') {
    result = await installMacos(cmd, logs, dryRun);
  } else if (os === 'windows') {
    result = await installWindows(cmd, logs, dryRun);
  } else if (os === 'linux') {
    result = await installLinux(cmd, logs, dryRun);
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }

  if (result.backup) {
    console.log(`[install-autostart] backup: ${result.backup}`);
    console.log(`[install-autostart] rollback: restore backup over ${result.path}`);
  }

  if (dryRun) {
    console.log('[install-autostart] dry-run complete; nothing installed');
    return { ...result, health: null };
  }

  console.log(`[install-autostart] installed: ${result.path}`);
  if (!verifyHealth) {
    return { ...result, health: null };
  }

  console.log(`[install-autostart] verifying ${healthUrl()} …`);
  const health = await waitForHealth(10_000);
  if (!health.ok) {
    console.error(`[install-autostart] health check failed: ${health.error}`);
    console.error('[install-autostart] check logs and run: npm run status:autostart');
    const error = new Error(`Bridge health check failed: ${health.error}`);
    error.health = health;
    throw error;
  }
  console.log('[install-autostart] health ok');
  return { ...result, health };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: npm run install:autostart -- [--dry-run] [--node <path>] [--repo-root <path>]',
    );
    return;
  }

  await installAutostart({
    dryRun: options.dryRun,
    nodePath: options.nodePath,
    repoRootPath: options.repoRootPath || repoRoot(),
  });
  console.log('[install-autostart] uninstall with: npm run uninstall:autostart');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error('[install-autostart]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
