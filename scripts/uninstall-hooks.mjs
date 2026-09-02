#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  backupFile,
  pathExists,
  projectHooksPath,
  readJsonFile,
  stripAppHooks,
  userHooksPath,
  writeHooksConfig,
} from './hook-utils.mjs';

function parseArgs(argv) {
  const options = {
    projectOnly: false,
    userOnly: false,
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--project-only') options.projectOnly = true;
    else if (arg === '--user-only') options.userOnly = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.projectOnly && !options.userOnly) {
    options.userOnly = true;
  }
  if (options.projectOnly && options.userOnly) {
    throw new Error('Use only one of --project-only or --user-only');
  }
  return options;
}

async function uninstallAt(targetPath, dryRun) {
  if (!(await pathExists(targetPath))) {
    console.log(`[uninstall-hooks] no file at ${targetPath}`);
    return;
  }

  const existing = await readJsonFile(targetPath, null);
  const { config, removed } = stripAppHooks(existing);

  if (removed === 0) {
    console.log(`[uninstall-hooks] no traffic-light hooks found in ${targetPath}`);
    return;
  }

  if (dryRun) {
    console.log(`[uninstall-hooks] dry-run would remove ${removed} command(s) from ${targetPath}`);
    return;
  }

  const backup = await backupFile(targetPath);
  await writeHooksConfig(targetPath, config);
  console.log(`[uninstall-hooks] removed ${removed} command(s) from ${targetPath}`);
  if (backup) {
    console.log(`[uninstall-hooks] backup: ${backup}`);
    console.log(`[uninstall-hooks] rollback: copy "${backup}" over "${targetPath}"`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run uninstall:hooks -- [--user-only|--project-only] [--dry-run]');
    return;
  }

  if (options.projectOnly) {
    await uninstallAt(projectHooksPath(process.cwd()), options.dryRun);
  } else {
    await uninstallAt(userHooksPath(), options.dryRun);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error('[uninstall-hooks]', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
