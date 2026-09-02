#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  backupFile,
  buildAppHooks,
  mergeHooksConfig,
  pathExists,
  projectHooksPath,
  readJsonFile,
  repoRootFromHere,
  userHooksPath,
  writeHooksConfig,
} from './hook-utils.mjs';

export function parseHooksInstallArgs(argv) {
  const options = {
    projectOnly: false,
    userOnly: false,
    dryRun: false,
    help: false,
    nodePath: process.execPath,
    repoRoot: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project-only') options.projectOnly = true;
    else if (arg === '--user-only') options.userOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--node') options.nodePath = argv[++i];
    else if (arg === '--repo-root') options.repoRoot = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.projectOnly && !options.userOnly) {
    // Default: user-level so every Cursor project reports status.
    options.userOnly = true;
  }
  if (options.projectOnly && options.userOnly) {
    throw new Error('Use only one of --project-only or --user-only');
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  npm run install:hooks -- [--user-only|--project-only] [--dry-run] [--node <path>] [--repo-root <path>]

Defaults to --user-only (all Cursor windows).

Installs Cursor Agent Traffic Light hooks with absolute paths.
Creates a timestamped backup before changing an existing hooks.json.
`);
}

async function installAt(targetPath, appHooks, dryRun) {
  const existing = (await readJsonFile(targetPath, null)) || { version: 1, hooks: {} };
  const merged = mergeHooksConfig(existing, appHooks);

  if (dryRun) {
    console.log(`[install-hooks] dry-run would write ${targetPath}`);
    return targetPath;
  }

  const backup = await backupFile(targetPath);
  await writeHooksConfig(targetPath, merged);

  console.log(`[install-hooks] wrote ${targetPath}`);
  if (backup) {
    console.log(`[install-hooks] backup: ${backup}`);
    console.log(`[install-hooks] rollback: copy "${backup}" over "${targetPath}"`);
  } else {
    console.log(`[install-hooks] rollback: delete "${targetPath}" if you no longer need it`);
  }
  return targetPath;
}

/**
 * Programmatic hooks install for setup.mjs.
 */
export async function installHooks({
  userOnly = true,
  projectOnly = false,
  dryRun = false,
  nodePath = process.execPath,
  repoRoot = repoRootFromHere(),
} = {}) {
  const appHooks = buildAppHooks(repoRoot, nodePath);
  console.log(`[install-hooks] repository: ${repoRoot}`);
  console.log(`[install-hooks] node: ${nodePath}`);

  if (projectOnly && !userOnly) {
    const target = projectHooksPath(process.cwd());
    if (!(await pathExists(repoRoot))) {
      throw new Error(`Repository root missing: ${repoRoot}`);
    }
    return installAt(target, appHooks, dryRun);
  }

  return installAt(userHooksPath(), appHooks, dryRun);
}

async function main() {
  const options = parseHooksInstallArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await installHooks({
    userOnly: options.userOnly,
    projectOnly: options.projectOnly,
    dryRun: options.dryRun,
    nodePath: options.nodePath,
    repoRoot: options.repoRoot || repoRootFromHere(),
  });

  console.log(
    '[install-hooks] restart Cursor completely, then check Settings -> Hooks -> Execution Log',
  );
  console.log('[install-hooks] keep the bridge running (setup/autostart or npm start)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error('[install-hooks]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
