import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const STATE_DIR = join(homedir(), '.cursor-agent-traffic-light');
export const INSTANCES_PATH = join(STATE_DIR, 'instances.json');
export const CONTEXT_PATH = join(STATE_DIR, 'conversation-context.json');

/**
 * @param {string} rootPath
 */
function projectNameFromPath(rootPath) {
  const parts = String(rootPath).split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return 'Unknown project';
  }
  return parts[parts.length - 1];
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
function normalizeInstance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const workspaceRoot =
    typeof value.workspaceRoot === 'string' && value.workspaceRoot.trim()
      ? value.workspaceRoot.trim()
      : null;
  const project =
    typeof value.project === 'string' && value.project.trim()
      ? value.project.trim()
      : workspaceRoot
        ? projectNameFromPath(workspaceRoot)
        : '';
  if (!workspaceRoot && !project) {
    return null;
  }

  const id =
    typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : value.conversationId
        ? `conv:${value.conversationId}`
        : workspaceRoot
          ? `ws:${workspaceRoot}`
          : `project:${project}`;

  return {
    id,
    project: project || 'Unknown project',
    workspaceRoot,
    state: typeof value.state === 'string' ? value.state : 'idle',
    message: typeof value.message === 'string' ? value.message : '',
    task: typeof value.task === 'string' ? value.task : '',
    tabName: typeof value.tabName === 'string' ? value.tabName : '',
    conversationId: value.conversationId ?? null,
    source: typeof value.source === 'string' ? value.source : 'bridge',
    event: value.event ?? 'restore',
    sequence: Number.isFinite(value.sequence) ? value.sequence : 0,
    updatedAt:
      typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    agentRunning: Boolean(value.agentRunning),
    shellInFlight: Boolean(value.shellInFlight),
    approvalPendingSince:
      typeof value.approvalPendingSince === 'string' ? value.approvalPendingSince : null,
    tabIndex: Number.isFinite(Number(value.tabIndex)) ? Number(value.tabIndex) : 0,
  };
}

/**
 * @param {{ instancesPath?: string, contextPath?: string }} [paths]
 * @returns {Promise<object[]>}
 */
export async function loadPersistedInstances(paths = {}) {
  const filePath = paths.instancesPath || INSTANCES_PATH;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.instances)
        ? parsed.instances
        : [];
    return list.map(normalizeInstance).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Unique workspaces from conversation-context.json (fallback after restart).
 * @param {{ contextPath?: string }} [paths]
 * @returns {Promise<object[]>}
 */
export async function loadContextWorkspaceSeeds(paths = {}) {
  const filePath = paths.contextPath || CONTEXT_PATH;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }

    /** @type {object[]} */
    const seeds = [];
    /** @type {Map<string, number>} */
    const tabCountByWorkspace = new Map();

    const entries = Object.entries(parsed).sort((a, b) => {
      const aTime = Date.parse(a[1]?.updatedAt || 0) || 0;
      const bTime = Date.parse(b[1]?.updatedAt || 0) || 0;
      return aTime - bTime;
    });

    for (const [conversationId, entry] of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const workspaceRoot =
        typeof entry.workspaceRoot === 'string' && entry.workspaceRoot.trim()
          ? entry.workspaceRoot.trim()
          : null;
      if (!workspaceRoot) {
        continue;
      }
      const tabIndex = (tabCountByWorkspace.get(workspaceRoot) || 0) + 1;
      tabCountByWorkspace.set(workspaceRoot, tabIndex);
      const updatedAt =
        typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date(0).toISOString();
      seeds.push({
        id: `conv:${conversationId}`,
        project:
          typeof entry.project === 'string' && entry.project.trim()
            ? entry.project.trim()
            : projectNameFromPath(workspaceRoot),
        workspaceRoot,
        state: 'idle',
        message: 'Restored Cursor chat',
        task: '',
        tabName: typeof entry.tabName === 'string' ? entry.tabName : '',
        conversationId,
        source: 'bridge',
        event: 'restore',
        sequence: 0,
        updatedAt,
        startedAt: null,
        tabIndex,
      });
    }
    return seeds;
  } catch {
    return [];
  }
}

/**
 * Load cards for bridge startup.
 * Prefer the persisted snapshot only — never re-seed closed projects from
 * conversation-context (that brought back windows the user already closed).
 * Context seeds are used only when there is no snapshot yet (first run).
 *
 * @param {{ instancesPath?: string, contextPath?: string }} [paths]
 * @returns {Promise<object[]>}
 */
export async function loadInstancesForHydration(paths = {}) {
  const persisted = await loadPersistedInstances(paths);
  if (persisted.length > 0) {
    return persisted;
  }
  return loadContextWorkspaceSeeds(paths);
}

/**
 * @param {object[]} instances
 * @param {{ instancesPath?: string }} [paths]
 */
export async function savePersistedInstances(instances, paths = {}) {
  const filePath = paths.instancesPath || INSTANCES_PATH;
  const list = (Array.isArray(instances) ? instances : [])
    .map(normalizeInstance)
    .filter(Boolean);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ savedAt: new Date().toISOString(), instances: list }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Debounced writer for status-store subscribers.
 * @param {() => object[]} getInstances
 * @param {number} [delayMs]
 */
export function createInstancePersister(getInstances, delayMs = 150) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let writing = false;
  let queued = false;

  const flush = async () => {
    writing = true;
    try {
      await savePersistedInstances(getInstances());
    } catch (error) {
      console.error('[bridge] failed to persist instances:', error);
    } finally {
      writing = false;
      if (queued) {
        queued = false;
        void flush();
      }
    }
  };

  return {
    schedule() {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (writing) {
          queued = true;
          return;
        }
        void flush();
      }, delayMs);
      timer.unref?.();
    },
    async flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}
