import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

export const APP_ID = 'com.cursor-agent-traffic-light.bridge';
export const APP_NAME = 'cursor-agent-traffic-light';

export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

export function detectOs() {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  return p;
}

export function logDir() {
  const home = homedir();
  const os = detectOs();
  if (os === 'macos') {
    return join(home, 'Library', 'Logs', APP_NAME);
  }
  if (os === 'windows') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP_NAME, 'logs');
  }
  return join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), APP_NAME, 'logs');
}

export function launchAgentPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${APP_ID}.plist`);
}

export function windowsStartupDir() {
  return join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}

export function windowsLauncherPath() {
  return join(windowsStartupDir(), `${APP_NAME}.cmd`);
}

export function linuxUnitPath() {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'systemd',
    'user',
    `${APP_NAME}.service`,
  );
}

export function bridgeCommand(root = repoRoot(), nodePath = process.execPath) {
  return {
    node: nodePath,
    script: join(root, 'bridge', 'server.mjs'),
    cwd: root,
  };
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function macosPlist({ node, script, cwd, stdoutLog, stderrLog }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(APP_ID)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>
</dict>
</plist>
`;
}

export function windowsCmd({ node, script, cwd, stdoutLog, stderrLog }) {
  return `@echo off\r
cd /d "${cwd}"\r
start "" /b "${node}" "${script}" >> "${stdoutLog}" 2>> "${stderrLog}"\r
`;
}

export function linuxUnit({ node, script, cwd, stdoutLog, stderrLog }) {
  const q = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  return `[Unit]
Description=Cursor Agent Traffic Light Bridge
After=default.target

[Service]
Type=simple
WorkingDirectory=${q(cwd)}
ExecStart=${q(node)} ${q(script)}
Restart=on-failure
RestartSec=3
StandardOutput=append:${stdoutLog}
StandardError=append:${stderrLog}

[Install]
WantedBy=default.target
`;
}

export function healthUrl() {
  return 'http://127.0.0.1:3210/health';
}

export async function waitForHealth(timeoutMs = 8000) {
  const started = Date.now();
  let lastError = 'not attempted';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(healthUrl(), { cache: 'no-store' });
      if (response.ok) {
        return { ok: true, body: await response.json() };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, error: lastError };
}

export function tempBackupDir() {
  return join(tmpdir(), APP_NAME, 'backups');
}
