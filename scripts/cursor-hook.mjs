#!/usr/bin/env node

/**
 * Non-blocking Cursor Desktop hook.
 *
 * Usage:
 *   node scripts/cursor-hook.mjs <eventName> <state>
 *   ... JSON payload on stdin ...
 *
 * Always exits 0. Never writes diagnostic logs to stdout.
 * Set CURSOR_TRAFFIC_LIGHT_DEBUG=1 for stderr diagnostics.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { enqueueRemoveRequest } from '../bridge/remove-spool.mjs';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3210';
/** Cursor kills hooks around 750ms — stay well under that budget. */
const REQUEST_TIMEOUT_MS = 450;
const TASK_MAX = 120;
const TAB_NAME_MAX = 80;
const DEBUG = process.env.CURSOR_TRAFFIC_LIGHT_DEBUG === '1';
const CONTEXT_DIR = join(homedir(), '.cursor-agent-traffic-light');
const CONTEXT_PATH = join(CONTEXT_DIR, 'conversation-context.json');

const ALLOWED_STATES = new Set(['idle', 'working', 'waiting', 'completed', 'error']);

const EVENT_STATE_MAP = Object.freeze({
  sessionStart: 'idle',
  beforeSubmitPrompt: 'working',
  afterAgentThought: 'working',
  preToolUse: 'working',
  postToolUse: 'working',
  // Tool failures are normal agent progress — never user-facing "error".
  postToolUseFailure: 'working',
  // beforeShell/beforeMCP = Cursor is executing (or about to); stay yellow.
  beforeShellExecution: 'working',
  afterShellExecution: 'working',
  beforeMCPExecution: 'working',
  afterMCPExecution: 'working',
  // Response chunks are mid-loop — Cursor still shows Stop until `stop`.
  afterAgentResponse: 'working',
  // Authoritative end of the agent loop (Stop button goes away).
  stop: 'completed',
  sessionEnd: 'idle',
});

/** sessionEnd reasons that mean the Cursor window/project went away. */
const CLOSE_REASONS = new Set(['window_close', 'user_close']);
const CLOSE_REASON_RE = /close|closed|quit|exit|unload/i;

/** Tools that pause the agent until the user answers (Cursor Ask / questions UI). */
const ASK_TOOL_RE = /^(ask|askquestion|ask_question|askuser|ask_user|userquestion)/i;

/**
 * Tools that can show Cursor's Run/Allow UI at `preToolUse`. Auto-approved
 * shells emit `beforeShell`/`beforeMCP` quickly and clear the hold. Write/Edit
 * are excluded — silent for seconds and look like "pending" if timed.
 */
const APPROVAL_TOOL_RE = /^(shell|bash)$/i;
const MCP_TOOL_RE = /^mcp[:_]/i;

function debug(...args) {
  if (!DEBUG) {
    return;
  }
  console.error('[cursor-hook]', ...args);
}

async function debugLogFile(line) {
  if (!DEBUG) {
    return;
  }
  try {
    const logDir = join(CONTEXT_DIR, 'logs');
    await mkdir(logDir, { recursive: true });
    await appendFile(join(logDir, 'hooks-debug.log'), `${line}\n`, 'utf8');
  } catch {
    // ignore logging failures
  }
}

function sanitizeText(value, max = Infinity) {
  if (value === null || value === undefined) {
    return '';
  }
  const cleaned = String(value)
    .replace(/[\s\S]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
        return '';
      }
      return ch;
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (!Number.isFinite(max) || cleaned.length <= max) {
    return cleaned;
  }
  return `${cleaned.slice(0, max - 1)}…`;
}

function workspaceRootFromPayload(payload) {
  if (typeof payload.workspace_root === 'string' && payload.workspace_root.trim()) {
    return sanitizeText(payload.workspace_root, 500);
  }
  if (Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) {
    return sanitizeText(payload.workspace_roots[0], 500);
  }
  if (typeof payload.workspaceRoot === 'string' && payload.workspaceRoot.trim()) {
    return sanitizeText(payload.workspaceRoot, 500);
  }
  return '';
}

