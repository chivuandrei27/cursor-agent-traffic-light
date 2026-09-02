import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.mjs';
import {
  APPROVAL_PROMOTE_INTERVAL_MS,
  HOST,
  PORT,
  STALE_SWEEP_INTERVAL_MS,
} from './config.mjs';
import {
  createInstancePersister,
  loadInstancesForHydration,
} from './instance-persist.mjs';
import { drainRemoveSpool } from './remove-spool.mjs';
import { createStatusStore } from './status-store.mjs';
import { WebSocketManager } from './websocket-manager.mjs';

const SPOOL_POLL_MS = 1_000;

/**
 * Start the local HTTP + WebSocket bridge.
 *
 * @param {{ host?: string, port?: number }} [options]
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   statusStore: import('./status-store.mjs').StatusStore,
 *   wsManager: WebSocketManager,
 *   host: string,
 *   port: number,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startBridge(options = {}) {
  const host = options.host ?? HOST;
  const port = options.port ?? PORT;
  const startedAt = Date.now();
  const statusStore = createStatusStore();

  try {
    const hydrated = await loadInstancesForHydration();
    if (hydrated.length > 0) {
      statusStore.restoreInstances(hydrated);
      console.log(`[bridge] restored ${hydrated.length} project card(s)`);
    }
  } catch (error) {
    console.error('[bridge] instance hydrate failed:', error);
  }

  const persister = createInstancePersister(() => statusStore.getInstances());
  statusStore.subscribe((_status, meta) => {
    if (meta?.deduped) {
      return;
    }
    persister.schedule();
  });

  let wsManager = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let staleTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let spoolTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let approvalTimer = null;

  const app = createApp({
    statusStore,
    getWebSocketClientCount: () => (wsManager ? wsManager.getClientCount() : 0),
    startedAt,
  });

  const server = createServer((req, res) => {
    void app(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  wsManager = new WebSocketManager(server, statusStore);

  const runSpoolDrain = async () => {
    try {
      const n = await drainRemoveSpool((filter) => statusStore.removeInstance(filter));
      if (n > 0) {
        console.log(`[bridge] removed ${n} project(s) from close-spool`);
      }
    } catch (error) {
      console.error('[bridge] remove-spool drain error:', error);
    }
  };
  await runSpoolDrain();
  spoolTimer = setInterval(() => {
    void runSpoolDrain();
  }, SPOOL_POLL_MS);
  spoolTimer.unref?.();

  staleTimer = setInterval(() => {
    try {
      const result = statusStore.sweepStaleActive();
      if (result.swept > 0) {
        console.log(`[bridge] auto-completed ${result.swept} stale instance(s)`);
      }
    } catch (error) {
      console.error('[bridge] stale sweep error:', error);
    }
  }, STALE_SWEEP_INTERVAL_MS);
  staleTimer.unref?.();

  approvalTimer = setInterval(() => {
    try {
      statusStore.promotePendingApprovals();
      statusStore.demoteStuckApprovals();
    } catch (error) {
      console.error('[bridge] approval promote error:', error);
    }
  }, APPROVAL_PROMOTE_INTERVAL_MS);
  approvalTimer.unref?.();

  console.log(`[bridge] listening on http://${host}:${boundPort}`);
  console.log(`[bridge] debug UI at http://${host}:${boundPort}/debug`);
  console.log(`[bridge] websocket at ws://${host}:${boundPort}/ws`);

  let closing = false;

  async function close() {
    if (closing) {
      return;
    }
    closing = true;

    console.log('[bridge] shutting down...');

    if (staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
    if (spoolTimer) {
      clearInterval(spoolTimer);
      spoolTimer = null;
    }
    if (approvalTimer) {
      clearInterval(approvalTimer);
      approvalTimer = null;
    }

    try {
      await persister.flushNow();
    } catch {
      // ignore
    }

    if (wsManager) {
      await wsManager.close();
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections?.();
    });

    console.log('[bridge] stopped');
  }

  return {
    server,
    statusStore,
    wsManager,
    host,
    port: boundPort,
    close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = await startBridge();

  const shutdown = async (signal) => {
    console.log(`[bridge] received ${signal}`);
    try {
      await bridge.close();
      process.exit(0);
    } catch (error) {
      console.error('[bridge] shutdown error:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}
