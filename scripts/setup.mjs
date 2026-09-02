#!/usr/bin/env node

/**
 * One-shot installer:
 *  1) resolve Node (>=18 system or private 22)
 *  2) sync app to stable dir when needed
 *  3) user-level Cursor hooks
 *  4) bridge autostart + health check
 *  5) print Chrome extension next step
 */

import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  APP_HOME,
  CHROME_EXTENSION_URL,
  MIN_SYSTEM_NODE_MAJOR,
  PRIVATE_NODE_VERSION,
} from './app-home.mjs';
import { repoRootFromHere } from './hook-utils.mjs';
import { installAutostart } from './install-autostart.mjs';
import { installHooks } from './install-hooks.mjs';
import {
  ensureNodeRuntime,
  isNodeMajorAtLeast,
  probeNodeVersion,
  writeInstallState,
} from './runtime-utils.mjs';
import { ensureAppInstall } from './sync-app.mjs';

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    preferPrivateNode: false,
    skipAutostart: false,
    skipHooks: false,
    forceSync: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--private-node') options.preferPrivateNode = true;
    else if (arg === '--skip-autostart') options.skipAutostart = true;
    else if (arg === '--skip-hooks') options.skipHooks = true;
    else if (arg === '--force-sync') options.forceSync = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Cursor Agent Traffic Light — setup

Usage:
  npx cursor-agent-traffic-light setup [options]
  npm run setup -- [options]

Options:
  --dry-run          Print actions without changing the system
  --private-node     Always use private Node ${PRIVATE_NODE_VERSION} (never system Node)
  --skip-hooks       Do not install Cursor hooks
  --skip-autostart   Do not install bridge autostart
  --force-sync       Copy package into ~/.cursor-agent-traffic-light/app even for local clones
  --help             Show this help

After setup:
  1. Install the Chrome extension (Web Store or load unpacked from extension/)
  2. Restart Cursor completely
`);
}

function step(title) {
  console.log(`\n${title}`);
}

async function maybeReexecWithNewerNode(nodePath, argv) {
  const current = probeNodeVersion(process.execPath);
  const target = probeNodeVersion(nodePath);
  if (!target || nodePath === process.execPath) {
    return false;
  }
  if (current && isNodeMajorAtLeast(current, MIN_SYSTEM_NODE_MAJOR)) {
    return false;
  }
  console.log(`[setup] Re-launching setup with Node ${target}…`);
  const result = spawnSync(nodePath, [process.argv[1], ...argv], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
  return true;
}

export async function runSetup(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { ok: true, dryRun: true };
  }

  console.log('Cursor Agent Traffic Light — setup');
  console.log(`App home: ${APP_HOME}`);

  step('[1/5] Checking Node…');
  const runtime = await ensureNodeRuntime({
    preferPrivate: options.preferPrivateNode,
    onProgress: (message) => console.log(`      ${message}`),
  });

  if (!options.dryRun) {
    await maybeReexecWithNewerNode(runtime.nodePath, argv);
  }

  const packageRoot = repoRootFromHere();

  step('[2/5] Preparing app files…');
  const app = await ensureAppInstall({
    packageRoot,
    nodePath: runtime.nodePath,
    forceSync: options.forceSync,
    dryRun: options.dryRun,
    onProgress: (message) => console.log(`      ${message}`),
  });

  if (!options.skipHooks) {
    step('[3/5] Installing Cursor hooks (user-level)…');
    await installHooks({
      userOnly: true,
      dryRun: options.dryRun,
      nodePath: runtime.nodePath,
      repoRoot: app.appDir,
    });
  } else {
    step('[3/5] Skipping hooks (--skip-hooks)');
  }

  if (!options.skipAutostart) {
    step('[4/5] Starting bridge + autostart…');
    if (options.dryRun) {
      console.log('      dry-run would install autostart and verify /health');
    } else {
      await installAutostart({
        dryRun: false,
        nodePath: runtime.nodePath,
        repoRootPath: app.appDir,
        verifyHealth: true,
      });
    }
  } else {
    step('[4/5] Skipping autostart (--skip-autostart)');
  }

  step('[5/5] Chrome extension');
  console.log(`      Web Store (when published): ${CHROME_EXTENSION_URL}`);
  console.log(`      Or load unpacked from: ${app.appDir}/extension`);
  console.log('      Then open the side panel — connection should show Connected.');

  if (!options.dryRun) {
    await writeInstallState({
      nodePath: runtime.nodePath,
      nodeSource: runtime.source,
      nodeVersion: runtime.version,
      appDir: app.appDir,
      packageRoot,
      privateNodeVersion: PRIVATE_NODE_VERSION,
      installedAt: new Date().toISOString(),
    });
  }

  console.log('\nDone.');
  console.log('Next: install/reload the Chrome extension, then restart Cursor once.');
  if (!options.skipAutostart) {
    console.log('Bridge should stay up via autostart (http://127.0.0.1:3210).');
  }

  return {
    ok: true,
    dryRun: options.dryRun,
    runtime,
    appDir: app.appDir,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSetup(process.argv.slice(2));
  } catch (error) {
    console.error('[setup]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
