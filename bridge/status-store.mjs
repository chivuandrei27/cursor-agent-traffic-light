import {
  APPROVAL_PENDING_DELAY_MS,
  APPROVAL_STUCK_RED_MS,
  DEDUPE_WINDOW_MS,
  HISTORY_LIMIT,
  INSTANCE_IDLE_TTL_MS,
  INSTANCE_LIMIT,
  INSTANCE_STALE_ACTIVE_MS,
} from './config.mjs';

const STATE_PRIORITY = Object.freeze({
  error: 5,
  waiting: 4,
  working: 3,
  completed: 2,
  idle: 1,
  offline: 0,
});

const ACTIVE_STATES = new Set(['working', 'waiting', 'error']);
const TERMINAL_STATES = new Set(['completed', 'idle']);
/** Only pure "working" is auto-completed — waiting/error mean the user must act. */
const STALE_SWEEP_STATES = new Set(['working']);

/**
 * beforeShell/beforeMCP mean Cursor advanced to execution (auto-approve or
 * user already clicked Run). Mark in-flight so long migrations stay yellow.
 * @param {object} status
 */
function isShellStartEvent(status) {
  const event = status.event || '';
  return (
    event === 'beforeShellExecution' ||
    event === 'beforeMCPExecution' ||
    event === 'approval-running'
  );
}

/**
 * @param {object} status
 */
function isShellEndEvent(status) {
  const event = status.event || '';
  if (event === 'afterShellExecution' || event === 'afterMCPExecution') {
    return true;
  }
  if (event === 'postToolUse' || event === 'postToolUseFailure') {
    return /tool:shell|tool:bash|tool:mcp|\bmcp:/i.test(
      `${status.task || ''} ${status.message || ''}`,
    );
  }
  if (event === 'stop' || event === 'sessionEnd' || event === 'beforeSubmitPrompt') {
    return true;
  }
  return false;
}

/**
 * Agent loop is active from `beforeSubmitPrompt` until Cursor's `stop`
 * (same window as the Stop button in the composer UI).
 * Mid-loop hooks must not reopen the loop after stop — Cursor sometimes
 * emits a late `afterAgentThought` after the turn already completed.
 * @param {object | undefined} previous
 * @param {{ event?: string | null, state?: string }} status
 */
export function resolveAgentRunning(previous, status) {
  const event = status.event || '';
  if (event === 'stop' || event === 'sessionEnd' || event === 'reset' || event === 'stale-timeout') {
    return false;
  }
  if (event === 'beforeSubmitPrompt') {
    return true;
  }
  return Boolean(previous?.agentRunning);
}

/**
 * True when a hook tries to flip a finished card back to active without a new prompt.
 * @param {object | undefined} previous
 * @param {{ state?: string, event?: string | null, source?: string }} status
 */
export function isPostStopResurrection(previous, status) {
  if (!previous || !TERMINAL_STATES.has(previous.state)) {
    return false;
  }
  if (!ACTIVE_STATES.has(status.state)) {
    return false;
  }
  if (status.event === 'beforeSubmitPrompt') {
    return false;
  }
  // Manual / bridge corrections are intentional.
  if (status.source === 'manual' || status.source === 'bridge') {
    return false;
  }
  return true;
}

/**
 * Events that clear a held Shell/MCP approval timer / red lamp.
 * beforeShell/beforeMCP clear it — they mean execution started (auto-approve
 * or Run already clicked). afterAgentThought must NOT clear — same-tick noise.
 * Non-Shell/MCP tool progress also clears (agent moved on; Cursor not asking).
 * @param {{ event?: string | null, task?: string, message?: string }} status
 */
