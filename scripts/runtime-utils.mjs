import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import {
  APP_HOME,
  MIN_SYSTEM_NODE_MAJOR,
  PRIVATE_NODE_VERSION,
  RUNTIME_DIR,
  STATE_PATH,
} from './app-home.mjs';

/**
 * @param {string} versionText e.g. v22.18.0 or 22.18.0
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseNodeVersion(versionText) {
  const match = String(versionText)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isNodeMajorAtLeast(versionText, minimumMajor) {
  const parsed = parseNodeVersion(versionText);
  return Boolean(parsed && parsed.major >= minimumMajor);
}

/**
 * @returns {{ os: string, cpu: string, triple: string, archive: string, isZip: boolean }}
 */
export function platformTriple(nodePlatform = platform(), nodeArch = arch()) {
  let os;
  let cpu;
  let isZip = false;

  if (nodePlatform === 'darwin') {
    os = 'darwin';
  } else if (nodePlatform === 'linux') {
    os = 'linux';
  } else if (nodePlatform === 'win32') {
    os = 'win';
    isZip = true;
  } else {
    throw new Error(`Unsupported platform for private Node runtime: ${nodePlatform}`);
  }

  if (nodeArch === 'arm64') {
    cpu = 'arm64';
  } else if (nodeArch === 'x64') {
    cpu = 'x64';
  } else {
    throw new Error(`Unsupported CPU architecture for private Node runtime: ${nodeArch}`);
  }

  const triple = `${os}-${cpu}`;
  const ext = isZip ? 'zip' : 'tar.gz';
  const archive = `node-v${PRIVATE_NODE_VERSION}-${triple}.${ext}`;
  return { os, cpu, triple, archive, isZip };
}

export function privateNodeBinaryPath(version = PRIVATE_NODE_VERSION) {
  const { triple } = platformTriple();
  const root = join(RUNTIME_DIR, `node-v${version}-${triple}`);
  if (platform() === 'win32') {
    return join(root, 'node.exe');
  }
  return join(root, 'bin', 'node');
}

