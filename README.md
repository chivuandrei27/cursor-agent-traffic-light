# Cursor Agent Traffic Light

Local traffic-light indicator for the Cursor AI agent.

```
Cursor Hooks  →  local bridge (127.0.0.1:3210)  →  Chrome extension
```

## Install (users)

You need **Chrome** and **Cursor Desktop**. Node is installed automatically for this app when missing or too old (private Node 22 — does not change your system Node).

### Option A — already have Node 18+

```bash
npx cursor-agent-traffic-light setup
```

### Option B — no Node / Node older than 18

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/<org>/cursor-agent-traffic-light/main/scripts/install.sh | bash

# or from a clone:
bash scripts/install.sh
```

Windows (PowerShell), from a clone:

```powershell
.\scripts\install.ps1
```

### Then

1. Install the **Chrome extension** (Chrome Web Store when published, or Load unpacked from `extension/`)
2. **Restart Cursor** once

Uninstall:

```bash
npx cursor-agent-traffic-light uninstall
```

## What setup does

1. Uses system Node if `>=18`, otherwise installs **private Node 22** under `~/.cursor-agent-traffic-light/runtime/`
2. Installs **user-level Cursor hooks** (`~/.cursor/hooks.json`) for every project
3. Enables **bridge autostart** and verifies `http://127.0.0.1:3210/health`
4. Prints Chrome extension next steps

## Local development

```bash
cd cursor-agent-traffic-light
npm install
npm run setup          # or: npm start + npm run install:hooks
npm test
```

```bash
npm start              # bridge only
npm run dev            # watch mode
npm run setup -- --dry-run
```

Debug UI: [http://127.0.0.1:3210/debug](http://127.0.0.1:3210/debug)

## Manual status / MCP (optional)

```bash
npm run status:working -- "Implementing authentication"
npm run install:mcp
```

## Security

- Bridge binds only to `127.0.0.1`
- Private Node runtime never modifies your global Node / PATH
- Hooks and extension talk only to localhost

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Installation](docs/INSTALLATION.md)
- [Status protocol](docs/STATUS-PROTOCOL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
