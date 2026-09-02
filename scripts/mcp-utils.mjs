import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_KEY = 'cursor-agent-traffic-light';

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function projectMcpPath(cwd = process.cwd()) {
  return join(cwd, '.cursor', 'mcp.json');
}

export function userMcpPath() {
  return join(homedir(), '.cursor', 'mcp.json');
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function buildMcpServerEntry(root = repoRoot()) {
  return {
    command: process.execPath,
    args: [join(root, 'mcp', 'server.mjs')],
  };
}

export async function readJson(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function backup(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak-${stamp}`;
  await copyFile(path, backupPath);
  return backupPath;
}

export function mergeMcpConfig(existing, entry) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  servers[MCP_SERVER_KEY] = entry;
  return {
    ...base,
    mcpServers: servers,
  };
}

export function stripMcpConfig(existing) {
  if (!existing || typeof existing !== 'object') {
    return { config: { mcpServers: {} }, removed: false };
  }
  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...existing.mcpServers }
      : {};
  const removed = Boolean(servers[MCP_SERVER_KEY]);
  delete servers[MCP_SERVER_KEY];
  return {
    config: {
      ...existing,
      mcpServers: servers,
    },
    removed,
  };
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function exampleMcpConfig(root = repoRoot()) {
  return {
    mcpServers: {
      [MCP_SERVER_KEY]: buildMcpServerEntry(root),
    },
  };
}
