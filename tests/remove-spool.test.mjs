import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { drainRemoveSpool, enqueueRemoveRequest } from '../bridge/remove-spool.mjs';

describe('remove-spool', () => {
  it('enqueues and drains remove requests', async () => {
    const spoolDir = await mkdtemp(join(tmpdir(), 'tl-spool-'));
    await enqueueRemoveRequest(
      { workspaceRoot: '/tmp/closed', project: 'closed', reason: 'window_close' },
      { spoolDir },
    );

    const seen = [];
    const n = await drainRemoveSpool((filter) => {
      seen.push(filter);
      return { removed: 1 };
    }, { spoolDir });

    assert.equal(n, 1);
    assert.equal(seen[0].workspaceRoot, '/tmp/closed');
    assert.equal(seen[0].project, 'closed');

    const again = await drainRemoveSpool(() => ({ removed: 0 }), { spoolDir });
    assert.equal(again, 0);
  });
});
