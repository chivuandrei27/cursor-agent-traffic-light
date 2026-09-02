import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BODY_BYTES, VERSION } from './config.mjs';
import { validateStatusPayload } from './status-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

/**
 * Create the HTTP request handler for the bridge.
 *
 * @param {{
 *   statusStore: import('./status-store.mjs').StatusStore,
 *   getWebSocketClientCount: () => number,
 *   startedAt: number,
 * }} deps
 */
export function createApp(deps) {
  const { statusStore, getWebSocketClientCount, startedAt } = deps;

  return async function handleRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const { pathname } = url;
      const method = req.method ?? 'GET';

      if (method === 'GET' && pathname === '/health') {
        const instances = statusStore.getInstances();
        return sendJson(res, 200, {
          status: 'ok',
          version: VERSION,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          webSocketClients: getWebSocketClientCount(),
          currentStatus: statusStore.getCurrent(),
          instances,
          instanceCount: instances.length,
          aggregateState: statusStore.getAggregateState(),
        });
      }

      if (method === 'GET' && pathname === '/api/status') {
        return sendJson(res, 200, statusStore.getCurrent());
      }

      if (method === 'GET' && pathname === '/api/instances') {
        const instances = statusStore.getInstances();
        return sendJson(res, 200, {
          instances,
          count: instances.length,
          aggregateState: statusStore.getAggregateState(),
        });
      }

      if (method === 'GET' && pathname === '/api/history') {
        return sendJson(res, 200, {
          history: statusStore.getHistory(),
        });
      }

      if (method === 'POST' && pathname === '/api/status') {
        return handlePostStatus(req, res, statusStore);
      }

      if (method === 'POST' && pathname === '/api/instances/remove') {
        return handleRemoveInstance(req, res, statusStore);
      }

      if (method === 'POST' && pathname === '/api/reset') {
        const result = statusStore.reset({ source: 'http-reset' });
        return sendJson(res, 200, {
          ok: true,
          deduped: result.deduped,
          status: result.status,
        });
      }

      if (method === 'GET' && (pathname === '/debug' || pathname === '/debug/')) {
        return serveFile(res, join(PUBLIC_DIR, 'debug.html'), 'text/html; charset=utf-8');
      }

      if (method === 'GET' && pathname === '/debug.js') {
        return serveFile(res, join(PUBLIC_DIR, 'debug.js'), 'text/javascript; charset=utf-8');
      }

      if (method === 'GET' && pathname === '/debug.css') {
        return serveFile(res, join(PUBLIC_DIR, 'debug.css'), 'text/css; charset=utf-8');
      }

      if (method === 'GET' && pathname === '/') {
        res.writeHead(302, { Location: '/debug' });
        res.end();
        return;
      }

      return sendJson(res, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `No route for ${method} ${pathname}`,
        },
      });
    } catch (error) {
      console.error('[http] unhandled error:', error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Unexpected server error',
          },
        });
      }
    }
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./status-store.mjs').StatusStore} statusStore
 */
async function handleRemoveInstance(req, res, statusStore) {
  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    return sendJson(res, bodyResult.status, { error: bodyResult.error });
  }

  const body = bodyResult.value && typeof bodyResult.value === 'object' ? bodyResult.value : {};
  const workspaceRoot =
    typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()
      ? body.workspaceRoot.trim()
      : null;
  const conversationId =
    typeof body.conversationId === 'string' && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  const project = typeof body.project === 'string' ? body.project.trim() : '';

  if (!workspaceRoot && !conversationId && !project) {
    return sendJson(res, 400, {
      error: {
        code: 'MISSING_FILTER',
        message: 'Provide workspaceRoot, conversationId, or project',
      },
    });
  }

  const result = statusStore.removeInstance({ workspaceRoot, conversationId, project });
  return sendJson(res, 200, {
    ok: true,
    removed: result.removed,
    status: result.status,
    instances: result.instances,
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./status-store.mjs').StatusStore} statusStore
 */
async function handlePostStatus(req, res, statusStore) {
  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    return sendJson(res, bodyResult.status, { error: bodyResult.error });
  }

  const validation = validateStatusPayload(bodyResult.value);
  if (!validation.ok) {
    return sendJson(res, 400, { error: validation.error });
  }

  const result = statusStore.setStatus(validation.value);
  return sendJson(res, 200, {
    ok: true,
    deduped: result.deduped,
    status: result.status,
    instances: result.instances,
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, error: object }>}
 */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let tooLarge = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk) => {
      if (tooLarge || settled) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) {
        return;
      }

      if (tooLarge) {
        finish({
          ok: false,
          status: 413,
          error: {
            code: 'BODY_TOO_LARGE',
            message: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
          },
        });
        return;
      }

      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        finish({
          ok: false,
          status: 400,
          error: {
            code: 'EMPTY_BODY',
            message: 'Request body is required',
          },
        });
        return;
      }

      try {
        finish({
          ok: true,
          value: JSON.parse(raw),
        });
      } catch {
        finish({
          ok: false,
          status: 400,
          error: {
            code: 'MALFORMED_JSON',
            message: 'Request body is not valid JSON',
          },
        });
      }
    });

    req.on('error', () => {
      finish({
        ok: false,
        status: 400,
        error: {
          code: 'BODY_READ_ERROR',
          message: 'Failed to read request body',
        },
      });
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {unknown} payload
 */
export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {string} contentType
 */
async function serveFile(res, filePath, contentType) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      sendJson(res, 404, {
        error: {
          code: 'NOT_FOUND',
          message: 'Asset not found',
        },
      });
      return;
    }
    throw error;
  }
}
