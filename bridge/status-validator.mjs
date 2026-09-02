import { HTTP_STATES, LIMITS } from './config.mjs';

/**
 * Sanitize a string field: coerce to string, trim, strip control characters.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  // Strip C0 controls and DEL without a control-char character class (eslint).
  return String(value)
    .replace(/[\s\S]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
        return '';
      }
      return ch;
    })
    .trim();
}

/**
 * Validate and normalize an inbound HTTP status payload.
 * Unknown fields are ignored. offline cannot be submitted over HTTP.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 */
export function validateStatusPayload(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_BODY',
        message: 'Request body must be a JSON object',
      },
    };
  }

  const state = sanitizeString(input.state);
  if (!state) {
    return {
      ok: false,
      error: {
        code: 'MISSING_STATE',
        message: 'Field "state" is required',
      },
    };
  }

  if (state === 'offline') {
    return {
      ok: false,
      error: {
        code: 'OFFLINE_NOT_ALLOWED',
        message: 'HTTP clients cannot submit state "offline"',
      },
    };
  }

  if (!HTTP_STATES.includes(state)) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_STATE',
        message: `Unknown state "${state}". Allowed: ${HTTP_STATES.join(', ')}`,
      },
    };
  }

  const message = sanitizeString(input.message ?? '');
  if (message.length > LIMITS.message) {
    return {
      ok: false,
      error: {
        code: 'MESSAGE_TOO_LONG',
        message: `message must be at most ${LIMITS.message} characters`,
      },
    };
  }

  const project = sanitizeString(input.project ?? '');
  if (project.length > LIMITS.project) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_TOO_LONG',
        message: `project must be at most ${LIMITS.project} characters`,
      },
    };
  }

  const task = sanitizeString(input.task ?? '');
  if (task.length > LIMITS.task) {
    return {
      ok: false,
      error: {
        code: 'TASK_TOO_LONG',
        message: `task must be at most ${LIMITS.task} characters`,
      },
    };
  }

  const tabName = sanitizeString(input.tabName ?? '');
  if (tabName.length > LIMITS.tabName) {
    return {
      ok: false,
      error: {
        code: 'TAB_NAME_TOO_LONG',
        message: `tabName must be at most ${LIMITS.tabName} characters`,
      },
    };
  }

  let conversationId = null;
  if (input.conversationId !== undefined && input.conversationId !== null) {
    conversationId = sanitizeString(input.conversationId);
    if (!conversationId) {
      conversationId = null;
    }
  }

  let generationId = null;
  if (input.generationId !== undefined && input.generationId !== null) {
    generationId = sanitizeString(input.generationId);
    if (!generationId) {
      generationId = null;
    }
  }

  const event = sanitizeString(input.event ?? '');
  const source = sanitizeString(input.source ?? 'manual') || 'manual';

  let workspaceRoot = '';
  if (input.workspaceRoot !== undefined && input.workspaceRoot !== null) {
    workspaceRoot = sanitizeString(input.workspaceRoot);
    if (workspaceRoot.length > LIMITS.workspaceRoot) {
      return {
        ok: false,
        error: {
          code: 'WORKSPACE_ROOT_TOO_LONG',
          message: `workspaceRoot must be at most ${LIMITS.workspaceRoot} characters`,
        },
      };
    }
  }

  return {
    ok: true,
    value: {
      state,
      message,
      project,
      task,
      tabName,
      conversationId,
      generationId,
      event: event || null,
      source,
      workspaceRoot: workspaceRoot || null,
    },
  };
}
