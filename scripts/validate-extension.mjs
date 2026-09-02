#!/usr/bin/env node

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const ALLOWED_PERMISSIONS = new Set(['storage', 'notifications', 'alarms', 'sidePanel']);
let failures = 0;

function fail(message) {
  console.error(`[validate-extension] FAIL: ${message}`);
  failures += 1;
}

function ok(message) {
  console.log(`[validate-extension] ok: ${message}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isPng(buffer) {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

async function main() {
  const manifestPath = join(root, 'manifest.json');
  if (!(await exists(manifestPath))) {
    fail('manifest.json missing');
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    ok('manifest JSON valid');
  } catch (error) {
    fail(`manifest JSON invalid: ${error.message}`);
    process.exit(1);
  }

  if (manifest.manifest_version !== 3) {
    fail('manifest_version must be 3');
  } else {
    ok('Manifest V3');
  }

  const requiredFiles = [
    'service-worker.js',
    'popup.html',
    'panel.js',
    'popup.css',
    'sidepanel.html',
    'options.html',
    'options.js',
    'options.css',
    'defaults.js',
    'i18n.js',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ];

  for (const relative of requiredFiles) {
    if (await exists(join(root, relative))) {
      ok(relative);
    } else {
      fail(`missing ${relative}`);
    }
  }

  for (const size of [16, 32, 48, 128]) {
    const buf = await readFile(join(root, 'icons', `icon${size}.png`));
    if (isPng(buf)) {
      ok(`icon${size}.png is PNG`);
    } else {
      fail(`icon${size}.png is not a valid PNG`);
    }
  }

  for (const perm of manifest.permissions || []) {
    if (!ALLOWED_PERMISSIONS.has(perm)) {
      fail(`unexpected permission: ${perm}`);
    }
  }
  ok('permissions within allow-list');

  if (manifest.content_scripts) {
    fail('content_scripts should not be present');
  }

  const htmlFiles = ['popup.html', 'sidepanel.html', 'options.html'];
  for (const file of htmlFiles) {
    const html = await readFile(join(root, file), 'utf8');
    if (/<script(?![^>]*\bsrc=)/i.test(html) || /onclick=|onload=/i.test(html)) {
      fail(`${file} appears to contain inline script handlers`);
    } else {
      ok(`${file} has no inline scripts`);
    }
    if (/https?:\/\/(?!127\.0\.0\.1)/i.test(html)) {
      fail(`${file} references remote URL`);
    }
  }

  const jsFiles = ['service-worker.js', 'panel.js', 'options.js', 'defaults.js', 'i18n.js'];
  for (const file of jsFiles) {
    const source = await readFile(join(root, file), 'utf8');
    if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source)) {
      fail(`${file} uses eval/new Function`);
    } else {
      ok(`${file} has no eval/new Function`);
    }
    if (file === 'service-worker.js') {
      if (/\bdocument\b|\bwindow\b|\binnerHTML\b/.test(source)) {
        fail('service-worker.js uses unsupported DOM APIs');
      } else {
        ok('service-worker.js avoids DOM APIs');
      }
    }
    if (/\binnerHTML\s*=/.test(source)) {
      fail(`${file} assigns innerHTML`);
    }
  }

  if (failures > 0) {
    console.error(`[validate-extension] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('[validate-extension] PASS');
}

await main();
