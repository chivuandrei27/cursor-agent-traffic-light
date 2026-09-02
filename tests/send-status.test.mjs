import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../scripts/send-status.mjs';

describe('send-status parseArgs', () => {
  it('parses positional state and message', () => {
    const parsed = parseArgs(['working', 'Implementing authentication']);
    assert.equal(parsed.help, false);
    assert.equal(parsed.options.state, 'working');
    assert.equal(parsed.options.message, 'Implementing authentication');
  });

  it('parses flagged options', () => {
    const parsed = parseArgs([
      '--state',
      'working',
      '--message',
      'Implementing authentication',
      '--project',
      'ulise',
      '--task',
      'Login module',
      '--source',
      'manual-cli',
    ]);
    assert.equal(parsed.options.state, 'working');
    assert.equal(parsed.options.project, 'ulise');
    assert.equal(parsed.options.task, 'Login module');
    assert.equal(parsed.options.source, 'manual-cli');
  });

  it('returns help', () => {
    const parsed = parseArgs(['--help']);
    assert.equal(parsed.help, true);
  });

  it('rejects unknown state', () => {
    assert.throws(() => parseArgs(['offline']), /Invalid state/);
  });
});