export function isApprovalResolvedEvent(status) {
  const event = status.event || '';
  if (
    event === 'beforeShellExecution' ||
    event === 'afterShellExecution' ||
    event === 'beforeMCPExecution' ||
    event === 'afterMCPExecution' ||
    event === 'stop' ||
    event === 'sessionEnd' ||
    event === 'beforeSubmitPrompt' ||
    event === 'approval-pending' ||
    event === 'approval-running' ||
    event === 'stale-timeout' ||
    event === 'reset' ||
    event === 'afterFileEdit' ||
    event === 'beforeReadFile'
  ) {
    return true;
  }
  if (event === 'postToolUse' || event === 'postToolUseFailure') {
    return true;
  }
  if (event === 'preToolUse') {
    // Shell/MCP preToolUse re-arms pending; Read/Write/etc. clear it.
    return !isPromotableApproval(status);
  }
  return false;
}

/**
 * Only Shell/MCP `preToolUse` gets the delayed red promote.
 * beforeShell must NOT arm — live auto-approved curls were falsely turning red.
 * @param {{ event?: string | null, task?: string, message?: string }} status
 */
export function isPromotableApproval(status) {
  const event = status.event || '';
  // before*/after* are execution signals, never "needs approval".
  if (
    event === 'beforeShellExecution' ||
    event === 'beforeMCPExecution' ||
    event === 'afterShellExecution' ||
    event === 'afterMCPExecution'
  ) {
    return false;
  }
  const text = `${status.task || ''} ${status.message || ''}`;
  // Write/Edit/Read stay yellow — auto-approve is silent for seconds.
  if (/tool:write|tool:edit|tool:read|pending approval: write|pending approval: edit/i.test(text)) {
    return false;
  }
  return /tool:shell|tool:bash|tool:mcp|pending approval: shell|pending approval: bash|pending approval: mcp|\bmcp:/i.test(
    text,
  );
}

/**
 * True when the card is already red for Shell/MCP approval and the new hook
 * is noise that must not downgrade it to yellow.
 * @param {object | undefined} previous
 * @param {{ event?: string | null, source?: string }} status
 */
export function shouldStickApprovalWaiting(previous, status) {
  if (!previous || previous.state !== 'waiting') {
    return false;
  }
  if (status.source === 'manual' || status.source === 'bridge') {
    return status.event === 'approval-pending';
  }
  if (isApprovalResolvedEvent(status)) {
    return false;
  }
  return previous.event === 'approval-pending' || previous.event === 'preToolUse';
}

/**
 * Ask/question red (`error`) must survive afterAgentThought noise.
 * @param {object | undefined} previous
 * @param {{ event?: string | null, state?: string, source?: string, task?: string, message?: string }} status
 */
export function shouldStickAskError(previous, status) {
  if (!previous || previous.state !== 'error') {
    return false;
  }
  if (status.source === 'manual' || status.source === 'bridge') {
    return false;
  }
  if (status.event === 'stop' || status.event === 'sessionEnd' || status.event === 'beforeSubmitPrompt') {
    return false;
  }
  if (status.event === 'postToolUse' || status.event === 'postToolUseFailure') {
    return false;
  }
  // Another Ask preToolUse refreshes; other tools clear.
  if (status.event === 'preToolUse') {
    return /ask|question/i.test(`${status.task || ''} ${status.message || ''}`);
  }
  return true;
}

/**
 * Only `preToolUse` arms the delayed red promote (Shell/MCP).
 * @param {{ event?: string | null }} status
 */
export function isApprovalGateEvent(status) {
  return (status.event || '') === 'preToolUse';
}

/**
 * Prompt-run start time: set on beforeSubmitPrompt / first active state,
 * preserved across tool/thought updates in the same run.
 *
 * @param {object | undefined} previous
 * @param {{ state: string, event?: string | null, updatedAt: string }} status
 * @returns {string | null}
 */
export function resolveStartedAt(previous, status) {
  const isActive = ACTIVE_STATES.has(status.state);
  const wasActive = previous ? ACTIVE_STATES.has(previous.state) : false;
  const isNewPrompt = status.event === 'beforeSubmitPrompt';

  if (isActive) {
    if (isNewPrompt || !wasActive || !previous?.startedAt) {
      return status.updatedAt;
    }
    return previous.startedAt;
  }

  return previous?.startedAt || null;
}

