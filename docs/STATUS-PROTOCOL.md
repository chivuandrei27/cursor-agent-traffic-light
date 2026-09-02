# Status protocol

## States

| State       | Meaning                            | HTTP submit | Color  |
| ----------- | ---------------------------------- | ----------- | ------ |
| `offline`   | Bridge or client connectivity lost | No          | grey   |
| `idle`      | Ready, no active agent work        | Yes         | slate  |
| `working`   | Agent is actively working          | Yes         | yellow |
| `waiting`   | Blocked on user, tool, or approval | Yes         | orange |
| `completed` | Latest unit of work finished       | Yes         | green  |
| `error`     | Failure needing attention          | Yes         | red    |

## Status object

```json
{
  "state": "working",
  "message": "Agent is implementing the feature",
  "project": "ulise",
  "task": "Implement authentication",
  "conversationId": null,
  "event": "beforeSubmitPrompt",
  "source": "cursor-hook",
  "sequence": 12,
  "updatedAt": "2026-07-31T12:00:00.000Z"
}
```

Fields set or overwritten by the bridge:

- `sequence` — monotonic integer, increments on every accepted change
- `updatedAt` — ISO-8601 timestamp generated server-side

## HTTP API

Base URL: `http://127.0.0.1:3210`

### GET /health

Liveness and summary.

### GET /api/status

Current status object.

### GET /api/history

```json
{ "history": [/* newest first, max 50 */] }
```

### POST /api/status

Body: JSON object. Unknown fields ignored.

Validation:

- body ≤ 64 KB
- valid JSON object
- `state` one of idle|working|waiting|completed|error
- `message` ≤ 500 chars
- `project` ≤ 200 chars
- `task` ≤ 300 chars
- strings sanitized (trim, strip control chars)

Success:

```json
{
  "ok": true,
  "deduped": false,
  "status": {}
}
```

### POST /api/reset

Sets status to idle with `event: "reset"`.

## WebSocket

URL: `ws://127.0.0.1:3210/ws`

On connect, the server immediately sends:

```json
{
  "type": "status",
  "payload": {}
}
```

Heartbeat:

Client → server

```json
{ "type": "ping", "timestamp": "..." }
```

Server → client

```json
{ "type": "pong", "timestamp": "..." }
```

Status broadcast uses the same `type: "status"` envelope after every accepted change.

## Sources

Common `source` values:

- `cursor-hook`
- `manual-cli`
- `debug-ui`
- `manual`
- `bridge`
- `http-reset`
