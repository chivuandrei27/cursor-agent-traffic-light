#!/usr/bin/env node

/**
 * Full uninstall: hooks, autostart, optional private runtime + synced app.
 * Never touches the user's system Node installation.
 */

import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { APP_DIR, APP_HOME, RUNTIME_DIR, STATE_PATH } from './app-home.mjs';
import { pathExists, projectHooksPath, userHooksPath } from './hook-utils.mjs';

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    keepRuntime: false,
    keepApp: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--keep-runtime') options.keepRuntime = true;
    else if (arg === '--keep-app') options.keepApp = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Cursor Agent Traffic Light — uninstall

Usage:
  npx cursor-agent-traffic-light uninstall [options]
  npm run uninstall -- [options]

Options:
  --dry-run        Show actions only
  --keep-runtime   Keep private Node under ~/.cursor-agent-traffic-light/runtime
  --keep-app       Keep synced app files under ~/.cursor-agent-traffic-light/app
  --help           Show this help

Does not modify system Node. Remove the Chrome extension from chrome://extensions.
`);
}

function runNodeScript(relativeUrl, args) {
  const scriptPath = fileURLToPath(new URL(relativeUrl, import.meta.url));
  return spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
}

export async function runUninstall(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return { ok: true };
  }

  console.log('Cursor Agent Traffic Light — uninstall');

  console.log('\n[1/4] Removing Cursor hooks…');
  if (options.dryRun) {
    console.log(`      would strip hooks from ${userHooksPath()}`);
    console.log(`      would strip hooks from ${projectHooksPath(process.cwd())} if present`);
  } else {
    runNodeScript('./uninstall-hooks.mjs', ['--user-only']);
    runNodeScript('./uninstall-hooks.mjs', ['--project-only']);
  }

  console.log('\n[2/4] Removing autostart…');
  if (options.dryRun) {
    console.log('      would run uninstall-autostart');
  } else {
    runNodeScript('./uninstall-autostart.mjs', []);
  }

  console.log('\n[3/4] Removing private runtime…');
  if (options.keepRuntime) {
    console.log('      kept (--keep-runtime)');
  } else if (options.dryRun) {
    console.log(`      would remove ${RUNTIME_DIR}`);
  } else if (await pathExists(RUNTIME_DIR)) {
    await rm(RUNTIME_DIR, { recursive: true, force: true });
    console.log(`      removed ${RUNTIME_DIR}`);
  } else {
    console.log('      nothing to remove');
  }

  console.log('\n[4/4] Removing synced app…');
  if (options.keepApp) {
    console.log('      kept (--keep-app)');
  } else if (options.dryRun) {
    console.log(`      would remove ${APP_DIR}`);
    console.log(`      would remove ${STATE_PATH}`);
  } else {
    if (await pathExists(APP_DIR)) {
      await rm(APP_DIR, { recursive: true, force: true });
      console.log(`      removed ${APP_DIR}`);
    } else {
      console.log('      no synced app dir');
    }
    if (await pathExists(STATE_PATH)) {
      await rm(STATE_PATH, { force: true });
      console.log(`      removed ${STATE_PATH}`);
    }
  }

  console.log(`\nApp home left at ${APP_HOME} (logs may remain).`);
  console.log('Remove the Chrome extension from chrome://extensions if installed.');
  console.log('Done.');
  return { ok: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runUninstall(process.argv.slice(2));
  } catch (error) {
    console.error('[uninstall]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