export function nodeDistUrl(version = PRIVATE_NODE_VERSION) {
  const { archive } = platformTriple();
  return `https://nodejs.org/dist/v${version}/${archive}`;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readInstallState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function writeInstallState(state) {
  await mkdir(APP_HOME, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Probe a node binary: returns version string or null.
 * @param {string} nodePath
 */
export function probeNodeVersion(nodePath) {
  const result = spawnSync(nodePath, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    timeout: 8_000,
  });
  if (result.status !== 0) {
    return null;
  }
  const version = String(result.stdout || '').trim();
  return parseNodeVersion(version) ? version : null;
}

/**
 * Decide which Node binary to use.
 * Policy A: system Node >=18 OK; otherwise private Node 22.
 *
 * @param {{
 *   preferPrivate?: boolean,
 *   systemNodePath?: string,
 *   systemVersion?: string | null,
 *   privateNodePath?: string,
 *   privateReady?: boolean,
 * }} [options]
 */
export function chooseNodeRuntime(options = {}) {
  const preferPrivate = Boolean(options.preferPrivate);
  const systemPath = options.systemNodePath || process.execPath;
  const systemVersion = options.systemVersion ?? probeNodeVersion(systemPath);
  const privatePath = options.privateNodePath || privateNodeBinaryPath();
  const privateReady = options.privateReady ?? Boolean(probeNodeVersion(privatePath));

  if (preferPrivate && privateReady) {
    return {
      nodePath: privatePath,
      source: 'private',
      version: probeNodeVersion(privatePath)?.replace(/^v/, '') || PRIVATE_NODE_VERSION,
      needsDownload: false,
    };
  }

  if (systemVersion && isNodeMajorAtLeast(systemVersion, MIN_SYSTEM_NODE_MAJOR)) {
    return {
      nodePath: systemPath,
      source: 'system',
      version: systemVersion.replace(/^v/, ''),
      needsDownload: false,
    };
  }

  if (privateReady) {
    return {
      nodePath: privatePath,
      source: 'private',
      version: probeNodeVersion(privatePath)?.replace(/^v/, '') || PRIVATE_NODE_VERSION,
      needsDownload: false,
    };
  }

  return {
    nodePath: privatePath,
    source: 'private',
    version: PRIVATE_NODE_VERSION,
    needsDownload: true,
    reason: systemVersion
      ? `system Node v${systemVersion.replace(/^v/, '')} is below ${MIN_SYSTEM_NODE_MAJOR}`
      : 'no usable system Node found',
  };
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  await mkdir(dirnameSafe(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
}

function dirnameSafe(filePath) {
  return join(filePath, '..');
}

async function extractTarGz(archivePath, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`tar extract failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
}

async function extractZip(archivePath, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  if (platform() === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destinationDir}" -Force`,
      ],
      { encoding: 'utf8' },
    );
    if (ps.status !== 0) {
      throw new Error(`zip extract failed: ${ps.stderr || ps.stdout || 'unknown error'}`);
    }
    return;
  }
  const result = spawnSync('unzip', ['-o', archivePath, '-d', destinationDir], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`unzip failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
}

/**
 * Download and extract private Node 22 into APP_HOME/runtime.
 * Does not modify system Node or PATH.
 */
export async function installPrivateNodeRuntime({
  version = PRIVATE_NODE_VERSION,
  onProgress = () => {},
} = {}) {
  const { archive, isZip, triple } = platformTriple();
  const url = nodeDistUrl(version);
  const extractRoot = RUNTIME_DIR;
  const targetDir = join(extractRoot, `node-v${version}-${triple}`);
  const nodePath = privateNodeBinaryPath(version);

  if (await pathExists(nodePath)) {
    const existing = probeNodeVersion(nodePath);
    if (existing) {
      onProgress(`Private Node already present (${existing})`);
      return { nodePath, version: existing.replace(/^v/, ''), reused: true };
    }
  }

  await mkdir(RUNTIME_DIR, { recursive: true });
  const archivePath = join(RUNTIME_DIR, archive);

  onProgress(`Downloading Node ${version} (${triple})…`);
  onProgress(url);
  await downloadFile(url, archivePath);

  onProgress('Extracting…');
  await rm(targetDir, { recursive: true, force: true });
  if (isZip) {
    await extractZip(archivePath, extractRoot);
  } else {
    await extractTarGz(archivePath, extractRoot);
  }

  // Official archives extract to node-vVERSION-TRIPLE/
  if (!(await pathExists(nodePath))) {
    throw new Error(`Node binary missing after extract: ${nodePath}`);
  }

  if (platform() !== 'win32') {
    await chmod(nodePath, 0o755);
  }

  await rm(archivePath, { force: true });

  const verified = probeNodeVersion(nodePath);
  if (!verified) {
    throw new Error(`Private Node failed to execute: ${nodePath}`);
  }

  onProgress(`Private Node ready: ${verified} → ${nodePath}`);
  return { nodePath, version: verified.replace(/^v/, ''), reused: false };
}

/**
 * Resolve a Node binary for the app. Downloads private 22 when needed.
 */
export async function ensureNodeRuntime({ preferPrivate = false, onProgress = () => {} } = {}) {
  let decision = chooseNodeRuntime({ preferPrivate });
  if (decision.needsDownload) {
    onProgress(decision.reason || 'Installing private Node 22…');
    // Current process must support fetch (Node 18+). Bootstrap shell covers older/missing Node.
    if (typeof fetch !== 'function') {
      throw new Error(
        'This Node is too old to download a runtime. Run scripts/install.sh (macOS/Linux) or scripts/install.ps1 (Windows) instead.',
      );
    }
    const installed = await installPrivateNodeRuntime({ onProgress });
    decision = {
      nodePath: installed.nodePath,
      source: 'private',
      version: installed.version,
      needsDownload: false,
    };
  } else {
    onProgress(
      decision.source === 'system'
        ? `Using system Node v${decision.version}`
        : `Using private Node v${decision.version}`,
    );
  }
  return decision;
}