function projectNameFromPath(rootPath) {
  const parts = String(rootPath).split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  const last = parts[parts.length - 1];
  if (parts.length >= 2 && /^(src|app|apps|packages|repo)$/i.test(last)) {
    return sanitizeText(`${parts[parts.length - 2]}/${last}`, 200);
  }
  return sanitizeText(last, 200);
}

function projectFromPayload(payload) {
  if (payload.project) {
    return sanitizeText(payload.project, 200);
  }
  const root = workspaceRootFromPayload(payload);
  if (root) {
    return projectNameFromPath(root);
  }
  return '';
}

function taskFromPayload(payload, eventName, state) {
  if (payload.task) {
    return sanitizeText(payload.task, TASK_MAX);
  }
  if (payload.tool_name) {
    return sanitizeText(`tool:${payload.tool_name}`, TASK_MAX);
  }
  if (payload.command) {
    return sanitizeText(`cmd:${payload.command}`, TASK_MAX);
  }
  if (payload.error) {
    return sanitizeText(payload.error, TASK_MAX);
  }
  if (payload.prompt) {
    return sanitizeText(payload.prompt, TASK_MAX);
  }
  return sanitizeText(`${eventName} → ${state}`, TASK_MAX);
}

/**
 * Prefer a substantive prompt line over wrappers like "Context" / timestamps.
 * @param {string} text
 */
function preferredPromptLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<\/?timestamp>.*$/i.test(line))
    .filter((line) => !/^<\/?user_query>$/i.test(line));

  const skipAlone = /^(context|important|note|notes|background|summary)$/i;
  const substantive = lines.find((line) => !skipAlone.test(line) && line.length >= 8);
  return substantive || lines[0] || '';
}

/**
 * Derive Cursor-style tab title from an agent transcript (jsonl).
 * Used when mid-loop hooks never saw beforeSubmitPrompt (empty tabName → "Tab N").
 * @param {string} text
 */
export function tabNameFromTranscriptText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.role !== 'user') {
      continue;
    }

    let raw = '';
    const content = entry.message?.content ?? entry.content;
    if (typeof content === 'string') {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part && typeof part === 'object' && part.type === 'text') {
            return part.text || '';
          }
          return '';
        })
        .join('\n');
    } else if (typeof entry.message === 'string') {
      raw = entry.message;
    }

    const queryMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    if (queryMatch) {
      raw = queryMatch[1];
    }

    const name = preferredPromptLine(raw);
    if (name) {
      return sanitizeText(name, TAB_NAME_MAX);
    }
  }

  return '';
}

/**
 * Chat tab label like Cursor's composer title: first user prompt, or an
 * explicit title field when Cursor sends one.
 */
export function tabNameFromPayload(payload, eventName) {
  const explicit =
    payload.tabName ||
    payload.chat_title ||
    payload.chatTitle ||
    payload.composer_title ||
    payload.composerTitle ||
    payload.title;
  if (explicit) {
    return sanitizeText(String(explicit).split('\n')[0], TAB_NAME_MAX);
  }
  if (payload.prompt) {
    const fromPrompt = preferredPromptLine(payload.prompt);
    if (fromPrompt) {
      return sanitizeText(fromPrompt, TAB_NAME_MAX);
    }
  }
  return '';
}

/**
 * Read Cursor transcript_path and derive a tab title when hooks never saw the prompt.
 * @param {object} payload
 */
export async function resolveTabNameFromTranscript(payload = {}) {
  const transcriptPath = payload.transcript_path || payload.transcriptPath;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return '';
  }
  try {
    const text = await readFile(transcriptPath, 'utf8');
    return tabNameFromTranscriptText(text.slice(0, 64_000));
  } catch {
    return '';
  }
}

