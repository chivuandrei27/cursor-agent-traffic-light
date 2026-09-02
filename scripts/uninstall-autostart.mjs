#!/usr/bin/env node

import { access, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  APP_ID,
  detectOs,
  launchAgentPath,
  linuxUnitPath,
  windowsLauncherPath,
} from './autostart-utils.mjs';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function backupAndRemove(path) {
  if (!(await exists(path))) {
    console.log(`[uninstall-autostart] nothing at ${path}`);
    return;
  }
  const bak = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await copyFile(path, bak);
  await rm(path);
  console.log(`[uninstall-autostart] removed ${path}`);
  console.log(`[uninstall-autostart] backup: ${bak}`);
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Refusing to uninstall autostart as root');
  }

  const os = detectOs();
  console.log(`[uninstall-autostart] os=${os}`);

  if (os === 'macos') {
    const plistPath = launchAgentPath();
    spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf8' });
    const domain = `gui/${process.getuid?.() ?? 501}`;
    spawnSync('launchctl', ['bootout', domain, APP_ID], { encoding: 'utf8' });
    await backupAndRemove(plistPath);
  } else if (os === 'windows') {
    await backupAndRemove(windowsLauncherPath());
  } else if (os === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'cursor-agent-traffic-light.service'], {
      encoding: 'utf8',
    });
    await backupAndRemove(linuxUnitPath());
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  } else {
    throw new Error(`Unsupported platform: ${os}`);
  }
}

try {
  await main();
} catch (error) {
  console.error('[uninstall-autostart]', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
