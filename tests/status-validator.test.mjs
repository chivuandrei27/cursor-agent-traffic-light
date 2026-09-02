import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeString, validateStatusPayload } from '../bridge/status-validator.mjs';

describe('sanitizeString', () => {
  it('trims and strips control characters', () => {
    assert.equal(sanitizeString('  hello\u0000world\n  '), 'helloworld');
  });

  it('coerces nullish to empty string', () => {
    assert.equal(sanitizeString(null), '');
    assert.equal(sanitizeString(undefined), '');
  });
});

describe('validateStatusPayload', () => {
  it('accepts a valid working payload and ignores unknown fields', () => {
    const result = validateStatusPayload({
      state: 'working',
      message: 'Implementing authentication',
      project: 'ulise',
      task: 'Login module',
      conversationId: null,
      event: 'beforeSubmitPrompt',
      source: 'manual',
      unexpected: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.value.state, 'working');
    assert.equal(result.value.project, 'ulise');
    assert.equal('unexpected' in result.value, false);
  });

  it('rejects non-object bodies', () => {
    const result = validateStatusPayload(['working']);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_BODY');
  });

  it('rejects missing state', () => {
    const result = validateStatusPayload({ message: 'hi' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MISSING_STATE');
  });

  it('rejects offline over HTTP', () => {
    const result = validateStatusPayload({ state: 'offline' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'OFFLINE_NOT_ALLOWED');
  });

  it('rejects unknown states', () => {
    const result = validateStatusPayload({ state: 'busy' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNKNOWN_STATE');
  });

  it('rejects message longer than 500 characters', () => {
    const result = validateStatusPayload({
      state: 'idle',
      message: 'x'.repeat(501),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MESSAGE_TOO_LONG');
  });

  it('rejects project longer than 200 characters', () => {
    const result = validateStatusPayload({
      state: 'idle',
      project: 'p'.repeat(201),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PROJECT_TOO_LONG');
  });

  it('rejects task longer than 300 characters', () => {
    const result = validateStatusPayload({
      state: 'idle',
      task: 't'.repeat(301),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASK_TOO_LONG');
  });

  it('defaults source to manual when empty', () => {
    const result = validateStatusPayload({ state: 'completed', source: '   ' });
    assert.equal(result.ok, true);
    assert.equal(result.value.source, 'manual');
  });
});
