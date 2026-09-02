# Architecture

## Overview

Cursor Agent Traffic Light is a local-only stack:

```
Cursor Desktop Hooks
      |
      v
Local Node.js HTTP bridge (127.0.0.1:3210)
      |
      +--> WebSocket broadcast (/ws)
      |
      +--> Chrome MV3 extension (toolbar indicator)
      |
      +--> Debug page (/debug)
```

Nothing is exposed outside loopback. There is no database, no cloud service, and no Docker dependency.

## Distribution

End users install via:

1. **npm package** — `npx cursor-agent-traffic-light setup` (or `scripts/install.sh` when Node is missing)
2. **Chrome extension** — Web Store or Load unpacked

Setup may install a **private Node 22** under `~/.cursor-agent-traffic-light/runtime/` without changing system Node. Hooks default to **user-level** so every Cursor window reports status. The bridge is kept alive with OS autostart.

## Components

### Bridge (`bridge/`)

Node 18+ ESM process (private runtime pins 22) that:

- accepts validated status updates over HTTP
- keeps the latest status and a rolling history of 50 events in memory
- broadcasts updates to WebSocket subscribers
- serves the debug console static assets

Key modules:

- `server.mjs` — process entry, listen/bind, graceful shutdown
- `app.mjs` — HTTP routing and body parsing
- `status-validator.mjs` — payload validation and sanitization
- `status-store.mjs` — in-memory state, sequence, history, dedupe
- `websocket-manager.mjs` — client fan-out, ping/pong
- `config.mjs` — host, port, limits

### Scripts (`scripts/`)

- `send-status.mjs` — manual CLI and npm `status:*` helpers
- `cursor-hook.mjs` — maps Cursor hook events to status POSTs
- `install-hooks.mjs` / `uninstall-hooks.mjs` — project hook installers

### Extension (`extension/`)

Manifest V3 Chrome extension with a module service worker, popup, and options page. It keeps one WebSocket to the bridge, updates the toolbar badge, and shows notifications on waiting/completed/error transitions.

### MCP (`mcp/`)

Optional stdio MCP server exposing `report_cursor_status` so the agent can report waiting/verified completion explicitly. Hooks remain the automatic fallback.

### Debug console (`bridge/public/`)

Local dark-mode dashboard for exercising every status without Cursor or Chrome.

## Engineering decisions

1. **Loopback only.** Binding `127.0.0.1` prevents LAN exposure of agent context.
2. **No Express.** Built-in `node:http` plus `ws` keeps the dependency surface tiny.
3. **Server-owned timestamps and sequence.** Clients may suggest content fields; the store assigns `sequence` and `updatedAt`.
4. **HTTP cannot set `offline`.** Offline is a bridge/extension connectivity concept, not a user-submitted agent state.
5. **500ms exact-dedupe.** Hooks and UIs can double-fire; identical payloads inside the window are ignored.
6. **In-memory only.** Status is ephemeral by design. Restarting the bridge returns to idle.
7. **Random free port in tests.** Integration tests call `startBridge({ port: 0 })` so they never fight a running dev server.

## Data flow

1. Cursor hook (or CLI / debug UI) POSTs JSON to `/api/status`.
2. Validator sanitizes and rejects invalid input with structured errors.
3. Status store increments sequence, records history, notifies subscribers.
4. WebSocket manager broadcasts `{ type: "status", payload }`.
5. Extension / debug page render the traffic-light state.
