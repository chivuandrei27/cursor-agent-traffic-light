/**
 * Local bridge configuration.
 *
 * Decisions:
 * - Bind only to 127.0.0.1 so the status API is never reachable from the LAN.
 * - Default port 3210 is unlikely to collide with common local services.
 * - Body size is capped at 64 KB to reject accidental huge payloads without
 *   needing a reverse proxy.
 */

export const HOST = '127.0.0.1';
export const PORT = 3210;
export const WS_PATH = '/ws';
export const MAX_BODY_BYTES = 64 * 1024;
export const HISTORY_LIMIT = 50;
export const DEDUPE_WINDOW_MS = 500;
export const INSTANCE_LIMIT = 20;
/** Drop idle/completed instances after this age; active ones stay longer. */
export const INSTANCE_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/**
 * If working gets no hook updates for this long, assume Cursor's
 * stop was missed and mark completed.
 * Only applies when agentRunning and shellInFlight are both false
 * (open loops / long shells skip the sweep). Keep this short so a
 * finished chat that never got `stop` does not sit yellow for minutes.
 */
export const INSTANCE_STALE_ACTIVE_MS = 90 * 1000;
/** How often the bridge sweeps for stale active instances. */
export const STALE_SWEEP_INTERVAL_MS = 15 * 1000;
/**
 * Shell/MCP `preToolUse` arms a yellow hold. If beforeShell / beforeMCP
 * (command starting) or another resolve event arrives within this window, stay
 * yellow. Only a genuine Run/Allow pause (no before/after shell hooks) turns red.
 */
export const APPROVAL_PENDING_DELAY_MS = 2500;
/** How often held approvals are checked for promotion to red. */
export const APPROVAL_PROMOTE_INTERVAL_MS = 1000;
/**
 * Safety valve: if a card has been red "needs approval" this long with no
 * resolve, assume the user clicked Run (or Cursor auto-ran) and go yellow.
 * Prevents multi-minute false NEEDS APPROVAL on long shells.
 */
export const APPROVAL_STUCK_RED_MS = 15_000;
export const VERSION = '0.1.0';

export const HTTP_STATES = Object.freeze(['idle', 'working', 'waiting', 'completed', 'error']);

export const ALL_STATES = Object.freeze(['offline', ...HTTP_STATES]);

export const LIMITS = Object.freeze({
  message: 500,
  project: 200,
  task: 300,
  tabName: 80,
  workspaceRoot: 500,
});
