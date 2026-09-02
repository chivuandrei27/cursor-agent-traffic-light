import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startBridge } from '../bridge/server.mjs';

describe('bridge HTTP integration', () => {
  /** @type {Awaited<ReturnType<typeof startBridge>>} */
  let bridge;
  let baseUrl;

  before(async () => {
    bridge = await startBridge({ port: 0 });
    baseUrl = `http://${bridge.host}:${bridge.port}`;
  });

  after(async () => {
    await bridge.close();
  });

  it('GET /health returns ok', async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(typeof body.webSocketClients, 'number');
    assert.equal(body.currentStatus.state, 'idle');
  });

  it('GET /api/status returns current status', async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.state);
    assert.ok('sequence' in body);
    assert.ok('updatedAt' in body);
  });

  it('POST /api/status accepts a valid payload', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'working',
        message: 'Manual bridge test',
        source: 'manual',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.state, 'working');
    assert.equal(body.status.message, 'Manual bridge test');
  });

  it('POST /api/status rejects invalid state', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'offline' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'OFFLINE_NOT_ALLOWED');
  });

  it('POST /api/status rejects malformed JSON', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'MALFORMED_JSON');
  });

  it('POST /api/reset resets to idle', async () => {
    await fetch(`${baseUrl}/api/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'error', message: 'boom', source: 't' }),
    });

    // Wait past dedupe window for a clean reset acceptance path
    await new Promise((resolve) => setTimeout(resolve, 520));

    const response = await fetch(`${baseUrl}/api/reset`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status.state, 'idle');
  });
});
