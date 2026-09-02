const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3210';
const DEFAULT_TIMEOUT_MS = 750;

const ALLOWED_STATES = new Set(['idle', 'working', 'waiting', 'completed', 'error']);
const VALIDATION_VALUES = new Set(['passed', 'failed', 'not-run']);

/**
 * @param {unknown} value
 * @param {number} max
 */
function sanitize(value, max) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @param {unknown} input
 */
export function validateReportInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Input must be an object' };
  }

  const state = sanitize(input.state, 40);
  if (!ALLOWED_STATES.has(state)) {
    return {
      ok: false,
      error: `Invalid state "${state}". Allowed: ${[...ALLOWED_STATES].join(', ')}`,
    };
  }

  const message = sanitize(input.message ?? '', 500);
  const project = sanitize(input.project ?? '', 200);
  const task = sanitize(input.task ?? '', 300);

  /** @type {{ lint: string, tests: string, build: string } | null} */
  let validation = null;
  if (input.validation !== undefined && input.validation !== null) {
    if (typeof input.validation !== 'object' || Array.isArray(input.validation)) {
      return { ok: false, error: 'validation must be an object' };
    }
    const lint = sanitize(input.validation.lint ?? 'not-run', 20) || 'not-run';
    const tests = sanitize(input.validation.tests ?? 'not-run', 20) || 'not-run';
    const build = sanitize(input.validation.build ?? 'not-run', 20) || 'not-run';
    for (const [name, value] of [
      ['lint', lint],
      ['tests', tests],
      ['build', build],
    ]) {
      if (!VALIDATION_VALUES.has(value)) {
        return {
          ok: false,
          error: `validation.${name} must be passed|failed|not-run`,
        };
      }
    }
    validation = { lint, tests, build };
  }

  return {
    ok: true,
    value: { state, message, project, task, validation },
  };
}

/**
 * Apply completed/error message conventions.
 * @param {{ state: string, message: string, validation: { lint: string, tests: string, build: string } | null }} input
 */
export function finalizeStatusMessage(input) {
  let message = input.message;
  let completionKind = null;

  if (input.state === 'completed') {
    const validation = input.validation || {
      lint: 'not-run',
      tests: 'not-run',
      build: 'not-run',
    };
    const allNotRun =
      validation.lint === 'not-run' &&
      validation.tests === 'not-run' &&
      validation.build === 'not-run';
    const allPassed =
      validation.lint === 'passed' &&
      validation.tests === 'passed' &&
      validation.build === 'passed';

    if (allNotRun) {
      completionKind = 'unverified';
      if (!/unverified/i.test(message)) {
        message = message ? `${message} · Unverified` : 'Completed · Unverified';
      }
    } else if (allPassed) {
      completionKind = 'verified';
      if (!/verified/i.test(message)) {
        message = message ? `${message} · Verified` : 'Completed · Verified';
      }
    } else {
      completionKind = 'partial';
    }
  }

  if (input.state === 'error' && input.validation) {
    const failed = Object.entries(input.validation)
      .filter(([, value]) => value === 'failed')
      .map(([key]) => key);
    if (failed.length > 0 && !message.toLowerCase().includes('failed')) {
      message = message
        ? `${message} (failed: ${failed.join(', ')})`
        : `Failed validation: ${failed.join(', ')}`;
    }
  }

  return { message, completionKind };
}

/**
 * @param {object} input
 * @param {{ bridgeUrl?: string, timeoutMs?: number }} [options]
 */
export async function reportCursorStatus(input, options = {}) {
  const validated = validateReportInput(input);
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.error,
      bridgeReachable: null,
    };
  }

  const finalized = finalizeStatusMessage(validated.value);
  const payload = {
    state: validated.value.state,
    message: finalized.message,
    project: validated.value.project,
    task: validated.value.task,
    source: 'cursor-mcp',
    event: 'report_cursor_status',
  };

  const bridgeUrl = (options.bridgeUrl || process.env.BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(
    /\/$/,
    '',
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${bridgeUrl}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        error: body?.error?.message || `Bridge HTTP ${response.status}`,
        bridgeReachable: true,
        status: body?.status ?? null,
        completionKind: finalized.completionKind,
      };
    }

    return {
      ok: true,
      bridgeReachable: true,
      deduped: Boolean(body?.deduped),
      status: body?.status ?? null,
      completionKind: finalized.completionKind,
      validation: validated.value.validation,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Bridge unavailable: ${error instanceof Error ? error.message : 'fetch failed'}`,
      bridgeReachable: false,
      completionKind: finalized.completionKind,
    };
  } finally {
    clearTimeout(timer);
  }
}
