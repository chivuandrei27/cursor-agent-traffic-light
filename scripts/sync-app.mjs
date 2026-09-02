import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_DIR, APP_HOME } from './app-home.mjs';
import { pathExists, repoRootFromHere } from './hook-utils.mjs';

const COPY_ENTRIES = ['bridge', 'scripts', 'mcp', 'extension', 'package.json', 'README.md'];

/**
 * Prefer the package root when it already has dependencies (local clone / linked install).
 */
export async function canUsePackageRootInPlace(packageRoot) {
  return pathExists(join(packageRoot, 'node_modules', 'ws'));
}

/**
 * Ensure a stable app directory for hooks/autostart.
 *
 * - Local clone with node_modules → use package root in place
 * - npx / global without usable deps → sync into ~/.cursor-agent-traffic-light/app
 */
export async function ensureAppInstall({
  packageRoot = repoRootFromHere(),
  nodePath,
  forceSync = false,
  dryRun = false,
  onProgress = () => {},
} = {}) {
  const inPlace = !forceSync && (await canUsePackageRootInPlace(packageRoot));
  if (inPlace) {
    onProgress(`Using package in place: ${packageRoot}`);
    return { appDir: packageRoot, synced: false, dryRun };
  }

  onProgress(`Syncing package into ${APP_DIR}`);
  if (dryRun) {
    return { appDir: APP_DIR, synced: true, dryRun: true };
  }

  await mkdir(APP_HOME, { recursive: true });
  await mkdir(APP_DIR, { recursive: true });

  for (const entry of COPY_ENTRIES) {
    const from = join(packageRoot, entry);
    const to = join(APP_DIR, entry);
    if (!(await pathExists(from))) {
      continue;
    }
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true, force: true });
  }

  for (const lockName of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lockFrom = join(packageRoot, lockName);
    if (await pathExists(lockFrom)) {
      await cp(lockFrom, join(APP_DIR, lockName), { force: true });
    }
  }

  onProgress('npm install --omit=dev…');
  const binDir = dirname(nodePath);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install', '--omit=dev', '--no-fund', '--no-audit'], {
    cwd: APP_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
    },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `npm install failed in ${APP_DIR}: ${result.stderr || result.stdout || 'error'}`,
    );
  }

  await writeFile(
    join(APP_DIR, '.traffic-light-sync.json'),
    `${JSON.stringify({ packageRoot, syncedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  return { appDir: APP_DIR, synced: true, dryRun: false };
}

export async function resolveAppDir(packageRoot = repoRootFromHere()) {
  if (await canUsePackageRootInPlace(packageRoot)) {
    return packageRoot;
  }
  if (await pathExists(join(APP_DIR, 'package.json'))) {
    try {
      const pkg = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8'));
      if (pkg?.name === 'cursor-agent-traffic-light') {
        return APP_DIR;
      }
    } catch {
      // fall through
    }
  }
  return packageRoot;
}