/**
 * Stable key for a Cursor chat tab / conversation instance.
 * Prefer conversation so parallel tabs in the same workspace stay separate.
 * @param {{ workspaceRoot?: string | null, project?: string, conversationId?: string | null, source?: string }} status
 */
export function instanceKey(status) {
  if (status.conversationId) {
    return `conv:${status.conversationId}`;
  }
  if (status.workspaceRoot) {
    return `ws:${status.workspaceRoot}`;
  }
  if (status.project) {
    return `project:${status.project}`;
  }
  return `source:${status.source || 'unknown'}`;
}

/**
 * Next 1-based tab index for a workspace / project.
 * @param {Map<string, object>} instances
 * @param {string | null | undefined} workspaceRoot
 * @param {string} project
 */
export function nextTabIndex(instances, workspaceRoot, project) {
  let max = 0;
  for (const instance of instances.values()) {
    const sameWs = workspaceRoot && instance.workspaceRoot === workspaceRoot;
    const sameProject =
      !workspaceRoot && project && instance.project === project && !instance.workspaceRoot;
    if (sameWs || sameProject) {
      max = Math.max(max, Number(instance.tabIndex) || 0);
    }
  }
  return max + 1;
}

/**
 * In-memory status store with sequence numbers, history, dedupe, and multi-instance tracking.
 */
