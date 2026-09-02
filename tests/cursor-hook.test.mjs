import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildHookStatus,
  cursorStdoutResponse,
  isProjectCloseSessionEnd,
  resolveHookState,
  tabNameFromPayload,
  tabNameFromTranscriptText,
} from '../scripts/cursor-hook.mjs';

describe('cursor-hook helpers', () => {
  it('builds a working status from beforeSubmitPrompt payload', () => {
    const longPrompt =
      'Implement login with OAuth and session cookies for the dashboard, ' +
      'including refresh token rotation, CSRF protection, and audit logging for every auth event';
    const status = buildHookStatus('beforeSubmitPrompt', 'working', {
      conversation_id: 'test-123',
      workspace_roots: ['/tmp/example'],
      hook_event_name: 'beforeSubmitPrompt',
      prompt: longPrompt,
    });

    assert.equal(status.state, 'working');
    assert.equal(status.conversationId, 'test-123');
    assert.equal(status.project, 'example');
    assert.equal(status.workspaceRoot, '/tmp/example');
    assert.ok(status.task.length <= 120);
    assert.equal(status.source, 'cursor-hook');
    assert.notEqual(status.task, longPrompt);
    assert.ok(status.tabName.startsWith('Implement login'));
    assert.ok(status.tabName.length <= 80);
  });

  it('derives tab name from the first prompt line', () => {
    assert.equal(
      tabNameFromPayload({ prompt: 'Fix the auth bug\nmore detail' }, 'beforeSubmitPrompt'),
      'Fix the auth bug',
    );
    assert.equal(tabNameFromPayload({ tool_name: 'Shell' }, 'preToolUse'), '');
    assert.equal(tabNameFromPayload({ chat_title: 'Auth refactor' }, 'stop'), 'Auth refactor');
  });

  it('derives Cursor tab name from transcript when hooks never saw beforeSubmitPrompt', () => {
    // Reproduces Ulise tab1: mid-loop hooks only → empty tabName → UI shows "Tab 1".
    const transcript = [
      JSON.stringify({
        role: 'user',
        message: {
          content: [
            {
              type: 'text',
              text:
                '<timestamp>Wednesday, Aug 5, 2026, 4:30 PM (UTC+3)</timestamp>\n' +
                '<user_query>\nContext\n\nConstruim modulul Email Integration & AI Invoice Hub\n</user_query>',
            },
          ],
        },
      }),
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'text', text: 'Încep cu analiza…' }] },
      }),
    ].join('\n');

    assert.equal(
      tabNameFromTranscriptText(transcript),
      'Construim modulul Email Integration & AI Invoice Hub',
    );
    assert.equal(tabNameFromTranscriptText(''), '');
    assert.equal(tabNameFromTranscriptText('not-json'), '');
  });

  it('maps stop completed/aborted; Cursor stop error is not questions', () => {
    assert.equal(resolveHookState('stop', 'completed', { status: 'completed' }), 'completed');
    assert.equal(resolveHookState('stop', 'completed', { status: 'error' }), 'completed');
    assert.equal(resolveHookState('stop', 'completed', { status: 'aborted' }), 'idle');
  });

  it('maps postToolUseFailure to working even when argv says error', () => {
    assert.equal(resolveHookState('postToolUseFailure', 'error', {}), 'working');
  });

  it('maps pending ask tools to error; answered ask tools resume working', () => {
    assert.equal(
      resolveHookState('preToolUse', 'working', { tool_name: 'AskQuestion' }),
      'error',
    );
    assert.equal(
      resolveHookState('postToolUse', 'working', { tool_name: 'AskQuestion' }),
      'working',
    );
  });

  it('maps Shell preToolUse to waiting; beforeShell stays working; Write stays working', () => {
    assert.equal(resolveHookState('preToolUse', 'working', { tool_name: 'Shell' }), 'waiting');
    assert.equal(resolveHookState('beforeShellExecution', 'working', {}), 'working');
    assert.equal(resolveHookState('beforeMCPExecution', 'working', {}), 'working');
    assert.equal(resolveHookState('afterShellExecution', 'working', {}), 'working');
    assert.equal(resolveHookState('preToolUse', 'working', { tool_name: 'Write' }), 'working');
    assert.equal(resolveHookState('preToolUse', 'working', { tool_name: 'Read' }), 'working');
    assert.equal(resolveHookState('preToolUse', 'working', { tool_name: 'mcp:server' }), 'waiting');
  });

  it('final chat questions never blink red — stop is green, mid-loop is yellow', () => {
    assert.equal(
      resolveHookState('afterAgentResponse', 'working', {
        text: 'I can do A or B. Which do you prefer?',
      }),
      'working',
    );
    assert.equal(
      resolveHookState('stop', 'completed', {
        status: 'completed',
        asksUser: true,
      }),
      'completed',
    );
  });

  it('keeps afterAgentResponse as working until stop (Stop button still up)', () => {
    const status = buildHookStatus('afterAgentResponse', 'working', {
      conversation_id: 'c1',
      workspace_roots: ['/tmp/ulise'],
      hook_event_name: 'afterAgentResponse',
    });
    assert.equal(status.state, 'working');
    assert.equal(status.project, 'ulise');
  });

  it('returns empty stdout for all hooks (never force-allow)', () => {
    assert.deepEqual(cursorStdoutResponse('preToolUse'), {});
    assert.deepEqual(cursorStdoutResponse('beforeShellExecution'), {});
    assert.deepEqual(cursorStdoutResponse('afterAgentResponse'), {});
  });

  it('treats only window/user close as project close', () => {
    assert.equal(isProjectCloseSessionEnd({ reason: 'window_close' }), true);
    assert.equal(isProjectCloseSessionEnd({ reason: 'user_close' }), true);
    assert.equal(isProjectCloseSessionEnd({ reason: 'completed' }), false);
    assert.equal(isProjectCloseSessionEnd({ reason: 'aborted' }), false);
    assert.equal(isProjectCloseSessionEnd({ reason: 'window closed' }), true);
  });
});
