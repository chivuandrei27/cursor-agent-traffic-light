import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { needsAutostartSync } from '../scripts/install-autostart.mjs';

describe('needsAutostartSync', () => {
  it('flags macOS privacy-protected folders for LaunchAgent sync', () => {
    const home = homedir();
    assert.equal(needsAutostartSync(join(home, 'Documents', 'Trafic Ligths')), true);
    assert.equal(needsAutostartSync(join(home, 'Desktop', 'proj')), true);
    assert.equal(needsAutostartSync(join(home, 'Downloads', 'proj')), true);
    assert.equal(needsAutostartSync(join(home, '.cursor-agent-traffic-light', 'app')), false);
    assert.equal(needsAutostartSync(join(home, 'dev', 'traffic')), false);
  });
});
