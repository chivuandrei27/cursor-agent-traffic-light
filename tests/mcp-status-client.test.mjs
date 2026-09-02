import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { finalizeStatusMessage, validateReportInput } from '../mcp/status-client.mjs';

describe('mcp status client', () => {
  it('rejects invalid states', () => {
    const result = validateReportInput({ state: 'offline', message: 'nope' });
    assert.equal(result.ok, false);
  });

  it('marks completed unverified when validation not run', () => {
    const finalized = finalizeStatusMessage({
      state: 'completed',
      message: 'Done',
      validation: { lint: 'not-run', tests: 'not-run', build: 'not-run' },
    });
    assert.equal(finalized.completionKind, 'unverified');
    assert.match(finalized.message, /Unverified/);
  });

  it('marks completed verified when all passed', () => {
    const finalized = finalizeStatusMessage({
      state: 'completed',
      message: 'Done',
      validation: { lint: 'passed', tests: 'passed', build: 'passed' },
    });
    assert.equal(finalized.completionKind, 'verified');
    assert.match(finalized.message, /Verified/);
  });
});