function messageFromPayload(payload, eventName, state) {
  if (state === 'waiting') {
    const tool = payload.tool_name || payload.command;
    if (tool) {
      return sanitizeText(`Pending approval: ${tool}`, 500);
    }
    return 'Pending approval';
  }
  if (state === 'error') {
    return sanitizeText(payload.message || 'Agent has questions', 500);
  }
  if (payload.message) {
    return sanitizeText(payload.message, 500);
  }
  if (
    (eventName === 'beforeShellExecution' || eventName === 'beforeMCPExecution') &&
    (payload.command || payload.tool_name)
  ) {
    return sanitizeText(`Running: ${payload.command || payload.tool_name}`, 500);
  }
  if (payload.tool_name) {
    return sanitizeText(`${eventName}: ${payload.tool_name}`, 500);
  }
  if (payload.model) {
    return sanitizeText(`${state} (${payload.model})`, 500);
  }
  if (eventName === 'stop' && payload.status) {
    return sanitizeText(`Cursor stop (${payload.status})`, 500);
  }
  return sanitizeText(`Cursor ${eventName}`, 500);
}

function conversationIdFromPayload(payload) {
  const value =
    payload.conversationId ??
    payload.conversation_id ??
    payload.conversationID ??
    payload.session_id ??
    payload.sessionId ??
    null;
  return value ? sanitizeText(value, 200) : null;
}

function generationIdFromPayload(payload) {
  const value = payload.generation_id ?? payload.generationId ?? null;
  return value ? sanitizeText(value, 200) : null;
}

/**
 * True when sessionEnd means the Cursor window/project closed (not chat end).
 * @param {object} payload
 */
export function isProjectCloseSessionEnd(payload = {}) {
  const reason = sanitizeText(payload.reason || payload.final_status || '').toLowerCase();
  if (!reason) {
    return false;
  }
  if (CLOSE_REASONS.has(reason)) {
    return true;
  }
  // Be tolerant of Cursor wording differences across builds.
  if (reason === 'completed' || reason === 'aborted' || reason === 'error') {
    return false;
  }
  return CLOSE_REASON_RE.test(reason);
}

/**
 * `error` on the traffic light means "AI has questions for you", not a failure.
 */
export function isAskTool(toolName) {
  return ASK_TOOL_RE.test(String(toolName || ''));
}

/**
 * Tools that typically show Cursor's pending-approval UI (Shell / MCP only).
 * @param {unknown} toolName
 */
export function isApprovalTool(toolName) {
  const name = String(toolName || '').trim();
  if (!name) {
    return false;
  }
  return APPROVAL_TOOL_RE.test(name) || MCP_TOOL_RE.test(name);
}

/**
 * Resolve traffic-light state from hook event + Cursor payload.
 * Red only when execution is blocked on the user:
 * `error` = pending Ask/question tool; `waiting` = pending approval.
 * A finished turn (`stop`) is always green/idle — chat questions in the
 * final reply do not block execution.
 */
export function resolveHookState(eventName, stateArg, payload = {}) {
  // Tool failures must never light the red "questions" state.
  if (eventName === 'postToolUseFailure') {
    return 'working';
  }

  if (
    eventName === 'beforeShellExecution' ||
    eventName === 'afterShellExecution' ||
    eventName === 'beforeMCPExecution' ||
    eventName === 'afterMCPExecution'
  ) {
    // before* = command starting (auto-approve or user already clicked Run).
    // after* = finished. Neither is "needs approval" — that is preToolUse only.
    return 'working';
  }

  // Ask-style tool pending = flow blocked until the user answers → red.
  if (eventName === 'preToolUse' && isAskTool(payload.tool_name)) {
    return 'error';
  }
  // Question answered — the loop is moving again.
  if (eventName === 'postToolUse' && isAskTool(payload.tool_name)) {
    return 'working';
  }

  // Shell/MCP may show Cursor's Run/Allow UI. Write/Edit never go red here —
  // auto-approved writes are silent for seconds and look like "pending".
  // Bridge holds Shell/MCP yellow briefly; red only if still unresolved.
  if (eventName === 'preToolUse' && isApprovalTool(payload.tool_name)) {
    return 'waiting';
  }

  if (eventName === 'stop') {
    // Turn ended — nothing is blocked on the user anymore. Questions in the
    // final chat reply do not block execution, so they must not stay red.
    const stopStatus = sanitizeText(payload.status || '').toLowerCase();
    return stopStatus === 'aborted' ? 'idle' : 'completed';
  }

  if (eventName === 'afterAgentResponse') {
    // Still inside the agent loop while Stop is visible — only `stop` ends it.
    return 'working';
  }

  const mapped = EVENT_STATE_MAP[eventName] || null;
  // Prefer the event map over argv so old hooks.json (`… postToolUseFailure error`)
  // cannot force a false red light.
  let state = mapped || (ALLOWED_STATES.has(stateArg) ? stateArg : 'working');
  if (!ALLOWED_STATES.has(state)) {
    state = 'working';
  }
  return state;
}

