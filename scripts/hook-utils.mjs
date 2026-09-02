import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const APP_MARKER = 'cursor-agent-traffic-light';

export const HOOK_EVENTS = Object.freeze([
  ['sessionStart', 'idle'],
  ['beforeSubmitPrompt', 'working'],
  ['afterAgentThought', 'working'],
  ['preToolUse', 'working'],
  ['postToolUse', 'working'],
  // Tool failure ≠ user-facing error; red is reserved for "AI has questions".
  ['postToolUseFailure', 'working'],
  // Shell/MCP before* = executing (yellow). Red waiting is preToolUse Shell/MCP only.
  ['beforeShellExecution', 'working'],
  ['afterShellExecution', 'working'],
  ['beforeMCPExecution', 'working'],
  ['afterMCPExecution', 'working'],
  // Final green comes only from `stop` (Stop button gone / agent loop ended).
  // afterAgentResponse is mid-loop — keep working.
  ['afterAgentResponse', 'working'],
  ['stop', 'completed'],
  // sessionEnd with window_close/user_close removes the project card (handled in hook).
  ['sessionEnd', 'idle'],
]);

export function repoRootFromHere(metaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(metaUrl)), '..');
}

export function projectHooksPath(cwd = process.cwd()) {
  return join(cwd, '.cursor', 'hooks.json');
}

export function userHooksPath() {
  return join(homedir(), '.cursor', 'hooks.json');
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function quoteForShell(value) {
  if (process.platform === 'win32') {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildHookCommand(repoRoot, eventName, state, nodeBin = process.execPath) {
  const scriptPath = join(repoRoot, 'scripts', 'cursor-hook.mjs');
  return `${quoteForShell(nodeBin)} ${quoteForShell(scriptPath)} ${eventName} ${state}`;
}

export function buildAppHooks(repoRoot, nodeBin = process.execPath) {
  /** @type {Record<string, Array<{ command: string }>>} */
  const hooks = {};
  for (const [eventName, state] of HOOK_EVENTS) {
    hooks[eventName] = [
      {
        command: buildHookCommand(repoRoot, eventName, state, nodeBin),
      },
    ];
  }
  return hooks;
}

export function isAppCommand(command) {
  if (typeof command !== 'string') {
    return false;
  }
  return (
    command.includes('cursor-hook.mjs') || command.includes(APP_MARKER) || command === 'PLACEHOLDER'
  );
}

export async function readJsonFile(path, fallback = null) {
  if (!(await pathExists(path))) {
    return fallback;
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function backupFile(path) {
  if (!(await pathExists(path))) {
    return null;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.bak-${stamp}`;
  await copyFile(path, backupPath);
  return backupPath;
}

/**
 * Merge app hooks into an existing hooks.json document.
 * Preserves unrelated commands.
 */
export function mergeHooksConfig(existing, appHooks) {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const hooks =
    base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks)
      ? { ...base.hooks }
      : {};

  for (const [eventName, entries] of Object.entries(appHooks)) {
    const current = Array.isArray(hooks[eventName]) ? [...hooks[eventName]] : [];
    const withoutApp = current.filter((entry) => !isAppCommand(entry?.command));
    hooks[eventName] = [...withoutApp, ...entries];
  }

  // Drop our commands from events we no longer manage (e.g. retired sessionEnd).
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (appHooks[eventName] || !Array.isArray(entries)) {
      continue;
    }
    const withoutApp = entries.filter((entry) => !isAppCommand(entry?.command));
    if (withoutApp.length === 0) {
      delete hooks[eventName];
    } else if (withoutApp.length !== entries.length) {
      hooks[eventName] = withoutApp;
    }
  }

  return {
    ...base,
    version: base.version ?? 1,
    hooks,
  };
}

/**
 * Remove only this application's commands.
 */
export function stripAppHooks(existing) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { config: { version: 1, hooks: {} }, removed: 0 };
  }

  const hooksIn = existing.hooks && typeof existing.hooks === 'object' ? existing.hooks : {};
  /** @type {Record<string, unknown[]>} */
  const hooksOut = {};
  let removed = 0;

  for (const [eventName, entries] of Object.entries(hooksIn)) {
    if (!Array.isArray(entries)) {
      hooksOut[eventName] = entries;
      continue;
    }
    const kept = [];
    for (const entry of entries) {
      if (isAppCommand(entry?.command)) {
        removed += 1;
      } else {
        kept.push(entry);
      }
    }
    if (kept.length > 0) {
      hooksOut[eventName] = kept;
    }
  }

  return {
    config: {
      ...existing,
      hooks: hooksOut,
    },
    removed,
  };
}

export async function writeHooksConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
