#!/usr/bin/env node

import {
  backup,
  buildMcpServerEntry,
  exampleMcpConfig,
  mergeMcpConfig,
  pathExists,
  projectMcpPath,
  readJson,
  repoRoot,
  writeJson,
} from './mcp-utils.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

async function main() {
  const root = repoRoot();
  const target = projectMcpPath(process.cwd());
  const entry = buildMcpServerEntry(root);
  const examplePath = join(root, '.cursor', 'mcp.example.json');

  await mkdir(dirname(examplePath), { recursive: true });
  await writeFile(examplePath, `${JSON.stringify(exampleMcpConfig(root), null, 2)}\n`, 'utf8');

  const existing = (await readJson(target)) || {};
  if (existing?.mcpServers?.['cursor-agent-traffic-light']) {
    console.log(`[install-mcp] already configured in ${target}`);
  }

  const merged = mergeMcpConfig(existing, entry);
  const bak = await backup(target);
  await writeJson(target, merged);

  console.log(`[install-mcp] wrote ${target}`);
  console.log(`[install-mcp] example also at ${examplePath}`);
  if (bak) {
    console.log(`[install-mcp] backup: ${bak}`);
    console.log(`[install-mcp] rollback: copy "${bak}" over "${target}"`);
  }
  console.log('[install-mcp] restart Cursor, then confirm the MCP server is connected');
  console.log(`[install-mcp] server entry: ${entry.command} ${entry.args.join(' ')}`);

  if (!(await pathExists(entry.args[0]))) {
    throw new Error(`MCP server missing at ${entry.args[0]}`);
  }
}

try {
  await main();
} catch (error) {
  console.error('[install-mcp]', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
