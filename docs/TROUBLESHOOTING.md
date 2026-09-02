# Troubleshooting

## Bridge will not start

`EADDRINUSE` on 3210 means another process owns the port. Stop it or check `npm run status:autostart`.

## Extension stays offline / badge is X

1. Confirm `curl http://127.0.0.1:3210/health` works.
2. Open the service worker console and look for `[traffic-light]` connect errors.
3. Click **Reconnect** in the popup.
4. Confirm options still point at `ws://127.0.0.1:3210/ws`.

## No notifications

Notifications fire only on transitions into waiting, completed, or error. They are suppressed on install/startup and when disabled in settings. Duplicates are ignored.

## Hooks do nothing

1. Re-run `npm run install:hooks -- --project-only`
2. Restart Cursor completely
3. Check **Settings → Hooks → Execution Log**
4. Bridge must be running; hooks fail open if it is not
5. Unsupported event names for your Cursor build are ignored by Cursor

## Hook seems slow or blocks Cursor

Hooks use a 750ms timeout and always exit 0. If Cursor still complains, inspect Execution Log and ensure stdout is only JSON (enable `CURSOR_TRAFFIC_LIGHT_DEBUG=1` for stderr diagnostics only).

## MCP tool missing

1. `npm run install:mcp`
2. Restart Cursor
3. Confirm `.cursor/mcp.json` contains `cursor-agent-traffic-light`
4. Run `npm run mcp` manually to see stdio server startup errors on stderr

## Autostart installed but health fails / extension stays disconnected

```bash
npm run status:autostart
```

Check the log directory printed by that command. On macOS, `launchctl list com.cursor-agent-traffic-light.bridge` should show the job. On Linux, `systemctl --user status cursor-agent-traffic-light.service`.

If logs show `EPERM` opening files under `~/Documents`, macOS blocked the LaunchAgent. Re-run `npm run install:autostart` — it syncs the app into `~/.cursor-agent-traffic-light/app` and points launchd there. Then click **Reconnect** in the extension.

Quick recovery without autostart: `npm start` in the project folder (keep that terminal open).

## Duplicate completion notifications

Bridge dedupes identical payloads within 500ms. Final green comes only from the `stop` hook (when Cursor's Stop button goes away). `afterAgentResponse` is mid-loop and stays `working`. Hooks must be installed for every project you care about — prefer `npm run install:hooks -- --user-only` so all Cursor windows report status, not only this repo.

If a project card stays yellow after the agent finishes: restart Cursor after installing user hooks, keep the bridge running, then check **Settings → Hooks → Execution Log** for `stop`. The bridge will not auto-complete while it believes the agent loop is still running (`agentRunning`). Late `afterAgentThought` hooks after `stop` are ignored so they cannot reopen a finished turn.

Red blink means the flow is **blocked on you** (the agent cannot continue until you act):
- **Needs you** (`error`): a pending Ask/question tool — the loop is paused until you answer.
- **Needs approval** (`waiting`): Shell/MCP `preToolUse` while Cursor's Run/Allow UI is up and no `beforeShell`/`beforeMCP` arrives within ~2.5s. `beforeShell` means the command is starting (auto-approve or Run clicked) — yellow, not red. `afterAgentThought` does not cancel a real hold. Read/Write/other tools clear a stuck red lamp. If red lasts >15s with no resolve, the bridge demotes to yellow (long shell safety). Write/Edit never go red on their own.

If two chats/tabs are open in the same project, each gets its own card. The subtitle is the chat name (from the first prompt), falling back to `Tab 1`, `Tab 2`, … when no prompt was captured yet. A finished tab no longer flips the still-running tab to green.

## CLI cannot reach bridge

```bash
node scripts/send-status.mjs working "test"
```

Exits 1 with a short error when the bridge is down. Override URL with `BRIDGE_URL`.