async function loadConversationContext() {
  try {
    const raw = await readFile(CONTEXT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // missing / invalid
  }
  return {};
}

async function saveConversationContext(context) {
  try {
    await mkdir(CONTEXT_DIR, { recursive: true });
    await writeFile(CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`, 'utf8');
  } catch (error) {
    debug('context save failed', error?.message || error);
  }
}

/**
 * Remember workspace/project per conversation so stop/afterAgentResponse
 * still update the same project card when Cursor omits workspace_roots.
 */
export async function applyConversationContext(status, payload = {}) {
  const conversationId = status.conversationId;
  if (!conversationId) {
    return status;
  }

  const context = await loadConversationContext();
  const previous = context[conversationId] || {};

  let workspaceRoot = status.workspaceRoot || previous.workspaceRoot || null;
  let project = status.project || previous.project || '';
  // Keep the first Cursor-style title; later prompts must not rename the tab.
  let tabName = previous.tabName || status.tabName || '';

  // Mid-loop hooks often omit the prompt — backfill Cursor's tab title from transcript.
  if (!tabName) {
    tabName = await resolveTabNameFromTranscript(payload);
  }

  if (workspaceRoot && !project) {
    project = projectNameFromPath(workspaceRoot);
  }

  const changed =
    workspaceRoot !== (previous.workspaceRoot || null) ||
    project !== (previous.project || '') ||
    tabName !== (previous.tabName || '');

  // Skip disk write when stop/afterAgentResponse only reuses known context —
  // Cursor's hook timeout is tight and this I/O was a common miss.
  if (changed) {
    context[conversationId] = {
      workspaceRoot,
      project,
      tabName,
      updatedAt: new Date().toISOString(),
    };

    const entries = Object.entries(context).sort((a, b) => {
      const aTime = Date.parse(a[1]?.updatedAt || 0);
      const bTime = Date.parse(b[1]?.updatedAt || 0);
      return bTime - aTime;
    });
    const trimmed = Object.fromEntries(entries.slice(0, 100));
    await saveConversationContext(trimmed);
  }

  return {
    ...status,
    workspaceRoot,
    project,
    tabName,
  };
}

/**
 * Drop conversation-context entries for a closed workspace so it cannot
 * be re-seeded after restart.
 * @param {{ workspaceRoot?: string | null, conversationId?: string | null }} filter
 */
export async function purgeConversationContext(filter = {}) {
  const context = await loadConversationContext();
  let changed = false;
  for (const [id, entry] of Object.entries(context)) {
    const matchConv = filter.conversationId && id === filter.conversationId;
    const matchWs =
      filter.workspaceRoot && entry?.workspaceRoot === filter.workspaceRoot;
    if (matchConv || matchWs) {
      delete context[id];
      changed = true;
    }
  }
  if (changed) {
    await saveConversationContext(context);
  }
}

/**
 * Build bridge status from hook args + payload.
 */
export function buildHookStatus(eventName, stateArg, payload) {
  const state = resolveHookState(eventName, stateArg, payload);
  const conversationId = conversationIdFromPayload(payload);
  const generationId = generationIdFromPayload(payload);
  const workspaceRoot = workspaceRootFromPayload(payload) || null;

  return {
    state,
    message: messageFromPayload(payload, eventName, state),
    project: projectFromPayload(payload),
    task: taskFromPayload(payload, eventName, state),
    tabName: tabNameFromPayload(payload, eventName),
    conversationId,
    generationId,
    event: sanitizeText(payload.hook_event_name || eventName, 100) || eventName,
    source: 'cursor-hook',
    workspaceRoot,
  };
}

/**
 * Cursor-facing stdout response. Observational hooks get {}.
 * Do NOT force permission:allow — Cursor may still show Run/Allow after the
 * hook returns, and forcing allow does not skip that UI reliably.
 * Returning {} leaves Cursor's own approval mode in charge.
 */
export function cursorStdoutResponse(eventName) {
  return {};
}

async function readStdinSafe() {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
  } catch (error) {
    debug('stdin read failed', error?.message || error);
    return '';
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parsePayload(raw) {
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Drop bulky fields we never send to the bridge.
      delete value.text;
      delete value.thinking;
      delete value.content;
      delete value.output;
      delete value.tool_input;
      delete value.tool_output;
      return value;
    }
  } catch (error) {
    debug('malformed stdin ignored', error?.message || error);
  }
  return {};
}

async function postRemoveInstance(filter, bridgeUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/api/instances/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
      signal: controller.signal,
    });
    if (!response.ok) {
      debug('bridge remove rejected', response.status);
      return null;
    }
    return response.json().catch(() => null);
  } catch (error) {
    debug('bridge remove unavailable', error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postStatus(status, bridgeUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(status),
      signal: controller.signal,
    });
    if (!response.ok) {
      debug('bridge rejected', response.status);
      return null;
    }
    return response.json().catch(() => null);
  } catch (error) {
    debug('bridge unavailable', error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const eventName = process.argv[2] || 'unknown';
  const stateArg = process.argv[3] || EVENT_STATE_MAP[eventName] || 'working';
  const raw = await readStdinSafe();
  const payload = parsePayload(raw);
  const bridgeUrl = process.env.BRIDGE_URL || DEFAULT_BRIDGE_URL;

  // Answer Cursor first so the agent/window is never blocked on the bridge.
  process.stdout.write(`${JSON.stringify(cursorStdoutResponse(eventName))}\n`);

  // Chat-level sessionEnd (completed/aborted/error) must not wipe green or cards.
  // Only window/project close removes the card.
  if (eventName === 'sessionEnd') {
    // Always keep a tiny audit trail — window-close hooks are easy to miss.
    try {
      await mkdir(join(CONTEXT_DIR, 'logs'), { recursive: true });
      await appendFile(
        join(CONTEXT_DIR, 'logs', 'session-end.log'),
        `${new Date().toISOString()} reason=${payload.reason || ''} final=${payload.final_status || ''} keys=${Object.keys(payload).join(',')}\n`,
        'utf8',
      );
    } catch {
      // ignore
    }

    if (!isProjectCloseSessionEnd(payload)) {
      debug('sessionEnd ignored (not a project close)', payload.reason);
      return;
    }

    let status = buildHookStatus(eventName, stateArg, payload);
    status = await applyConversationContext(status, payload);

    const filter = {
      workspaceRoot: status.workspaceRoot,
      conversationId: status.conversationId,
      project: status.project,
      reason: sanitizeText(payload.reason || payload.final_status || '', 80),
    };

    // Durable first: Cursor often kills this process while the window closes.
    try {
      await enqueueRemoveRequest(filter);
    } catch (error) {
      debug('spool enqueue failed', error?.message || error);
    }

    await purgeConversationContext({
      workspaceRoot: status.workspaceRoot,
      conversationId: status.conversationId,
    });

    if (DEBUG) {
      debug('removing project', filter);
    }

    // Best-effort immediate HTTP remove (may not finish on window close).
    await postRemoveInstance(filter, bridgeUrl);
    return;
  }

  let status = buildHookStatus(eventName, stateArg, payload);
  status = await applyConversationContext(status, payload);

  if (DEBUG) {
    try {
      await mkdir(join(CONTEXT_DIR, 'logs'), { recursive: true });
    } catch {
      // ignore
    }
    await debugLogFile(
      `${new Date().toISOString()} event=${eventName} state=${status.state} project=${status.project} ws=${status.workspaceRoot || ''}`,
    );
    debug('sending', status);
  }

  await postStatus(status, bridgeUrl);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    debug('fatal', error?.message || error);
    try {
      process.stdout.write('{}\n');
    } catch {
      // ignore
    }
    process.exit(0);
  }
}
