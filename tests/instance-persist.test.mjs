import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  loadContextWorkspaceSeeds,
  loadInstancesForHydration,
  savePersistedInstances,
} from '../bridge/instance-persist.mjs';

describe('instance-persist', () => {
  it('hydrates from persisted snapshot and does not re-seed closed projects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tl-persist-'));
    const instancesPath = join(dir, 'instances.json');
    const contextPath = join(dir, 'conversation-context.json');

    await writeFile(
      contextPath,
      JSON.stringify({
        c1: {
          workspaceRoot: '/Users/me/ulise',
          project: 'Ulise',
          updatedAt: '2026-08-04T10:00:00.000Z',
        },
        c3: {
          workspaceRoot: '/Users/me/traffic',
          project: 'Trafic Ligths',
          updatedAt: '2026-08-04T11:30:00.000Z',
        },
      }),
      'utf8',
    );

    await savePersistedInstances(
      [
        {
          id: 'ws:/Users/me/traffic',
          project: 'Trafic Ligths',
          workspaceRoot: '/Users/me/traffic',
          state: 'working',
          updatedAt: '2026-08-04T12:00:00.000Z',
        },
      ],
      { instancesPath },
    );

    const seeds = await loadContextWorkspaceSeeds({ contextPath });
    assert.equal(seeds.length, 2);

    const hydrated = await loadInstancesForHydration({ instancesPath, contextPath });
    assert.equal(hydrated.length, 1);
    assert.equal(hydrated[0].project, 'Trafic Ligths');
  });
});
