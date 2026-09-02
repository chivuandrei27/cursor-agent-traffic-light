#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { runSetup } from '../scripts/setup.mjs';
import { runUninstall } from '../scripts/uninstall.mjs';

function printHelp() {
  console.log(`cursor-agent-traffic-light

Commands:
  setup       Install Node runtime if needed, hooks, bridge autostart
  uninstall   Remove hooks, autostart, private runtime
  help        Show this help

Examples:
  npx cursor-agent-traffic-light setup
  npx cursor-agent-traffic-light uninstall
`);
}

async function main(argv) {
  const command = argv[0] || 'help';
  const rest = argv.slice(1);

  if (command === 'setup') {
    await runSetup(rest);
    return;
  }
  if (command === 'uninstall') {
    await runUninstall(rest);
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
