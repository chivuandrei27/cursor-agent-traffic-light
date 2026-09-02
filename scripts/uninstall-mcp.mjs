#!/usr/bin/env node

import {
  backup,
  pathExists,
  projectMcpPath,
  readJson,
  stripMcpConfig,
  writeJson,
} from './mcp-utils.mjs';

async function main() {
  const target = projectMcpPath(process.cwd());
  if (!(await pathExists(target))) {
    console.log(`[uninstall-mcp] no MCP config at ${target}`);
    return;
  }

  const existing = await readJson(target);
  const { config, removed } = stripMcpConfig(existing);
  if (!removed) {
    console.log(`[uninstall-mcp] traffic-light MCP entry not found in ${target}`);
    return;
  }

  const bak = await backup(target);
  await writeJson(target, config);
  console.log(`[uninstall-mcp] removed entry from ${target}`);
  if (bak) {
    console.log(`[uninstall-mcp] backup: ${bak}`);
    console.log(`[uninstall-mcp] rollback: copy "${bak}" over "${target}"`);
  }
}

try {
  await main();
} catch (error) {
  console.error('[uninstall-mcp]', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