export class StatusStore {
  /**
   * @param {{
   *   historyLimit?: number,
   *   dedupeWindowMs?: number,
   *   instanceLimit?: number,
   *   instanceIdleTtlMs?: number,
   *   instanceStaleActiveMs?: number,
   *   approvalPendingDelayMs?: number,
   *   approvalStuckRedMs?: number,
   *   now?: () => number,
   * }} [options]
   */
  constructor(options = {}) {
    this.historyLimit = options.historyLimit ?? HISTORY_LIMIT;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEDUPE_WINDOW_MS;
    this.instanceLimit = options.instanceLimit ?? INSTANCE_LIMIT;
    this.instanceIdleTtlMs = options.instanceIdleTtlMs ?? INSTANCE_IDLE_TTL_MS;
    this.instanceStaleActiveMs = options.instanceStaleActiveMs ?? INSTANCE_STALE_ACTIVE_MS;
    this.approvalPendingDelayMs = options.approvalPendingDelayMs ?? APPROVAL_PENDING_DELAY_MS;
    this.approvalStuckRedMs = options.approvalStuckRedMs ?? APPROVAL_STUCK_RED_MS;
    this.now = options.now ?? (() => Date.now());
    this.sequence = 0;
    this.subscribers = new Set();
    this.history = [];
    /** @type {Map<string, object>} */
    this.instances = new Map();
    this.current = this.#createStatus({
      state: 'idle',
      message: 'Bridge ready',
      project: '',
      task: '',
      conversationId: null,
      event: null,
      source: 'bridge',
      workspaceRoot: null,
    });
    this.history.push({ ...this.current });
  }

  getCurrent() {
    return { ...this.current };
  }

  /**
   * Cursor chat tabs: group by project in first-seen order (stable — activity
   * must not reshuffle projects), then by tab index within each project.
   * @returns {object[]}
   */
  getInstances() {
    this.#pruneInstances();
    const list = [...this.instances.values()].map((entry) => ({ ...entry }));

    /** @type {Map<string, object[]>} */
    const byProject = new Map();
    for (const item of list) {
      const groupKey = item.workspaceRoot || item.project || item.id;
      if (!byProject.has(groupKey)) {
        byProject.set(groupKey, []);
      }
      byProject.get(groupKey).push(item);
    }

    /** @type {object[]} */
    const ordered = [];
    for (const [, items] of byProject) {
      items.sort((a, b) => (Number(a.tabIndex) || 0) - (Number(b.tabIndex) || 0));
      ordered.push(...items);
    }
    return ordered;
  }

  /**
   * Aggregate the highest-priority state across instances.
   */
  getAggregateState() {
    const instances = this.getInstances();
    if (instances.length === 0) {
      return this.current.state;
    }
    let best = 'idle';
    let bestScore = -1;
    for (const instance of instances) {
      const score = STATE_PRIORITY[instance.state] ?? 0;
      if (score > bestScore) {
        best = instance.state;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Newest first, up to historyLimit entries.
   * @returns {object[]}
   */
  getHistory() {
    return this.history.map((entry) => ({ ...entry }));
  }

  /**
   * @param {(status: object, meta: { deduped: boolean, instances: object[] }) => void} listener
   * @returns {() => void} unsubscribe
   */
  subscribe(listener) {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * Apply a validated status patch. Server owns sequence and updatedAt.
   * Exact duplicates within the dedupe window are ignored.
   *
   * @param {object} patch
   * @returns {{ status: object, accepted: boolean, deduped: boolean, instances: object[] }}
   */
  setStatus(patch) {
    const candidate = {
      state: patch.state,
      message: patch.message ?? '',
      project: patch.project ?? '',
      task: patch.task ?? '',
      tabName: patch.tabName ?? '',
      conversationId: patch.conversationId ?? null,
      generationId: patch.generationId ?? null,
      event: patch.event ?? null,
      source: patch.source ?? 'manual',
      workspaceRoot: patch.workspaceRoot ?? null,
    };

    if (this.#isDuplicate(candidate)) {
      return {
        status: this.getCurrent(),
        accepted: false,
        deduped: true,
        instances: this.getInstances(),
      };
    }

    const previous = this.instances.get(this.#resolveInstanceKey(candidate));
    if (isPostStopResurrection(previous, candidate)) {
      return {
        status: this.getCurrent(),
        accepted: false,
        deduped: true,
        instances: this.getInstances(),
      };
    }

    const status = this.#createStatus(candidate);
    this.#upsertInstance(status);
    const instance = this.instances.get(this.#resolveInstanceKey(status));
    // Card overrides (sticky questions, shell-in-flight) win over raw hook state.
    const effective = instance
      ? {
          ...status,
          state: instance.state,
          message: instance.message,
          project: instance.project,
          task: instance.task || status.task,
          workspaceRoot: instance.workspaceRoot,
        }
      : status;
    this.current = effective;
    this.history.unshift({ ...effective });
    if (this.history.length > this.historyLimit) {
      this.history.length = this.historyLimit;
    }

    const instances = this.getInstances();
    this.#notify(effective, false, instances);
    return {
      status: this.getCurrent(),
      accepted: true,
      deduped: false,
      instances,
    };
  }

  /**
   * Mark working/waiting instances completed when Cursor's stop hook never arrived.
   * @returns {{ swept: number, status: object, instances: object[] }}
   */
  sweepStaleActive() {
    const now = this.now();
    /** @type {object[]} */
    const stale = [];

    for (const instance of this.instances.values()) {
      if (!STALE_SWEEP_STATES.has(instance.state)) {
        continue;
      }
      // Respect Cursor's agent loop: Stop button still up ⇒ not completed.
      if (instance.agentRunning || instance.shellInFlight) {
        continue;
      }
      const age = now - Date.parse(instance.updatedAt);
      if (Number.isFinite(age) && age >= this.instanceStaleActiveMs) {
        stale.push(instance);
      }
    }

    if (stale.length === 0) {
      return {
        swept: 0,
        status: this.getCurrent(),
        instances: this.getInstances(),
      };
    }

    // Prefer sweeping the newest stale instance last so `current` reflects it.
    stale.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));

    let lastResult = null;
    for (const instance of stale) {
      lastResult = this.setStatus({
        state: 'completed',
        message: 'Auto-completed (no Cursor stop hook)',
        project: instance.project || '',
        task: instance.task || '',
        conversationId: instance.conversationId || null,
        event: 'stale-timeout',
        source: 'bridge',
        workspaceRoot: instance.workspaceRoot || null,
      });
    }

    return {
      swept: stale.length,
      status: lastResult?.status ?? this.getCurrent(),
      instances: lastResult?.instances ?? this.getInstances(),
    };
  }

  /**
   * Flip held Shell/MCP preToolUse approvals to red once they are genuinely
   * pending — i.e. no beforeShell/beforeMCP within the grace delay.
   * @returns {number} promoted count
   */
  promotePendingApprovals() {
    const now = this.now();
    let promoted = 0;
    for (const instance of [...this.instances.values()]) {
      if (!instance.approvalPendingSince || instance.state !== 'working') {
        continue;
      }
      const age = now - Date.parse(instance.approvalPendingSince);
      if (!Number.isFinite(age) || age < this.approvalPendingDelayMs) {
        continue;
      }
      // Re-check after age math — afterShell may have cleared mid-loop.
      const fresh = this.instances.get(instance.id);
      if (!fresh?.approvalPendingSince || fresh.state !== 'working') {
        continue;
      }
      this.setStatus({
        state: 'waiting',
        message: fresh.approvalPendingMessage || fresh.message || 'Pending approval',
        project: fresh.project || '',
        task: fresh.approvalPendingTask || fresh.task || '',
        conversationId: fresh.conversationId || null,
        event: 'approval-pending',
        source: 'bridge',
        workspaceRoot: fresh.workspaceRoot || null,
      });
      promoted += 1;
    }
    return promoted;
  }

  /**
   * Demote stuck red "needs approval" to yellow running. Cursor has no
   * "user clicked Run" hook; long auto-approved shells otherwise stay red.
   * @returns {number} demoted count
   */
  demoteStuckApprovals() {
    const now = this.now();
    let demoted = 0;
    for (const instance of [...this.instances.values()]) {
      if (instance.state !== 'waiting' || instance.event !== 'approval-pending') {
        continue;
      }
      const age = now - Date.parse(instance.updatedAt);
      if (!Number.isFinite(age) || age < this.approvalStuckRedMs) {
        continue;
      }
      this.setStatus({
        state: 'working',
        message: instance.message?.replace(/^Pending approval:\s*/i, 'Running: ') || 'Running',
        project: instance.project || '',
        task: instance.task || '',
        conversationId: instance.conversationId || null,
        event: 'approval-running',
        source: 'bridge',
        workspaceRoot: instance.workspaceRoot || null,
      });
      demoted += 1;
    }
    return demoted;
  }

  /**
   * Restore project cards after bridge restart (from disk / conversation context).
   * Does not rewrite history or bump sequence for each card.
   * @param {object[]} entries
   * @returns {object[]}
   */
  restoreInstances(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return this.getInstances();
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const workspaceRoot = entry.workspaceRoot || null;
      const project = entry.project || (workspaceRoot ? workspaceRoot.split(/[/\\]/).pop() : '');
      if (!workspaceRoot && !project) {
        continue;
      }

      const key =
        entry.id ||
        (entry.conversationId
          ? `conv:${entry.conversationId}`
          : workspaceRoot
            ? `ws:${workspaceRoot}`
            : `project:${project}`);
      const previous = this.instances.get(key);
      const tabIndex =
        Number(entry.tabIndex) ||
        Number(previous?.tabIndex) ||
        nextTabIndex(this.instances, workspaceRoot, project);

      this.instances.set(key, {
        id: key,
        project: project || previous?.project || 'Unknown project',
        workspaceRoot: workspaceRoot || previous?.workspaceRoot || null,
        state: entry.state || previous?.state || 'idle',
        message: entry.message || previous?.message || '',
        task: entry.task || previous?.task || '',
        tabName: entry.tabName || previous?.tabName || '',
        conversationId: entry.conversationId || previous?.conversationId || null,
        generationId: entry.generationId || previous?.generationId || null,
        source: entry.source || previous?.source || 'bridge',
        event: entry.event || previous?.event || 'restore',
        sequence: Number.isFinite(entry.sequence) ? entry.sequence : previous?.sequence || 0,
        updatedAt: entry.updatedAt || previous?.updatedAt || new Date(this.now()).toISOString(),
        startedAt: entry.startedAt || previous?.startedAt || null,
        shellInFlight: Boolean(entry.shellInFlight ?? previous?.shellInFlight),
        agentRunning: Boolean(entry.agentRunning ?? previous?.agentRunning),
        approvalPendingSince: entry.approvalPendingSince ?? previous?.approvalPendingSince ?? null,
        tabIndex,
      });
    }

    this.#pruneInstances();
    const instances = this.getInstances();
    // Notify UI without inventing a new "current" agent status.
    this.#notify(this.getCurrent(), false, instances);
    return instances;
  }

  /**
   * Drop project card(s) when a Cursor window/project is closed.
   * @param {{
   *   workspaceRoot?: string | null,
   *   conversationId?: string | null,
   *   project?: string,
   * }} filter
   * @returns {{ removed: number, instances: object[], status: object }}
   */
  removeInstance(filter = {}) {
    const workspaceRoot = filter.workspaceRoot || null;
    const conversationId = filter.conversationId || null;
    const project = filter.project || '';

    /** @type {string[]} */
    const removedKeys = [];
    for (const [key, instance] of this.instances) {
      const matchWorkspace = workspaceRoot && instance.workspaceRoot === workspaceRoot;
      const matchConversation = conversationId && instance.conversationId === conversationId;
      const matchProject =
        !workspaceRoot &&
        !conversationId &&
        project &&
        instance.project === project;
      if (matchWorkspace || matchConversation || matchProject) {
        removedKeys.push(key);
      }
    }

    for (const key of removedKeys) {
      this.instances.delete(key);
    }

    const instances = this.getInstances();

    if (removedKeys.length > 0) {
      const currentMatches =
        (workspaceRoot && this.current.workspaceRoot === workspaceRoot) ||
        (conversationId && this.current.conversationId === conversationId) ||
        (project && !workspaceRoot && !conversationId && this.current.project === project);

      if (currentMatches || instances.length === 0) {
        const newest = instances[0];
        if (newest) {
          this.current = this.#createStatus({
            state: newest.state,
            message: newest.message,
            project: newest.project,
            task: newest.task,
            conversationId: newest.conversationId,
            event: 'sessionEnd',
            source: 'cursor-hook',
            workspaceRoot: newest.workspaceRoot,
          });
        } else {
          this.current = this.#createStatus({
            state: 'idle',
            message: 'No open Cursor projects',
            project: '',
            task: '',
            conversationId: null,
            event: 'sessionEnd',
            source: 'bridge',
            workspaceRoot: null,
          });
        }
        this.history.unshift({ ...this.current });
        if (this.history.length > this.historyLimit) {
          this.history.length = this.historyLimit;
        }
      }

      this.#notify(this.getCurrent(), false, instances);
    }

    return {
      removed: removedKeys.length,
      instances,
      status: this.getCurrent(),
    };
  }

  /**
   * Reset to idle and clear tracked instances.
   * @param {{ message?: string, source?: string }} [options]
   */
  reset(options = {}) {
    this.instances.clear();
    return this.setStatus({
      state: 'idle',
      message: options.message ?? 'Reset to idle',
      project: '',
      task: '',
      conversationId: null,
      event: 'reset',
      source: options.source ?? 'bridge',
      workspaceRoot: null,
    });
  }

  /**
   * Force offline (bridge-owned; not available via HTTP POST validation).
   * @param {{ message?: string }} [options]
   */
  setOffline(options = {}) {
    return this.setStatus({
      state: 'offline',
      message: options.message ?? 'Bridge offline',
      project: this.current.project,
      task: this.current.task,
      conversationId: this.current.conversationId,
      event: 'offline',
      source: 'bridge',
      workspaceRoot: this.current.workspaceRoot,
    });
  }

  #createStatus(fields) {
    this.sequence += 1;
    return {
      state: fields.state,
      message: fields.message ?? '',
      project: fields.project ?? '',
      task: fields.task ?? '',
      tabName: fields.tabName ?? '',
      conversationId: fields.conversationId ?? null,
      generationId: fields.generationId ?? null,
      event: fields.event ?? null,
      source: fields.source ?? 'bridge',
      workspaceRoot: fields.workspaceRoot ?? null,
      sequence: this.sequence,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  #resolveInstanceKey(status) {
    // One card per Cursor chat tab. Match by conversation first so stop hooks
    // that omit workspace_roots still update the right tab.
    if (status.conversationId) {
      for (const [existingKey, instance] of this.instances) {
        if (instance.conversationId === status.conversationId) {
          return existingKey;
        }
      }
      return `conv:${status.conversationId}`;
    }

    // Hooks without conversationId: prefer the newest active tab in this workspace.
    if (status.workspaceRoot) {
      let bestKey = null;
      let bestTime = -1;
      for (const [key, instance] of this.instances) {
        if (instance.workspaceRoot !== status.workspaceRoot) {
          continue;
        }
        if (!ACTIVE_STATES.has(instance.state) && !instance.agentRunning) {
          continue;
        }
        const time = Date.parse(instance.updatedAt) || 0;
        if (time >= bestTime) {
          bestTime = time;
          bestKey = key;
        }
      }
      if (bestKey) {
        return bestKey;
      }

      const wsKey = `ws:${status.workspaceRoot}`;
      if (this.instances.has(wsKey)) {
        return wsKey;
      }
      for (const [existingKey, instance] of this.instances) {
        if (instance.workspaceRoot === status.workspaceRoot) {
          return existingKey;
        }
      }
      return wsKey;
    }

    if (status.project) {
      for (const [existingKey, instance] of this.instances) {
        if (
          instance.project === status.project &&
          (!status.workspaceRoot || instance.workspaceRoot === status.workspaceRoot)
        ) {
          return existingKey;
        }
      }
    }

    return instanceKey(status);
  }

  #upsertInstance(status) {
    // Bridge bootstrap / global reset noise should not create a fake Cursor window.
    if (status.source === 'bridge' && !status.project && !status.workspaceRoot) {
      return;
    }
    // Anonymous hooks (no workspace, project, or conversation) cannot be tied
    // to a Cursor window — never invent an "Unknown project" card for them.
    if (!status.project && !status.workspaceRoot && !status.conversationId) {
      return;
    }

    const key = this.#resolveInstanceKey(status);
    const previous = this.instances.get(key);
    const startedAt = resolveStartedAt(previous, status);

    const workspaceRoot = status.workspaceRoot || previous?.workspaceRoot || null;
    const project = status.project || previous?.project || 'Unknown project';
    let tabIndex = Number(previous?.tabIndex) || 0;
    if (!tabIndex) {
      tabIndex = nextTabIndex(this.instances, workspaceRoot, project);
    }

    let shellInFlight = Boolean(previous?.shellInFlight);
    if (isShellStartEvent(status)) {
      shellInFlight = true;
    } else if (isShellEndEvent(status)) {
      shellInFlight = false;
    }

    const agentRunning = resolveAgentRunning(previous, status);

    // Long shell/migrations: stay yellow working, never green, never "needs you".
    // Red waiting is only for a fresh approval pause — not while the command runs.
    let state = status.state;
    let message = status.message;
    if (shellInFlight && state === 'completed') {
      state = 'working';
    }
    // Never show green while Cursor's agent loop is still open (Stop visible).
    if (agentRunning && state === 'completed' && status.event !== 'stop') {
      state = 'working';
    }

    // Shell/MCP: only preToolUse arms the delayed red. beforeShell clears it and
    // sets shellInFlight (auto-approve / Run already clicked). Hold yellow during
    // the grace window; promotePendingApprovals() turns red only if still gated.
    let approvalPendingSince = previous?.approvalPendingSince || null;
    let approvalPendingMessage = previous?.approvalPendingMessage || null;
    let approvalPendingTask = previous?.approvalPendingTask || null;
    if (
      status.source === 'cursor-hook' &&
      isApprovalGateEvent(status) &&
      status.state === 'waiting' &&
      isPromotableApproval(status)
    ) {
      approvalPendingSince = status.updatedAt;
      approvalPendingMessage = status.message || 'Pending approval';
      approvalPendingTask = status.task || '';
      state = 'working';
    } else if (
      status.source === 'cursor-hook' &&
      status.event === 'preToolUse' &&
      status.state === 'waiting'
    ) {
      // Non-promotable waiting — stay yellow, never arm timer.
      state = 'working';
      approvalPendingSince = null;
      approvalPendingMessage = null;
      approvalPendingTask = null;
    } else if (isApprovalResolvedEvent(status)) {
      approvalPendingSince = null;
      approvalPendingMessage = null;
      approvalPendingTask = null;
    }

    // Thought noise must not wipe a blinking red approval or Ask lamp.
    if (shouldStickApprovalWaiting(previous, status)) {
      state = 'waiting';
      message = previous.message || message;
    } else if (shouldStickAskError(previous, status)) {
      state = 'error';
      message = previous.message || message;
    }

    this.instances.set(key, {
      id: key,
      project,
      workspaceRoot,
      state,
      message,
      task: status.task,
      // First non-empty title wins (matches Cursor keeping the original chat name).
      tabName: previous?.tabName || status.tabName || '',
      conversationId: status.conversationId || previous?.conversationId || null,
      generationId: status.generationId || previous?.generationId || null,
      source: status.source,
      event: status.event,
      sequence: status.sequence,
      updatedAt: status.updatedAt,
      startedAt,
      shellInFlight,
      agentRunning,
      approvalPendingSince,
      approvalPendingMessage,
      approvalPendingTask,
      tabIndex,
    });

    this.#pruneInstances();

    if (this.instances.size > this.instanceLimit) {
      const sorted = [...this.instances.entries()].sort(
        (a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt),
      );
      const removeCount = this.instances.size - this.instanceLimit;
      for (let i = 0; i < removeCount; i += 1) {
        this.instances.delete(sorted[i][0]);
      }
    }
  }

  #pruneInstances() {
    const now = this.now();
    for (const [key, instance] of this.instances) {
      const age = now - Date.parse(instance.updatedAt);
      const inactive =
        instance.state === 'idle' || instance.state === 'completed' || instance.state === 'offline';
      if (inactive && age > this.instanceIdleTtlMs) {
        this.instances.delete(key);
      }
    }
  }

  #isDuplicate(candidate) {
    const current = this.current;
    if (!current) {
      return false;
    }

    const same =
      current.state === candidate.state &&
      current.message === candidate.message &&
      current.project === candidate.project &&
      current.task === candidate.task &&
      current.conversationId === candidate.conversationId &&
      current.event === candidate.event &&
      current.source === candidate.source &&
      current.workspaceRoot === candidate.workspaceRoot;

    if (!same) {
      return false;
    }

    const previousMs = Date.parse(current.updatedAt);
    if (Number.isNaN(previousMs)) {
      return false;
    }

    return this.now() - previousMs < this.dedupeWindowMs;
  }

  #notify(status, deduped, instances) {
    for (const listener of this.subscribers) {
      try {
        listener({ ...status }, { deduped, instances });
      } catch (error) {
        console.error('[status-store] subscriber error:', error);
      }
    }
  }
}

export function createStatusStore(options) {
  return new StatusStore(options);
}
