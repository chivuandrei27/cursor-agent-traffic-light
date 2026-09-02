# Installation

## End users (recommended)

### Requirements

- Chrome 116+
- Cursor Desktop
- macOS, Windows, or Linux
- Node **not required** on the machine: setup installs a private Node 22 when needed

### One-command setup (Node 18+ already installed)

```bash
npx cursor-agent-traffic-light setup
```

Or from a git clone:

```bash
npm install
npm run setup
```

### Bootstrap without usable Node

macOS / Linux:

```bash
bash scripts/install.sh
```

Windows:

```powershell
.\scripts\install.ps1
```

These download Node **22.18.0** into `~/.cursor-agent-traffic-light/runtime/` only for this app.

### After setup

1. Install the Chrome extension (Web Store link from setup output, or Load unpacked → `extension/`)
2. Restart Cursor completely
3. Confirm the extension shows **Connected**

### Uninstall

```bash
npx cursor-agent-traffic-light uninstall
# or: npm run uninstall
```

Removes user hooks, autostart, private runtime, and synced app files. Does **not** touch system Node. Remove the extension from `chrome://extensions`.

## Node policy

| System Node       | Behavior                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| Missing or `< 18` | Install private Node 22 under `~/.cursor-agent-traffic-light/runtime/` |
| `>= 18`           | Use system Node (unless `--private-node`)                              |
| Any               | System Node / PATH never modified                                      |

Pinned private version: **22.18.0**. Minimum system Node for `npx setup`: **18** (uses `fetch`).

## Setup flags

```bash
npm run setup -- --dry-run
npm run setup -- --private-node
npm run setup -- --skip-autostart
npm run setup -- --skip-hooks
```

## Developer / advanced

### Bridge only

```bash
npm start
curl http://127.0.0.1:3210/health
```

Debug UI: [http://127.0.0.1:3210/debug](http://127.0.0.1:3210/debug)

### Hooks only

```bash
npm run install:hooks              # default: --user-only
npm run install:hooks -- --project-only
npm run uninstall:hooks
```

### Autostart only

```bash
npm run install:autostart -- --dry-run
npm run install:autostart
npm run status:autostart
npm run uninstall:autostart
```

### MCP (optional)

```bash
npm run install:mcp
npm run uninstall:mcp
```

## Chrome extension (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension` folder
4. Pin the extension / open the side panel

## Paths

| Path                                         | Purpose                        |
| -------------------------------------------- | ------------------------------ |
| `~/.cursor-agent-traffic-light/runtime/`     | Private Node 22                |
| `~/.cursor-agent-traffic-light/app/`         | Synced app copy (npx installs) |
| `~/.cursor-agent-traffic-light/install.json` | Last setup state               |
| `~/.cursor/hooks.json`                       | User-level Cursor hooks        |
