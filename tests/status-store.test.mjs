import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveStartedAt, StatusStore } from '../bridge/status-store.mjs';

describe('StatusStore', () => {
  it('starts idle with sequence 1', () => {
    const store = new StatusStore({ now: () => 1_000 });
    const current = store.getCurrent();
    assert.equal(current.state, 'idle');
    assert.equal(current.sequence, 1);
    assert.equal(current.updatedAt, new Date(1_000).toISOString());
  });

  it('increments sequence for every accepted change', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    const first = store.setStatus({ state: 'working', message: 'a', source: 't' });
    now = 2_000;
    const second = store.setStatus({ state: 'waiting', message: 'b', source: 't' });

    assert.equal(first.status.sequence, 2);
    assert.equal(second.status.sequence, 3);
    assert.equal(store.getCurrent().sequence, 3);
  });

  it('preserves the latest 50 changes, newest first', () => {
    let now = 0;
    const store = new StatusStore({
      historyLimit: 50,
      now: () => {
        now += 1_000;
        return now;
      },
    });

    for (let i = 0; i < 60; i += 1) {
      store.setStatus({
        state: 'working',
        message: `m-${i}`,
        source: 't',
      });
    }

    const history = store.getHistory();
    assert.equal(history.length, 50);
    assert.equal(history[0].message, 'm-59');
    assert.equal(history[49].message, 'm-10');
  });

  it('deduplicates exact duplicates within 500ms', () => {
    let now = 10_000;
    const store = new StatusStore({ now: () => now, dedupeWindowMs: 500 });

    const first = store.setStatus({
      state: 'working',
      message: 'same',
      project: 'p',
      task: 't',
      source: 'cli',
      event: 'e',
      conversationId: null,
    });
    assert.equal(first.accepted, true);

    now = 10_400;
    const duplicate = store.setStatus({
      state: 'working',
      message: 'same',
      project: 'p',
      task: 't',
      source: 'cli',
      event: 'e',
      conversationId: null,
    });

    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.deduped, true);
    assert.equal(store.getCurrent().sequence, first.status.sequence);
  });

  it('accepts the same payload after the dedupe window', () => {
    let now = 10_000;
    const store = new StatusStore({ now: () => now, dedupeWindowMs: 500 });

    store.setStatus({ state: 'error', message: 'boom', source: 't' });
    now = 10_600;
    const again = store.setStatus({ state: 'error', message: 'boom', source: 't' });

    assert.equal(again.accepted, true);
    assert.equal(again.deduped, false);
  });

  it('notifies subscribers after each accepted change', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });
    const seen = [];
    store.subscribe((status, meta) => {
      seen.push({ state: status.state, deduped: meta.deduped });
    });

    now = 2_000;
    store.setStatus({ state: 'completed', message: 'done', source: 't' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].state, 'completed');
  });

  it('reset returns idle', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });
    now = 2_000;
    store.setStatus({ state: 'working', message: 'go', source: 't' });
    now = 3_000;
    const result = store.reset();
    assert.equal(result.status.state, 'idle');
    assert.equal(result.status.event, 'reset');
  });

  it('tracks multiple Cursor projects by workspace root', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'A',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
    });
    now = 2_000;
    store.setStatus({
      state: 'waiting',
      message: 'B',
      project: 'traffic-light',
      workspaceRoot: '/Users/me/traffic-light',
      source: 'cursor-hook',
    });

    const instances = store.getInstances();
    assert.equal(instances.length, 2);
    assert.equal(store.getAggregateState(), 'waiting');
    assert.ok(instances.some((item) => item.project === 'ulise'));
    assert.ok(instances.some((item) => item.project === 'traffic-light'));
  });

  it('keeps project order stable when a later project gets activity', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-ulise',
      source: 'cursor-hook',
      event: 'stop',
    });
    now = 2_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      conversationId: 'conv-traffic',
      source: 'cursor-hook',
      event: 'stop',
    });

    assert.deepEqual(
      store.getInstances().map((item) => item.project),
      ['ulise', 'traffic'],
    );

    // Newer activity on the first project must not reshuffle the list.
    now = 3_000;
    store.setStatus({
      state: 'working',
      message: 'again',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    assert.deepEqual(
      store.getInstances().map((item) => item.project),
      ['ulise', 'traffic'],
    );

    // Newer activity on the second project must not jump it above the first.
    now = 4_000;
    store.setStatus({
      state: 'working',
      message: 'busy',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      conversationId: 'conv-traffic',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    assert.deepEqual(
      store.getInstances().map((item) => item.project),
      ['ulise', 'traffic'],
    );
  });

  it('keeps separate cards for parallel chat tabs in the same workspace', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'tab1 running',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-tab-1',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    now = 2_000;
    store.setStatus({
      state: 'working',
      message: 'tab2 running',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-tab-2',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    now = 3_000;
    store.setStatus({
      state: 'completed',
      message: 'tab2 done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-tab-2',
      source: 'cursor-hook',
      event: 'stop',
    });

    const instances = store.getInstances();
    assert.equal(instances.length, 2);
    const tab1 = instances.find((item) => item.conversationId === 'conv-tab-1');
    const tab2 = instances.find((item) => item.conversationId === 'conv-tab-2');
    assert.equal(tab1.state, 'working');
    assert.equal(tab1.tabIndex, 1);
    assert.equal(tab2.state, 'completed');
    assert.equal(tab2.tabIndex, 2);
    assert.equal(store.getAggregateState(), 'working');
  });

  it('keeps chat tabName across later tool updates', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'start',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-named',
      tabName: 'Fix login flow',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    now = 2_000;
    store.setStatus({
      state: 'working',
      message: 'tool',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-named',
      tabName: '',
      task: 'tool:Shell',
      source: 'cursor-hook',
      event: 'preToolUse',
    });

    const instances = store.getInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].tabName, 'Fix login flow');
  });

  it('keeps the original Cursor tab name when a later prompt arrives', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'start',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-rename',
      tabName: 'Construim modulul Email Integration',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    now = 2_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-rename',
      source: 'cursor-hook',
      event: 'stop',
    });
    now = 3_000;
    store.setStatus({
      state: 'working',
      message: 'again',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-rename',
      tabName: 'in pagina de invoices adauga un card',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    assert.equal(
      store.getInstances()[0].tabName,
      'Construim modulul Email Integration',
    );
  });

  it('updates the same project card when stop omits workspaceRoot but keeps conversationId', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'busy',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-ulise-1',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    now = 2_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: '',
      workspaceRoot: null,
      conversationId: 'conv-ulise-1',
      source: 'cursor-hook',
      event: 'stop',
    });

    const instances = store.getInstances();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].state, 'completed');
    assert.equal(instances[0].project, 'ulise');
    assert.equal(instances[0].workspaceRoot, '/Users/me/ulise');
  });

  it('auto-completes orphaned working instances when agent loop is not running', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      instanceStaleActiveMs: 90_000,
    });

    // Manual/orphan card — not tied to an open Cursor agent loop.
    store.setStatus({
      state: 'working',
      message: 'stuck',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-stale',
      source: 'manual',
      event: 'manual',
    });
    assert.equal(store.getInstances()[0].agentRunning, false);

    now = 50_000;
    assert.equal(store.sweepStaleActive().swept, 0);

    now = 95_000;
    const result = store.sweepStaleActive();
    assert.equal(result.swept, 1);
    assert.equal(result.status.state, 'completed');
    assert.equal(result.status.event, 'stale-timeout');
    assert.equal(store.getInstances()[0].state, 'completed');
  });

  it('auto-completes finished Ulise-style orphan (afterAgentThought, no stop) within 90s', () => {
    // Reproduces: agent finished, stop hook missed, card stuck on working as "Tab 1".
    // agentRunning is false because beforeSubmitPrompt never opened the loop on this card.
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'working (cursor-grok-4.5-high-fast)',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/Ulise 2',
      conversationId: 'conv-ulise-tab1',
      tabName: '',
      source: 'cursor-hook',
      event: 'afterAgentThought',
      task: 'afterAgentThought → working',
    });
    assert.equal(store.getInstances()[0].agentRunning, false);
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.getInstances()[0].tabName, '');

    // Must not stay yellow for 15 minutes after the agent already finished.
    now = 1_000 + 90_000;
    const result = store.sweepStaleActive();
    assert.equal(result.swept, 1);
    assert.equal(store.getInstances()[0].state, 'completed');
    assert.equal(store.getInstances()[0].event, 'stale-timeout');
  });

  it('does not stale-sweep waiting (user may be on approval UI)', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      instanceStaleActiveMs: 90_000,
    });

    store.setStatus({
      state: 'waiting',
      message: 'need approval',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
    });

    now = 200_000;
    assert.equal(store.sweepStaleActive().swept, 0);
    assert.equal(store.getInstances()[0].state, 'waiting');
  });

  it('keeps startedAt across tool actions in the same prompt', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-1',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    const start = store.getInstances()[0].startedAt;
    assert.equal(start, new Date(1_000).toISOString());

    now = 5_000;
    store.setStatus({
      state: 'working',
      message: 'tool',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-1',
      source: 'cursor-hook',
      event: 'preToolUse',
    });
    assert.equal(store.getInstances()[0].startedAt, start);

    now = 12_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      conversationId: 'conv-1',
      source: 'cursor-hook',
      event: 'stop',
    });
    assert.equal(store.getInstances()[0].startedAt, start);
  });

  it('resets startedAt on a new beforeSubmitPrompt', () => {
    const previous = {
      state: 'completed',
      startedAt: new Date(1_000).toISOString(),
    };
    const next = resolveStartedAt(previous, {
      state: 'working',
      event: 'beforeSubmitPrompt',
      updatedAt: new Date(50_000).toISOString(),
    });
    assert.equal(next, new Date(50_000).toISOString());
  });

  it('restoreInstances brings back multiple project cards', () => {
    const store = new StatusStore({ now: () => 10_000 });
    store.restoreInstances([
      {
        id: 'ws:/Users/me/ulise',
        project: 'ulise',
        workspaceRoot: '/Users/me/ulise',
        state: 'completed',
        updatedAt: new Date(5_000).toISOString(),
      },
      {
        id: 'ws:/Users/me/traffic',
        project: 'traffic',
        workspaceRoot: '/Users/me/traffic',
        state: 'idle',
        updatedAt: new Date(6_000).toISOString(),
      },
    ]);

    const instances = store.getInstances();
    assert.equal(instances.length, 2);
    assert.ok(instances.some((item) => item.project === 'ulise'));
    assert.ok(instances.some((item) => item.project === 'traffic'));
  });

  it('removeInstance drops a closed project card', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });
    store.setStatus({
      state: 'completed',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
    });
    now = 2_000;
    store.setStatus({
      state: 'working',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      source: 'cursor-hook',
    });

    now = 3_000;
    const result = store.removeInstance({ workspaceRoot: '/Users/me/ulise' });
    assert.equal(result.removed, 1);
    assert.equal(result.instances.length, 1);
    assert.equal(result.instances[0].project, 'traffic');
  });

  it('beforeShell alone never arms needs-approval (auto-approved curl stays yellow)', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      approvalPendingDelayMs: 2_000,
      instanceStaleActiveMs: 90_000,
    });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    // Live bug: auto-approved shell fired beforeShell with "Pending approval" mapping.
    now = 2_000;
    store.setStatus({
      state: 'working',
      message: 'Running: curl http://127.0.0.1:3210/health',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeShellExecution',
      task: 'cmd:curl http://127.0.0.1:3210/health',
    });
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.getInstances()[0].approvalPendingSince, null);
    assert.equal(store.getInstances()[0].shellInFlight, true);

    now = 10_000;
    assert.equal(store.promotePendingApprovals(), 0);
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.sweepStaleActive().swept, 0);

    now = 11_000;
    store.setStatus({
      state: 'working',
      message: 'done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'afterShellExecution',
    });
    assert.equal(store.getInstances()[0].shellInFlight, false);
  });

  it('preToolUse Shell promotes to red; beforeShell clears; Read/Write clear stuck red', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      approvalPendingDelayMs: 2_000,
    });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    // Genuine pending: preToolUse Shell, no beforeShell → red after grace.
    now = 2_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Shell',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Shell',
    });
    assert.equal(store.getInstances()[0].state, 'working');
    assert.ok(store.getInstances()[0].approvalPendingSince);

    now = 2_100;
    store.setStatus({
      state: 'working',
      message: 'thinking',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'afterAgentThought',
    });
    assert.ok(store.getInstances()[0].approvalPendingSince);

    now = 4_500;
    assert.equal(store.promotePendingApprovals(), 1);
    assert.equal(store.getInstances()[0].state, 'waiting');

    // Thought noise must not wipe blinking red.
    now = 4_600;
    store.setStatus({
      state: 'working',
      message: 'thinking',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'afterAgentThought',
    });
    assert.equal(store.getInstances()[0].state, 'waiting');

    // Agent coding (Read) — Cursor is not asking anymore.
    now = 5_000;
    store.setStatus({
      state: 'working',
      message: 'preToolUse: Read',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Read',
    });
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.getInstances()[0].approvalPendingSince, null);

    // Auto-approved path: preToolUse then beforeShell quickly — never red.
    now = 6_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Shell',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Shell',
    });
    assert.ok(store.getInstances()[0].approvalPendingSince);

    now = 6_100;
    store.setStatus({
      state: 'working',
      message: 'Running: migrate',
      project: 'Ulise 2',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeShellExecution',
      task: 'cmd:migrate',
    });
    assert.equal(store.getInstances()[0].approvalPendingSince, null);
    assert.equal(store.getInstances()[0].shellInFlight, true);
    assert.equal(store.getInstances()[0].state, 'working');

    now = 20_000;
    assert.equal(store.promotePendingApprovals(), 0);
    assert.equal(store.getInstances()[0].state, 'working');
  });

  it('demotes stuck needs-approval to yellow running after stuck timeout', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      approvalPendingDelayMs: 2_000,
      approvalStuckRedMs: 5_000,
    });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    now = 2_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Shell',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Shell',
    });
    now = 4_500;
    assert.equal(store.promotePendingApprovals(), 1);
    assert.equal(store.getInstances()[0].state, 'waiting');

    now = 7_000;
    assert.equal(store.demoteStuckApprovals(), 0);

    now = 10_000;
    assert.equal(store.demoteStuckApprovals(), 1);
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.getInstances()[0].event, 'approval-running');
    assert.equal(store.getInstances()[0].shellInFlight, true);
    assert.match(store.getInstances()[0].message, /^Running:/);
  });

  it('does not stale-sweep while Cursor agent loop is running', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      instanceStaleActiveMs: 90_000,
    });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
      generationId: 'gen-1',
    });
    assert.equal(store.getInstances()[0].agentRunning, true);

    now = 200_000;
    assert.equal(store.sweepStaleActive().swept, 0);
    assert.equal(store.getInstances()[0].state, 'working');

    now = 210_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'stop',
      generationId: 'gen-1',
    });
    assert.equal(store.getInstances()[0].agentRunning, false);
    assert.equal(store.getInstances()[0].state, 'completed');
  });

  it('holds Shell approval yellow; beforeShell clears; Write never goes red; genuine pending promotes', () => {
    let now = 1_000;
    const store = new StatusStore({
      now: () => now,
      approvalPendingDelayMs: 2_000,
    });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    // Auto-approved Shell: beforeShell clears pending — no red blip.
    now = 2_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Shell',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Shell',
    });
    assert.equal(store.getInstances()[0].state, 'working');
    assert.ok(store.getInstances()[0].approvalPendingSince);

    now = 2_050;
    store.setStatus({
      state: 'working',
      message: 'Running: ls',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'beforeShellExecution',
      task: 'cmd:ls',
    });
    assert.equal(store.getInstances()[0].approvalPendingSince, null);
    assert.equal(store.getInstances()[0].shellInFlight, true);

    now = 2_100;
    store.setStatus({
      state: 'working',
      message: 'done ls',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'afterShellExecution',
      task: 'cmd:ls',
    });
    assert.equal(store.getInstances()[0].shellInFlight, false);
    now = 6_000;
    assert.equal(store.promotePendingApprovals(), 0);

    // Write must never arm the red timer.
    now = 7_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Write',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Write',
    });
    assert.equal(store.getInstances()[0].approvalPendingSince, null);
    now = 15_000;
    assert.equal(store.promotePendingApprovals(), 0);

    // Genuine pending: preToolUse + thought, no beforeShell — promote.
    now = 20_000;
    store.setStatus({
      state: 'waiting',
      message: 'Pending approval: Shell',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:Shell',
    });
    now = 20_100;
    store.setStatus({
      state: 'working',
      message: 'thinking',
      project: 'p',
      workspaceRoot: '/tmp/p',
      source: 'cursor-hook',
      event: 'afterAgentThought',
    });
    assert.ok(store.getInstances()[0].approvalPendingSince);

    now = 22_500;
    assert.equal(store.promotePendingApprovals(), 1);
    assert.equal(store.getInstances()[0].state, 'waiting');
    assert.equal(store.getInstances()[0].message, 'Pending approval: Shell');
  });

  it('Ask error stays red through afterAgentThought until answered', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    now = 2_000;
    store.setStatus({
      state: 'error',
      message: 'Agent has questions',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:AskQuestion',
    });
    assert.equal(store.getInstances()[0].state, 'error');

    now = 2_100;
    store.setStatus({
      state: 'working',
      message: 'thinking',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'afterAgentThought',
    });
    assert.equal(store.getInstances()[0].state, 'error');

    now = 3_000;
    store.setStatus({
      state: 'working',
      message: 'answered',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'postToolUse',
      task: 'tool:AskQuestion',
    });
    assert.equal(store.getInstances()[0].state, 'working');
  });

  it('does not create a card for anonymous hooks without any identity', () => {
    const store = new StatusStore({ now: () => 1_000 });
    store.setStatus({
      state: 'working',
      message: 'Cursor preToolUse',
      source: 'cursor-hook',
      event: 'preToolUse',
    });
    assert.equal(store.getInstances().length, 0);
  });

  it('blocked question is red mid-loop; stop always ends the turn green', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });

    // AskQuestion tool pending — flow blocked on the user.
    now = 2_000;
    store.setStatus({
      state: 'error',
      message: 'Agent has questions',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'preToolUse',
      task: 'tool:AskQuestion',
    });
    assert.equal(store.getInstances()[0].state, 'error');

    // User answered; loop resumes.
    now = 3_000;
    store.setStatus({
      state: 'working',
      message: 'answered',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'postToolUse',
      task: 'tool:AskQuestion',
    });
    assert.equal(store.getInstances()[0].state, 'working');

    // Turn finished — green even if the reply ended with a question.
    now = 4_000;
    const stopped = store.setStatus({
      state: 'completed',
      message: 'completed',
      project: 'ulise',
      workspaceRoot: '/Users/me/ulise',
      source: 'cursor-hook',
      event: 'stop',
    });
    assert.equal(stopped.status.state, 'completed');
    assert.equal(store.getInstances()[0].state, 'completed');
    assert.equal(store.getInstances()[0].agentRunning, false);
  });

  it('ignores late afterAgentThought that arrives after stop', () => {
    let now = 1_000;
    const store = new StatusStore({ now: () => now });

    store.setStatus({
      state: 'working',
      message: 'go',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    now = 2_000;
    store.setStatus({
      state: 'completed',
      message: 'done',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      source: 'cursor-hook',
      event: 'stop',
    });
    assert.equal(store.getInstances()[0].state, 'completed');

    now = 3_000;
    const late = store.setStatus({
      state: 'working',
      message: 'stray thought',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      source: 'cursor-hook',
      event: 'afterAgentThought',
    });
    assert.equal(late.accepted, false);
    assert.equal(store.getInstances()[0].state, 'completed');
    assert.equal(store.getInstances()[0].agentRunning, false);

    now = 4_000;
    store.setStatus({
      state: 'working',
      message: 'new prompt',
      project: 'traffic',
      workspaceRoot: '/Users/me/traffic',
      source: 'cursor-hook',
      event: 'beforeSubmitPrompt',
    });
    assert.equal(store.getInstances()[0].state, 'working');
    assert.equal(store.getInstances()[0].agentRunning, true);
  });
});
