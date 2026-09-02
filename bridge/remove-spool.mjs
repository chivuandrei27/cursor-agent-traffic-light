import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = join(homedir(), '.cursor-agent-traffic-light');
export const SPOOL_DIR = join(STATE_DIR, 'remove-spool');

/**
 * Sync-ish durable remove request. Used when Cursor may kill the hook
 * during window close before an HTTP POST finishes.
 *
 * @param {{
 *   workspaceRoot?: string | null,
 *   conversationId?: string | null,
 *   project?: string,
 *   reason?: string,
 * }} filter
 * @param {{ spoolDir?: string }} [options]
 */
export async function enqueueRemoveRequest(filter, options = {}) {
  const dir = options.spoolDir || SPOOL_DIR;
  await mkdir(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = join(dir, `${stamp}.tmp`);
  const finalPath = join(dir, `${stamp}.json`);
  const payload = {
    ...filter,
    enqueuedAt: new Date().toISOString(),
  };
  await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8');
  await rename(tmpPath, finalPath);
  return finalPath;
}

/**
 * Drain spool files into removeInstance calls.
 *
 * @param {(filter: object) => { removed: number }} removeFn
 * @param {{ spoolDir?: string }} [options]
 * @returns {Promise<number>} number of files processed
 */
export async function drainRemoveSpool(removeFn, options = {}) {
  const dir = options.spoolDir || SPOOL_DIR;
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }

  let processed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const fullPath = join(dir, name);
    try {
      const raw = await readFile(fullPath, 'utf8');
      const filter = JSON.parse(raw);
      if (filter && typeof filter === 'object') {
        removeFn({
          workspaceRoot: filter.workspaceRoot || null,
          conversationId: filter.conversationId || null,
          project: filter.project || '',
        });
      }
      await unlink(fullPath);
      processed += 1;
    } catch (error) {
      console.error('[bridge] remove-spool entry failed:', name, error?.message || error);
      try {
        await unlink(fullPath);
      } catch {
        // ignore
      }
    }
  }
  return processed;
}
