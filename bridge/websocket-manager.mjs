import { WebSocketServer } from 'ws';
import { WS_PATH } from './config.mjs';

/**
 * Manages WebSocket clients subscribed to status updates.
 */
export class WebSocketManager {
  /**
   * @param {import('node:http').Server} httpServer
   * @param {import('./status-store.mjs').StatusStore} statusStore
   */
  constructor(httpServer, statusStore) {
    this.statusStore = statusStore;
    this.clients = new Set();
    this.wss = new WebSocketServer({
      server: httpServer,
      path: WS_PATH,
    });

    this.wss.on('connection', (socket, request) => {
      this.#onConnection(socket, request);
    });

    this.unsubscribe = this.statusStore.subscribe((status, meta) => {
      this.broadcastStatus(status);
      this.broadcastInstances(meta.instances ?? this.statusStore.getInstances());
    });
  }

  getClientCount() {
    return this.clients.size;
  }

  /**
   * @param {object} status
   */
  broadcastStatus(status) {
    this.#broadcast({
      type: 'status',
      payload: status,
    });
  }

  /**
   * @param {object[]} instances
   */
  broadcastInstances(instances) {
    this.#broadcast({
      type: 'instances',
      payload: {
        instances,
        count: instances.length,
        aggregateState: this.statusStore.getAggregateState(),
      },
    });
  }

  /**
   * Close all clients and the WebSocket server.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    for (const client of this.clients) {
      try {
        client.close(1001, 'Bridge shutting down');
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    await new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  #broadcast(message) {
    const envelope = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(envelope);
        } catch (error) {
          console.error('[ws] broadcast failed:', error.message);
        }
      }
    }
  }

  #onConnection(socket, request) {
    const remote = request.socket.remoteAddress ?? 'unknown';
    this.clients.add(socket);
    console.log(`[ws] client connected (${remote}). clients=${this.clients.size}`);

    try {
      socket.send(
        JSON.stringify({
          type: 'status',
          payload: this.statusStore.getCurrent(),
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'instances',
          payload: {
            instances: this.statusStore.getInstances(),
            count: this.statusStore.getInstances().length,
            aggregateState: this.statusStore.getAggregateState(),
          },
        }),
      );
    } catch (error) {
      console.error('[ws] failed to send initial snapshot:', error.message);
    }

    socket.on('message', (raw) => {
      this.#onMessage(socket, raw);
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      console.log(`[ws] client disconnected (${remote}). clients=${this.clients.size}`);
    });

    socket.on('error', (error) => {
      console.error(`[ws] client error (${remote}):`, error.message);
      this.clients.delete(socket);
    });
  }

  #onMessage(socket, raw) {
    let text;
    try {
      text = typeof raw === 'string' ? raw : raw.toString('utf8');
    } catch {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'ping') {
      try {
        socket.send(
          JSON.stringify({
            type: 'pong',
            timestamp: message.timestamp ?? new Date().toISOString(),
          }),
        );
      } catch (error) {
        console.error('[ws] failed to send pong:', error.message);
      }
    }
  }
}
