import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chooseNodeRuntime,
  isNodeMajorAtLeast,
  parseNodeVersion,
  platformTriple,
} from '../scripts/runtime-utils.mjs';

describe('runtime-utils', () => {
  it('parses node versions', () => {
    assert.deepEqual(parseNodeVersion('v22.18.0'), { major: 22, minor: 18, patch: 0 });
    assert.deepEqual(parseNodeVersion('18.20.4'), { major: 18, minor: 20, patch: 4 });
    assert.equal(parseNodeVersion('nope'), null);
  });

  it('checks minimum major', () => {
    assert.equal(isNodeMajorAtLeast('v20.11.0', 18), true);
    assert.equal(isNodeMajorAtLeast('v16.20.0', 18), false);
  });

  it('builds platform triples', () => {
    assert.equal(platformTriple('darwin', 'arm64').triple, 'darwin-arm64');
    assert.equal(platformTriple('linux', 'x64').archive.includes('linux-x64.tar.gz'), true);
    assert.equal(platformTriple('win32', 'x64').isZip, true);
  });

  it('prefers system Node when >= 18', () => {
    const decision = chooseNodeRuntime({
      systemNodePath: '/usr/bin/node',
      systemVersion: '20.11.0',
      privateReady: false,
    });
    assert.equal(decision.source, 'system');
    assert.equal(decision.needsDownload, false);
    assert.equal(decision.nodePath, '/usr/bin/node');
  });

  it('downloads private Node when system is too old', () => {
    const decision = chooseNodeRuntime({
      systemNodePath: '/usr/bin/node',
      systemVersion: '16.20.0',
      privateReady: false,
      privateNodePath: '/tmp/private-node',
    });
    assert.equal(decision.source, 'private');
    assert.equal(decision.needsDownload, true);
    assert.equal(decision.nodePath, '/tmp/private-node');
  });

  it('uses existing private Node when preferPrivate is set', () => {
    const decision = chooseNodeRuntime({
      preferPrivate: true,
      systemVersion: '20.11.0',
      privateReady: true,
      privateNodePath: '/tmp/private-node',
    });
    // privateReady true but probeNodeVersion may fail on fake path — pass version via needsDownload false path
    // When privateReady is true, chooseNodeRuntime uses private without probing if we short-circuit.
    assert.equal(decision.nodePath, '/tmp/private-node');
    assert.equal(decision.source, 'private');
  });
});
