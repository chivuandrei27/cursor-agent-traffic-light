#!/usr/bin/env node

import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  APP_ID,
  detectOs,
  healthUrl,
  launchAgentPath,
  linuxUnitPath,
  logDir,
  waitForHealth,
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

async function main() {
  const os = detectOs();
  console.log(`os: ${os}`);
  console.log(`logs: ${logDir()}`);

  if (os === 'macos') {
    const path = launchAgentPath();
    console.log(`plist: ${path}`);
    console.log(`installed: ${await exists(path)}`);
    const list = spawnSync('launchctl', ['list', APP_ID], { encoding: 'utf8' });
    console.log(`launchctl: ${list.status === 0 ? 'loaded' : 'not loaded'}`);
    if (list.stdout) console.log(list.stdout.trim());
  } else if (os === 'windows') {
    const path = windowsLauncherPath();
    console.log(`launcher: ${path}`);
    console.log(`installed: ${await exists(path)}`);
  } else if (os === 'linux') {
    const path = linuxUnitPath();
    console.log(`unit: ${path}`);
    console.log(`installed: ${await exists(path)}`);
    const status = spawnSync(
      'systemctl',
      ['--user', 'is-active', 'cursor-agent-traffic-light.service'],
      { encoding: 'utf8' },
    );
    console.log(`systemd: ${(status.stdout || status.stderr || '').trim() || 'unknown'}`);
  }

  console.log(`health url: ${healthUrl()}`);
  const health = await waitForHealth(2000);
  if (health.ok) {
    console.log('health: ok');
    console.log(JSON.stringify(health.body, null, 2));
  } else {
    console.log(`health: unavailable (${health.error})`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error('[status:autostart]', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
